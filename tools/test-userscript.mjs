// Browser smoke test with a GM shim; --models also downloads and runs real Silero/Whisper models. No API keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = process.argv.includes('--models');
const fixtures = process.argv.includes('--fixtures');
const ttsOnly = process.argv.includes('--tts-only');
const cpu = process.argv.includes('--cpu');
const profile = fs.mkdtempSync(path.join(root, 'logs', 'userscript-chrome-'));
const source = fs.readFileSync(path.join(root, 'apps/userscript/dist/@nvt/userscript.user.js'), 'utf8');
const resources = Object.fromEntries(Object.entries({
  ortBundle: 'node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs',
  ortGlue: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
  transformersBundle: 'node_modules/@huggingface/transformers/dist/transformers.min.js',
  hfGlue: 'node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs',
  piperJs: 'apps/extension/public/piper/piper_phonemize.js',
}).map(([key, file]) => [key, fs.readFileSync(path.join(root, file), 'utf8')]));
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/fixture') {
      const target = new URL(url.searchParams.get('url'));
      const name = target.pathname.split('/').pop();
      const file = target.pathname.includes('/whisper-tiny.en/') ? path.join(root, 'logs/whisper-fixtures', target.pathname.split('/resolve/')[1].split('/').slice(1).join('/')) :
        target.pathname.includes('/silero/') ? path.join(root, 'research/silero_onnx/models', name) :
        target.pathname.includes('transformers@') ? path.join(root, 'node_modules/@huggingface/transformers/dist', name) :
        target.pathname.includes('piper-wasm@') ? path.join(root, 'apps/extension/public/piper', name) : path.join(root, 'node_modules/onnxruntime-web/dist', name);
      assert.ok(fs.existsSync(file), `missing fixture ${name}`);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    } else if (url.pathname === '/gm') {
      const target = new URL(url.searchParams.get('url'));
      assert.match(target.hostname, /(^|\.)(storage\.beget\.cloud|huggingface\.co|hf\.co|jsdelivr\.net)$/);
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;
      const response = await fetch(target, { headers });
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
      res.writeHead(response.status, responseHeaders);
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } else if (url.pathname === '/nvt.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(source);
    else res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>NVT userscript smoke</title><script>
      const values = new Map([['nvt.settings', {autoTranslate:'off'}]]);
      const resources = ${JSON.stringify(resources).replaceAll('<', '\\u003c')};
      window.GM_getValue = k => values.get(k);
      window.GM_setValue = (k,v) => values.set(k,v);
      window.GM_deleteValue = k => values.delete(k);
      window.GM_getResourceText = k => resources[k];
      window.GM_registerMenuCommand = (name,fn) => {window.nvtOpenPanel = fn};
      window.GM_addValueChangeListener = () => {};
      window.GM_info = {};
      window.NVT_importModule = url => import(url);
      window.__testShadows = [];
      const attachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) {const root=attachShadow.call(this,options);__testShadows.push(root);return root};
      window.unsafeWindow = window;
      if (${cpu}) Object.defineProperty(navigator,'gpu',{value:undefined});
      window.GM_xmlhttpRequest = d => {
        const ac = new AbortController();
        const timer = setTimeout(()=>ac.abort(),d.timeout || 90000);
        const target=${fixtures} && (d.url.includes('/silero/') || d.url.includes('/whisper-tiny.en/') || d.url.endsWith('.wasm')) ? '/fixture?url='+encodeURIComponent(d.url) : d.url;
        fetch(target,{headers:d.headers,signal:ac.signal,credentials:'omit'})
          .then(async r => {const meta={status:r.status,responseHeaders:[...r.headers].map(x=>x.join(': ')).join('\\r\\n')};if(d.responseType==='stream')d.onloadstart({...meta,response:r.body});else d.onload({...meta,response:await r.arrayBuffer()})})
          .catch(e=>ac.signal.aborted ? d.onabort?.() : d.onerror?.({error:e.message}))
          .finally(()=>clearTimeout(timer));
        return {abort:()=>ac.abort()};
      };
      </script><script src=/nvt.js></script><body></body>`);
  } catch (e) { res.writeHead(500).end(e.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn(process.env.NVT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--window-position=2600,50', '--window-size=1600,900', '--autoplay-policy=no-user-gesture-required', origin,
], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
const pending = new Map();
let seq = 0;
const events = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}
async function until(expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`timeout: ${expression}; errors: ${JSON.stringify(events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Runtime.consoleAPICalled').slice(-5))}`);
}
try {
  const activePort = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(activePort) && i < 80; i++) await sleep(250);
  const port = Number(fs.readFileSync(activePort, 'utf8').split('\n')[0]);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = tabs.find(tab => tab.url.startsWith(origin));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) {
      const callback = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? callback.reject(new Error(JSON.stringify(msg.error))) : callback.resolve(msg.result);
    } else events.push(msg);
  };
  await send('Runtime.enable');
  await until('!!globalThis.__nvt?.localModels');
  const capabilities = await evaluate(`(async()=>({asr:await __nvt.localModels.getLocalAsrInfo(),tts:await __nvt.localModels.getLocalTtsInfo()}))()`);
  assert.equal(capabilities.asr.env.offscreen, true);
  assert.equal(capabilities.tts.env.offscreen, true);
  console.log(JSON.stringify({ smoke: 'ok', gpu: capabilities.tts.env.gpu, tap: await evaluate('__nvt.tap') }));
  await evaluate('nvtOpenPanel()');
  await until(`__testShadows.some(root=>root.textContent.includes('Groq') && root.textContent.includes('Локаль'))`);
  if (models) {
    await evaluate(`__nvt.localModels.localTtsDownload('silero-cpu','eugene')`);
    await until(`(async()=>{const s=(await __nvt.localModels.getLocalTtsInfo()).units.silero;if(s?.model==='error')throw Error(s.error);return s?.model==='ready'})()`, 600000);
    const tts = await evaluate(`(async()=>{const r=await __nvt.localModels.localTtsTest('silero-cpu','eugene','Проверка русского голоса.');const b=atob(r.pcmB64);let energy=0;for(let i=0;i<b.length;i+=2){let n=b.charCodeAt(i)|(b.charCodeAt(i+1)<<8);if(n>=32768)n-=65536;energy+=(n/32768)**2}return {duration:r.durationSec,ms:r.ms,rms:Math.sqrt(energy/(b.length/2))}})()`);
    assert.ok(tts.rms > 0.005 && tts.duration > 0.3);
    console.log(JSON.stringify({ tts: 'ok', fixtures, ...tts }));
    if (!ttsOnly) {
    const model = 'onnx-community/whisper-tiny.en';
    await evaluate(`__nvt.localModels.localAsrDownload(${JSON.stringify(model)})`);
    await until(`(async()=>{const s=(await __nvt.localModels.getLocalAsrInfo()).units[${JSON.stringify(model)}];if(s?.model==='error')throw Error(s.error);return s?.model==='ready'})()`, 600000);
    const wave = fs.readFileSync(path.join(root, 'research/capture_yt.wav'));
    const pcm = wave.subarray(44).toString('base64');
    const asr = await evaluate(`__nvt.localAsr.send({op:'transcribe',id:'smoke-asr',model:${JSON.stringify(model)},pcmB64:${JSON.stringify(pcm)},lang:'en'})`);
    assert.equal(asr.ok, true, asr.error);
    assert.ok(asr.text?.trim() || asr.segments?.length, JSON.stringify(asr));
    console.log(JSON.stringify({ asr: 'ok', text: asr.text, segments: asr.segments?.length, device: asr.device }));
    }
  }
  const errors = events.filter(event => event.method === 'Runtime.exceptionThrown');
  assert.equal(errors.length, 0, JSON.stringify(errors));
} finally {
  ws?.close();
  child.kill();
  server.closeAllConnections();
  server.close();
}
