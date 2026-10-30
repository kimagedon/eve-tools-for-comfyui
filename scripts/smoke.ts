// Smoke test against a live ComfyUI: node scripts/smoke.ts <server> <edit|flf|i2v> <image> [image2]
// Also writes the API-format graphs to workflows/ (node scripts/smoke.ts export).
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { editGraph, shotFlfGraph, shotI2vGraph, type ApiGraph } from '../src/workflows.ts';

const [server, mode, img1, img2] = process.argv.slice(2);

if (server === 'export') {
  const shot = { prompt: 'Slow cinematic dolly-in, steady camera.', seed: 1, width: 1280, height: 536, seconds: 4 };
  const out: Record<string, ApiGraph> = {
    'edit.json': editGraph({ image1: 'input.png', image2: 'guide.png', prompt: 'Extend the scene.', seed: 1 }),
    'shot-video.json': shotFlfGraph({ ...shot, first: 'first.png', last: 'last.png' }),
    'shot-video-i2v.json': shotI2vGraph({ ...shot, first: 'first.png' }),
  };
  for (const [f, g] of Object.entries(out)) writeFileSync(`workflows/${f}`, JSON.stringify(g, null, 2) + '\n');
  console.log('exported', Object.keys(out).join(', '));
  process.exit(0);
}

async function upload(path: string) {
  const fd = new FormData();
  fd.append('image', new Blob([readFileSync(path)]), basename(path));
  fd.append('overwrite', 'true');
  const j = await (await fetch(`${server}/upload/image`, { method: 'POST', body: fd })).json();
  return j.name as string;
}

const t0 = Date.now();
const a = await upload(img1);
const b = img2 ? await upload(img2) : undefined;
const seed = 7;
const shot = { prompt: 'Slow cinematic dolly-in toward the centre, steady camera, natural light drifting.', seed, width: 1280, height: 536, seconds: 4 };
const graph =
  mode === 'edit' ? editGraph({ image1: a, image2: b, prompt: 'Extend the scene beyond the frame naturally, photorealistic.', seed })
  : mode === 'flf' ? shotFlfGraph({ ...shot, first: a, last: b ?? a })
  : shotI2vGraph({ ...shot, first: a });
const r = await fetch(`${server}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph }) });
const j = await r.json();
if (!r.ok || j.error) { console.error(JSON.stringify(j, null, 2).slice(0, 3000)); process.exit(1); }
const id = j.prompt_id;
console.log('queued', id);
for (;;) {
  await new Promise((res) => setTimeout(res, 3000));
  const h = (await (await fetch(`${server}/history/${id}`)).json())[id];
  if (!h) continue;
  if (h.status?.status_str === 'error') { console.error(JSON.stringify(h.status.messages.at(-1)).slice(0, 2000)); process.exit(1); }
  if (h.status?.completed) {
    for (const o of Object.values<any>(h.outputs)) for (const f of [...(o.images ?? []), ...(o.videos ?? []), ...(o.gifs ?? [])]) {
      const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
      const buf = Buffer.from(await (await fetch(`${server}/view?${q}`)).arrayBuffer());
      const out = `.smoke/smoke-${mode}-${f.filename.split('/').pop()}`;
      writeFileSync(out, buf);
      console.log('saved', out, buf.length, 'bytes', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    }
    break;
  }
}
