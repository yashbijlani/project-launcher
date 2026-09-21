import type {
  IntelligentDiscoveryProvider,
  ProjectEvidence,
  ProjectProposal,
  Project,
  Service,
} from './types.js';
import { slugify } from './config.js';
import { validateProjectStructure } from './safety.js';

/**
 * Optional AI discovery adapter.
 *
 * This lives OUTSIDE the deterministic core. If no provider is configured,
 * discovery still works. The provider only receives a bounded evidence package
 * (never the whole corpus), and its output is always a *proposal* that must be
 * validated and approved before any command is executed.
 *
 * Two implementations are provided:
 *  - NullAIProvider: returns nothing useful (default; used when no AI is configured).
 *  - HttpAIProvider: sends the evidence package to an OpenAI-compatible chat
 *    endpoint and parses a strict JSON proposal.
 */

export interface AIAdapterConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class NullAIProvider implements IntelligentDiscoveryProvider {
  readonly id = 'null';
  async analyzeProject(): Promise<ProjectProposal> {
    return { project: emptyProject(), confidence: 0, rationale: 'No AI provider configured.', warnings: ['AI disabled'] };
  }
}

export class HttpAIProvider implements IntelligentDiscoveryProvider {
  readonly id = 'http-openai-compatible';
  constructor(private config: AIAdapterConfig) {}

