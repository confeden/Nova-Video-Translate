// Read the local development logs without needing an exported diagnostics file.
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const file = fileURLToPath(new URL('../logs/diag.jsonl', import.meta.url));
const count = Math.max(1, Math.min(500, Number(process.argv[2]) || 60));
let fd;
try {
  fd = openSync(file, 'r');
  const size = fstatSync(fd).size;
  const start = Math.max(0, size - 512 * 1024);
  const b = Buffer.alloc(size - start);
  readSync(fd, b, 0, b.length, start);
  const lines = b.toString('utf8').trimEnd().split('\n');
  if (start) lines.shift();
  console.log(lines.slice(-count).join('\n'));
} catch (e) {
  console.error(`Cannot read development logs: ${e.message}. Run npm run dev:build.`);
  process.exitCode = 1;
} finally { if (fd !== undefined) closeSync(fd); }
