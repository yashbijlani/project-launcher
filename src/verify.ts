import { connect } from 'node:net';
import type {
  Project,
  ProjectVerification,
  ServiceVerificationEvidence,
  UnsafeApproval,
} from './types.js';
import { ProjectManager } from './manager.js';
import { acquireLock, releaseLock, startHeartbeat, type ProjectLock } from './lock.js';
import { assertSafeToOperate, validateProjectPaths } from './safety.js';
import { computeConfigFingerprint } from './fingerprint.js';
import { checkPrereqs } from './prereqs.js';
import { buildStartPlan } from './graph.js';
import { saveProject } from './config.js';
import { readFileSync } from 'node:fs';

export interface VerifyOptions {
  profile?: string;
  services?: string[];
  allowUnsafe?: boolean;
  unsafeApproval?: UnsafeApproval;
  /** Skip persisting the verification record (for dry runs). */
  dryRun?: boolean;
}

export interface VerifyResult {
  projectId: string;
  ok: boolean;
  status: 'verified' | 'failed' | 'blocked';
  failureClass?: string;
  detail?: string;
  errors: string[];
  blockers: { type: string; message: string; service?: string }[];
  order: string[];
  services: Record<string, ServiceVerificationEvidence>;
  fingerprint: string;
}

function launcherVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function tcpClosed(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (closed: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(true));
  });
}

/**
 * Deterministic end-to-end verification:
 * validate -> prereqs -> own -> start -> health -> stop -> cleanup -> record.
 * Never installs dependencies or modifies the repository.
 */
