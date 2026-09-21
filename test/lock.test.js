import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { acquireLock, releaseLock, readLock, lockOwnerAlive, heartbeatLock } from '../dist/lock.js';
import { readProcessIdentity } from '../dist/proc.js';

const here = dirname(fileURLToPath(import.meta.url));
const lockModuleUrl = new URL('../dist/lock.js', import.meta.url).href;

function isolatedHome() {
  const home = mkdtempSync(join(tmpdir(), 'launcher-lock-test-'));
  const prev = process.env.LAUNCHER_HOME;
  process.env.LAUNCHER_HOME = home;
  return { home, restore: () => { if (prev === undefined) delete process.env.LAUNCHER_HOME; else process.env.LAUNCHER_HOME = prev; } };
}

function waitForFile(path, timeoutMs = 5000) {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

/** A child launcher process that holds a lock, simulating a second terminal. */
function spawnLockHolder(home, projectId, holdMs = 8000) {
  const script = `
    import(${JSON.stringify(lockModuleUrl)}).then((m) => {
      const r = m.acquireLock(${JSON.stringify(projectId)}, 'start');
      if (!r.ok) { console.error('child could not acquire'); process.exit(2); }
      setInterval(() => m.heartbeatLock(r.lock), 1000).unref();
      setTimeout(() => {}, ${holdMs});
    });
  `;
  return spawn('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, LAUNCHER_HOME: home },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

test('two launcher processes cannot both own one project', async () => {
  const { home, restore } = isolatedHome();
  let child = null;
  try {
    child = spawnLockHolder(home, 'proj-a');
    waitForFile(join(home, 'locks', 'proj-a.lock'));
    const second = acquireLock('proj-a', 'start');
    assert.equal(second.ok, false);
    assert.ok(second.busy);
    assert.match(second.busyReason || '', /already owned/);
    assert.match(second.busyReason || '', new RegExp(String(child.pid)));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    const third = acquireLock('proj-a', 'start');
    assert.equal(third.ok, true);
    assert.equal(third.recoveredStale, true);
    releaseLock(third.lock);
  } finally {
    try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    restore();
  }
});

test('same-process nested acquisition is re-entrant', () => {
  const { restore } = isolatedHome();
  try {
    const first = acquireLock('proj-nested', 'verify');
    assert.equal(first.ok, true);
    const second = acquireLock('proj-nested', 'start');
    assert.equal(second.ok, true);
    assert.equal(second.lock.instanceId, first.lock.instanceId);
    releaseLock(second.lock);
    // Still held after one release...
    assert.ok(readLock('proj-nested'));
    releaseLock(first.lock);
    assert.equal(readLock('proj-nested'), null);
  } finally {
    restore();
  }
});

test('stale lock from a dead owner is recovered safely', async () => {
  const { home, restore } = isolatedHome();
  try {
    mkdirSync(join(home, 'locks'), { recursive: true });
    // A PID that has definitely exited and been reaped (exit listener auto-reaps).
    const child = spawn('true', [], { stdio: 'ignore' });
    const deadPid = child.pid;
    await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(readProcessIdentity(deadPid), null);
    writeFileSync(join(home, 'locks', 'proj-stale.lock'), JSON.stringify({
      projectId: 'proj-stale',
      ownerPid: deadPid,
      instanceId: 'dead-instance',
      operation: 'start',
      createdAt: Date.now() - 60000,
      heartbeatAt: Date.now() - 60000,
    }));
    const r = acquireLock('proj-stale', 'start');
    assert.equal(r.ok, true);
    assert.equal(r.recoveredStale, true);
    releaseLock(r.lock);
  } finally {
    restore();
  }
});

test('PID reuse is detected via owner start-time mismatch', () => {
  const { home, restore } = isolatedHome();
  try {
    mkdirSync(join(home, 'locks'), { recursive: true });
    const me = readProcessIdentity(process.pid);
    assert.ok(me && me.startTimeTicks);
    writeFileSync(join(home, 'locks', 'proj-reuse.lock'), JSON.stringify({
      projectId: 'proj-reuse',
      ownerPid: process.pid, // alive, but claims a different start time
      ownerStartTimeTicks: (me.startTimeTicks || 0) + 999999,
      instanceId: 'impostor',
      operation: 'start',
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
    }));
    const existing = readLock('proj-reuse');
    assert.ok(existing);
    assert.equal(lockOwnerAlive(existing), false);
    const r = acquireLock('proj-reuse', 'start');
    assert.equal(r.ok, true);
    assert.equal(r.recoveredStale, true);
    releaseLock(r.lock);
  } finally {
    restore();
  }
});

test('expired heartbeat on a live owner is treated as stale', () => {
  const { home, restore } = isolatedHome();
  try {
    mkdirSync(join(home, 'locks'), { recursive: true });
    const me = readProcessIdentity(process.pid);
    writeFileSync(join(home, 'locks', 'proj-hb.lock'), JSON.stringify({
      projectId: 'proj-hb',
      ownerPid: process.pid,
      ownerStartTimeTicks: me?.startTimeTicks,
      instanceId: 'hung-instance',
      operation: 'start',
      createdAt: Date.now() - 120000,
      heartbeatAt: Date.now() - 120000,
    }));
    const r = acquireLock('proj-hb', 'start');
    assert.equal(r.ok, true);
    assert.equal(r.recoveredStale, true);
    releaseLock(r.lock);
  } finally {
    restore();
  }
});

test('release only removes our own lock', () => {
  const { restore } = isolatedHome();
  try {
    const first = acquireLock('proj-rel', 'start');
    assert.equal(first.ok, true);
    // A foreign release object must not remove it.
    releaseLock({ ...first.lock, instanceId: 'someone-else' });
    assert.ok(readLock('proj-rel'));
    releaseLock(first.lock);
    assert.equal(readLock('proj-rel'), null);
  } finally {
    restore();
  }
});

test('heartbeat keeps a live lock authoritative', () => {
  const { restore } = isolatedHome();
  try {
    const first = acquireLock('proj-hb2', 'start');
    assert.equal(first.ok, true);
    heartbeatLock(first.lock);
    // Same process re-acquires re-entrantly; the lock must still exist.
    const second = acquireLock('proj-hb2', 'start');
    assert.equal(second.ok, true);
    releaseLock(second.lock);
    releaseLock(first.lock);
    assert.equal(readLock('proj-hb2'), null);
  } finally {
    restore();
  }
});

test('lock dir is created on demand', () => {
  const { home, restore } = isolatedHome();
  try {
    const r = acquireLock('proj-mkdir', 'start');
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(home, 'locks')));
    releaseLock(r.lock);
  } finally {
    restore();
  }
});
