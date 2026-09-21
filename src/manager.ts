import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import type {
  Project,
  Service,
  RuntimeProjectState,
  ServiceStatus,
  UnsafeApproval,
} from './types.js';
import { SupervisedProcess, classifyFailure, type LogLine, type ExitInfo } from './supervisor.js';
import { buildStartPlan, validateProfile, withDependencies, withDependents, type GraphError } from './graph.js';
import { waitForHealthy, runHealthCheck } from './health.js';
import { logDir } from './paths.js';
import {
  writeState,
  readState,
  writeLease,
  removeLease,
  mergeServiceStatus,
} from './state.js';
import { acquireLock, releaseLock, startHeartbeat, type ProjectLock } from './lock.js';
import { assertSafeToOperate } from './safety.js';
import { readProcessIdentity, identityMatches } from './proc.js';

export interface StartOptions {
  profile?: string;
  services?: string[];
  /** If true, do not fail the whole start when one service fails. */
  continueOnError?: boolean;
  /** Wait for health checks before returning. */
  waitHealthy?: boolean;
  /** Safety gate: if project is marked unsafe, must be true or accompanied by approval. */
  allowUnsafe?: boolean;
  unsafeApproval?: UnsafeApproval;
}

export interface StartResult {
  projectId: string;
  started: string[];
  failed: { id: string; failureClass: string; detail: string }[];
  skipped: string[];
  errors: GraphError[];
}

export interface ManagerEvents {
  log: (line: LogLine) => void;
  state: (state: RuntimeProjectState) => void;
}

export class ProjectManager extends EventEmitter {
  private project: Project;
  private procs = new Map<string, SupervisedProcess>();
  private state: RuntimeProjectState;
  private healthTimers = new Map<string, NodeJS.Timeout>();
  private desiredRunning = new Set<string>();
  private crashTimes = new Map<string, number[]>();

  constructor(project: Project) {
    super();
    this.project = project;
    this.state = { projectId: project.id, name: project.name, services: {} };
    // Seed from persisted state so a fresh CLI invocation can reclaim orphans.
    // PIDs are only trusted when their persisted identity still matches.
    const persisted = readState(project.id);
    for (const s of project.services) {
      const prev = persisted?.services[s.id];
      const seeded = {
        id: s.id,
        status: 'stopped' as ServiceStatus,
        restarts: prev?.restarts ?? 0,
        health: prev?.health ?? { status: 'unknown' as const },
        pid: undefined as number | undefined,
        process: undefined as RuntimeProjectState['services'][string]['process'],
        startedAt: prev?.startedAt,
      };
      if (prev?.pid) {
        if (prev.process) {
          if (identityMatches(prev.process, readProcessIdentity(prev.pid))) {
            seeded.status = prev.status;
            seeded.pid = prev.pid;
            seeded.process = prev.process;
          }
        } else if (readProcessIdentity(prev.pid)) {
          // Legacy V1 state without identity: trust once, identity will be captured on next start.
          seeded.status = prev.status;
          seeded.pid = prev.pid;
        }
      }
      this.state.services[s.id] = seeded;
    }
  }

  getState(): RuntimeProjectState {
    return this.state;
  }

  private emitState(): void {
    this.emit('state', this.state);
    writeState(this.state);
  }

  private emitLog(line: LogLine): void {
    this.emit('log', line);
  }

  serviceById(id: string): Service | undefined {
    return this.project.services.find((s) => s.id === id);
  }

  /** Resolve the set of services for a start request. */
  resolveServices(opts: StartOptions): { ids: string[]; errors: GraphError[] } {
    const errors: GraphError[] = [];
    let requested: string[];
    if (opts.services?.length) {
      requested = opts.services;
    } else if (opts.profile) {
      const profile = this.project.profiles?.[opts.profile];
      if (!profile) {
        errors.push({ kind: 'missing-dependency', message: `Profile "${opts.profile}" not found`, nodes: [] });
        return { ids: [], errors };
      }
      requested = profile.services;
      errors.push(...validateProfile(this.project.services, profile.services));
    } else {
      requested = this.project.services.map((s) => s.id);
    }
    return { ids: withDependencies(this.project.services, requested), errors };
  }

