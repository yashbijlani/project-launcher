import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompose } from '../dist/detectors/docker.js';
import { inferDevPort } from '../dist/detectors/node.js';
import { MonorepoDetector, UnsafeProjectDetector } from '../dist/detectors/others.js';
import { PythonDetector } from '../dist/detectors/python.js';
import { buildContext } from '../dist/detectors/index.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parses compose services, ports and depends_on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-'));
  const path = join(dir, 'docker-compose.yml');
  writeFileSync(
    path,
    `services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
  backend:
    build: .
    depends_on:
      - db
  worker:
    build: .
    depends_on:
      - db
`,
  );
  const parsed = parseCompose(path);
  assert.deepEqual(parsed.services.map((s) => s.name), ['db', 'backend', 'worker']);
  assert.deepEqual(parsed.services[0].ports, ['5432:5432']);
  assert.deepEqual(parsed.services[1].dependsOn, ['db']);
  assert.equal(parsed.services[1].build, true);
  assert.equal(parsed.services[0].image, 'postgres:16');
});

test('infers vite/next dev ports', () => {
  assert.equal(inferDevPort({ vite: '^5' }, 'vite'), 5173);
  assert.equal(inferDevPort({ next: '14' }, 'next dev'), 3000);
  assert.equal(inferDevPort({}, 'vite --port 4444'), 4444);
  assert.equal(inferDevPort({}, 'node server.js'), undefined);
});

test('marks a pnpm workspace without a root start command as a monorepo', () => {
  const root = mkdtempSync(join(tmpdir(), 'monorepo-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  const detector = new MonorepoDetector();
  const result = detector.detect(buildContext(root));
  assert.equal(result.type, 'MonorepoDetector');
  assert.equal(result.meta.monorepo, true);
  assert.equal(result.meta.rootService, false);
});

test('does not invent a uvicorn module object from a dependency alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'python-fallback-'));
  mkdirSync(join(root, 'demo'));
  writeFileSync(join(root, 'demo', 'requirements.txt'), 'uvicorn==0.30.1\n');
  writeFileSync(join(root, 'demo', 'README.md'), 'Run with `python main.py`.');
  writeFileSync(join(root, 'demo', 'main.py'), 'from framework import *\n\nserve()\n');
  const detector = new PythonDetector();
  const result = detector.detect(buildContext(root));
  assert.ok(result.candidates.length > 0);
  assert.ok(result.candidates.every((c) => c.command === 'python3 main.py'));
});

test('marks an explicitly vulnerable local target as unsafe', () => {
  const root = mkdtempSync(join(tmpdir(), 'unsafe-target-'));
  writeFileSync(
    join(root, 'serve.py'),
    '"""Intentionally vulnerable. Run locally only."""\n\nprint("demo")\n',
  );
  const detector = new UnsafeProjectDetector();
  const result = detector.detect(buildContext(root));
  assert.ok(result);
  assert.equal(result.meta.unsafe, true);
});
