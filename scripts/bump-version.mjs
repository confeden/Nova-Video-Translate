#!/usr/bin/env node
// Usage: node scripts/bump-version.mjs [patch|minor|major]   (default: patch)
// Keeps the root, extension and userscript package.json versions identical. WXT takes the manifest version from
// apps/extension/package.json; apps/userscript/vite.config.ts reads apps/userscript/package.json for @version.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['package.json', 'apps/extension/package.json', 'apps/userscript/package.json'].map((f) => join(root, f));
const kind = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error(`unknown bump "${kind}" (use patch | minor | major)`);
  process.exit(1);
}

const cur = JSON.parse(readFileSync(files[1], 'utf8')).version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur);
if (!m) {
  console.error(`apps/extension/package.json has a non-semver version: ${cur}`);
  process.exit(1);
}
let [maj, min, pat] = m.slice(1).map(Number);
if (kind === 'major') [maj, min, pat] = [maj + 1, 0, 0];
else if (kind === 'minor') [min, pat] = [min + 1, 0];
else pat += 1;
const next = `${maj}.${min}.${pat}`;

for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const json = JSON.parse(raw);
  json.version = next;
  writeFileSync(f, `${JSON.stringify(json, null, 2)}\n`);
}
console.log(`NVT version ${cur} -> ${next}`);
