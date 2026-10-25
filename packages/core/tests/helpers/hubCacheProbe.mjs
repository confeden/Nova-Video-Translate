// Runs transformers.js' real getModelFile (Node) against a fake Cache seeded under the keys given in argv[2] (JSON {key: bytes[]}).
// Prints JSON {hit: number[], optionalMissing: null}. No network: allowRemoteModels = false.
import { pathToFileURL } from 'node:url';
const [, , hubPath, seedJson, model, revision, file] = process.argv;
const seed = JSON.parse(seedJson);
const store = new Map(Object.entries(seed).map(([k, v]) => [k, new Uint8Array(v)]));
globalThis.caches = { open: async () => ({ match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined), put: async () => {} }) };
const { getModelFile } = await import(pathToFileURL(hubPath).href);
const { env } = await import(new URL('../env.js', pathToFileURL(hubPath)).href);
env.useBrowserCache = true;
env.useFSCache = false;
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = 'https://invalid.local/nvt-no-local-models/';
const hit = await getModelFile(model, file, true, { revision });
const optionalMissing = await getModelFile(model, 'generation_config.json', false, { revision });
console.log(JSON.stringify({ hit: Array.from(hit), optionalMissing }));
process.exit(0);
