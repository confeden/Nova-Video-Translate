// Local diagnostics sink for the NVT extension. Run: node tools/diag-server.mjs
// The extension's background POSTs page logs to http://127.0.0.1:8765/log; they land in logs/diag.jsonl.
// Old records survive version changes. Rotate at 16 MiB without deleting history.
import { createServer } from 'node:http';
import { mkdirSync as mkdirAudio } from 'node:fs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8765;
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const LOG_FILE = join(LOG_DIR, 'diag.jsonl');
const VERSION_FILE = join(LOG_DIR, 'version.txt');
const MAX_BYTES = 16 * 1024 * 1024;
let lastWrite = null;

mkdirSync(LOG_DIR, { recursive: true });

function rotate(version) {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size >= MAX_BYTES) {
    renameSync(LOG_FILE, join(LOG_DIR, `diag-${Date.now()}.jsonl`));
  }
  writeFileSync(VERSION_FILE, version);
}

createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return res.writeHead(403).end();
  // only the local extension talks to this server; CORS is open for loopback only
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ app: 'nvt-diag', protocol: 2, file: LOG_FILE, lastWrite, version: existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, 'utf8').trim() : null }));
  }
  if (req.method !== 'POST' || (req.url !== '/log' && req.url !== '/audio')) return res.writeHead(404).end();
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > MAX_BYTES) { res.writeHead(413).end(); req.destroy(); }
  });
  req.on('end', () => {
    try {
      const msg = JSON.parse(body);
      if (req.url === '/audio') {
        // a decoded dub as 16-bit mono WAV in logs/audio/ (devlog only); the name carries the segment start and its noise floor
        const dir = join(LOG_DIR, 'audio');
        mkdirAudio(dir, { recursive: true });
        const pcm = Buffer.from(String(msg.pcm16), 'base64');
        const head = Buffer.alloc(44);
        head.write('RIFF', 0);
        head.writeUInt32LE(36 + pcm.length, 4);
        head.write('WAVEfmt ', 8);
        head.writeUInt32LE(16, 16);
        head.writeUInt16LE(1, 20);
        head.writeUInt16LE(1, 22);
        head.writeUInt32LE(Number(msg.sampleRate), 24);
        head.writeUInt32LE(Number(msg.sampleRate) * 2, 28);
        head.writeUInt16LE(2, 32);
        head.writeUInt16LE(16, 34);
        head.write('data', 36);
        head.writeUInt32LE(pcm.length, 40);
        const safe = String(msg.name).replace(/[^\w.-]/g, '_');
        writeFileSync(join(dir, `${safe}.wav`), Buffer.concat([head, pcm]));
        return res.writeHead(200).end('ok');
      }
      if (!Array.isArray(msg.entries)) return res.writeHead(400).end('entries must be an array');
      rotate(String(msg.version ?? 'unknown'));
      const at = new Date().toISOString();
      const lines = (msg.entries ?? []).map((e) => JSON.stringify({ at, version: msg.version, page: msg.page, ...e }));
      appendFileSync(LOG_FILE, lines.join('\n') + '\n');
      lastWrite = at;
      res.writeHead(200).end('ok');
    } catch (e) {
      console.error('NVT diag write failed:', e instanceof Error ? e.message : String(e));
      res.writeHead(500).end('log write failed');
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`NVT diag sink: http://127.0.0.1:${PORT}/log -> ${LOG_FILE}`));
