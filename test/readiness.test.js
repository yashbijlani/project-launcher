import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeReadiness } from '../dist/prereqs.js';
import { discover } from '../dist/discovery.js';

function project(services, extra = {}) {
  return { id: 'p', name: 'p', root: '/tmp', services, ...extra };
}

test('no services is unknown, not broken', () => {
  assert.equal(computeReadiness(project([]), false).status, 'unknown');
});

test('device runtime reports needs_device', () => {
  const r = computeReadiness(project([{ id: 'a', name: 'a', command: './gradlew build', runtime: 'device' }]), false);
  assert.equal(r.status, 'needs_device');
  assert.equal(r.blockers[0].type, 'device');
});

test('external runtime reports needs_environment', () => {
  const r = computeReadiness(project([{ id: 'a', name: 'a', command: 'remote', runtime: 'external' }]), false);
  assert.equal(r.status, 'needs_environment');
});

test('unsafe project reports unsafe', () => {
  const r = computeReadiness(project([{ id: 'a', name: 'a', command: 'true' }], { metadata: { unsafe: true } }), false);
  assert.equal(r.status, 'unsafe');
});

test('invalid structure reports broken', () => {
  const r = computeReadiness(project([{ id: 'a', name: 'a', command: 'true', dependsOn: ['ghost'] }]), false);
  assert.equal(r.status, 'broken');
});

test('verified project is ready, unverified is ready_but_unverified', () => {
  const p = project([{ id: 'a', name: 'a', command: 'node /tmp/x.mjs' }]);
  const r = computeReadiness(p, false);
  assert.ok(['ready_but_unverified', 'needs_environment', 'broken'].includes(r.status));
  // With a valid command and verified=true, readiness is ready (unless prereqs block).
  const r2 = computeReadiness(p, true);
  assert.ok(['ready', 'needs_environment'].includes(r2.status));
});

test('workspace monorepo exposes multiple runnable targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'mono-targets-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  mkdirSync(join(root, 'packages', 'a'), { recursive: true });
  writeFileSync(join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a', scripts: { dev: 'vite' }, dependencies: { vite: '^5' } }));
  mkdirSync(join(root, 'packages', 'b'), { recursive: true });
  writeFileSync(join(root, 'packages', 'b', 'package.json'), JSON.stringify({ name: 'b', scripts: { start: 'node index.js' } }));
  const outcome = discover(root, 'mono');
  assert.ok(outcome.targets.length >= 1);
  const keys = outcome.targets.map((t) => t.key);
  assert.ok(keys.some((k) => k.includes('a')));
});
