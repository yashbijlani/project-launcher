import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStartPlan, validateProfile, withDependencies } from '../dist/graph.js';

function svc(id, dependsOn) {
  return { id, name: id, command: `echo ${id}`, dependsOn };
}

test('linear dependency order: C before B before A', () => {
  const services = [svc('a', ['b']), svc('b', ['c']), svc('c')];
  const plan = buildStartPlan(services);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.order, ['c', 'b', 'a']);
});

test('diamond dependency is deterministic', () => {
  const services = [svc('d', ['b', 'c']), svc('b', ['a']), svc('c', ['a']), svc('a')];
  const plan = buildStartPlan(services);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.order[0], 'a');
  assert.equal(plan.order[3], 'd');
});

test('detects cycles', () => {
  const services = [svc('a', ['b']), svc('b', ['a'])];
  const plan = buildStartPlan(services);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].kind, 'cycle');
  assert.ok(plan.errors[0].nodes.includes('a'));
  assert.ok(plan.errors[0].nodes.includes('b'));
});

test('detects missing dependencies', () => {
  const services = [svc('a', ['nope'])];
  const plan = buildStartPlan(services);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].kind, 'missing-dependency');
});

test('withDependencies expands transitively', () => {
  const services = [svc('a', ['b']), svc('b', ['c']), svc('c'), svc('z')];
  assert.deepEqual(withDependencies(services, ['a']), ['a', 'b', 'c']);
});

test('validateProfile flags unknown services', () => {
  const errors = validateProfile([svc('a')], ['a', 'ghost']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ghost/);
});
