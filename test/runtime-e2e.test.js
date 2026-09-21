import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { discover } from '../dist/discovery.js';
import { saveProject, loadProject } from '../dist/config.js';
import { verifyProject } from '../dist/verify.js';
import { ProjectManager } from '../dist/manager.js';
import { readState } from '../dist/state.js';
import { readProcessIdentity } from '../dist/proc.js';
import { isolatedHome, freePort } from './helpers.js';

function portOpen(port) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(2000);
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

test('end to end: discover, configure, verify, start, cross-CLI status and stop, cleanup', async (t) => {
  const { restore } = isolatedHome();
  const root = mkdtempSync(join(tmpdir(), 'launcher-e2e-proj-'));
  t.after(async () => {
    try {
      const p = loadProject('e2e-app');
      if (p) await new ProjectManager(p).stop();
    } catch { /* ignore */ }
    restore();
  });
  try {
    const port = await freePort();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'e2e-app', scripts: { dev: 'node server.mjs' }, dependencies: {} }));
    writeFileSync(join(root, 'server.mjs'), `import { createServer } from 'node:http';\ncreateServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1');\n`);

    // discover
    const outcome = discover(root, 'e2e-app');
    assert.ok(outcome.project.services.length > 0);
    assert.ok(outcome.targets.length > 0);

    // configure (as the user would after review: run node directly, no install)
    outcome.project.id = 'e2e-app';
    const svc = outcome.project.services[0];
    svc.command = 'node server.mjs';
    svc.port = port;
    svc.healthCheck = { type: 'tcp', port, startPeriodMs: 8000 };
    saveProject(outcome.project);

    // verify
    const verified = await verifyProject(loadProject('e2e-app'), {});
    assert.equal(verified.ok, true);
    assert.equal(verified.status, 'verified');

    // start
    const mgr = new ProjectManager(loadProject('e2e-app'));
    const started = await mgr.start({});
    assert.deepEqual(started.failed, []);
    assert.equal(await portOpen(port), true);

    // status from another "CLI process" (fresh manager reading persisted state)
    const other = new ProjectManager(loadProject('e2e-app'));
    const st = other.getState().services[svc.id];
    assert.ok(st && st.pid);
    const persisted = readState('e2e-app');
    assert.ok(persisted.services[svc.id].process);

    // stop from another "CLI process"
    const stopper = new ProjectManager(loadProject('e2e-app'));
    const stop = await stopper.stop();
    assert.ok(stop.stopped.includes(svc.id));
    assert.equal(await portOpen(port), false);
    assert.equal(readProcessIdentity(st.pid), null);
  } finally {
    restore();
  }
});
