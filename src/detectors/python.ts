import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import type { Detection, CandidateCommand } from '../types.js';
import type { Detector, DetectionContext } from './base.js';
import { relPath } from './base.js';

interface PySignals {
  frameworks: string[];
  hasUvicorn: boolean;
  asgiApp?: string;
  mainFile?: string;
  scripts: Record<string, string>;
  tooling: string[];
  scriptCandidates: string[];
  relativeImports?: boolean;
  /** Fully qualified module when relative-importing app files must run as a package. */
  packageModule?: string;
  /** Working directory (relative to project root) for packageModule; '' means project root. */
  packageCwdRel?: string;
}

function analyzePython(ctx: DetectionContext, dir: string): PySignals {
  const frameworks = new Set<string>();
  let hasUvicorn = false;
  const scripts: Record<string, string> = {};
  const tooling: string[] = [];

  const req = safeRead(join(dir, 'requirements.txt'));
  const reqTexts = req ? [req] : [];
  const pyproject = safeRead(join(dir, 'pyproject.toml'));
  const texts = [...reqTexts, pyproject || ''].join('\n').toLowerCase();
  for (const fw of ['fastapi', 'flask', 'django', 'streamlit', 'gradio', 'aiohttp', 'sanic', 'tornado']) {
    if (new RegExp(`(^|[^a-z])${fw}([^a-z]|$)`).test(texts)) frameworks.add(fw);
  }
  if (/\buvicorn\b/.test(texts)) hasUvicorn = true;
  if (/\[tool\.poetry\]/.test(pyproject || '')) tooling.push('poetry');
  if (/\[tool\.uv/.test(pyproject || '')) tooling.push('uv');
  if (/\[build-system\]/.test(pyproject || '')) tooling.push('build-system');
  if (existingFile(join(dir, 'uv.lock'))) tooling.push('uv.lock');
  if (existingFile(join(dir, 'poetry.lock'))) tooling.push('poetry.lock');
  if (existingFile(join(dir, 'Pipfile'))) tooling.push('pipenv');

  // find probable ASGI/WSGI app entrypoints
  let asgiApp: string | undefined;
  let mainFile: string | undefined;
  let relativeImports = false;
  let appFileAbs: string | undefined;
  const candidates = [
    'main.py', 'app.py', 'server.py', 'wsgi.py', 'asgi.py', 'manage.py',
    'app/main.py', 'src/main.py', 'src/app.py', 'api/main.py',
  ];
  for (const c of candidates) {
    const p = join(dir, c);
    if (existingFile(p)) {
      const txt = safeRead(p)!;
      const m = txt.match(/(?:^|[;\n])\s*(\w+)\s*=\s*(FastAPI|Flask|Django|Starlette)\s*\(/m);
      if (m) {
        const mod = c.replace(/\.py$/, '').replace(/\//g, '.');
        asgiApp = `${mod}:${m[1]}`;
        mainFile = c;
        appFileAbs = p;
        relativeImports = /^\s*from\s+\.\w+/m.test(txt) || /^\s*from\s+\.\s+import\s+/m.test(txt);
        break;
      }
      if (c === 'manage.py') {
        asgiApp = 'manage.py';
        mainFile = c;
        break;
      }
      if (!mainFile) mainFile = c;
    }
  }

  // Fallback: scan all python files (shallow) for an ASGI/WSGI application object.
  if (!asgiApp) {
    for (const sf of ctx.shallowFiles) {
      if (!sf.endsWith('.py') || sf.includes('/tests/') || sf.includes('test_')) continue;
      const txt = safeRead(join(ctx.root, sf)) || '';
      const m = txt.match(/(?:^|[;\n])\s*(\w+)\s*=\s*(FastAPI|Flask|Starlette)\s*\(/m);
      if (m) {
        // Express the module relative to `dir` when possible (so cwd=dir resolves it).
        const abs = join(ctx.root, sf);
        appFileAbs = abs;
        relativeImports = relativeImports || /^\s*from\s+\.\w+/m.test(txt) || /^\s*from\s+\.\s+import\s+/m.test(txt);
        const relToDir = abs.startsWith(dir + '/') ? abs.slice(dir.length + 1) : null;
        if (relToDir) {
          const mod = relToDir.replace(/\.py$/, '').replace(/\//g, '.');
          asgiApp = `${mod}:${m[1]}`;
          mainFile = relToDir;
        } else {
          const mod = sf.replace(/\.py$/, '').replace(/\//g, '.');
          asgiApp = `${mod}:${m[1]}`;
          mainFile = sf;
        }
        break;
      }
    }
  }

  // pyproject [project.scripts]
  if (pyproject) {
    const m = pyproject.match(/\[project\.scripts\]([\s\S]*?)(\n\[|$)/);
    if (m && m[1]) {
      for (const line of m[1].split('\n')) {
        const mm = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["'](.+)["']/);
        if (mm && mm[1] && mm[2]) scripts[mm[1]] = mm[2];
      }
    }
  }

  // scan scripts/ and root for runnable entrypoints (README-referenced or with __main__)
  const readme = safeRead(join(dir, 'README.md'));
  const scriptCandidates: string[] = [];
  for (const sub of ['scripts', 'bin', '.']) {
    const scanDir = sub === '.' ? dir : join(dir, sub);
    if (!existingFile(scanDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(scanDir).filter((f) => f.endsWith('.py'));
    } catch {
      continue;
    }
    for (const f of entries) {
      const full = relPath(ctx, join(scanDir, f));
      const text = safeRead(join(scanDir, f)) || '';
      const hasMain = /__name__\s*==\s*["']__main__["']/.test(text);
      const mentioned = readme ? readme.includes(f) : false;
      if (hasMain || mentioned) scriptCandidates.push(full);
    }
  }
  // Rank: server-like names and earlier README mentions first.
  const rank = (p: string): number => {
    const b = p.split('/').pop() || p;
    let score = 100;
    if (/(^|\/)(web|server|app|main|serve)\.py$/.test(p)) score -= 50;
    if (/(^|\/)scripts\//.test(p)) score -= 5;
    if (readme) {
      const idx = readme.indexOf(b);
      if (idx >= 0) score -= Math.max(0, 40 - idx / 100);
    }
    return score;
  };
  scriptCandidates.sort((a, b) => rank(a) - rank(b));
  if (!mainFile && scriptCandidates.length) {
    mainFile = scriptCandidates[0];
  }
  let packageModule: string | undefined;
  let packageCwdRel: string | undefined;
  if (relativeImports && appFileAbs && asgiApp) {
    const objectName = asgiApp.includes(':') ? asgiApp.split(':')[1] : 'app';
    let packageDir = dirname(appFileAbs);
    const moduleParts = [basename(appFileAbs, '.py')];
    while (packageDir.startsWith(ctx.root + '/') && existsSync(join(packageDir, '__init__.py'))) {
      moduleParts.unshift(basename(packageDir));
      const parent = dirname(packageDir);
      if (parent === packageDir) break;
      packageDir = parent;
    }
    if (moduleParts.length > 1) {
      packageCwdRel = packageDir === ctx.root ? '' : relPath(ctx, packageDir);
      packageModule = `${moduleParts.join('.')}:${objectName}`;
    }
  }
  return {
    frameworks: [...frameworks],
    hasUvicorn,
    asgiApp,
    mainFile,
    scripts,
    tooling,
    scriptCandidates,
    relativeImports,
    packageModule,
    packageCwdRel,
  };
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, 'utf8').slice(0, 300_000);
  } catch {
    return null;
  }
}
function existingFile(p: string): boolean {
  return existsSync(p);
}

export class PythonDetector implements Detector {
  type = 'PythonDetector';

  detect(ctx: DetectionContext): Detection | null {
    const manifests: string[] = [];
    const dirs = new Set<string>();

    for (const m of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']) {
      const p = ctx.findFile(m, 2);
      if (p) {
        manifests.push(relPath(ctx, p));
        let d = dirname(p);
        // keep only dirs within root
        if (!d.startsWith(ctx.root)) d = ctx.root;
        dirs.add(d);
      }
    }
    if (!manifests.length) return null;

    const candidates: CandidateCommand[] = [];
    const evidence: string[] = [];
    const allFrameworks = new Set<string>();
    const inferred: Record<string, PySignals> = {};

    for (const dir of dirs) {
      const rel = relPath(ctx, dir);
      const sig = analyzePython(ctx, dir);
      inferred[rel || '.'] = sig;
      sig.frameworks.forEach((f) => allFrameworks.add(f));

      const py = pythonFor(ctx, dir);
      const inDir = rel && rel !== '.' ? { cwd: rel } : {};

      if (sig.asgiApp && sig.frameworks.includes('fastapi')) {
        const module = sig.relativeImports && sig.packageModule ? sig.packageModule : sig.asgiApp;
        const appDir = sig.relativeImports && sig.packageModule ? join(ctx.root, sig.packageCwdRel || '') : dir;
        let appPy = pythonFor(ctx, appDir, appDir);
        if (appPy === 'python3' && dir !== appDir) {
          const manifestPy = pythonFor(ctx, dir, appDir);
          if (manifestPy !== 'python3') appPy = manifestPy;
          else evidence.push(`${rel || '.'}: no project venv found for package-root run; using system python3`);
        }
        const appRel = appDir === ctx.root ? '' : relPath(ctx, appDir);
        const appInDir = appRel && appRel !== '.' ? { cwd: appRel } : {};
        candidates.push({ command: `${appPy} -m uvicorn ${module} --reload`, ...appInDir, role: 'backend' });
        candidates.push({ command: `${appPy} -m uvicorn ${module}`, ...appInDir, role: 'backend' });
        evidence.push(
          `${rel || '.'}: FastAPI app at ${module} (@ ${sig.mainFile})${sig.relativeImports && sig.packageModule ? ' (relative imports; run as a package)' : ''}`,
        );
        continue;
      }
      if (sig.asgiApp && sig.frameworks.includes('flask')) {
        candidates.push({ command: `${py} -m flask --app ${sig.asgiApp} run`, ...inDir, role: 'backend' });
        candidates.push({ command: `${py} ${runnablePath(sig.mainFile, rel)}`, ...inDir, role: 'backend' });
        evidence.push(`${rel || '.'}: Flask app at ${sig.asgiApp}`);
        continue;
      }
      if (basename(sig.mainFile || '') === 'manage.py') {
        candidates.push({ command: `${py} manage.py runserver`, ...inDir, role: 'backend' });
        evidence.push(`${rel || '.'}: Django manage.py`);
        continue;
      }
      if (sig.frameworks.includes('streamlit')) {
        candidates.push({ command: `${py} -m streamlit run ${runnablePath(sig.mainFile, rel)}`, ...inDir, role: 'frontend' });
        evidence.push(`${rel || '.'}: Streamlit`);
        continue;
      }
      if (sig.hasUvicorn) {
        if (!sig.asgiApp && sig.scriptCandidates.length) {
          // A uvicorn dependency alone does not identify the ASGI module object.
          // Prefer the documented or directly runnable script instead of inventing `module:app`.
          const fallback = runnablePath(sig.scriptCandidates[0], rel);
          candidates.push({ command: `${py} ${fallback}`, ...inDir, role: 'backend' });
          evidence.push(`${rel || '.'}: uvicorn is present but no ASGI app object was identified; using script ${sig.scriptCandidates[0]}`);
          continue;
        }
        const target = sig.asgiApp || runnablePath(sig.mainFile, rel);
        candidates.push({ command: `${py} -m uvicorn ${target}${target.includes(':') ? '' : ':app'} --reload`, ...inDir, role: 'backend' });
        evidence.push(`${rel || '.'}: uvicorn in dependencies`);
        continue;
      }
      if (sig.mainFile) {
        candidates.push({ command: `${py} ${runnablePath(sig.mainFile, rel)}`, ...inDir, role: 'backend' });
        evidence.push(`${rel || '.'}: python entrypoint ${sig.mainFile} (framework unconfirmed)`);
      }
    }

    let confidence = 0.4;
    if (allFrameworks.has('fastapi') || allFrameworks.has('flask') || allFrameworks.has('django')) confidence = 0.85;
    else if (candidates.length && candidates.every((c) => /--reload|flask run|manage.py runserver/.test(c.command))) confidence = 0.8;
    else if (candidates.length) confidence = 0.55;

    evidence.unshift(`python manifests: ${manifests.join(', ')}`);

    return {
      type: this.type,
      confidence,
      evidence,
      candidates,
      meta: { frameworks: [...allFrameworks], manifests, inferred },
    };
  }
}

function runnablePath(rootRelativePath: string | undefined, cwdRel: string): string {
  if (!rootRelativePath) return 'main.py';
  const cwd = cwdRel && cwdRel !== '.' ? cwdRel : '';
  if (!cwd) return rootRelativePath;
  if (rootRelativePath === cwd) return basename(rootRelativePath);
  if (rootRelativePath.startsWith(`${cwd}/`)) return rootRelativePath.slice(cwd.length + 1);
  return rootRelativePath;
}

export class FastAPIDetector implements Detector {
  type = 'FastAPIDetector';
  detect(ctx: DetectionContext): Detection | null {
    // A fastapi/uvicorn dependency is only a strong signal when an ASGI app object exists.
    const py = ctx.findFile('requirements.txt', 2);
    const pp = ctx.findFile('pyproject.toml', 2);
    let text = '';
    for (const p of [py, pp]) {
      if (p) text += (safeRead(p) || '').toLowerCase();
    }
    if (!text.includes('fastapi') && !text.includes('uvicorn')) return null;
    const hasAppObject = findAppObject(ctx);
    const hasMain = ['main.py', 'app.py', 'server.py', 'app/main.py'].some((f) =>
      existingFile(join(ctx.root, f)),
    );
    const confidence = hasAppObject ? 0.9 : hasMain ? 0.55 : 0.35;
    const evidence = [
      `fastapi/uvicorn referenced in ${[py, pp].filter(Boolean).map((p) => relPath(ctx, p!)).join(', ')}`,
      hasAppObject ? 'an ASGI application object was found' : 'no ASGI application object was found',
    ];
    return {
      type: this.type,
      confidence,
      evidence,
      candidates: [],
    };
  }
}

function findAppObject(ctx: DetectionContext): boolean {
  const pythonFiles = ctx.shallowFiles
    .filter((f) => f.endsWith('.py') && !f.includes('/tests/') && !f.includes('test_'))
    .slice(0, 30);
  for (const f of pythonFiles) {
    let text: string;
    try {
      text = readFileSync(join(ctx.root, f), 'utf8').slice(0, 50_000);
    } catch {
      continue;
    }
    if (/(?:^|[;\n])\s*\w+\s*=\s*(FastAPI|Flask|Starlette)\s*\(/m.test(text)) return true;
  }
  return false;
}

/** Choose the best python interpreter for a directory. Prefers local venv. */
export function pythonFor(ctx: DetectionContext, dir: string, fromDir: string = dir): string {
  const candidates = [
    join(dir, '.venv', 'bin', 'python'),
    join(dir, 'venv', 'bin', 'python'),
    join(dir, '.venv', 'bin', 'python3'),
    join(ctx.root, '.venv', 'bin', 'python'),
    join(ctx.root, 'venv', 'bin', 'python'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return relInterp(c, fromDir);
  }
  return 'python3';
}

function relInterp(abs: string, cwdDir: string): string {
  // Prefer a path relative to the service working directory, even when the
  // interpreter sits elsewhere in the project (for example, a repo-root venv).
  if (abs.startsWith(cwdDir + '/')) return abs.slice(cwdDir.length + 1);
  return relative(cwdDir, abs);
}
