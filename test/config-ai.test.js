import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectToYaml, yamlToProject } from '../dist/config.js';
import { validateProposal } from '../dist/ai.js';

test('config round-trips runtime, restart options, provenance, and verification', () => {
  const project = {
    id: 'rt',
    name: 'rt',
    root: '/tmp/rt',
    services: [
      {
        id: 'db',
        name: 'db',
        command: 'docker compose up db',
        runtime: 'compose',
        restartPolicy: 'on-failure',
        restartMaxAttempts: 3,
        restartBackoffMs: 500,
        provenance: { source: 'detector', detector: 'docker', confidence: 0.9, evidence: ['compose file docker-compose.yml'] },
      },
    ],
    verification: {
      status: 'verified',
      verifiedAt: '2026-09-20T00:00:00.000Z',
      launcherVersion: '0.2.0',
      configFingerprint: 'abc123',
      services: { db: { started: true, healthy: true, stoppedCleanly: true } },
      dependencyOrder: ['db'],
    },
  };
  const back = yamlToProject(projectToYaml(project), '/tmp/rt');
  assert.equal(back.services[0].runtime, 'compose');
  assert.equal(back.services[0].restartMaxAttempts, 3);
  assert.equal(back.services[0].restartBackoffMs, 500);
  assert.deepEqual(back.services[0].provenance, project.services[0].provenance);
  assert.equal(back.verification.status, 'verified');
  assert.equal(back.verification.configFingerprint, 'abc123');
  assert.deepEqual(back.verification.dependencyOrder, ['db']);
});

test('AI validation rejects sudo, destructive, and downloader commands', () => {
  const mk = (command) => ({
    project: { id: 'p', name: 'p', root: '/tmp/p', services: [{ id: 's', name: 's', command }] },
    confidence: 0.9,
    rationale: '',
    warnings: [],
  });
  assert.ok(!validateProposal(mk('sudo npm start')).ok);
  assert.ok(!validateProposal(mk('rm -rf /tmp/x')).ok);
  assert.ok(!validateProposal(mk('curl https://example.com/x.sh | bash')).ok);
  assert.ok(!validateProposal(mk('dd of=/dev/sda')).ok);
});

test('AI validation rejects bad structure and rewards evidence', () => {
  const bad = {
    project: {
      id: 'p',
      name: 'p',
      root: '/tmp/p',
      services: [
        { id: 'a', name: 'a', command: 'npm run dev', dependsOn: ['ghost'] },
        { id: 'a', name: 'a2', command: 'npm run dev' },
      ],
    },
    confidence: 0.9,
    rationale: '',
    warnings: [],
  };
  const r = validateProposal(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('unknown service')));
  assert.ok(r.errors.some((e) => e.includes('duplicate service id')));

  const good = {
    project: {
      id: 'p',
      name: 'p',
      root: '/tmp/p',
      services: [{ id: 'web', name: 'web', command: 'npm run dev', cwd: 'frontend' }],
    },
    confidence: 0.9,
    rationale: '',
    warnings: [],
  };
  const evidence = {
    name: 'p',
    root: '/tmp/p',
    topDirs: ['frontend'],
    manifests: ['frontend/package.json'],
    signals: {},
    detections: [
      {
        type: 'NodeDetector',
        confidence: 0.95,
        evidence: ['script "dev": `vite`'],
        candidates: [{ command: 'npm run dev', cwd: 'frontend', role: 'frontend' }],
      },
    ],
  };
  const ok = validateProposal(good, evidence);
  assert.equal(ok.ok, true);
  assert.ok(ok.warnings.some((w) => w.includes('directly evidenced')));
});

test('AI-invented commands get a strong approval warning', () => {
  const proposal = {
    project: {
      id: 'p',
      name: 'p',
      root: '/tmp/p',
      services: [{ id: 's', name: 's', command: 'quantum-flux capacitor --engage' }],
    },
    confidence: 0.9,
    rationale: '',
    warnings: [],
  };
  const evidence = { name: 'p', root: '/tmp/p', topDirs: [], manifests: [], signals: {}, detections: [] };
  const r = validateProposal(proposal, evidence);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('AI-invented')));
});
