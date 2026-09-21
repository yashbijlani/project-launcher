import { readFileSync, readdirSync } from 'node:fs';
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
    // Discover every package.json at shallow depth, not just the first one.
    // This is what makes workspace/monorepo target selection possible.
    const roots = [ctx.root, ...ctx.shallowFiles
      .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
      .map((f) => join(ctx.root, dirname(f)))];
    // Workspace packages commonly live at depth 3+ (apps/web, packages/x), so
    // expand the declared workspace globs explicitly instead of guessing.
    for (const dir of expandWorkspaceGlobs(ctx)) roots.push(dir);
    const seen = new Set<string>();
    const pkgPaths: string[] = [];
    for (const dir of roots) {
      const p = join(dir, 'package.json');
      if (seen.has(p)) continue;
      seen.add(p);
      if (fileExists(p)) pkgPaths.push(p);
    }
    if (!pkgPaths.length) return null;

    // Root package first so its metadata is the primary one.
    pkgPaths.sort((a, b) => a.length - b.length);

    const allCandidates: CandidateCommand[] = [];
    const allEvidence: string[] = [];
    let bestConfidence = 0;
    let primaryMeta: Record<string, unknown> | null = null;
    const packages: Array<Record<string, unknown>> = [];

    for (const pkgPath of pkgPaths) {
      const pkg = readPackageJson(pkgPath);
      const rel = relPath(ctx, dirname(pkgPath)) || '.';
      if (!pkg) {
        allEvidence.push(`package.json at ${rel} but failed to parse`);
        bestConfidence = Math.max(bestConfidence, 0.5);
        continue;
      }
      const result = this.analyzePackage(ctx, pkgPath, pkg);
      allCandidates.push(...result.candidates);
      allEvidence.push(...result.evidence);
      packages.push(result.meta);
      bestConfidence = Math.max(bestConfidence, result.confidence);
      if (!primaryMeta) primaryMeta = result.meta;
    }

    return {
      type: this.type,
      confidence: bestConfidence,
      evidence: allEvidence,
      candidates: allCandidates,
      meta: {
        ...(primaryMeta || {}),
        packages,
        packageCount: packages.length,
        // Convenience: port of the primary (root-most) package, if any.
        devServerPort: (primaryMeta as { devServerPort?: number } | null)?.devServerPort,
      },
    };
  }

  private analyzePackage(
    ctx: DetectionContext,
    pkgPath: string,
    pkg: PkgJson,
  ): { candidates: CandidateCommand[]; evidence: string[]; confidence: number; meta: Record<string, unknown> } {
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
    if (port) {
      for (const c of candidates) c.port = port;
    }

    return {
      candidates,
      evidence: evidenceList,
      confidence,
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

/**
 * Expand workspace declarations from package.json / pnpm-workspace.yaml into
 * concrete package directories. Supports the common `dir/*` and `dir/**` forms
 * without a full glob implementation.
 */
function expandWorkspaceGlobs(ctx: DetectionContext): string[] {
  const globs: string[] = [];
  const rootPkg = readPackageJson(join(ctx.root, 'package.json'));
  if (rootPkg?.workspaces) {
    const ws = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces.packages || [];
    globs.push(...ws);
  }
  const pnpmPath = join(ctx.root, 'pnpm-workspace.yaml');
  if (fileExists(pnpmPath)) {
    try {
      const text = readFileSync(pnpmPath, 'utf8');
      const section = text.match(/^packages:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m);
      if (section && section[1]) {
        globs.push(
          ...section[1]
            .split('\n')
            .map((l) => l.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, ''))
            .filter(Boolean),
        );
      }
    } catch {
      /* ignore */
    }
  }

  const dirs = new Set<string>();
  for (const glob of globs) {
    if (glob.includes('*')) {
      const base = glob.slice(0, glob.indexOf('*')).replace(/\/$/, '');
      const baseDir = join(ctx.root, base);
      let entries;
      try {
        entries = readdirSync(baseDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory()) dirs.add(join(baseDir, e.name));
      }
    } else {
      dirs.add(join(ctx.root, glob));
    }
  }
  return [...dirs];
}
