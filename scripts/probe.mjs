#!/usr/bin/env node
// Phase 3 helper: bounded, deterministic signal extraction.
// Reads only known manifest files + first N lines of README. Never recurses into heavy dirs.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const corpus = process.argv[2] || '/home/penguin/code';
const out = process.argv[3] || join(process.cwd(), 'signals.json');
const inventory = JSON.parse(readFileSync(join(process.cwd(), 'inventory.json'), 'utf8'));
const README_LINES = 60;

function tryRead(p, maxBytes = 200_000) {
  try { return readFileSync(p, 'utf8').slice(0, maxBytes); } catch { return null; }
}
function readFirstLines(p, n) {
  const t = tryRead(p);
  if (!t) return null;
  return t.split('\n').slice(0, n).join('\n');
}
function findFile(root, name, depth = 2) {
  // BFS limited
  let level = [root];
  for (let d = 0; d <= depth; d++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.env.example') continue;
        const full = join(dir, e.name);
        if (e.isFile() && e.name === name) return full;
        if (e.isDirectory()) {
          const skip = ['.git','node_modules','.venv','venv','__pycache__','dist','build','target','.gradle','.dart_tool','.next','.cache','vendor','.pnpm-store','Pods'];
          if (!skip.includes(e.name)) next.push(full);
        }
      }
    }
    level = next;
    if (!level.length) break;
  }
  return null;
}

function extractPackageJson(p) {
  const t = tryRead(p, 500_000);
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    return {
      name: j.name,
      scripts: j.scripts || {},
      dependencies: Object.keys(j.dependencies || {}),
      devDependencies: Object.keys(j.devDependencies || {}),
      workspaces: j.workspaces ? (Array.isArray(j.workspaces) ? j.workspaces : j.workspaces.packages) : null,
      packageManager: j.packageManager || null,
      main: j.main,
      type: j.type,
    };
  } catch { return { parse_error: true }; }
}

function extractCompose(p) {
  const t = tryRead(p);
  if (!t) return null;
  // lightweight: capture top-level service names and image/build and ports
  const services = {};
  const lines = t.split('\n');
  let inServices = false, svcIndent = 0, current = null;
  const serviceRe = /^(\s{2,})([A-Za-z0-9_.-]+):\s*$/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^services:\s*$/.test(trimmed)) { inServices = true; continue; }
    if (/^[A-Za-z]/.test(line) && inServices && !/^services:/.test(trimmed)) { inServices = false; current = null; continue; }
    if (!inServices) continue;
    const m = line.match(serviceRe);
    if (m && m[1].length === 2) { current = m[2]; services[current] = { image: null, build: null, ports: [], depends_on: [] }; continue; }
    if (!current) continue;
    if (/^\s+image:\s*(.+)$/.test(line)) services[current].image = line.match(/image:\s*(.+)/)[1].trim();
    if (/^\s+build:/.test(line)) services[current].build = true;
    if (/^\s+-\s*"?\d+:\d+/.test(line)) services[current].ports.push(trimmed.replace(/^-\s*/, '').replace(/"/g, ''));
    if (/^\s+-\s*([A-Za-z0-9_.-]+)\s*$/.test(line) && /depends_on/.test(lines[lines.indexOf(line)-1] || '')) services[current].depends_on.push(trimmed.replace(/^-\s*/, ''));
  }
  return { services, raw_length: t.length };
}

function extractPy(p) {
  const t = tryRead(p);
  if (!t) return null;
  const scripts = {};
  const deps = [];
  // naive: [project.scripts] / [project] dependencies
  const m = t.match(/\[project\.scripts\]([\s\S]*?)(\n\[|$)/);
  if (m) for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["'](.+)["']/);
    if (mm) scripts[mm[1]] = mm[2];
  }
  const dm = t.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (dm) for (const d of dm[1].split(',')) { const s = d.trim().replace(/["']/g,'').split(/[<>=!\[]/)[0]; if (s) deps.push(s); }
  const fw = [];
  for (const k of ['fastapi','flask','django','uvicorn','gunicorn','streamlit','gradio','celery','sqlalchemy']) {
    if (t.toLowerCase().includes(k)) fw.push(k);
  }
  const names = [];
  if (t.includes('[tool.poetry]')) names.push('poetry');
  if (t.includes('[tool.uv]') || t.includes('[tool.uv.')) names.push('uv');
  if (t.includes('[build-system]')) names.push('build-system');
  return { scripts, dependencies: deps.slice(0, 40), frameworks: fw, tooling: names };
}

function extractRequirements(txt) {
  if (!txt) return null;
  const lines = txt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return { count: lines.length, packages: lines.map((l) => l.split(/[<>=!\[;]/)[0]).filter(Boolean).slice(0, 60) };
}

function extractMakefile(txt) {
  if (!txt) return null;
  const targets = [];
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.-]+):(?!=)/);
    if (m && !m[1].startsWith('.')) targets.push(m[1]);
  }
  return { targets };
}

function firstHeading(md) {
  if (!md) return null;
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

const result = [];
for (const p of inventory.projects) {
  if (p.name === 'project-launcher') continue;
  const root = p.path;
  const pkgPath = findFile(root, 'package.json', 2);
  const pyPath = findFile(root, 'pyproject.toml', 2);
  const reqPath = findFile(root, 'requirements.txt', 2);
  const composePath = findFile(root, 'docker-compose.yml', 2) || findFile(root, 'compose.yml', 2) ||
    findFile(root, 'docker-compose.yaml', 2) || findFile(root, 'compose.yaml', 2);
  const makePath = findFile(root, 'Makefile', 1);
  const readmePath = (p.readme_files || []).map((f) => join(root, f))[0];
  const procfilePath = findFile(root, 'Procfile', 1);
  const shScripts = [];
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.sh')) shScripts.push(e.name);
    }
  } catch {}

  result.push({
    name: p.name,
    root,
    android: p.android,
    docker_compose: p.docker_compose,
    package_manager: p.package_manager,
    top_dirs: p.top_dirs,
    manifests: p.manifests,
    readme_title: firstHeading(readFirstLines(readmePath, README_LINES)),
    readme_excerpt: readFirstLines(readmePath, README_LINES),
    package_json: pkgPath ? extractPackageJson(pkgPath) : null,
    package_json_path: pkgPath ? pkgPath.replace(root + '/', '') : null,
    pyproject: pyPath ? extractPy(pyPath) : null,
    pyproject_path: pyPath ? pyPath.replace(root + '/', '') : null,
    requirements: extractRequirements(reqPath ? tryRead(reqPath) : null),
    requirements_path: reqPath ? reqPath.replace(root + '/', '') : null,
    compose: composePath ? extractCompose(composePath) : null,
    compose_path: composePath ? composePath.replace(root + '/', '') : null,
    makefile: makePath ? extractMakefile(tryRead(makePath)) : null,
    procfile: procfilePath ? tryRead(procfilePath).split('\n').filter(Boolean) : null,
    shell_scripts: shScripts,
  });
}

import { writeFileSync } from 'node:fs';
writeFileSync(out, JSON.stringify(result, null, 2));
console.error(`Wrote ${out} for ${result.length} projects`);
