import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Service } from './types.js';
import { slugify } from './config.js';
import { runtimeDir } from './paths.js';

/**
 * Phase 19: opt-in "learn from manual startup".
 *
 * We deliberately do NOT record global shell history or hook bash. Instead the
 * user runs:
 *
 *   launcher learn /code/project
 *
 * which snapshots the set of processes/cwd/ports before and after the user
 * performs their normal startup in another terminal, then diffs them. This is
 * opt-in, scoped to a short window, and never persists raw commands from
 * unrelated shells.
 */

export interface ObservedProcess {
  pid: number;
  ppid: number;
  command: string;
  cwd?: string;
}

export interface LearnSession {
  projectId: string;
  root: string;
  startedAt: number;
  baseline: ObservedProcess[];
}

export interface LearnedStep {
  command: string;
  cwd?: string;
}

const SESSION_FILE = (id: string): string => join(runtimeDir(), `${id}.learn.json`);

export function listProcesses(): ObservedProcess[] {
  // Uses /proc on Linux. Read-only.
  const result: ObservedProcess[] = [];
  try {
    const pids = readdirSync('/proc').filter((f: string) => /^\d+$/.test(f));
    for (const pidStr of pids) {
      const pid = Number(pidStr);
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
        const cwdLink = `/proc/${pid}/cwd`;
        let cwd: string | undefined;
        try {
          cwd = readlinkSync(cwdLink);
        } catch {
          cwd = undefined;
        }
        // stat format: pid (comm) state ppid ...
        const close = stat.lastIndexOf(')');
        const rest = stat.slice(close + 2).split(' ');
        const ppid = Number(rest[1]);
        if (!cmdline) continue;
        result.push({ pid, ppid, command: cmdline, cwd });
      } catch {
        /* kernel thread or gone */
      }
    }
  } catch {
    /* non-linux */
  }
  return result;
}

/** Services started by the launcher itself must be excluded from learning. */
export function excludeLauncherOwned(procs: ObservedProcess[], ownedPids: number[]): ObservedProcess[] {
  const owned = new Set(ownedPids);
  return procs.filter((p) => !owned.has(p.pid) && !owned.has(p.ppid));
}

export function startLearnSession(root: string, projectId: string): LearnSession {
  if (!existsSync(runtimeDir())) mkdirSync(runtimeDir(), { recursive: true });
  const session: LearnSession = {
    projectId,
    root,
    startedAt: Date.now(),
    baseline: listProcesses().filter((p) => p.cwd?.startsWith(root)),
  };
  writeFileSync(SESSION_FILE(projectId), JSON.stringify(session, null, 2));
  return session;
}

export interface LearnResult {
  project: Project;
  steps: LearnedStep[];
  newProcesses: ObservedProcess[];
}

export function finishLearnSession(session: LearnSession, name: string): LearnResult {
  const now = listProcesses().filter((p) => p.cwd?.startsWith(session.root));
  const before = new Set(session.baseline.map((p) => p.pid));
  const newProcesses = now.filter((p) => !before.has(p.pid));

  // Reduce to one representative command per (command,cwd) to avoid duplicates from forks.
  const seen = new Set<string>();
  const steps: LearnedStep[] = [];
  for (const p of newProcesses) {
    const key = `${p.command}@${p.cwd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({ command: p.command, cwd: p.cwd });
  }

  const services: Service[] = steps.map((s, i) => ({
    id: slugify(`${guessRole(s.command)}-${i + 1}`),
    name: guessRole(s.command),
    command: s.command,
    cwd: s.cwd && s.cwd !== session.root && s.cwd.startsWith(session.root) ? s.cwd.slice(session.root.length + 1) : undefined,
    restartPolicy: 'never',
    notes: 'Observed via `launcher learn` (user-approved).',
  }));

  const project: Project = {
    id: slugify(name),
    name,
    root: session.root,
    services,
    metadata: { source: 'learned', discoveredAt: new Date().toISOString() },
  };
  return { project, steps, newProcesses };
}

function guessRole(cmd: string): string {
  if (/uvicorn|gunicorn|flask|django|manage\.py/.test(cmd)) return 'backend';
  if (/vite|next|nuxt|react-scripts|webpack/.test(cmd)) return 'frontend';
  if (/worker|celery|queue|scheduler/.test(cmd)) return 'worker';
  if (/docker\s+compose/.test(cmd)) return 'stack';
  return 'service';
}

export function sessionFileFor(projectId: string): string {
  return SESSION_FILE(projectId);
}

export function readLearnSession(projectId: string): LearnSession | null {
  const p = SESSION_FILE(projectId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LearnSession;
  } catch {
    return null;
  }
}
