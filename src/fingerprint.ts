import { createHash } from 'node:crypto';
import type { Project } from './types.js';

/** Fields that affect startup behavior. Changing any of these invalidates verification. */
export function fingerprintPayload(project: Project): unknown {
  const services = [...project.services]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      command: s.command,
      cwd: s.cwd || '',
      environment: sortRecord(s.environment || {}),
      dependsOn: [...(s.dependsOn || [])].sort(),
      healthCheck: s.healthCheck
        ? {
            type: s.healthCheck.type,
            url: s.healthCheck.url || '',
            host: s.healthCheck.host || '',
            port: s.healthCheck.port ?? null,
            command: s.healthCheck.command || '',
            timeoutMs: s.healthCheck.timeoutMs ?? null,
            intervalMs: s.healthCheck.intervalMs ?? null,
            startPeriodMs: s.healthCheck.startPeriodMs ?? null,
            expectStatus: s.healthCheck.expectStatus || null,
            expectBody: s.healthCheck.expectBody || '',
          }
        : null,
      restartPolicy: s.restartPolicy || 'never',
      restartMaxAttempts: s.restartMaxAttempts ?? null,
      restartBackoffMs: s.restartBackoffMs ?? null,
      runtime: s.runtime || 'process',
      port: s.port ?? null,
    }));
  const profiles = Object.fromEntries(
    Object.entries(project.profiles || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { services: [...v.services].sort(), description: v.description || '' }]),
  );
  const actions = Object.fromEntries(
    Object.entries(project.actions || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { command: v.command, cwd: v.cwd || '', description: v.description || '' }]),
  );
  return { id: project.id, root: project.root, services, profiles, actions };
}

function sortRecord(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

/** sha256 over the stable startup-relevant configuration. */
export function computeConfigFingerprint(project: Project): string {
  return createHash('sha256').update(stableStringify(fingerprintPayload(project))).digest('hex');
}

/** True when the stored verification record matches the current configuration. */
export function isVerificationCurrent(project: Project): boolean {
  const v = project.verification;
  if (!v || v.status !== 'verified' || !v.configFingerprint) return false;
  return v.configFingerprint === computeConfigFingerprint(project);
}
