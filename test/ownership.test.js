import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ProjectManager } from '../dist/manager.js';
import { saveProject } from '../dist/config.js';
import { readProcessIdentity, identityMatches } from '../dist/proc.js';
import { readState, writeState } from '../dist/state.js';
import { isolatedHome, freePort, delay } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const echoService = join(here, 'fixtures', 'echo-service.mjs');

function sleepProject(id, port) {
  return {
    id,
    name: id,
    root: here,
    services: [
      {
        id: 'web',
        name: 'web',
        command: `node ${echoService} ${port}`,
        port,
        healthCheck: { type: 'tcp', port, startPeriodMs: 8000 },
      },
    ],
  };
}

test('duplicate start from a second manager does not spawn a duplicate tree', async (t) => {
  const { restore } = isolatedHome();
  const port = await freePort();
  const project = sleepProject('dup-start', port);
  t.after(async () => {
    try { await new ProjectManager(project).stop(); } catch { /* ignore */ }
    restore();
  });
  try {
    saveProject(project);
    const first = new ProjectManager(project);
    const r1 = await first.start({});
    assert.deepEqual(r1.failed, []);
    const pid1 = first.getState().services.web.pid;
    assert.ok(pid1);

    // A second manager (simulating a second CLI) must adopt, not duplicate.
    const second = new ProjectManager(project);
    const r2 = await second.start({});
    assert.deepEqual(r2.failed, []);
    const pid2 = second.getState().services.web.pid;
    assert.equal(pid2, pid1);

    const stopper = new ProjectManager(project);
    const stop = await stopper.stop();
    assert.deepEqual(stop.stopped, ['web']);
    assert.equal(readProcessIdentity(pid1), null);
  } finally {
    restore();
  }
});

test('stop from a fresh manager reclaims a verified orphan and cleans up', async (t) => {
  const { restore } = isolatedHome();
  const port = await freePort();
  const project = sleepProject('orphan-stop', port);
  t.after(async () => {
    try { await new ProjectManager(project).stop(); } catch { /* ignore */ }
    restore();
  });
  try {
    saveProject(project);
    const mgr = new ProjectManager(project);
    const r = await mgr.start({});
    assert.deepEqual(r.failed, []);
    const pid = mgr.getState().services.web.pid;
    assert.ok(pid);
    // Simulate the original CLI going away: use a brand new manager.
    const fresh = new ProjectManager(project);
    const stop = await fresh.stop();
    assert.deepEqual(stop.stopped, ['web']);
    assert.equal(readProcessIdentity(pid), null);
  } finally {
    restore();
  }
});

test('stop refuses to signal a PID that was reused by an unrelated process', async () => {
  const { restore } = isolatedHome();
  let squatter = null;
  try {
    const port = await freePort();
    const project = sleepProject('pid-reuse', port);
    saveProject(project);
    // An unrelated process whose PID we pretend to own, with a wrong identity.
    squatter = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
    squatter.unref();
    writeState({
      projectId: 'pid-reuse',
      name: 'pid-reuse',
      services: {
        web: {
          id: 'web',
          status: 'running',
          restarts: 0,
          pid: squatter.pid,
          process: { pid: squatter.pid, startTimeTicks: -1, commandFingerprint: 'wrong' },
        },
      },
    });
    const mgr = new ProjectManager(project);
    const stop = await mgr.stop();
    assert.deepEqual(stop.stopped, []);
    // The unrelated process must still be alive.
    assert.ok(readProcessIdentity(squatter.pid));
    const after = readState('pid-reuse');
    assert.equal(after.services.web.status, 'stopped');
  } finally {
    try { squatter?.kill('SIGKILL'); } catch { /* ignore */ }
    restore();
  }
});

test('restart loops are suppressed after max attempts', async () => {
  const { restore } = isolatedHome();
  const logs = [];
  try {
    const project = {
      id: 'restart-loop',
      name: 'restart-loop',
      root: here,
      services: [
        {
          id: 'flaky',
          name: 'flaky',
          command: 'node -e "process.exit(1)"',
          restartPolicy: 'on-failure',
          restartMaxAttempts: 2,
          restartBackoffMs: 100,
        },
      ],
    };
    saveProject(project);
    const mgr = new ProjectManager(project);
    mgr.on('log', (l) => logs.push(l.line));
    await mgr.start({ waitHealthy: false });
    await delay(2500);
    assert.ok(logs.some((l) => l.includes('restart loop suppressed')), `logs: ${logs.join(' | ')}`);
    assert.equal(mgr.getState().services.flaky.status, 'failed');
    await mgr.stop();
  } finally {
    restore();
  }
});

test('identity matching distinguishes our process from strangers', () => {
  const me = readProcessIdentity(process.pid);
  assert.ok(me);
  assert.equal(identityMatches(me, readProcessIdentity(process.pid)), true);
  assert.equal(identityMatches({ ...me, startTimeTicks: (me.startTimeTicks || 0) + 1 }, readProcessIdentity(process.pid)), false);
  assert.equal(identityMatches(me, null), false);
  assert.equal(identityMatches(undefined, readProcessIdentity(process.pid)), false);
});
