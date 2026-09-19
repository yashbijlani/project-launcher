import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from './types.js';
import { listProjects, loadProject } from './config.js';
import { readState } from './state.js';
import { discover } from './discovery.js';
import { logDir } from './paths.js';

export interface ServerOptions {
  port?: number;
  host?: string;
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
      resolve({ port: actualPort, close: () => server.close() });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') return sendHtml(res, dashboardHtml());

  if (url.pathname === '/api/projects') {
    const projects = listProjects().map((p) => ({ ...p, runtime: readState(p.id) }));
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
    });
  }

  const detail = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[1]!);
    const project = loadProject(id);
    if (!project) return sendJson(res, { error: 'not found' }, 404);
    return sendJson(res, { project, runtime: readState(id) });
  }

  const lifecycle = url.pathname.match(/^\/api\/projects\/([^/]+)\/(start|stop|restart)$/);
  if (lifecycle && req.method === 'POST') {
    const id = decodeURIComponent(lifecycle[1]!);
    const action = lifecycle[2] as 'start' | 'stop' | 'restart';
    const project = loadProject(id);
    if (!project) return sendJson(res, { error: 'not found' }, 404);
    const body = await readBody(req).catch(() => '{}');
    const parsed = body ? (JSON.parse(body) as { profile?: string }) : {};
    return sendJson(res, await runLifecycle(project, action, parsed.profile));
  }

  const logs = url.pathname.match(/^\/api\/projects\/([^/]+)\/logs$/);
  if (logs) {
    return sendJson(res, recentLogs(decodeURIComponent(logs[1]!)));
  }

  return sendJson(res, { error: 'not found' }, 404);
}

async function runLifecycle(project: Project, action: 'start' | 'stop' | 'restart', profile?: string): Promise<unknown> {
  const { ProjectManager } = await import('./manager.js');
  const mgr = new ProjectManager(project);
  if (action === 'stop' || action === 'restart') {
    await mgr.reconcileOnAttach();
    await mgr.stop();
  }
  if (action === 'stop') return { ok: true, action };
  const startResult = await mgr.start({ profile, waitHealthy: true, allowUnsafe: true });
  return { ok: startResult.failed.length === 0, action, result: startResult };
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
  .proj { border:1px solid #333; border-radius:8px; padding:12px; margin:8px 0; background:#181818; }
  .name { font-size:15px; font-weight:600; }
  .svc { font-size:13px; color:#aaa; margin-left:16px; }
  .status { font-size:12px; color:#777; }
  button { background:#2a2a2a; color:#eee; border:1px solid #444; border-radius:6px; padding:4px 10px; margin-right:6px; cursor:pointer; }
  button:hover { background:#333; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; }
  .green { background:#3fb950; } .red { background:#f85149; } .yellow { background:#d29922; } .grey { background:#555; }
  pre { background:#0d0d0d; padding:10px; border-radius:6px; max-height:220px; overflow:auto; font-size:12px; }
  input { background:#222; color:#eee; border:1px solid #444; border-radius:6px; padding:6px; width:360px; }
</style></head><body>
<h1>Project Launcher</h1>
<div><input id="path" placeholder="/home/penguin/code/some-project"><button onclick="disc()">Discover</button></div>
<pre id="disc"></pre>
<div id="list"></div>
<script>
const dot = s => ['healthy','running'].includes(s)?'green':['crashed','failed','unhealthy'].includes(s)?'red':['starting','stopping'].includes(s)?'yellow':'grey';
async function load(){
  const projects = await (await fetch('/api/projects')).json();
  const el = document.getElementById('list'); el.innerHTML='';
  for (const p of projects){
    const st = p.runtime;
    const svcs = Object.values(st?.services||{});
    const dotCls = svcs.some(s=>['crashed','failed','unhealthy'].includes(s.status))?'red':svcs.some(s=>['healthy','running'].includes(s.status))?'green':'grey';
    const div=document.createElement('div'); div.className='proj';
    let html='<div class="name"><span class="dot '+dotCls+'"></span>'+p.name+' <span class="status">('+p.id+')</span></div>';
    html+=svcs.map(s=>'<div class="svc"><span class="dot '+dot(s.status)+'"></span>'+s.id+': '+s.status+(s.health?.detail?' — '+s.health.detail:'')+'</div>').join('');
    html+='<div style="margin-top:8px"><button onclick="act(\\''+p.id+'\\',\\'start\\')">Start</button>'+
      '<button onclick="act(\\''+p.id+'\\',\\'stop\\')">Stop</button>'+
      '<button onclick="act(\\''+p.id+'\\',\\'restart\\')">Restart</button>'+
      '<button onclick="logs(\\''+p.id+'\\')">Logs</button></div>';
    div.innerHTML=html;
    el.appendChild(div);
  }
}
async function act(id,action){ await fetch('/api/projects/'+id+'/'+action,{method:'POST',body:'{}'}); load(); }
async function logs(id){ const r=await (await fetch('/api/projects/'+id+'/logs')).json(); document.getElementById('disc').textContent=r.tail||'(no logs)'; }
async function disc(){ const path=document.getElementById('path').value; const r=await (await fetch('/api/projects/discover',{method:'POST',body:JSON.stringify({path})})).json(); document.getElementById('disc').textContent=JSON.stringify(r,null,2); }
load(); setInterval(load, 4000);
</script>
</body></html>`;
}