  async start(opts: StartOptions = {}): Promise<StartResult> {
    const result: StartResult = {
      projectId: this.project.id,
      started: [],
      failed: [],
      skipped: [],
      errors: [],
    };

    // Single authoritative safety gate (shared with the HTTP server).
    const gate = assertSafeToOperate(this.project, {
      allowUnsafe: opts.allowUnsafe,
      unsafeApproval: opts.unsafeApproval,
      operation: 'start',
    });
    if (!gate.ok) {
      for (const message of gate.errors) {
        result.errors.push({ kind: 'missing-dependency', message, nodes: [] });
      }
      return result;
    }

    // Ownership: only one launcher instance may drive a project at a time.
    const acquired = acquireLock(this.project.id, 'start');
    if (!acquired.ok) {
      result.errors.push({
        kind: 'locked',
        message: acquired.busyReason || 'Project is already owned by another launcher instance',
        nodes: [],
      });
      return result;
    }
    const lock: ProjectLock = acquired.lock!;
    const stopHeartbeat = startHeartbeat(lock);

    try {
      await this.reconcileWithIdentity();

      const { ids, errors } = this.resolveServices(opts);
      result.errors.push(...errors);
      const fatal = errors.filter((e) => e.kind === 'cycle' || e.kind === 'missing-dependency');
      if (fatal.length) return result;

      const selected = this.project.services.filter((s) => ids.includes(s.id));
      const plan = buildStartPlan(selected);
      result.errors.push(...plan.errors);
      if (plan.errors.some((e) => e.kind === 'cycle')) return result;

      mkdirSync(logDir(), { recursive: true });
      const projectLogDir = logDir() + '/' + this.project.id;

      writeLease({
        projectId: this.project.id,
        supervisorPid: process.pid,
        startedAt: Date.now(),
        processes: {},
      });

      this.state.startedAt = Date.now();
      this.emitState();

      const waitHealthy = opts.waitHealthy !== false;

      for (const id of plan.order) {
        const svc = this.serviceById(id);
        if (!svc) continue;

        // A service already running under verified ownership is not started twice.
        const existing = this.state.services[id];
        if (
          existing &&
          (existing.status === 'healthy' || existing.status === 'running') &&
          existing.pid &&
          identityMatches(existing.process, readProcessIdentity(existing.pid))
        ) {
          result.started.push(id);
          continue;
        }

        // Check dependencies succeeded (healthy if a health check exists, else running)
        const unmet: string[] = [];
        for (const dep of svc.dependsOn || []) {
          const depState = this.state.services[dep];
          const ok = depState && (depState.status === 'healthy' || depState.status === 'running');
          if (!ok) unmet.push(dep);
        }
        if (unmet.length) {
          const detail = `dependency not ready: ${unmet.join(', ')}`;
          this.setStatus(id, 'failed');
          result.failed.push({ id, failureClass: 'SERVICE_ORDER', detail });
          if (!opts.continueOnError) break;
          continue;
        }

        const startResult = await this.startService(svc, projectLogDir, waitHealthy);
        if (startResult.ok) {
          result.started.push(id);
        } else {
          result.failed.push({ id, failureClass: startResult.failureClass, detail: startResult.detail });
          if (!opts.continueOnError) break;
        }
      }

      this.updateLease();
      this.emitState();
      return result;
    } finally {
      stopHeartbeat();
      releaseLock(lock);
    }
  }

