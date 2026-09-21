import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getComposeModel, dockerDaemonAvailable } from '../dist/docker.js';
import { buildStartPlan } from '../dist/graph.js';
import { verifyProject } from '../dist/verify.js';
import { saveProject, loadProject } from '../dist/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'compose');

function isolatedHome() {
  const home = mkdtempSync(join(tmpdir(), 'launcher-docker-test-'));
  const prev = process.env.LAUNCHER_HOME;
  process.env.LAUNCHER_HOME = home;
  return { restore: () => { if (prev === undefined) delete process.env.LAUNCHER_HOME; else process.env.LAUNCHER_HOME = prev; } };
}

test('compose model exposes the service graph from the fallback parser', () => {
  const model = getComposeModel(fixture);
  assert.ok(model);
  // `docker compose config` is client-side and works even without a daemon;
  // the fallback parser covers environments without the Docker CLI.
  assert.ok(model.source === 'docker-cli' || model.source === 'fallback-parser');
  const names = model.services.map((s) => s.name).sort();
  assert.deepEqual(names, ['app', 'db']);
  const app = model.services.find((s) => s.name === 'app');
  assert.deepEqual(app.dependsOn, ['db']);
  const plan = buildStartPlan(
    model.services.map((s) => ({ id: s.name, name: s.name, command: `docker compose up ${s.name}`, dependsOn: s.dependsOn })),
  );
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.order, ['db', 'app']);
});

test('compose fixture verifies end-to-end when a daemon is available', async (t) => {
  if (!dockerDaemonAvailable()) {
    t.skip('Docker daemon unavailable; compose lifecycle not attempted');
    return;
  }
  const img = spawnSync('docker', ['image', 'inspect', 'busybox:1'], { encoding: 'utf8', timeout: 15000 });
  if (img.status !== 0) {
    t.skip('busybox:1 image not present; refusing to pull images in tests');
    return;
  }
  const { restore } = isolatedHome();
  try {
    const project = {
      id: 'compose-fixture',
      name: 'compose-fixture',
      root: fixture,
      services: [
        {
          id: 'db',
          name: 'db',
          command: 'docker compose up db',
          cwd: '.',
          runtime: 'compose',
          port: 18081,
          healthCheck: { type: 'tcp', port: 18081, startPeriodMs: 30000 },
        },
        {
          id: 'app',
          name: 'app',
          command: 'docker compose up app',
          cwd: '.',
          runtime: 'compose',
          dependsOn: ['db'],
        },
      ],
    };
    saveProject(project);
    const result = await verifyProject(loadProject('compose-fixture'), {});
    assert.equal(result.ok, true);
    assert.equal(result.status, 'verified');
    assert.deepEqual(result.order, ['db', 'app']);
    // Leave no containers behind.
    const ps = spawnSync('docker', ['compose', '-f', join(fixture, 'docker-compose.yml'), 'ps', '-q'], { encoding: 'utf8', timeout: 15000 });
    assert.equal((ps.stdout || '').trim(), '');
  } finally {
    spawnSync('docker', ['compose', '-f', join(fixture, 'docker-compose.yml'), 'down', '--volumes'], { timeout: 30000 });
    restore();
  }
});
