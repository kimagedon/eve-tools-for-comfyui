// Generates the demo plates on a live ComfyUI with the same edit graph: node scripts/gen-demo.ts <server>
import { readFileSync, writeFileSync } from 'node:fs';
import { editGraph } from '../src/workflows.ts';

const server = process.argv[2];
const SCENES: Record<string, string> = {
  'night-cafe': 'Replace the whole image with a photograph: an empty small cafe at night, warm pendant lamps over wooden tables, rain-streaked window, chairs pushed in, tiled floor, moody cinematic still, 35mm film look, no people, no text, no logos.',
  'workshop': 'Replace the whole image with a photograph: an empty craftsman woodworking workshop, workbench with hand tools, shelves of timber, dusty daylight from a high window, concrete floor, cinematic still, 35mm film look, no people, no text, no logos.',
  'corridor': 'Replace the whole image with a photograph: a long empty old apartment corridor with a tall window at the end, afternoon light falling across worn parquet, green painted walls, doors on both sides, cinematic still, 35mm film look, no people, no text, no logos.',
};
const fd = new FormData();
fd.append('image', new Blob([readFileSync('.smoke/grey.png')]), 'grey.png');
fd.append('overwrite', 'true');
const grey = (await (await fetch(`${server}/upload/image`, { method: 'POST', body: fd })).json()).name;
const ids = await Promise.all(Object.entries(SCENES).map(async ([name, prompt], i) => {
  const g = editGraph({ image1: grey, prompt, seed: 1000 + i, fast: false });
  const j = await (await fetch(`${server}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: g }) })).json();
  if (j.error) throw new Error(JSON.stringify(j));
  return [name, j.prompt_id] as const;
}));
for (const [name, id] of ids) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const h = (await (await fetch(`${server}/history/${id}`)).json())[id];
    if (!h?.status?.completed) { if (h?.status?.status_str === 'error') { console.error(name, 'failed'); break; } continue; }
    const f = Object.values<any>(h.outputs)[0].images[0];
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
    writeFileSync(`examples/${name}.png`, Buffer.from(await (await fetch(`${server}/view?${q}`)).arrayBuffer()));
    console.log('saved', name);
    break;
  }
}
