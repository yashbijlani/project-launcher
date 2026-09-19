import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Detection } from '../types.js';

export interface DetectionContext {
  root: string;
  topFiles: string[];
  topDirs: string[];
  /** All shallow files (depth<=2) relative to root, for manifest discovery. */
  shallowFiles: string[];
  readFirst(path: string, maxBytes?: number): string | null;
  findFile(name: string, maxDepth?: number): string | null;
}

export interface Detector {
  type: string;
  detect(ctx: DetectionContext): Detection | null;
}

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'target', '.gradle', '.dart_tool', '.next', '.cache', '.turbo', 'vendor',
  '.mypy_cache', '.pytest_cache', 'coverage', '.idea', '.vscode', '.pnpm-store',
  'Pods', '.expo', 'out', '.parcel-cache', 'htmlcov', '.ruff_cache',
]);

export function buildContext(root: string): DetectionContext {
  const topEntries = readdirSync(root, { withFileTypes: true });
  const topFiles = topEntries.filter((e) => e.isFile()).map((e) => e.name);
  const topDirs = topEntries
    .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name))
    .map((e) => e.name);

  const shallowFiles: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      } else if (e.isFile()) {
        shallowFiles.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(root, '', 1);

  const readFirst = (path: string, maxBytes = 200_000): string | null => {
    try {
      return readFileSync(path, 'utf8').slice(0, maxBytes);
    } catch {
      return null;
    }
  };

  const findFile = (name: string, maxDepth = 2): string | null => {
    let level: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (level.length) {
      const next: Array<{ dir: string; depth: number }> = [];
      for (const { dir, depth } of level) {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.isDirectory()) {
            if (depth < maxDepth && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
              next.push({ dir: join(dir, e.name), depth: depth + 1 });
            }
          } else if (e.isFile() && e.name === name) {
            return join(dir, e.name);
          }
        }
      }
      level = next;
    }
    return null;
  };

  return { root, topFiles, topDirs, shallowFiles, readFirst, findFile };
}

/** Extract the first N lines of a file safely. */
export function readHead(path: string, lines: number): string | null {
  try {
    const t = readFileSync(path, 'utf8');
    return t.split('\n').slice(0, lines).join('\n');
  } catch {
    return null;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function hasFile(ctx: DetectionContext, rel: string): boolean {
  return existsSync(join(ctx.root, rel));
}

export function relPath(ctx: DetectionContext, abs: string): string {
  if (abs === ctx.root) return '';
  if (abs.startsWith(ctx.root + '/')) return abs.slice(ctx.root.length + 1);
  return abs;
}

export { IGNORE_DIRS };
