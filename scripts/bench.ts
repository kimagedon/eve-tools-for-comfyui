// Per-node timing against a live ComfyUI (websocket "executing" events).
//   node scripts/bench.ts <server> <edit|outpaint|flf|i2v> <image> [image2] [key=value ...]
// Options: seed=7  tag=name  cache=1 (no prompt nonce)  decode=tiled|full|T:O:TT:TO (VAEDecodeTiled tile/overlap/temporal/temporal overlap)
//          front=1 (jump the queue)  prompt="..."  nosave=1
// Prints queue wait, per-node seconds and the total; the output lands in .smoke/bench-<tag>-*.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { editGraph, outpaintGraph, shotFlfGraph, shotI2vGraph, type ApiGraph } from '../src/workflows.ts';

const args = process.argv.slice(2);
const opts = Object.fromEntries(args.filter((a) => /^\w+=/.test(a)).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const [server, mode, img1, img2] = args.filter((a) => !/^\w+=/.test(a));
const seed = Number(opts.seed ?? 7);
const tag = opts.tag ?? mode;

async function upload(path: string) {
  const fd = new FormData();
  fd.append('image', new Blob([readFileSync(path)]), `bench-${basename(path)}`);
  fd.append('overwrite', 'true');
  const j = await (await fetch(`${server}/upload/image`, { method: 'POST', body: fd })).json();
  return j.name as string;
}

const a = await upload(img1);
const b = img2 ? await upload(img2) : undefined;
// A nonce in the prompt defeats ComfyUI's node cache so text encoders really run (cache=1 keeps it).
const nonce = opts.cache ? '' : ` Take ${Date.now() % 100000}.`;
const shot = { prompt: (opts.prompt ?? 'Slow cinematic dolly-in toward the centre, steady camera, natural light drifting.') + nonce, seed, width: 1280, height: 536, seconds: 4 };
const editPrompt = (opts.prompt ?? 'Extend the scene beyond the frame naturally, photorealistic.') + nonce;
const graph: ApiGraph =
  mode === 'edit' ? editGraph({ image1: a, image2: b, prompt: editPrompt, seed })
  : mode === 'outpaint' ? outpaintGraph({ canvas: b ?? a, original: a, prompt: editPrompt, seed })
  : mode === 'flf' ? shotFlfGraph({ ...shot, first: a, last: b ?? a })
  : shotI2vGraph({ ...shot, first: a });

// Decode variants for the LTX tail experiments.
if (opts.decode && graph.decode) {
  const src = graph.decode.inputs.samples, vae = graph.decode.inputs.vae;
  if (opts.decode === 'full') graph.decode = { class_type: 'VAEDecode', inputs: { samples: src, vae } };
  else if (opts.decode !== 'tiled') {
    const [tile_size, overlap, temporal_size, temporal_overlap] = opts.decode.split(':').map(Number);
    graph.decode = { class_type: 'VAEDecodeTiled', inputs: { samples: src, vae, tile_size, overlap, temporal_size, temporal_overlap } };
  }
}
if (opts.nosave && graph.save) graph.save.class_type = 'PreviewImage';

const clientId = crypto.randomUUID();
const ws = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?clientId=${clientId}`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const t0 = performance.now();
const r = await fetch(`${server}/prompt`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: clientId, ...(opts.front ? { front: true } : {}) }),
});
const j = await r.json();
if (!r.ok || j.error) { console.error(JSON.stringify(j, null, 2).slice(0, 3000)); process.exit(1); }
const id = j.prompt_id as string;

const spans: { node: string; start: number; end?: number }[] = [];
let startedAt = 0;
let cached: string[] = [];
const done = new Promise<void>((resolve, reject) => {
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const m = JSON.parse(ev.data);
    if (m.data?.prompt_id !== id) return;
    const now = performance.now();
    if (m.type === 'execution_start') startedAt = now;
    if (m.type === 'execution_cached') cached = m.data.nodes ?? [];
    if (m.type === 'executing') {
      const last = spans.at(-1);
      if (last && last.end === undefined) last.end = now;
      if (m.data.node === null) resolve();
      else spans.push({ node: m.data.node, start: now });
    }
    if (m.type === 'execution_success') { const last = spans.at(-1); if (last && last.end === undefined) last.end = now; resolve(); }
    if (m.type === 'execution_error') reject(new Error(m.data.exception_message));
  };
});
await done;
const total = (performance.now() - t0) / 1000;

const h = (await (await fetch(`${server}/history/${id}`)).json())[id];
mkdirSync('.smoke', { recursive: true });
for (const o of Object.values<any>(h?.outputs ?? {})) for (const f of [...(o.images ?? []), ...(o.videos ?? []), ...(o.gifs ?? [])]) {
  if (f.type !== 'output') continue;
  const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
  const buf = Buffer.from(await (await fetch(`${server}/view?${q}`)).arrayBuffer());
  const out = `.smoke/bench-${tag}-${f.filename.split('/').pop()}`;
  writeFileSync(out, buf);
  console.log('saved', out, buf.length, 'bytes');
}
ws.close();

const rows = spans.map((s) => ({ node: `${s.node} (${graph[s.node]?.class_type ?? '?'})`, s: ((s.end ?? s.start) - s.start) / 1000 })).filter((r) => r.s >= 0.05);
console.log(`[${tag}] queue wait ${((startedAt - t0) / 1000).toFixed(1)}s, cached ${cached.length} nodes`);
for (const r of rows) console.log(`  ${r.s.toFixed(2).padStart(7)}s  ${r.node}`);
console.log(`[${tag}] TOTAL ${total.toFixed(1)}s (exec ${((performance.now() - startedAt) / 1000 - 0).toFixed(1)}s incl. download)`);
