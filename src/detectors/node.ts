import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Detection, CandidateCommand } from '../types.js';
import type { Detector, DetectionContext } from './base.js';
import { relPath } from './base.js';

interface PkgJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

const SERVICE_SCRIPT_ORDER = ['dev', 'develop', 'start', 'serve', 'preview'];
const FRONTEND_DEPS = ['react', 'react-dom', 'vue', 'svelte', 'next', 'nuxt', '@angular/core', 'vite'];
const BACKEND_DEPS = ['express', 'fastify', 'koa', 'hapi', 'nestjs', '@nestjs/core', 'hono'];

export function readPackageJson(path: string): PkgJson | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PkgJson;
  } catch {
    return null;
  }
}

/** Determine package manager from lockfiles in a directory and its parents. */
export function packageManagerFor(ctx: DetectionContext, dir: string): { pm: string; evidence: string } {
  const checks: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['pnpm-workspace.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  // check dir then walk up to root
  let current = dir;
  while (true) {
    for (const [file, pm] of checks) {
      if (fileExists(join(current, file))) return { pm, evidence: `${relPath(ctx, join(current, file))}` };
    }
    if (current === ctx.root) break;
    const next = dirname(current);
    if (!next.startsWith(ctx.root)) break;
    current = next;
  }
  // root-level fallback
  for (const [file, pm] of checks) {
    if (fileExists(join(ctx.root, file))) return { pm, evidence: file };
  }
  return { pm: 'npm', evidence: 'no lockfile found (defaulting to npm)' };
}

function fileExists(p: string): boolean {
  try {
    readFileSync(p, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export class NodeDetector implements Detector {
  type = 'NodeDetector';

  detect(ctx: DetectionContext): Detection | null {
    const pkgPath = ctx.findFile('package.json', 2);
    if (!pkgPath) return null;
    const pkg = readPackageJson(pkgPath);
    if (!pkg) {
      return {
        type: this.type,
        confidence: 0.5,
        evidence: [`package.json found at ${relPath(ctx, pkgPath)} but failed to parse`],
        candidates: [],
      };
    }

    const pkgDir = dirname(pkgPath);
    const rel = relPath(ctx, pkgDir);
    const { pm, evidence } = packageManagerFor(ctx, pkgDir);
    const scripts = pkg.scripts || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const isFrontend = FRONTEND_DEPS.some((d) => d in deps);
    const isBackend = BACKEND_DEPS.some((d) => d in deps);

    let role = 'app';
    if (isBackend && !isFrontend) role = 'backend';
    else if (isFrontend && !isBackend) role = 'frontend';
    else if (isFrontend && isBackend) role = 'fullstack';

    const candidates: CandidateCommand[] = [];
    const evidenceList: string[] = [
      `package.json at ${relPath(ctx, pkgPath)}`,
      `package manager: ${pm} (${evidence})`,
    ];

    const runPrefix = pm === 'npm' ? 'npm run' : pm;
    const firstExisting = SERVICE_SCRIPT_ORDER.find((s) => s in scripts);
    for (const script of SERVICE_SCRIPT_ORDER) {
      if (!(script in scripts)) continue;
      const cmd = script === 'start' && pm === 'npm' ? 'npm start' : `${runPrefix} ${script}`;
      candidates.push({
        command: cmd,
        cwd: rel || undefined,
        role,
      });
    }

    let confidence: number;
    if (firstExisting) {
      confidence = 0.95;
      evidenceList.push(`script "${firstExisting}": \`${scripts[firstExisting]}\``);
    } else if (Object.keys(scripts).length) {
      confidence = 0.6;
      evidenceList.push(`scripts present but no dev/start: ${Object.keys(scripts).slice(0, 6).join(', ')}`);
    } else {
      confidence = 0.45;
      evidenceList.push('no runnable scripts in package.json');
    }

    // Monorepo workspace awareness
    if (pkg.workspaces) {
      const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
      evidenceList.push(`workspaces: ${globs.join(', ')}`);
      const nonRoot = candidates.filter((c) => c.cwd);
      if (nonRoot.length) confidence = Math.min(confidence, 0.7);
    }

    if (pkg.name) evidenceList.push(`package name: ${pkg.name}`);

    // Infer the conventional dev-server port from the framework/script.
    const devScript = scripts['dev'] || scripts['develop'] || '';
    const port = inferDevPort(deps, devScript);

    return {
      type: this.type,
      confidence,
      evidence: evidenceList,
      candidates,
      meta: {
        packageManager: pm,
        scripts: Object.keys(scripts),
        dependencies: Object.keys(deps).slice(0, 30),
        role,
        packageName: pkg.name,
        path: relPath(ctx, pkgPath),
        devServerPort: port,
      },
    };
  }
}

export function inferDevPort(deps: Record<string, string>, devScript: string): number | undefined {
  const explicit = devScript.match(/--port[= ](\d{2,5})/) || devScript.match(/-p\s*(\d{2,5})/);
  if (explicit && explicit[1]) return Number(explicit[1]);
  if ('vite' in deps || /\bvite\b/.test(devScript)) return 5173;
  if ('next' in deps || /\bnext\b/.test(devScript)) return 3000;
  if ('nuxt' in deps) return 3000;
  if ('@angular/core' in deps) return 4200;
  if ('react-scripts' in deps) return 3000;
  if ('webpack' in deps && /webpack serve/.test(devScript)) return 8080;
  return undefined;
}
