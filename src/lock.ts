import { existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launcherHome } from './paths.js';
import { readProcessIdentity } from './proc.js';

export interface ProjectLock {
  projectId: string;
  /** PID of the launcher process holding the lock. */
  ownerPid: number;
  /** Start-time ticks of the owner, used to detect PID reuse. */
  ownerStartTimeTicks?: number;
  /** Unique launcher instance id. */
  instanceId: string;
  operation: string;
  createdAt: number;
  heartbeatAt: number;
}

export interface AcquireResult {
  ok: boolean;
  lock?: ProjectLock;
  busy?: ProjectLock;
  busyReason?: string;
  recoveredStale?: boolean;
}

/** Locks live outside the state dir so they survive state rewrites. */
export function lockDir(): string {
  return join(launcherHome(), 'locks');
}

function lockPath(projectId: string): string {
  return join(lockDir(), `${projectId}.lock`);
}

/**
 * In-process re-entrancy: the same launcher process may hold a project lock
 * across nested operations (e.g. verify -> start -> stop). The file lock still
 * guarantees mutual exclusion across processes; the depth counter only tracks
 * nesting within this process.
 */
const activeLocks = new Map<string, { lock: ProjectLock; depth: number }>();

function ensureLockDir(): void {
  if (!existsSync(lockDir())) mkdirSync(lockDir(), { recursive: true });
}

function readLockFile(path: string): ProjectLock | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProjectLock;
  } catch {
    return null;
  }
}

/** A lock is only authoritative when its owner is provably alive and fresh. */
export function lockOwnerAlive(lock: ProjectLock, maxHeartbeatAgeMs = 30_000): boolean {
  const identity = readProcessIdentity(lock.ownerPid);
  if (!identity) return false;
  if (lock.ownerStartTimeTicks !== undefined && identity.startTimeTicks !== lock.ownerStartTimeTicks) {
    return false; // PID was reused by an unrelated process.
  }
  if (Date.now() - lock.heartbeatAt > maxHeartbeatAgeMs) return false;
  return true;
}

/**
 * Atomically acquire the per-project lock using O_EXCL creation.
 * If a stale lock exists (dead owner, reused PID, or expired heartbeat),
 * it is quarantined and acquisition is retried once.
 */
export function acquireLock(projectId: string, operation: string, opts: { heartbeatIntervalMs?: number } = {}): AcquireResult {
  ensureLockDir();
  const path = lockPath(projectId);
  const ownerIdentity = readProcessIdentity(process.pid);
  const candidate: ProjectLock = {
    projectId,
    ownerPid: process.pid,
    ownerStartTimeTicks: ownerIdentity?.startTimeTicks,
    instanceId: randomUUID(),
    operation,
    createdAt: Date.now(),
    heartbeatAt: Date.now(),
  };

  const tryCreate = (): boolean => {
    let fd = -1;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(candidate, null, 2));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    } finally {
      if (fd !== -1) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  };

  if (tryCreate()) {
    activeLocks.set(projectId, { lock: candidate, depth: 1 });
    return { ok: true, lock: candidate };
  }

  const existing = readLockFile(path);
  if (!existing) {
    // Raced with a release; retry once.
    if (tryCreate()) {
      activeLocks.set(projectId, { lock: candidate, depth: 1 });
      return { ok: true, lock: candidate };
    }
    return { ok: false, busyReason: 'lock contention' };
  }
  if (lockOwnerAlive(existing, opts.heartbeatIntervalMs ? opts.heartbeatIntervalMs * 3 : 30_000)) {
    // Re-entrant: we already hold this lock in this process (verify -> start).
    const active = activeLocks.get(projectId);
    if (active && active.lock.instanceId === existing.instanceId) {
      active.depth += 1;
      return { ok: true, lock: active.lock };
    }
    return {
      ok: false,
      busy: existing,
      busyReason: `Project already owned by launcher instance ${existing.instanceId} (pid ${existing.ownerPid}, operation ${existing.operation})`,
    };
  }
  // Stale: quarantine then retry once.
  try {
    renameSync(path, `${path}.stale-${Date.now()}`);
  } catch {
    return { ok: false, busyReason: 'could not recover stale lock' };
  }
  if (tryCreate()) {
    activeLocks.set(projectId, { lock: candidate, depth: 1 });
    return { ok: true, lock: candidate, recoveredStale: true };
  }
  return { ok: false, busyReason: 'lock contention after stale recovery' };
}

/** Refresh the heartbeat so concurrent invocations see a live owner. */
export function heartbeatLock(lock: ProjectLock): void {
  const path = lockPath(lock.projectId);
  const current = readLockFile(path);
  // Only heartbeat our own lock (same instance id).
  if (!current || current.instanceId !== lock.instanceId) return;
  lock.heartbeatAt = Date.now();
  try {
    writeFileSync(path, JSON.stringify(lock, null, 2));
  } catch {
    /* ignore */
  }
}

/** Release only if we still own it. Nested holders decrement the depth. */
export function releaseLock(lock: ProjectLock): void {
  const path = lockPath(lock.projectId);
  const current = readLockFile(path);
  // A foreign instance id must never release (or disturb bookkeeping for) our lock.
  if (current && current.instanceId !== lock.instanceId) return;
  const active = activeLocks.get(lock.projectId);
  if (active && active.lock.instanceId === lock.instanceId && active.depth > 1) {
    active.depth -= 1;
    return;
  }
  activeLocks.delete(lock.projectId);
  if (!current) return;
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

export function readLock(projectId: string): ProjectLock | null {
  ensureLockDir();
  return readLockFile(lockPath(projectId));
}

/** Start a heartbeat timer; caller must clear it. Returns a stop function. */
export function startHeartbeat(lock: ProjectLock, intervalMs = 5000): () => void {
  const timer = setInterval(() => heartbeatLock(lock), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
