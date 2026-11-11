// Local development delivery: enable telemetry, build, keep a hidden loopback sink.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function health() {
  try {
    const r = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(1000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const prior = await health();
if (prior && (prior.app !== 'nvt-diag' || prior.protocol !== 2)) throw new Error('Port 8765 belongs to an incompatible service');
if (!prior) {
  mkdirSync(path.join(root, 'logs'), { recursive: true });
  const fd = openSync(path.join(root, 'logs', 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'tools', 'diag-server.mjs')], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  child.unref();
  closeSync(fd);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const h = await health();
    if (h?.app === 'nvt-diag' && h.protocol === 2) { ready = true; break; }
  }
  if (!ready) throw new Error('Diagnostics sink did not start; inspect logs/server.log');
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this tool with npm run dev:build');
const build = spawn(process.execPath, [npm, 'run', 'build'], { cwd: root, env: { ...process.env, NVT_DEVLOG: '1' }, stdio: 'inherit', windowsHide: true });
const code = await new Promise((resolve, reject) => { build.on('error', reject); build.on('exit', resolve); });
if (code !== 0) process.exit(typeof code === 'number' ? code : 1);
console.log('Dev logging enabled -> logs/diag.jsonl (127.0.0.1:8765). Reload the extension and video page.');
