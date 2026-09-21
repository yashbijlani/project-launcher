import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, RuntimeProjectState, UnsafeApproval } from './types.js';
import { listProjects, loadProject, saveProject } from './config.js';
import { readState } from './state.js';
import { discover } from './discovery.js';
import { logDir } from './paths.js';
import { isUnsafeAuthorized } from './safety.js';
import { computeReadiness } from './prereqs.js';
import { isVerificationCurrent } from './fingerprint.js';

export interface ServerOptions {
  port?: number;
  host?: string;
}

export interface LauncherEvent {
  type: string;
  projectId: string;
  service?: string;
  at: number;
  detail?: string;
}

const eventLog: LauncherEvent[] = [];
const sseClients = new Set<ServerResponse>();

export function publishEvent(e: Omit<LauncherEvent, 'at'>): void {
  const full: LauncherEvent = { ...e, at: Date.now() };
  eventLog.push(full);
  if (eventLog.length > 500) eventLog.splice(0, eventLog.length - 500);
  for (const res of sseClients) {
    try {
      res.write(`data: ${JSON.stringify(full)}\n\n`);
    } catch {
      /* ignore */
    }
  }
}

export function startServer(opts: ServerOptions = {}): Promise<{ port: number; close(): void }> {
  const port = opts.port ?? Number(process.env.LAUNCHER_PORT || 8790);
  const host = opts.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => sendJson(res, { error: (err as Error).message }, 500));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      process.stderr.write(`project-launcher UI: http://${host}:${actualPort}/\n`);
      resolve({
        port: actualPort,
        close: () => {
          // Drop keep-alive sockets so the process can exit promptly.
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

interface LifecycleBody {
  profile?: string;
  services?: string[];
  allowUnsafe?: boolean;
  unsafeApproval?: UnsafeApproval;
}

function parseUnsafeApproval(body: LifecycleBody, project: Project): { ok: boolean; error?: string; approval?: UnsafeApproval } {
  if (!project.metadata?.unsafe) return { ok: true };
  // The server NEVER authorizes unsafe projects by itself. The request must carry
  // an explicit, well-formed approval object. A bare boolean is rejected as ambiguous.
  const a = body.unsafeApproval;
  if (a === undefined && body.allowUnsafe === true) {
    return { ok: false, error: 'Unsafe project: a bare allowUnsafe flag is ambiguous over HTTP. Provide unsafeApproval {projectId, reason}.' };
  }
  if (!isUnsafeAuthorized(project, false, a)) {
    return { ok: false, error: 'Unsafe project: missing or malformed unsafeApproval {projectId, reason} (reason must be at least 8 characters).' };
  }
  return { ok: true, approval: a };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') return sendHtml(res, dashboardHtml());

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', projectId: '', at: Date.now() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname === '/api/projects') {
    const projects = listProjects().map((p) => summarize(p));
    return sendJson(res, projects);
  }

  if (url.pathname === '/api/projects/discover' && req.method === 'POST') {
    const root = JSON.parse((await readBody(req)) || '{}').path as string;
    const outcome = discover(root, root.split('/').pop());
    return sendJson(res, {
      project: outcome.project,
      confidence: outcome.confidence,
      warnings: outcome.warnings,
      ambiguous: outcome.ambiguous,
      targets: outcome.targets,
    });
  }

  const detail = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[1]!);
    const project = loadProject(id);
    if (!project) return sendJson(res, { error: 'not found' }, 404);
    return sendJson(res, summarize(project));
  }

  const lifecycle = url.pathname.match(/^\/api\/projects\/([^/]+)\/(start|stop|restart)$/);
  if (lifecycle && req.method === 'POST') {
    const id = decodeURIComponent(lifecycle[1]!);
    const action = lifecycle[2] as 'start' | 'stop' | 'restart';
    const project = loadProject(id);
    if (!project) return sendJson(res, { error: 'not found' }, 404);
    const body = await readBody(req).catch(() => '{}');
    const parsed = body ? (JSON.parse(body) as LifecycleBody) : {};
    const auth = parseUnsafeApproval(parsed, project);
    if (!auth.ok) return sendJson(res, { error: auth.error }, 403);
    return sendJson(res, await runLifecycle(project, action, parsed));
  }

  const verify = url.pathname.match(/^\/api\/projects\/([^/]+)\/verify$/);
  if (verify && req.method === 'POST') {
    const id = decodeURIComponent(verify[1]!);
    const project = loadProject(id);
    if (!project) return sendJson(res, { error: 'not found' }, 404);
    const body = await readBody(req).catch(() => '{}');
    const parsed = body ? (JSON.parse(body) as LifecycleBody) : {};
    const auth = parseUnsafeApproval(parsed, project);
    if (!auth.ok) return sendJson(res, { error: auth.error }, 403);
    const { verifyProject } = await import('./verify.js');
    publishEvent({ type: 'verification.started', projectId: id });
    const result = await verifyProject(project, { profile: parsed.profile, services: parsed.services, unsafeApproval: auth.approval });
    publishEvent({ type: 'verification.completed', projectId: id, detail: result.status });
    return sendJson(res, result);
  }

  const doctor = url.pathname.match(/^\/api\/projects\/([^/]+)\/doctor$/);
  if (doctor) {
    const id = decodeURIComponent(doctor[1]!);
    const project = loadProject(id);
    if (!project) return sendJson(res, { error: 'not found' }, 404);
    return sendJson(res, {
      project: id,
      readiness: computeReadiness(project, isVerificationCurrent(project)),
      verification: project.verification ? { ...project.verification, current: isVerificationCurrent(project) } : null,
    });
  }

  const explain = url.pathname.match(/^\/api\/projects\/([^/]+)\/explain$/);
  if (explain) {
    const id = decodeURIComponent(explain[1]!);
    const project = loadProject(id);
    if (!project) return sendJson(res, { error: 'not found' }, 404);
    return sendJson(res, {
      project: id,
      root: project.root,
      verification: project.verification ? { ...project.verification, current: isVerificationCurrent(project) } : null,
      readiness: computeReadiness(project, isVerificationCurrent(project)),
      services: project.services.map((s) => ({
        id: s.id,
        command: s.command,
        cwd: s.cwd || '.',
        runtime: s.runtime || 'process',
        dependsOn: s.dependsOn || [],
        healthCheck: s.healthCheck,
        provenance: s.provenance || { source: 'manual' },
      })),
    });
  }

  const save = url.pathname.match(/^\/api\/projects\/([^/]+)\/save$/);
  if (save && req.method === 'POST') {
    const id = decodeURIComponent(save[1]!);
    const body = await readBody(req).catch(() => '{}');
    const parsed = body ? (JSON.parse(body) as { project?: Project }) : {};
    if (!parsed.project || parsed.project.id !== id) return sendJson(res, { error: 'body must contain the full project with a matching id' }, 400);
    const { validateProjectStructure } = await import('./safety.js');
    const errors = validateProjectStructure(parsed.project);
    if (errors.length) return sendJson(res, { error: 'invalid project', errors }, 400);
    saveProject(parsed.project);
    publishEvent({ type: 'project.saved', projectId: id });
    return sendJson(res, { ok: true });
  }

  const logs = url.pathname.match(/^\/api\/projects\/([^/]+)\/logs$/);
  if (logs) {
    return sendJson(res, recentLogs(decodeURIComponent(logs[1]!)));
  }

  return sendJson(res, { error: 'not found' }, 404);
}

