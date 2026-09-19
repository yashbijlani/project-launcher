#!/usr/bin/env node
// Phase 1: cheap, non-invasive inventory of a corpus directory.
// Enumerates immediate children only, plus a shallow (depth<=2) manifest probe.
// Never descends into heavy/ignored directories.
import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const corpus = process.argv[2] || '/home/penguin/code';
const outJson = process.argv[3] || join(process.cwd(), 'inventory.json');
const outMd = process.argv[4] || join(process.cwd(), 'INVENTORY.md');

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'target', '.gradle', '.dart_tool', '.next', '.cache', '.turbo', '.mypy_cache',
  '.pytest_cache', 'coverage', '.idea', '.vscode', 'vendor', '.tox', '.pnpm-store',
  'Pods', '.expo', 'out', '.parcel-cache', 'htmlcov', '.ruff_cache',
]);

const MANIFESTS = [
  'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  'pyproject.toml', 'requirements.txt', 'uv.lock', 'Pipfile', 'poetry.lock',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'Dockerfile', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
  'pubspec.yaml', 'Makefile', 'taskfile.yml', 'Taskfile.yml', 'Taskfile.yaml',
  'Gemfile', 'composer.json', 'CMakeLists.txt', 'meson.build',
  'build.gradle.kts', 'settings.gradle.kts', 'settings.gradle', 'gradlew',
];

const LANG_EXT = new Map([
  ['.py', 'python'], ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.jsx', 'javascript'],
  ['.dart', 'dart'], ['.rs', 'rust'], ['.go', 'go'], ['.java', 'java'], ['.kt', 'kotlin'],
  ['.rb', 'ruby'], ['.php', 'php'], ['.cs', 'csharp'], ['.swift', 'swift'],
  ['.c', 'c'], ['.cpp', 'cpp'], ['.sh', 'shell'], ['.ipynb', 'jupyter'],
]);

function safeStat(p) {
  try { return statSync(p); } catch { return null; }
}

function listShallow(dir, depth = 0, maxDepth = 2, state) {
  const files = [];
  const dirs = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { files, dirs }; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example' && e.name !== '.env.sample') {
      continue;
    }
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      dirs.push(e.name);
      if (depth < maxDepth) {
        const sub = listShallow(join(dir, e.name), depth + 1, maxDepth, state);
        for (const f of sub.files) files.push(join(e.name, f));
      }
    } else if (e.isFile()) {
      files.push(e.name);
    }
  }
  return { files, dirs };
}

