#!/usr/bin/env node
// Runs deterministic discovery over the whole corpus and writes per-project
// reports plus a summary. Read-only: never starts anything.
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discover } from '../dist/discovery.js';
import { computeReadiness } from '../dist/prereqs.js';

const corpus = process.argv[2] || '/home/penguin/code';
const outDir = process.argv[3] || join(process.cwd(), 'discovery');
mkdirSync(outDir, { recursive: true });

const entries = readdirSync(corpus, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'project-launcher')
  .map((e) => e.name)
  .sort();

const rows = [];
for (const name of entries) {
  const root = join(corpus, name);
  let outcome;
  try {
    outcome = discover(root, name);
  } catch (err) {
    rows.push({ name, error: err.message });
    continue;
  }
  const { project, confidence, warnings, ambiguous, detections } = outcome;
  const readiness = computeReadiness(project, false);
  let md = `# Discovery: ${project.name}\n\n`;
  md += `- Path: \`${root}\`\n`;
  md += `- Confidence: **${confidence.toFixed(2)}**\n`;
  md += `- Readiness: **${readiness.status}**\n`;
  md += `- Unsafe to auto-run: ${project.metadata?.unsafe ? `**yes** (${project.metadata.unsafeReason})` : 'no'}\n`;
  md += `- Stack signals: ${(project.metadata?.stack || []).join(', ') || '(none)'}\n\n`;

  if (readiness.blockers.length) {
    md += `## Blockers\n\n`;
    for (const b of readiness.blockers) {
      md += `- [${b.type}]${b.service ? ` (${b.service})` : ''} ${b.message}${b.suggestion ? `\n  - suggestion: ${b.suggestion}` : ''}\n`;
    }
    md += `\n`;
  }

  if (outcome.targets.length > 1) {
    md += `## Runnable targets\n\n`;
    for (const t of outcome.targets) {
      md += `- \`${t.key}\` — ${t.label}${t.primary ? ' (primary)' : ''}: \`${t.command}\`${t.cwd ? ` (cwd ${t.cwd})` : ''}\n`;
    }
    md += `\n`;
  }

  md += `## Services\n\n`;
  if (!project.services.length) md += `_None detected. Manual configuration required._\n\n`;
  for (const s of project.services) {
    md += `### ${s.id}\n`;
    md += `- Command: \`${s.command}\`\n`;
    md += `- Working directory: \`${s.cwd || '.'}\`\n`;
    if (s.runtime) md += `- Runtime: ${s.runtime}\n`;
    if (s.port) md += `- Port: ${s.port}\n`;
    if (s.dependsOn?.length) md += `- Depends on: ${s.dependsOn.join(', ')}\n`;
    if (s.healthCheck) md += `- Health: ${JSON.stringify(s.healthCheck)}\n`;
    if (s.provenance) md += `- Provenance: ${s.provenance.source}${s.provenance.detector ? `/${s.provenance.detector}` : ''}${typeof s.provenance.confidence === 'number' ? ` (confidence ${s.provenance.confidence.toFixed(2)})` : ''}\n`;
    if (s.notes) md += `- Notes: ${s.notes}\n`;
    md += `\n`;
  }

  md += `## Detector evidence\n\n`;
  for (const d of detections) {
    if (!d.evidence.length && !d.candidates.length) continue;
    md += `- **${d.type}** (confidence ${d.confidence.toFixed(2)})\n`;
    for (const e of d.evidence) md += `  - ${e}\n`;
  }
  md += `\n`;

  if (ambiguous.length) {
    md += `## Ambiguous alternates (need a human decision)\n\n`;
    for (const a of ambiguous) md += `- \`${a.command}\`${a.cwd ? ` (cwd ${a.cwd})` : ''} — role ${a.role || '?'}\n`;
    md += `\n`;
  }
  if (warnings.length) {
    md += `## Warnings\n\n`;
    for (const w of warnings) md += `- ${w}\n`;
    md += `\n`;
  }

  writeFileSync(join(outDir, `${name}.md`), md);
  rows.push({
    name,
    confidence,
    readiness: readiness.status,
    unsafe: Boolean(project.metadata?.unsafe),
    services: project.services.length,
    commands: project.services.map((s) => s.command),
    manual: project.services.length === 0 || confidence < 0.5,
  });
}

writeFileSync(join(outDir, '_summary.json'), JSON.stringify(rows, null, 2));

let md = `# Corpus Discovery Summary\n\nProjects: ${rows.length}\n\n`;
md += `| project | conf | readiness | unsafe | services | first command |\n|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.name} | ${r.error ? 'ERR' : r.confidence.toFixed(2)} | ${r.readiness || ''} | ${r.unsafe ? 'yes' : ''} | ${r.services ?? 0} | ${(r.commands?.[0] || r.error || '').slice(0, 56)} |\n`;
}
const auto = rows.filter((r) => !r.error && r.services > 0 && r.confidence >= 0.8).length;
const ambiguous = rows.filter((r) => !r.error && r.services > 0 && r.confidence < 0.8).length;
const none = rows.filter((r) => r.error || r.services === 0).length;
md += `\n- Automatically understood (conf>=0.8, >=1 service): ${auto}\n`;
md += `- Detected but ambiguous: ${ambiguous}\n`;
md += `- Nothing detected / error: ${none}\n`;
writeFileSync(join(outDir, 'SUMMARY.md'), md);

process.stderr.write(`Wrote ${rows.length} discovery reports to ${outDir}\n`);
