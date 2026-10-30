#!/usr/bin/env node
/**
 * Export the finished project open in a running EVE Tools tab as a
 * pre-rendered sample bundle for the static (GitHub Pages) build.
 *
 *   node scripts/export-sample.mjs <id> [-s=<playwright-cli session>]
 *   e.g.  node scripts/export-sample.mjs night-cafe -s=e2e
 *
 * <id>     the sample's file name without extension: night-cafe | workshop | corridor
 * -s=...   the playwright-cli session whose tab holds the project (IndexedDB
 *          lives in that browser profile); omitted = the default session
 *
 * Needs the app served from this repo by `npm run dev` or `npm run preview`
 * (their server writes the files: scripts/sample-export-plugin.ts). Writes
 * public/samples/<id>/ — project.json, photo/plate/lit .jpg, per camera
 * <cam>-a.jpg, <cam>-b.jpg (≤ 1600 px) and the original LTX <cam>.mp4. A
 * bundle already there is moved to .smoke/samples-old/<id>-<time>/.
 *
 * Without playwright-cli: in the app tab's DevTools console run
 *   await __eveExportProject("night-cafe")
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("-"));
const session = args.find((a) => a.startsWith("-s=") || a.startsWith("--session="));
if (!id || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) {
  console.error("usage: node scripts/export-sample.mjs <id> [-s=<playwright-cli session>]   (id: night-cafe | workshop | corridor)");
  process.exit(2);
}

const fn = `async () => {
  if (!window.__eveExportProject) throw new Error("No exporter on this page: open the app on localhost (npm run dev / npm run preview)");
  return JSON.stringify(await window.__eveExportProject(${JSON.stringify(id)}));
}`;
const cli = spawnSync("playwright-cli", [...(session ? [`-s=${session.split("=")[1]}`] : []), "eval", fn], { encoding: "utf8", timeout: 180_000 });
const out = `${cli.stdout ?? ""}${cli.stderr ?? ""}`;
if (cli.error) { console.error(`playwright-cli failed to start: ${cli.error.message}`); process.exit(1); }
if (cli.status !== 0 || /Error:|### Error/.test(out)) { console.error(out.trim()); process.exit(1); }

const dir = join(import.meta.dirname, "..", "public", "samples", id);
const manifest = join(dir, "project.json");
if (!existsSync(manifest)) { console.error(out.trim()); console.error(`\nNo ${manifest} — the export did not finish.`); process.exit(1); }

// Check the bundle on disk: every file project.json names is there.
const { project } = JSON.parse(readFileSync(manifest, "utf8"));
const named = [project.photo, project.plate, project.litPlate, ...Object.values(project.shots).flatMap((s) => [s.a, s.b, s.clip])].filter(Boolean);
const missing = named.filter((f) => !existsSync(join(dir, f)));
let total = statSync(manifest).size;
console.log(`public/samples/${id}/`);
for (const f of named) {
  if (!existsSync(join(dir, f))) continue;
  const bytes = statSync(join(dir, f)).size;
  total += bytes;
  console.log(`  ${f.padEnd(22)} ${(bytes / 1024).toFixed(0).padStart(6)} KB`);
}
const shots = Object.values(project.shots);
console.log(`  project.json           ${(statSync(manifest).size / 1024).toFixed(0).padStart(6)} KB`);
console.log(`${project.cameras.length} cameras · ${shots.filter((s) => s.clip).length} clips · ${shots.filter((s) => s.a).length} stills · ${(total / 1048576).toFixed(1)} MB`);
if (missing.length) { console.error(`Missing files: ${missing.join(", ")}`); process.exit(1); }
if (!shots.some((s) => s.clip)) console.warn("Warning: no clips in this project — Shoot will show stills only.");