  private async startService(
    svc: Service,
    projectLogDir: string,
    waitHealthy: boolean,
  ): Promise<{ ok: boolean; failureClass: string; detail: string }> {
    if (this.procs.has(svc.id) && this.procs.get(svc.id)!.running) {
      return { ok: true, failureClass: 'UNKNOWN', detail: 'already running' };
    }
    // Owned by a previous invocation and still verifiably ours: do not duplicate.
    const st = this.state.services[svc.id];
    if (
      st?.pid &&
      (st.status === 'healthy' || st.status === 'running') &&
      identityMatches(st.process, readProcessIdentity(st.pid))
    ) {
      return { ok: true, failureClass: 'UNKNOWN', detail: 'already running (verified ownership)' };
    }
    this.setStatus(svc.id, 'starting', { startedAt: Date.now() });
    const proc = new SupervisedProcess({
      id: svc.id,
      command: svc.command,
      cwd: svc.cwd ? `${this.project.root}/${svc.cwd}` : this.project.root,
      env: svc.environment,
      logDir: projectLogDir,
    });
    this.procs.set(svc.id, proc);
    this.desiredRunning.add(svc.id);

    proc.on('log', (line: LogLine) => this.emitLog(line));
    proc.on('exit', (info: ExitInfo) => {
      const wasDesired = this.desiredRunning.has(svc.id);
      this.setStatus(svc.id, wasDesired ? 'crashed' : 'stopped', {
        exitCode: info.code,
        signal: info.signal,
        stoppedAt: info.endedAt,
      });
      this.procs.delete(svc.id);
    });
    proc.on('exit', (info: ExitInfo) => {
      const policy = svc.restartPolicy || 'never';
      if (policy === 'never' || info.code === 0) return;
      if (!this.desiredRunning.has(svc.id) || !this.state.services[svc.id]) return;
      // Restart safeguards: sliding 60s window, max attempts, exponential backoff.
      const now = Date.now();
      const maxAttempts = svc.restartMaxAttempts ?? 5;
      const baseBackoff = svc.restartBackoffMs ?? 1000;
      const history = (this.crashTimes.get(svc.id) || []).filter((t) => now - t < 60_000);
      history.push(now);
      this.crashTimes.set(svc.id, history);
      if (history.length > maxAttempts) {
        this.emitLog({ id: svc.id, stream: 'system', line: `restart loop suppressed: ${history.length} crashes in 60s (max ${maxAttempts})`, at: now });
        this.setStatus(svc.id, 'failed');
        this.desiredRunning.delete(svc.id);
        return;
      }
      const restarts = (this.state.services[svc.id]!.restarts || 0) + 1;
      const backoff = Math.min(baseBackoff * 2 ** (history.length - 1), 30_000);
      this.setStatus(svc.id, 'starting', { restarts });
      this.emitLog({ id: svc.id, stream: 'system', line: `restart policy=${policy}, restart #${restarts} in ${backoff}ms`, at: now });
      setTimeout(() => void this.startService(svc, projectLogDir, false), backoff);
    });

    try {
      proc.start();
    } catch (err) {
      this.setStatus(svc.id, 'failed');
      this.desiredRunning.delete(svc.id);
      return { ok: false, failureClass: 'UNKNOWN', detail: (err as Error).message };
    }

    this.setStatus(svc.id, 'running', { pid: proc.pid, startedAt: Date.now() });
    const identity = await captureIdentity(proc.pid);
    if (identity) {
      this.setStatus(svc.id, 'running', { process: identity });
    } else {
      this.emitLog({ id: svc.id, stream: 'system', line: 'warning: could not read process identity; ownership verification unavailable', at: Date.now() });
    }
    this.updateLease();

    // Determine health behavior: explicit check, else implicit tcp if port known, else process-only.
    let hc = svc.healthCheck;
    if (!hc && svc.port) hc = { type: 'tcp', port: svc.port, startPeriodMs: 30_000 };

    if (!hc) {
      // Wait a short stabilization window; if the process exits immediately, it failed.
      const alive = await sleepCheckExit(proc, 2000);
      if (!alive) {
        const info = proc.exitInfo;
        const stderr = info?.stderrTail || '';
        const failureClass = classifyFailure(info, stderr, info?.stdoutTail || '');
        // A restart-loop suppression may have already marked this failed; keep that verdict.
        if (this.state.services[svc.id]?.status !== 'failed') {
          this.setStatus(svc.id, 'crashed', { exitCode: info?.code ?? null });
        }
        this.desiredRunning.delete(svc.id);
        return { ok: false, failureClass, detail: firstLines(stderr) || 'process exited during startup' };
      }
      this.setHealth(svc.id, 'unknown', 'no health check configured (process is running)');
      return { ok: true, failureClass: 'UNKNOWN', detail: 'running' };
    }

    if (!waitHealthy) {
      void this.becomeHealthy(svc, hc);
      return { ok: true, failureClass: 'UNKNOWN', detail: 'starting (health check deferred)' };
    }

    const health = await waitForHealthy(hc, proc ? svc.cwd ? `${this.project.root}/${svc.cwd}` : this.project.root : this.project.root, {
      abort: () => !proc.running,
    });
    if (health.healthy) {
      this.setHealth(svc.id, 'healthy', health.detail);
      this.startPeriodicHealth(svc, hc);
      return { ok: true, failureClass: 'UNKNOWN', detail: health.detail };
    }
    if (!proc.running) {
      const info = proc.exitInfo;
      const failureClass = classifyFailure(info, info?.stderrTail || '', info?.stdoutTail || '');
      if (this.state.services[svc.id]?.status !== 'failed') {
        this.setStatus(svc.id, 'crashed');
      }
      this.desiredRunning.delete(svc.id);
      return {
        ok: false,
        failureClass,
        detail: firstLines(info?.stderrTail || '') || `exited (code ${info?.code})`,
      };
    }
    // still running but unhealthy
    this.setHealth(svc.id, 'unhealthy', health.detail);
    this.startPeriodicHealth(svc, hc);
    return { ok: false, failureClass: 'UNKNOWN', detail: `unhealthy: ${health.detail}` };
  }