function detectLanguages(projectPath, topFiles, state) {
  const langs = new Map();
  let entries;
  try { entries = readdirSync(projectPath, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      // one level deep only, count extensions
      let sub;
      try { sub = readdirSync(join(projectPath, e.name), { withFileTypes: true }); } catch { continue; }
      for (const se of sub) {
        if (!se.isFile()) continue;
        const ext = se.name.includes('.') ? '.' + se.name.split('.').pop() : '';
        const l = LANG_EXT.get(ext);
        if (l) langs.set(l, (langs.get(l) || 0) + 1);
      }
    } else if (e.isFile()) {
      const ext = e.name.includes('.') ? '.' + e.name.split('.').pop() : '';
      const l = LANG_EXT.get(ext);
      if (l) langs.set(l, (langs.get(l) || 0) + 1);
    }
  }
  return [...langs.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
}

function detectPackageManager(projectPath, topFiles, nested) {
  const all = new Set([...topFiles, ...nested]);
  if (all.has('pnpm-lock.yaml') || all.has('pnpm-workspace.yaml')) return 'pnpm';
  if (all.has('yarn.lock')) return 'yarn';
  if (all.has('package-lock.json')) return 'npm';
  if (all.has('bun.lockb') || all.has('bun.lock')) return 'bun';
  if (existsSync(join(projectPath, 'uv.lock'))) return 'uv';
  if (existsSync(join(projectPath, 'poetry.lock'))) return 'poetry';
  if (existsSync(join(projectPath, 'Pipfile'))) return 'pipenv';
  return null;
}

function main() {
  if (!existsSync(corpus)) {
    console.error(`Corpus not found: ${corpus}`);
    process.exit(1);
  }
  const names = readdirSync(corpus, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();

  const projects = [];
  for (const name of names) {
    const root = join(corpus, name);
    const { files, dirs } = listShallow(root, 0, 2, {});
    const topEntries = readdirSync(root, { withFileTypes: true });
    const topFiles = topEntries.filter((e) => e.isFile()).map((e) => e.name);
    const topDirs = topEntries.filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name)).map((e) => e.name);
    const fileNameSet = new Set(files.map((f) => basename(f)));
    const manifests = MANIFESTS.filter((m) => topFiles.includes(m) || files.some((f) => basename(f) === m));
    const git = existsSync(join(root, '.git'));
    const readmes = topFiles.filter((f) => /^readme(\.|$)/i.test(f));
    const envs = topFiles.filter((f) => /^\.env/.test(f));
    const scripts = topFiles.filter((f) => f.endsWith('.sh'));
    const langs = detectLanguages(root, topFiles, {});
    const pm = detectPackageManager(root, topFiles, files);
    const dockerCompose = manifests.some((m) => /compose\.ya?ml$/.test(m));
    const dockerfile = manifests.includes('Dockerfile');
    const android = manifests.includes('build.gradle.kts') || manifests.includes('build.gradle') ||
      manifests.includes('settings.gradle.kts') || manifests.includes('settings.gradle') ||
      topFiles.includes('gradlew');
    const codeManifests = manifests.filter((m) => !/gradle|gradlew/.test(m));
    const docsOnly = !git && codeManifests.length === 0 && !android &&
      topDirs.length === 0 &&
      !topFiles.some((f) => /\.(js|ts|py|dart|rs|go|java|kt|html)$/.test(f)) && !readmes.length;
    const kinds = [];
    if (android) kinds.push('android');
    if (dockerCompose) kinds.push('docker-compose');
    if (docsOnly) kinds.push('docs-only');

    projects.push({
      name, path: root, is_git: git,
      top_files: topFiles.sort(), top_dirs: topDirs.sort(),
      manifests, readme: readmes.length > 0, readme_files: readmes,
      env_files: envs, shell_scripts: scripts, languages: langs,
      package_manager: pm, docker_compose: dockerCompose, dockerfile,
      android, docs_only: docsOnly, kinds,
    });
  }

  const payload = { corpus, scanned_at: new Date().toISOString(), count: projects.length, projects };
  writeFileSync(outJson, JSON.stringify(payload, null, 2));

  // Markdown report
  let md = `# PROJECT INVENTORY\n\nCorpus: \`${corpus}\`\nProjects found: ${projects.length}\nScanned: ${payload.scanned_at}\n\n`;
  for (const p of projects) {
    const stack = p.languages.slice(0, 4).join(' + ') || (p.android ? 'android/kotlin' : 'unknown');
    const flags = p.kinds.slice();
    if (p.package_manager) flags.push(`pm=${p.package_manager}`);
    if (p.docker_compose) flags.push('docker-compose');
    if (p.dockerfile) flags.push('Dockerfile');
    if (p.readme) flags.push('README');
    if (p.env_files.length) flags.push(`env(${p.env_files.length})`);
    if (p.shell_scripts.length) flags.push(`sh(${p.shell_scripts.length})`);
    md += `## ${p.name}\n`;
    md += `- Path: \`${p.path}\`\n`;
    md += `- Git: ${p.is_git ? 'yes' : 'no'}\n`;
    md += `- Stack: ${stack}\n`;
    md += `- Manifests: ${p.manifests.join(', ') || '(none)'}\n`;
    md += `- Top dirs: ${p.top_dirs.slice(0, 12).join(', ') || '(none)'}\n`;
    md += `- Signals: ${flags.join(', ') || '(none)'}\n\n`;
  }
  writeFileSync(outMd, md);
  console.error(`Wrote ${outJson} and ${outMd} (${projects.length} projects)`);
}

main();