export async function verifyProject(project: Project, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const fingerprint = computeConfigFingerprint(project);
  const fail = (
    status: 'failed' | 'blocked',
    failureClass: string | undefined,
    detail: string,
    errors: string[] = [],
    services: Record<string, ServiceVerificationEvidence> = {},
    order: string[] = [],
  ): VerifyResult => {
    const result: VerifyResult = {
      projectId: project.id,
      ok: false,
      status,
      failureClass,
      detail,
      errors,
      blockers: [],
      order,
      services,
      fingerprint,
    };
    if (!opts.dryRun) persistVerification(project, result);
    return result;
  };

  // 1-4. Configuration, paths, structure.
  const gate = assertSafeToOperate(project, { allowUnsafe: opts.allowUnsafe, unsafeApproval: opts.unsafeApproval, operation: 'verify' });
  if (!gate.ok) {
    const unsafe = gate.errors.some((e) => e.includes('UNSAFE TO AUTO-RUN'));
    return fail(unsafe ? 'blocked' : 'failed', unsafe ? 'PERMISSION' : 'AMBIGUOUS', gate.errors.join('; '), gate.errors);
  }
  const pathErrors = validateProjectPaths(project);
  if (pathErrors.length) {
    return fail('failed', 'WRONG_WORKING_DIRECTORY', pathErrors.join('; '), pathErrors);
  }

  // 5. Prerequisites (no installation, no execution).
  const prereqs = checkPrereqs(project);
  if (!prereqs.ok) {
    const first = prereqs.blockers[0]!;
    const failureClass =
      first.type === 'docker' ? 'DOCKER_REQUIRED' : first.type === 'device' ? 'DEVICE_REQUIRED' : first.type === 'credentials' ? 'MISSING_ENVIRONMENT_VARIABLE' : 'MISSING_DEPENDENCY';
    const result = fail('blocked', failureClass, prereqs.blockers.map((b) => b.message).join('; '));
    result.blockers = prereqs.blockers;
    return result;
  }

  // 6. Ownership.
  const acquired = acquireLock(project.id, 'verify');
  if (!acquired.ok) {
    return fail('blocked', 'SERVICE_ORDER', acquired.busyReason || 'Project is owned by another launcher instance', [acquired.busyReason || 'busy']);
  }
  const lock = acquired.lock!;
  const stopHeartbeat = startHeartbeat(lock);

  const mgr = new ProjectManager(project);
  await mgr.reconcileWithIdentity();
  const services: Record<string, ServiceVerificationEvidence> = {};
  const forService = (id: string): ServiceVerificationEvidence =>
    (services[id] ??= { started: false, healthy: false, stoppedCleanly: false });

  try {
    // 7-8. Start in dependency order with health.
    const startResult = await mgr.start({
      profile: opts.profile,
      services: opts.services,
      allowUnsafe: opts.allowUnsafe,
      unsafeApproval: opts.unsafeApproval,
      waitHealthy: true,
    });
    const order = buildStartPlan(project.services.filter((s) => startResult.started.includes(s.id) || startResult.failed.some((f) => f.id === s.id))).order;
    for (const id of startResult.started) {
      const st = mgr.getState().services[id];
      const svc = project.services.find((s) => s.id === id);
      forService(id).started = true;
      forService(id).healthy = st?.status === 'healthy' || st?.status === 'running';
      if (svc?.healthCheck) {
        forService(id).health = { type: svc.healthCheck.type, url: svc.healthCheck.url, port: svc.healthCheck.port };
      }
      forService(id).detail = st?.health?.detail;
    }
    if (startResult.failed.length || startResult.errors.length) {
      const first = startResult.failed[0];
      const detail = first ? `${first.id} [${first.failureClass}] ${first.detail}` : startResult.errors.map((e) => e.message).join('; ');
      await mgr.stop();
      return fail('failed', first?.failureClass || 'UNKNOWN', detail, [...startResult.errors.map((e) => e.message)], services, order);
    }

    // 9-10. Confirm declared ports are actually usable.
    for (const id of startResult.started) {
      const svc = project.services.find((s) => s.id === id);
      if (svc?.port && svc.healthCheck?.type !== 'http') {
        const usable = !(await tcpClosed('127.0.0.1', svc.port));
        if (!usable) {
          await mgr.stop();
          return fail('failed', 'PORT_CONFLICT', `service ${id}: port ${svc.port} is not usable after start`, [], services, order);
        }
      }
    }

    // 11. Stop in reverse dependency order.
    const stopResult = await mgr.stop();
    void stopResult;

    // 12. Confirm cleanup: every started service dead and ports closed.
    await mgr.reconcileWithIdentity();
    const state = mgr.getState();
    const leftovers: string[] = [];
    for (const id of startResult.started) {
      const st = state.services[id];
      if (st && st.status !== 'stopped') {
        leftovers.push(id);
        continue;
      }
      forService(id).stoppedCleanly = true;
      const svc = project.services.find((s) => s.id === id);
      if (svc?.port) {
        const closed = await tcpClosed('127.0.0.1', svc.port);
        if (!closed) leftovers.push(`${id} (port ${svc.port} still open)`);
      }
    }
    if (leftovers.length) {
      return fail('failed', 'UNKNOWN', `cleanup incomplete: ${leftovers.join(', ')}`, [], services, order);
    }

    // 13. Write verification evidence.
    const verification: ProjectVerification = {
      status: 'verified',
      verifiedAt: new Date().toISOString(),
      launcherVersion: launcherVersion(),
      configFingerprint: fingerprint,
      environment: {
        nodeVersion: prereqs.environment.nodeVersion,
        pythonVersion: prereqs.environment.pythonVersion,
        dockerVersion: prereqs.environment.dockerVersion,
      },
      services,
      dependencyOrder: order,
    };
    project.verification = verification;
    if (!opts.dryRun) saveProject(project);
    return {
      projectId: project.id,
      ok: true,
      status: 'verified',
      errors: [],
      blockers: [],
      order,
      services,
      fingerprint,
    };
  } finally {
    // 14. Release ownership.
    stopHeartbeat();
    releaseLock(lock);
  }
}

function persistVerification(project: Project, result: VerifyResult): void {
  project.verification = {
    status: result.status,
    verifiedAt: new Date().toISOString(),
    launcherVersion: launcherVersion(),
    configFingerprint: result.fingerprint,
    services: result.services,
    dependencyOrder: result.order.length ? result.order : undefined,
    failureClass: result.failureClass,
    detail: result.detail,
  };
  try {
    saveProject(project);
  } catch {
    /* verification must never fail the process on persistence errors */
  }
}

export type { ProjectLock };
