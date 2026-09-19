import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { startServer } from './server.js';

/**
 * Phase 15/16: minimal desktop launcher + global hotkey.
 *
 * The core runtime is a local HTTP server. The desktop client is deliberately
 * thin and isolated here so that if WebKitGTK / a window manager is missing,
 * nothing in the core breaks: we fall back to the default browser.
 *
 * Global hotkey: registration is delegated to the desktop environment
 * (Hyprland/omarchy) via a helper script in scripts/. We do not implement a
 * fragile X11 grab in Node.
 */

export interface DesktopOptions {
  port?: number;
  openBrowser?: boolean;
}

export async function startDesktop(opts: DesktopOptions = {}): Promise<void> {
  const server = await startServer({ port: opts.port });
  const url = `http://127.0.0.1:${server.port}/`;

  const webkit = detectWebkitLauncher();
  if (webkit && !opts.openBrowser) {
    process.stderr.write(`Opening desktop window (${webkit.name})...\n`);
    const child = spawn(webkit.command[0]!, webkit.command.slice(1).map((a) => a.replace('{url}', url)), {
      stdio: 'ignore',
    });
    child.on('exit', () => server.close());
    return;
  }

  process.stderr.write(`No WebKitGTK launcher found; opening default browser at ${url}\n`);
  spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  process.stderr.write('Press Ctrl+C to stop the launcher server.\n');
  await new Promise<void>(() => {
    /* keep serving until killed */
  });
}

interface WebkitLauncher {
  name: string;
  command: string[];
}

export function detectWebkitLauncher(): WebkitLauncher | null {
  // Option 1: a tiny GTK webview script using PyGObject (often present on Arch/omarchy).
  const gtk = spawnSync('python3', ['-c', 'import gi; gi.require_version("WebKit2","4.1")'], { stdio: 'ignore' });
  if (gtk.status === 0) {
    return { name: 'python-gtk-webview', command: ['python3', gtkWebviewScript(), '{url}'] };
  }
  // Option 2: `webkit-launcher` style binaries
  for (const bin of ['epiphany', 'surf']) {
    const r = spawnSync('which', [bin], { stdio: 'ignore' });
    if (r.status === 0) return { name: bin, command: [bin, '{url}'] };
  }
  return null;
}

let scriptPath: string | null = null;
function gtkWebviewScript(): string {
  if (scriptPath) return scriptPath;
  scriptPath = joinPath(tmpdir(), 'project-launcher-webview.py');
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env python3
import sys, gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2
url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8790/"
win = Gtk.Window(title="Project Launcher")
win.set_default_size(900, 700)
view = WebKit2.WebView()
view.load_uri(url)
win.add(view)
win.connect("destroy", Gtk.main_quit)
win.show_all()
Gtk.main()
`,
  );
  return scriptPath;
}
