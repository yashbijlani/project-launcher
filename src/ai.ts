import type {
  IntelligentDiscoveryProvider,
  ProjectEvidence,
  ProjectProposal,
  Project,
  Service,
} from './types.js';
import { slugify } from './config.js';

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
 */
export function validateProposal(proposal: ProjectProposal): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings = [...proposal.warnings];
  if (proposal.confidence < 0.3) errors.push(`proposal confidence too low (${proposal.confidence})`);
  if (!proposal.project.services.length) errors.push('proposal has no services');
  for (const s of proposal.project.services) {
    if (!s.command.trim()) errors.push(`service ${s.id} has empty command`);
    if (/\bsudo\b/.test(s.command)) errors.push(`service ${s.id} uses sudo (refused)`);
    if (/(rm\s+-rf\s+\/|mkfs|dd\s+if=|shutdown|reboot)/.test(s.command)) errors.push(`service ${s.id} contains a destructive command`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