  private async becomeHealthy(svc: Service, hc: NonNullable<Service['healthCheck']>): Promise<void> {
    const proc = this.procs.get(svc.id);
    const cwd = svc.cwd ? `${this.project.root}/${svc.cwd}` : this.project.root;
    const health = await waitForHealthy(hc, cwd, { abort: () => !proc?.running });
    if (!proc?.running) return;
    this.setHealth(svc.id, health.healthy ? 'healthy' : 'unhealthy', health.detail);
    this.startPeriodicHealth(svc, hc);
  }

  private startPeriodicHealth(svc: Service, hc: NonNullable<Service['healthCheck']>): void {
    const existing = this.healthTimers.get(svc.id);
    if (existing) clearInterval(existing);
    const interval = hc.intervalMs && hc.intervalMs > 1000 ? hc.intervalMs : 5000;
    const timer = setInterval(async () => {
      if (!this.procs.get(svc.id)?.running) {
        clearInterval(timer);
        this.healthTimers.delete(svc.id);
        return;
      }
      const res = await runHealthCheck(hc, svc.cwd ? `${this.project.root}/${svc.cwd}` : this.project.root);
      this.setHealth(svc.id, res.healthy ? 'healthy' : 'unhealthy', res.detail);
    }, interval);
    timer.unref?.();
    this.healthTimers.set(svc.id, timer);
  }

  private setHealth(id: string, status: 'unknown' | 'healthy' | 'unhealthy', detail: string): void {
    const svcState = this.state.services[id];
    if (!svcState) return;
    svcState.health = { status, lastCheckAt: Date.now(), detail };
    this.emitState();
  }

  private setStatus(id: string, status: ServiceStatus, extra: Partial<{ exitCode: number | null; signal: string | null; stoppedAt: number; startedAt: number; pid: number; process: RuntimeProjectState['services'][string]['process']; restarts: number }> = {}): void {
    mergeServiceStatus(this.state, id, { status, ...extra });
    this.emitState();
  }

  private updateLease(): void {
    const processes: Record<string, number> = {};
    for (const [id, p] of this.procs) if (p.pid) processes[id] = p.pid;
    writeLease({
      projectId: this.project.id,
      supervisorPid: process.pid,
      startedAt: this.state.startedAt || Date.now(),
      processes,
    });
  }

