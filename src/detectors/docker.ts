import { readFileSync } from 'node:fs';
import type { Detection, CandidateCommand } from '../types.js';
import type { Detector, DetectionContext } from './base.js';
import { relPath } from './base.js';

interface ComposeService {
  name: string;
  image?: string;
  build?: boolean;
  ports: string[];
  dependsOn: string[];
}

export function parseCompose(path: string): { version?: string; services: ComposeService[] } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // Minimal indentation-aware parser (avoids a full YAML dep in detectors).
  const lines = text.split('\n');
  const services: ComposeService[] = [];
  let section: 'none' | 'services' | 'other' = 'none';
  let current: ComposeService | null = null;
  let currentField: 'ports' | 'depends' | 'none' = 'none';

  for (const raw of lines) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const indent = (raw.match(/^(\s*)/)?.[1] ?? '').length;
    const line = raw.trim();

    if (indent === 0) {
      if (/^services:\s*$/.test(line)) section = 'services';
      else section = 'other';
      current = null;
      currentField = 'none';
      continue;
    }
    if (section !== 'services') continue;

    const svcMatch = raw.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (svcMatch && svcMatch[1]) {
      current = { name: svcMatch[1], ports: [], dependsOn: [] };
      services.push(current);
      currentField = 'none';
      continue;
    }
    if (!current) continue;

    if (indent >= 4) {
      if (/^image:\s*(.+)$/.test(line)) {
        current.image = line.replace(/^image:\s*/, '').replace(/["']/g, '');
        currentField = 'none';
      } else if (/^build:/.test(line)) {
        current.build = true;
        currentField = 'none';
      } else if (/^depends_on:/.test(line)) {
        currentField = 'depends';
      } else if (/^ports:/.test(line)) {
        currentField = 'ports';
      } else if (/^[a-z_]+:/.test(line)) {
        currentField = 'none';
      } else if (/^-\s*/.test(line)) {
        const val = line.replace(/^-\s*/, '').replace(/["']/g, '');
        if (currentField === 'ports') current.ports.push(val);
        else if (currentField === 'depends') current.dependsOn.push(val);
      }
    }
  }
  return { services };
}

export class DockerDetector implements Detector {
  type = 'DockerDetector';

  detect(ctx: DetectionContext): Detection | null {
    const composeFile =
      ctx.findFile('docker-compose.yml', 1) ||
      ctx.findFile('docker-compose.yaml', 1) ||
      ctx.findFile('compose.yml', 1) ||
      ctx.findFile('compose.yaml', 1);
    const dockerfile = ctx.findFile('Dockerfile', 2);

    if (!composeFile && !dockerfile) return null;

    const evidence: string[] = [];
    const candidates: CandidateCommand[] = [];

    if (composeFile) {
      const rel = relPath(ctx, composeFile);
      // If compose is nested, run from its dir.
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : undefined;
      const parsed = parseCompose(composeFile);
      const svcs = parsed?.services.map((s) => s.name) ?? [];
      evidence.push(`compose file ${rel} with services: ${svcs.join(', ') || '(none parsed)'}`);
      candidates.push({ command: 'docker compose up', cwd: dir, role: 'stack' });
      candidates.push({ command: 'docker compose up -d', cwd: dir, role: 'stack' });
    }
    if (dockerfile) {
      evidence.push(`Dockerfile at ${relPath(ctx, dockerfile)}`);
    }

    return {
      type: this.type,
      confidence: composeFile ? 0.9 : 0.6,
      evidence,
      candidates,
      meta: {
        composeFile: composeFile ? relPath(ctx, composeFile) : null,
        dockerfile: dockerfile ? relPath(ctx, dockerfile) : null,
        services: composeFile ? parseCompose(composeFile)?.services ?? [] : [],
      },
    };
  }
}

/** Docker-driven detection that expands compose services into individual service candidates. */
export function composeServiceCandidates(ctx: DetectionContext): CandidateCommand[] {
  const composeFile =
    ctx.findFile('docker-compose.yml', 1) ||
    ctx.findFile('compose.yml', 1) ||
    ctx.findFile('docker-compose.yaml', 1) ||
    ctx.findFile('compose.yaml', 1);
  if (!composeFile) return [];
  const rel = relPath(ctx, composeFile);
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : undefined;
  const parsed = parseCompose(composeFile);
  if (!parsed) return [];
  const out: CandidateCommand[] = [];
  const hasBuild = parsed.services.some((s) => s.build);
  if (hasBuild) {
    out.push({ command: 'docker compose up --build', cwd: dir, role: 'stack' });
  }
  for (const s of parsed.services) {
    out.push({
      command: `docker compose up ${s.name}`,
      cwd: dir,
      role: 'stack',
      serviceId: s.name,
      dependsOn: s.dependsOn,
    });
  }
  return out;
}
