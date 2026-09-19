import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeProjectState, ServiceStatus } from './types.js';
import { stateDir } from './paths.js';

export interface SupervisorLease {
  projectId: string;
  supervisorPid: number;
  startedAt: number;
  /** serviceId -> pid of the process-group leader we own */
  processes: Record<string, number>;
}

function statePath(projectId: string): string {
  return join(stateDir(), `${projectId}.json`);
}

function leasePath(projectId: string): string {
  return join(stateDir(), `${projectId}.lease.json`);
}

function ensure(): void {
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
}

export function writeState(state: RuntimeProjectState): void {
  ensure();
  writeFileSync(statePath(state.projectId), JSON.stringify(state, null, 2));
}

export function readState(projectId: string): RuntimeProjectState | null {
  const p = statePath(projectId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RuntimeProjectState;
  } catch {
    return null;
  }
}

export function clearState(projectId: string): void {
  const p = statePath(projectId);
  if (existsSync(p)) writeFileSync(p, JSON.stringify({ projectId, services: {} }, null, 2));
}

export function writeLease(lease: SupervisorLease): void {
  ensure();
  writeFileSync(leasePath(lease.projectId), JSON.stringify(lease, null, 2));
}

export function readLease(projectId: string): SupervisorLease | null {
  const p = leasePath(projectId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SupervisorLease;
  } catch {
    return null;
  }
}

export function removeLease(projectId: string): void {
  const p = leasePath(projectId);
  if (existsSync(p)) {
    try {
      writeFileSync(p, '');
    } catch {
      /* ignore */
    }
  }
}

export function listStates(): RuntimeProjectState[] {
  ensure();
  return readdirSync(stateDir())
    .filter((f) => f.endsWith('.json') && !f.endsWith('.lease.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(stateDir(), f), 'utf8')) as RuntimeProjectState;
      } catch {
        return null;
      }
    })
    .filter((s): s is RuntimeProjectState => s !== null);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function mergeServiceStatus(
  state: RuntimeProjectState,
  id: string,
  patch: Partial<{ status: ServiceStatus; pid: number; startedAt: number; stoppedAt: number; exitCode: number | null; signal: string | null; restarts: number }>,
): void {
  const prev = state.services[id] || { id, status: 'stopped', restarts: 0 };
  state.services[id] = { ...prev, ...patch };
}
