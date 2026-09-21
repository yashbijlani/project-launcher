import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeToOperate,
  isUnsafeAuthorized,
  resolveInsideRoot,
  validateProjectStructure,
  validateProjectPaths,
} from '../dist/safety.js';
import { computeConfigFingerprint, isVerificationCurrent } from '../dist/fingerprint.js';

function baseProject() {
  return {
    id: 'demo',
    name: 'demo',
    root: '/tmp/demo-root',
    services: [{ id: 'web', name: 'web', command: 'npm run dev' }],
  };
}

function unsafeProject() {
  return {
    ...baseProject(),
    metadata: { unsafe: true, unsafeReason: 'test target' },
  };
}

test('safe project passes the gate', () => {
  const d = assertSafeToOperate(baseProject(), { operation: 'start' });
  assert.equal(d.ok, true);
});

test('unsafe project is blocked without authorization', () => {
  const d = assertSafeToOperate(unsafeProject(), { operation: 'start' });
  assert.equal(d.ok, false);
  assert.ok(d.errors.some((e) => e.includes('UNSAFE TO AUTO-RUN')));
});

test('unsafe project passes with the CLI flag', () => {
  const d = assertSafeToOperate(unsafeProject(), { allowUnsafe: true, operation: 'start' });
  assert.equal(d.ok, true);
});

test('unsafe project passes with a well-formed approval', () => {
  assert.equal(isUnsafeAuthorized(unsafeProject(), false, { projectId: 'demo', reason: 'local testing only' }), true);
});

test('malformed approvals are rejected', () => {
  const p = unsafeProject();
  assert.equal(isUnsafeAuthorized(p, false, undefined), false);
  assert.equal(isUnsafeAuthorized(p, false, { projectId: 'demo', reason: '' }), false);
  assert.equal(isUnsafeAuthorized(p, false, { projectId: 'demo', reason: 'short' }), false);
  assert.equal(isUnsafeAuthorized(p, false, { projectId: 'other', reason: 'local testing only' }), false);
  assert.equal(isUnsafeAuthorized(p, false, null), false);
});

test('cwd traversal is rejected', () => {
  const p = baseProject();
  p.services[0].cwd = '../../etc';
  const errors = validateProjectStructure(p);
  assert.ok(errors.some((e) => e.includes('escapes the project root')));
  const r = resolveInsideRoot('/root/proj', '../../etc', 'service x cwd');
  assert.equal(r.ok, false);
});

test('absolute cwd outside the root is rejected', () => {
  const p = baseProject();
  p.services[0].cwd = '/etc';
  assert.ok(validateProjectStructure(p).some((e) => e.includes('escapes')));
});

test('cwd inside the root resolves', () => {
  const r = resolveInsideRoot('/root/proj', 'backend', 'service x cwd');
  assert.equal(r.ok, true);
  assert.equal(r.path, '/root/proj/backend');
});

test('invalid dependency references are structural errors', () => {
  const p = baseProject();
  p.services[0].dependsOn = ['ghost'];
  assert.ok(validateProjectStructure(p).some((e) => e.includes('unknown service')));
});

test('device and external runtimes cannot be auto-started', () => {
  const p = baseProject();
  p.services[0].runtime = 'device';
  const errors = validateProjectStructure(p);
  assert.ok(errors.some((e) => e.includes('cannot be auto-started')));
});

test('missing project root is a path error', () => {
  const errors = validateProjectPaths({ ...baseProject(), root: '/tmp/definitely-not-a-launcher-dir-xyz' });
  assert.ok(errors.some((e) => e.includes('does not exist')));
});

test('fingerprint is stable across key order and changes with commands', () => {
  const a = baseProject();
  const b = {
    id: 'demo',
    name: 'demo',
    root: '/tmp/demo-root',
    services: [{ command: 'npm run dev', name: 'web', id: 'web' }],
  };
  assert.equal(computeConfigFingerprint(a), computeConfigFingerprint(b));
  const c = baseProject();
  c.services[0].command = 'npm run preview';
  assert.notEqual(computeConfigFingerprint(a), computeConfigFingerprint(c));
  const d = baseProject();
  d.services[0].cwd = 'frontend';
  assert.notEqual(computeConfigFingerprint(a), computeConfigFingerprint(d));
});

test('verification is current only when the fingerprint matches', () => {
  const p = baseProject();
  assert.equal(isVerificationCurrent(p), false);
  p.verification = { status: 'verified', configFingerprint: computeConfigFingerprint(p) };
  assert.equal(isVerificationCurrent(p), true);
  p.services[0].command = 'npm run preview';
  assert.equal(isVerificationCurrent(p), false);
});

test('failed verification records are never current', () => {
  const p = baseProject();
  p.verification = { status: 'failed', configFingerprint: computeConfigFingerprint(p) };
  assert.equal(isVerificationCurrent(p), false);
});