  /** Gracefully stop the given services (or all) in reverse dependency order. */
  async stop(serviceIds?: string[], graceMs = 5000): Promise<{ stopped: string[]; failures: string[] }> {
    const acquired = acquireLock(this.project.id, 'stop');
    if (!acquired.ok) {
      return { stopped: [], failures: [acquired.busyReason || 'Project is already owned by another launcher instance'] };
    }
    const lock = acquired.lock!;
    const stopHeartbeat = startHeartbeat(lock);
    try {
      await this.reconcileWithIdentity();

      // Stopping a service must also stop anything that depends on it, otherwise
      // we leave dependents running against a dependency that is gone.
      const expandedIds = serviceIds?.length ? withDependents(this.project.services, serviceIds) : undefined;
      const selected = expandedIds
        ? this.project.services.filter((s) => expandedIds.includes(s.id))
        : this.project.services;
      const plan = buildStartPlan(selected);
      const order = [...plan.order].reverse();

      for (const id of order) this.desiredRunning.delete(id);

      const stopped: string[] = [];
      const failures: string[] = [];

      for (const id of order) {
        const proc = this.procs.get(id);
        const svcState = this.state.services[id];
        // Reclaim orphans from a previous launcher instance, but ONLY when the
        // persisted identity still matches. Never signal on PID alone.
        if (!proc && svcState?.pid) {
          const actual = readProcessIdentity(svcState.pid);
          if (!identityMatches(svcState.process, actual)) {
            if (actual) {
              this.emitLog({ id, stream: 'system', line: `stale state: pid ${svcState.pid} is now an unrelated process; refusing to signal`, at: Date.now() });
            }
            this.setStatus(id, 'stopped', { stoppedAt: Date.now() });
            const cur = this.state.services[id];
            if (cur) {
              cur.pid = undefined;
              cur.process = undefined;
            }
            this.emitState();
            continue;
          }
          this.emitLog({ id, stream: 'system', line: `reclaiming verified pid ${svcState.pid}`, at: Date.now() });
          try {
            process.kill(-svcState.pid, 'SIGTERM');
          } catch {
            try {
              process.kill(svcState.pid, 'SIGTERM');
            } catch {
              /* ignore */
            }
          }
          await sleep(500);
          if (readProcessIdentity(svcState.pid)) {
            try {
              process.kill(-svcState.pid, 'SIGKILL');
            } catch {
              try {
                process.kill(svcState.pid, 'SIGKILL');
              } catch {
                /* ignore */
              }
            }
          }
          this.setStatus(id, 'stopped', { stoppedAt: Date.now() });
          stopped.push(id);
          continue;
        }
        if (!proc) {
          this.setStatus(id, 'stopped', { stoppedAt: Date.now() });
          continue;
        }
        this.setStatus(id, 'stopping');
        const timer = this.healthTimers.get(id);
        if (timer) {
          clearInterval(timer);
          this.healthTimers.delete(id);
        }
        const info = await proc.stop(graceMs);
        this.procs.delete(id);
        if (info) {
          this.setStatus(id, 'stopped', {
            exitCode: info.code,
            signal: info.signal,
            stoppedAt: Date.now(),
          });
          stopped.push(id);
        } else {
          this.setStatus(id, 'stopped', { stoppedAt: Date.now() });
          stopped.push(id);
        }
      }

      removeLease(this.project.id);
      this.emitState();
      return { stopped, failures };
    } finally {
      stopHeartbeat();
      releaseLock(lock);
    }
  }

  /**
   * Reconcile persisted state with the OS using process identity, not PID alone.
   * - identity matches -> keep live status
   * - PID alive but identity differs -> stale; clear without signaling
   * - PID gone -> crashed
   */
  async reconcileWithIdentity(): Promise<{ stale: string[] }> {
    const stale: string[] = [];
    for (const [id, svcState] of Object.entries(this.state.services)) {
      if (!svcState.pid) continue;
      const actual = readProcessIdentity(svcState.pid);
      if (identityMatches(svcState.process, actual)) continue;
      if (actual) {
        stale.push(id);
        this.emitLog({ id, stream: 'system', line: `stale state: pid ${svcState.pid} no longer matches; cleared without signaling`, at: Date.now() });
        this.setStatus(id, 'stopped', { stoppedAt: Date.now() });
        svcState.pid = undefined;
        svcState.process = undefined;
        this.emitState();
      } else if (svcState.status !== 'stopped') {
        this.setStatus(id, 'crashed', { exitCode: null });
      }
    }
    return { stale };
  }

  /** Backwards-compatible wrapper. */
  async reconcileOnAttach(): Promise<void> {
    await this.reconcileWithIdentity();
  }

  logsDir(): string {
    return `${logDir()}/${this.project.id}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read /proc identity for a just-spawned pid, retrying briefly for visibility. */
async function captureIdentity(pid: number | undefined): Promise<RuntimeProjectState['services'][string]['process']> {
  if (!pid) return undefined;
  for (let i = 0; i < 10; i++) {
    const identity = readProcessIdentity(pid);
    if (identity) return identity;
    await sleep(100);
  }
  return undefined;
}

async function sleepCheckExit(proc: SupervisedProcess, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!proc.running) return false;
    await sleep(100);
  }
  return proc.running;
}

function firstLines(text: string, n = 6): string {
  return text.split('\n').filter(Boolean).slice(0, n).join(' | ');
}