export function summarize(project: Project): {
  project: Project;
  runtime: RuntimeProjectState | null;
  verification: (Project['verification'] & { current: boolean }) | null;
  readiness: ReturnType<typeof computeReadiness>;
} {
  return {
    project,
    runtime: readState(project.id),
    verification: project.verification ? { ...project.verification, current: isVerificationCurrent(project) } : null,
    readiness: computeReadiness(project, isVerificationCurrent(project)),
  };
}

async function runLifecycle(project: Project, action: 'start' | 'stop' | 'restart', body: LifecycleBody): Promise<unknown> {
  const { ProjectManager } = await import('./manager.js');
  const mgr = new ProjectManager(project);
  const previous = new Map<string, string>();
  const snapshot = (): void => {
    for (const [id, s] of Object.entries(mgr.getState().services)) previous.set(id, `${s.status}|${s.health?.status}`);
  };
  snapshot();
  const emitDiff = (): void => {
    for (const [id, s] of Object.entries(mgr.getState().services)) {
      const key = `${s.status}|${s.health?.status}`;
      if (previous.get(id) !== key) {
        previous.set(id, key);
        const event =
          s.status === 'starting' ? 'service.starting'
          : s.status === 'healthy' ? 'service.healthy'
          : s.status === 'running' ? 'service.started'
          : s.status === 'crashed' || s.status === 'failed' ? 'service.failed'
          : s.status === 'unhealthy' ? 'service.unhealthy'
          : s.status === 'stopped' ? 'service.exited'
          : s.status === 'stopping' ? 'service.stopping'
          : 'service.state';
        publishEvent({ type: event, projectId: project.id, service: id, detail: s.health?.detail });
      }
    }
  };
  mgr.on('state', emitDiff);
  publishEvent({ type: `project.${action}`, projectId: project.id });
  if (action === 'stop' || action === 'restart') {
    await mgr.reconcileWithIdentity();
    await mgr.stop(body.services);
  }
  if (action === 'stop') {
    publishEvent({ type: 'project.stopped', projectId: project.id });
    return { ok: true, action };
  }
  const startResult = await mgr.start({ profile: body.profile, services: body.services, unsafeApproval: body.unsafeApproval });
  const ok = startResult.failed.length === 0;
  publishEvent({ type: ok ? 'project.started' : 'project.failed', projectId: project.id });
  return { ok, action, result: startResult };
}