  async analyzeProject(input: ProjectEvidence): Promise<ProjectProposal> {
    const system = [
      'You are a project startup assistant. You receive a SMALL evidence package about one local project.',
      'Propose a startup configuration as STRICT JSON only, no prose.',
      'Schema: {"services":[{"id":string,"command":string,"cwd":string?,"port":number?,"depends_on":string[]?,"health":{"type":"http"|"tcp"|"process"|"command","url"?:string,"port"?:number,"command"?:string}}],"confidence":number,"rationale":string,"warnings":string[]}',
      'Only use commands that are evidenced. Do not invent credentials. Mark anything risky in warnings.',
    ].join('\n');
    const user = JSON.stringify(redactEvidence(input), null, 2);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { project: emptyProject(), confidence: 0, rationale: `AI request failed: HTTP ${res.status}`, warnings: [await res.text().catch(() => '')] };
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content || '';
      return parseProposal(content, input);
    } catch (err) {
      return { project: emptyProject(), confidence: 0, rationale: `AI request error: ${(err as Error).message}`, warnings: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Strip anything that looks like a secret before sending evidence to a model. */
export function redactEvidence(evidence: ProjectEvidence): ProjectEvidence {
  const redact = (s: string): string =>
    s
      .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
      .replace(/(api[_-]?key\s*[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
      .replace(/(password\s*[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
      .replace(/(token\s*[=:]\s*)[^\s"']+/gi, '$1[REDACTED]');
  return {
    ...evidence,
    readmeExcerpt: evidence.readmeExcerpt ? redact(evidence.readmeExcerpt) : undefined,
    logs: evidence.logs?.map(redact),
  };
}

export function parseProposal(content: string, input: ProjectEvidence): ProjectProposal {
  let json = content.trim();
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) json = fence[1].trim();
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { project: emptyProject(), confidence: 0, rationale: 'AI did not return JSON.', warnings: [content.slice(0, 500)] };
  }
  let parsed: {
    services?: Array<{ id?: string; command?: string; cwd?: string; port?: number; depends_on?: string[]; health?: Service['healthCheck'] }>;
    confidence?: number;
    rationale?: string;
    warnings?: string[];
  };
  try {
    parsed = JSON.parse(json.slice(start, end + 1));
  } catch (err) {
    return { project: emptyProject(), confidence: 0, rationale: `AI JSON parse error: ${(err as Error).message}`, warnings: [] };
  }

  const services: Service[] = (parsed.services || [])
    .filter((s) => typeof s.command === 'string' && s.command.length > 0)
    .map((s, i) => ({
      id: slugify(s.id || `service-${i + 1}`),
      name: s.id || `service-${i + 1}`,
      command: s.command!,
      cwd: s.cwd,
      port: typeof s.port === 'number' ? s.port : undefined,
      dependsOn: s.depends_on,
      healthCheck: s.health,
      restartPolicy: 'never',
    }));

  const project: Project = {
    id: slugify(input.name),
    name: input.name,
    root: input.root,
    services,
    metadata: { source: 'ai-proposal', discoveredAt: new Date().toISOString() },
  };
  return {
    project,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    rationale: parsed.rationale || '',
    warnings: parsed.warnings || [],
  };
}

function emptyProject(): Project {
  return { id: 'unknown', name: 'unknown', root: '', services: [] };
}

export function providerFromEnv(): IntelligentDiscoveryProvider {
  const baseUrl = process.env.LAUNCHER_AI_BASE_URL;
  const model = process.env.LAUNCHER_AI_MODEL;
  if (!baseUrl || !model) return new NullAIProvider();
  return new HttpAIProvider({ baseUrl, model, apiKey: process.env.LAUNCHER_AI_API_KEY });
}

/**
 * Validate an AI proposal before it can be persisted.
 * This is the mandatory gate: AI output never bypasses it.
 *
 * Layered policy (not a single blacklist):
 *  1. structural: ids, dependencies, cycles, profiles, actions, health checks
 *  2. filesystem: cwd containment, no arbitrary absolute paths
 *  3. evidence: directly evidenced vs derived vs AI-invented commands
 *  4. security: destructive, privilege, exfiltration, and downloader patterns
 */
export function validateProposal(
  proposal: ProjectProposal,
  evidence?: ProjectEvidence,
): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings = [...proposal.warnings];
  const project = proposal.project;

  if (proposal.confidence < 0.3) errors.push(`proposal confidence too low (${proposal.confidence})`);
  if (!project.services.length) errors.push('proposal has no services');
  if (!project.id || !/^[a-z0-9][a-z0-9-]*$/.test(project.id)) errors.push('proposal has an invalid project id');
  if (!project.root) errors.push('proposal has no project root');

  // Structural validation reuses the same gate as the runtime.
  errors.push(...validateProjectStructure({ ...project, verification: undefined }));

  // Filesystem: no absolute command paths outside the project, scripts must exist when claimed.
  for (const s of project.services) {
    for (const m of s.command.matchAll(/(^|\s)(\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+)/g)) {
      const abs = m[2]!;
      if (abs.startsWith(project.root + '/') || abs === project.root) continue;
      if (/^\/(bin|usr\/bin|usr\/local\/bin|opt\/)/.test(abs)) continue; // system binary paths
      errors.push(`service ${s.id} references an absolute path outside the project: ${abs}`);
    }
  }

  // Evidence tiers.
  if (evidence) {
    const haystack = collectEvidenceText(evidence).toLowerCase();
    for (const s of project.services) {
      const cmd = s.command.toLowerCase();
      const tokens = cmd.split(/[^a-z0-9_./-]+/).filter((t) => t.length > 2);
      const evidenced = tokens.some((t) => haystack.includes(t)) || haystack.includes(cmd.slice(0, 60));
      const scriptRef = cmd.match(/([a-z0-9_./-]+\.(py|sh|js|mjs))/)?.[1];
      if (evidenced) {
        warnings.push(`service ${s.id}: command is directly evidenced`);
      } else if (scriptRef && haystack.includes(scriptRef.split('/').pop()!)) {
        warnings.push(`service ${s.id}: command is derived from evidence (verify before running)`);
      } else {
        warnings.push(`service ${s.id}: AI-invented command (requires explicit approval AND successful verification)`);
      }
    }
  }

  // Security layer.
  for (const s of project.services) {
    const cmd = s.command;
    if (/\bsudo\b/.test(cmd)) errors.push(`service ${s.id} uses sudo (refused)`);
    if (/(rm\s+-rf\s+\/|mkfs(\.| )|dd\s+(if|of)=|shutdown|reboot|halt|poweroff)/.test(cmd)) {
      errors.push(`service ${s.id} contains a destructive command`);
    }
    if (/(curl|wget)\s+.*\|\s*(bash|sh)/.test(cmd)) errors.push(`service ${s.id} pipes a download into a shell (refused)`);
    if (/base64\s+(-d|--decode)/.test(cmd) && /\|\s*(bash|sh|python)/.test(cmd)) {
      errors.push(`service ${s.id} decodes and executes a payload (refused)`);
    }
    if (/\benv\b.*\|\s*(curl|nc|bash)/.test(cmd) || /\/proc\/.*(password|secret|key)/.test(cmd)) {
      errors.push(`service ${s.id} looks like credential exfiltration (refused)`);
    }
    if (/\/dev\/(sda|nvme|mem|kvm)/.test(cmd)) errors.push(`service ${s.id} touches a raw device (refused)`);
    if (/chmod\s+(-R\s+)?777\s+\//.test(cmd)) errors.push(`service ${s.id} weakens system permissions (refused)`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

function collectEvidenceText(evidence: ProjectEvidence): string {
  const parts: string[] = [
    evidence.readmeTitle || '',
    evidence.readmeExcerpt || '',
    (evidence.manifests || []).join('\n'),
    JSON.stringify(evidence.signals || {}),
  ];
  for (const d of evidence.detections || []) {
    parts.push(d.type, d.evidence.join('\n'), d.candidates.map((c) => `${c.command} ${c.cwd || ''}`).join('\n'));
  }
  return parts.join('\n');
}
