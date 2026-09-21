import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import type { ProcessIdentity } from './types.js';

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read a Linux process identity from /proc.
 * Returns null when the process does not exist or /proc is unavailable.
 */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const stat = readText(`/proc/${pid}/stat`);
  if (!stat) return null;
  // stat: pid (comm) state ppid pgrp ... starttime is field 22 overall.
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const comm = stat.slice(stat.indexOf('(') + 1, close);
  const rest = stat.slice(close + 2).split(' ');
  // rest[0]=state, rest[1]=ppid, rest[2]=pgrp, ..., starttime is index 19 of rest.
  const pgid = Number(rest[2]);
  const startTimeTicks = Number(rest[19]);
  if (!Number.isFinite(startTimeTicks)) return null;

  const cmdline = readText(`/proc/${pid}/cmdline`);
  let exe: string | null;
  try {
    exe = readlinkSync(`/proc/${pid}/exe`);
  } catch {
    exe = null;
  }
  const fingerprint = createHash('sha256')
    .update(`${exe || ''}\0${cmdline || ''}`)
    .digest('hex');

  return {
    pid,
    pgid: Number.isFinite(pgid) ? pgid : undefined,
    startTimeTicks,
    comm,
    commandFingerprint: fingerprint,
  };
}

/**
 * True when the currently-observed process matches the persisted identity.
 *
 * The authoritative signal is the kernel process creation time
 * (`startTimeTicks`, /proc/<pid>/stat field 22) combined with the PID. It is
 * stable across `exec` (bash -lc often execs its command, changing comm/exe)
 * and it changes when a PID is reused by an unrelated process.
 *
 * `commandFingerprint` is recorded for diagnostics only and is never allowed to
 * be the sole reason to reject a match.
 */
export function identityMatches(expected: ProcessIdentity | undefined, actual: ProcessIdentity | null): boolean {
  if (!expected?.pid || !actual) return false;
  if (actual.pid !== expected.pid) return false;
  if (expected.startTimeTicks === undefined || actual.startTimeTicks === undefined) {
    // Without a creation timestamp we cannot safely distinguish PID reuse.
    return false;
  }
  return actual.startTimeTicks === expected.startTimeTicks;
}

export function commandFingerprintFor(exe: string | null, cmdline: string | null): string {
  return createHash('sha256').update(`${exe || ''}\0${cmdline || ''}`).digest('hex');
}