function recentLogs(id: string): { files: string[]; tail: string } {
  const dir = join(logDir(), id);
  if (!existsSync(dir)) return { files: [], tail: '' };
  const files = readdirSync(dir).sort();
  let tail = '';
  for (const f of files.slice(-2)) {
    try {
      const c = readFileSync(join(dir, f), 'utf8');
      tail += `== ${f} ==\n${c.split('\n').slice(-80).join('\n')}\n`;
    } catch {
      /* ignore */
    }
  }
  return { files, tail };
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function dashboardHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Project Launcher</title>
<style>
  body { font-family: system-ui, sans-serif; background:#111; color:#eee; margin:0; padding:24px; }
  h1 { font-size:18px; }
  #search { background:#222; color:#eee; border:1px solid #444; border-radius:6px; padding:8px; width:100%; max-width:520px; font-size:14px; }
  .proj { border:1px solid #333; border-radius:8px; padding:12px; margin:8px 0; background:#181818; }
  .proj.selected { border-color:#888; }
  .name { font-size:15px; font-weight:600; }
  .svc { font-size:13px; color:#aaa; margin-left:16px; }
  .meta { font-size:12px; color:#777; }
  .tag { display:inline-block; font-size:11px; border:1px solid #444; border-radius:4px; padding:1px 6px; margin-right:4px; }
  button { background:#2a2a2a; color:#eee; border:1px solid #444; border-radius:6px; padding:4px 10px; margin-right:6px; cursor:pointer; }
  button:hover { background:#333; }
  button.danger { border-color:#a33; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; }
  .green { background:#3fb950; } .red { background:#f85149; } .yellow { background:#d29922; } .grey { background:#555; }
  pre { background:#0d0d0d; padding:10px; border-radius:6px; max-height:220px; overflow:auto; font-size:12px; }
  #events { font-size:12px; color:#9ad; max-height:140px; overflow:auto; }
  input.txt { background:#222; color:#eee; border:1px solid #444; border-radius:6px; padding:6px; width:360px; }
  .hint { font-size:12px; color:#666; }
</style></head><body>
<h1>Project Launcher</h1>
<div><input id="search" placeholder="Search projects... (j/k move, S start, X stop, R restart, L logs, D details, V verify)"></div>
<pre id="disc"></pre>
<div id="events"></div>
<div id="list"></div>
<script>
let projects = [];
let selected = 0;
let filter = '';
const dot = s => ['healthy','running'].includes(s)?'green':['crashed','failed','unhealthy'].includes(s)?'red':['starting','stopping'].includes(s)?'yellow':'grey';
const rdot = r => r==='ready'?'green':['ready_but_unverified'].includes(r)?'yellow':['needs_environment','needs_docker','needs_device','needs_credentials','ambiguous','unknown'].includes(r)?'yellow':r==='unsafe'?'red':'red';
async function load(){
  projects = await (await fetch('/api/projects')).json();
  render();
}
function visible(){ return projects.filter(p => (p.project.name+' '+p.project.id).toLowerCase().includes(filter)); }
function render(){
  const list = visible();
  if (selected >= list.length) selected = Math.max(0, list.length - 1);
  const el = document.getElementById('list'); el.innerHTML='';
  list.forEach((p, i) => {
    const st = p.runtime;
    const svcs = Object.values(st?.services||{});
    const dotCls = svcs.some(s=>['crashed','failed','unhealthy'].includes(s.status))?'red':svcs.some(s=>['healthy','running'].includes(s.status))?'green':'grey';
    const ver = p.verification ? (p.verification.current ? 'VERIFIED' : p.verification.status.toUpperCase()+' (stale)') : 'UNVERIFIED';
    const div=document.createElement('div'); div.className='proj'+(i===selected?' selected':'');
    let html='<div class="name"><span class="dot '+dotCls+'"></span>'+p.project.name+
      ' <span class="tag">'+ver+'</span><span class="tag">'+p.readiness.status+'</span></div>';
    html+='<div class="meta">'+p.project.root+'</div>';
    html+=svcs.map(s=>'<div class="svc"><span class="dot '+dot(s.status)+'"></span>'+s.id+': '+s.status+(s.health?.detail?' — '+s.health.detail:'')+'</div>').join('');
    if (p.readiness.blockers.length) html+=p.readiness.blockers.map(b=>'<div class="svc">⛔ ['+b.type+'] '+b.message+'</div>').join('');
    html+='<div style="margin-top:8px">'+
      '<button onclick="act(\\''+p.project.id+'\\',\\'start\\')">Start</button>'+
      '<button onclick="act(\\''+p.project.id+'\\',\\'stop\\')">Stop</button>'+
      '<button onclick="act(\\''+p.project.id+'\\',\\'restart\\')">Restart</button>'+
      '<button onclick="verify(\\''+p.project.id+'\\')">Verify</button>'+
      '<button onclick="logs(\\''+p.project.id+'\\')">Logs</button>'+
      '<button onclick="details(\\''+p.project.id+'\\')">Details</button></div>';
    div.innerHTML=html;
    el.appendChild(div);
  });
}
async function act(id,action,extra){
  const p = projects.find(x=>x.project.id===id);
  let body = Object.assign({}, extra||{});
  if (p && p.project.metadata && p.project.metadata.unsafe && (action==='start'||action==='restart'||action==='verify')) {
    const reason = prompt('UNSAFE PROJECT\\n\\n'+p.project.name+': '+(p.project.metadata.unsafe_reason||'')+'\\n\\nType a reason to explicitly authorize this '+action+':');
    if (!reason || reason.trim().length < 8) { alert('Refused: explicit reason required.'); return; }
    body.unsafeApproval = { projectId: id, reason: reason.trim() };
  }
  const endpoint = action==='verify' ? '/verify' : '/'+action;
  const r = await fetch('/api/projects/'+id+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const out = await r.json();
  if (!r.ok) alert('Failed: '+(out.error||r.status));
  load();
}
async function verify(id){ return act(id,'verify'); }
async function logs(id){ const r=await (await fetch('/api/projects/'+id+'/logs')).json(); document.getElementById('disc').textContent=r.tail||'(no logs)'; }
async function details(id){ const r=await (await fetch('/api/projects/'+id+'/explain')).json(); document.getElementById('disc').textContent=JSON.stringify(r,null,2); }
document.getElementById('search').addEventListener('input', e=>{ filter=e.target.value.toLowerCase(); selected=0; render(); });
document.addEventListener('keydown', e=>{
  if (e.target.tagName==='INPUT' && e.target.id!=='search') return;
  const list = visible();
  if (!list.length) return;
  const cur = list[selected];
  const k = e.key.toLowerCase();
  if (k==='j' || e.key==='ArrowDown'){ selected=Math.min(list.length-1,selected+1); render(); e.preventDefault(); }
  else if (k==='k' || e.key==='ArrowUp'){ selected=Math.max(0,selected-1); render(); e.preventDefault(); }
  else if (k==='s'){ act(cur.project.id,'start'); }
  else if (k==='x'){ act(cur.project.id,'stop'); }
  else if (k==='r'){ act(cur.project.id,'restart'); }
  else if (k==='l'){ logs(cur.project.id); }
  else if (k==='d'){ details(cur.project.id); }
  else if (k==='v'){ act(cur.project.id,'verify'); }
  else if (e.key==='Enter'){ const anyRunning = Object.values(cur.runtime?.services||{}).some(s=>['running','healthy'].includes(s.status)); act(cur.project.id, anyRunning?'stop':'start'); }
});
const es = new EventSource('/api/events');
es.onmessage = e=>{
  try {
    const ev = JSON.parse(e.data);
    if (!ev.type || ev.type==='connected') return;
    const box = document.getElementById('events');
    const line = document.createElement('div');
    line.textContent = new Date(ev.at).toLocaleTimeString()+' '+ev.type+' '+ev.projectId+(ev.service?' / '+ev.service:'')+(ev.detail?' — '+ev.detail:'');
    box.prepend(line);
    while (box.children.length > 30) box.lastChild.remove();
    if (['project.started','project.stopped','project.failed','verification.completed','service.failed'].includes(ev.type)) load();
  } catch {}
};
load(); setInterval(load, 8000);
</script>
</body></html>`;
}
