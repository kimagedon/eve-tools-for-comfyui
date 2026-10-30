/**
 * Pre-rendered sample projects: a finished session (plates, lit plate,
 * stills, LTX clips, lights, cameras, cut) shipped as static files, so the
 * GitHub Pages build opens a sample straight into a shot film without any
 * ComfyUI server.
 *
 * A bundle lives in public/samples/<id>/ (id = the sample's file name without
 * extension, e.g. "night-cafe"):
 *
 *   project.json   { format: "eve-sample", v: 1, id, exported, project }
 *                  `project` is the session record lib/persist.ts restores,
 *                  every Blob replaced by a file name next to it
 *   photo.jpg  plate.jpg  lit.jpg       the still, Extend's plate, Relight's plate
 *   <cam>-a.jpg  <cam>-b.jpg  <cam>.mp4  per camera: start / end still, the LTX clip
 *
 * `loadSample(id)` returns the same record `loadSession()` does, so the app
 * restores a sample exactly like a reload. `installSampleExporter()` adds
 * `window.__eveExportProject(id)` on a local server only: it reads the
 * current IndexedDB session and writes the bundle through the dev/preview
 * server (scripts/sample-export-plugin.ts). Usage: scripts/export-sample.mjs.
 */
import { loadSession } from "@/lib/persist";
import type { LightPlan } from "@/components/tools/light-studio";
import type { Shot } from "@/components/tools/shoot";
import { RELIEF, guideSize, type Relief } from "@/components/tools/scene-rig";
import { endPose, rackFocus, type RigCamera } from "@/lib/rig";
import { outputAspect, setOutputAspect, type Sensor } from "@/lib/cine";
import { depthFor } from "@/lib/depth";
import { buildSurface, type DepthSurface } from "@/lib/depth-mesh";
import { FILL_GREY } from "@/lib/extend-fill";
import { renderGuide } from "@/components/tools/guide-renderer";

/** The session record (App's `Saved`): what survives a reload and what a sample restores to. */
export interface ProjectRecord {
  v: 1;
  photo: Blob; plate: Blob | null; litPlate: Blob | null;
  step: "set" | "3d" | "light" | "cameras" | "shoot" | "result"; reached: number;
  /** 4 = step indices without the old 3D step (see App's restore). */
  steps?: 4; relief: Relief; sensor: Sensor;
  plan: LightPlan | null; cameras: RigCamera[]; scenePrompt: string; order: string[];
  litPlan?: string | null;
  shots: Record<string, { status: Shot["status"]; trim: [number, number]; error?: string; a?: Blob; b?: Blob; clip?: Blob; take?: number; ga?: Blob; gb?: Blob }>;
  /** Set when the project is a pre-rendered sample: its id. */
  sample?: string | null;
}

type Named<T> = { [K in keyof T]: T[K] extends Blob ? string : T[K] extends Blob | null ? string | null : T[K] extends Blob | undefined ? string | undefined : T[K] };
type BundleShot = Named<ProjectRecord["shots"][string]>;
type BundleProject = Omit<Named<ProjectRecord>, "shots"> & { shots: Record<string, BundleShot> };
export interface SampleBundle { format: "eve-sample"; v: 1; id: string; exported: string; project: BundleProject }

/** The sample id for a sample file name: "night-cafe.png" → "night-cafe". */
export const sampleId = (file: string) => file.replace(/\.[^.]+$/, "");

const folder = (id: string) => new URL(`${import.meta.env.BASE_URL}samples/${id}/`, location.href);

/** The step a sample opens on, and how far its stepper reaches (Shoot). */
const OPEN_ON: ProjectRecord["step"] = "set";
const REACHED_ALL = 4;

/**
 * The pre-rendered project for a sample set, or null when it has no bundle
 * (the app then opens the bare photo, as before). Never throws.
 */
export async function loadSample(id: string): Promise<ProjectRecord | null> {
  try {
    const base = folder(id);
    const res = await fetch(new URL("project.json", base));
    // A dev server answers a missing file with index.html: only JSON counts.
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    const bundle = (await res.json()) as SampleBundle;
    if (bundle?.format !== "eve-sample" || bundle.v !== 1 || !bundle.project?.photo) return null;
    const blob = async (name: string): Promise<Blob> => {
      const r = await fetch(new URL(name, base));
      if (!r.ok) throw new Error(`Sample file missing: ${name}`);
      return r.blob();
    };
    const maybe = (name?: string | null) => (name ? blob(name) : Promise.resolve(undefined));
    const p = bundle.project;
    const [photo, plate, litPlate, shots] = await Promise.all([
      blob(p.photo), maybe(p.plate), maybe(p.litPlate),
      Promise.all(Object.entries(p.shots).map(async ([cam, s]) => {
        const [a, b, clip, ga, gb] = await Promise.all([maybe(s.a), maybe(s.b), maybe(s.clip), maybe(s.ga).catch(() => undefined), maybe(s.gb).catch(() => undefined)]);
        return [cam, { status: s.status, trim: s.trim, error: s.error, a, b, clip, ga, gb }] as const;
      })),
    ]);
    return {
      ...p, v: 1, photo, plate: plate ?? null, litPlate: litPlate ?? null,
      shots: Object.fromEntries(shots),
      // A finished sample opens on its Result.
      step: Object.values(p.shots).some((x) => x.a || x.clip) ? "result" : OPEN_ON, reached: Math.max(p.reached, REACHED_ALL), sample: id,
    };
  } catch {
    return null;
  }
}

// ── Exporter (local server only) ────────────────────────────────────────────

/** Long side of an exported still; plates keep their size (up to PLATE_EDGE). */
const STILL_EDGE = 1600;
const PLATE_EDGE = 2560;
const JPEG_QUALITY = 0.92;

async function jpeg(b: Blob, edge: number): Promise<Blob> {
  const bmp = await createImageBitmap(b);
  const k = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
}

/** A file name from a camera id: letters, digits and dashes only. */
const safe = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "cam";

async function exportProject(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) throw new Error(`Bad sample id "${id}" (lowercase, digits, dashes)`);
  const v = await loadSession<ProjectRecord>();
  if (v?.v !== 1 || !v.photo) throw new Error("No project in this browser's IndexedDB — open the app and render a set first");
  const route = `${import.meta.env.BASE_URL}__eve/sample/${id}/`;
  const post = async (name: string, body: Blob | string) => {
    const r = await fetch(route + name, { method: "POST", body });
    if (!r.ok) throw new Error(`Writing ${name} failed: ${r.status} ${await r.text()}`);
  };
  const files: { name: string; bytes: number }[] = [];
  const put = async (name: string, b: Blob) => { await post(name, b); files.push({ name, bytes: b.size }); return name; };

  const begun = await fetch(route + "begin", { method: "POST" });
  if (!begun.ok) throw new Error(`The server has no sample endpoint (${begun.status}) — run the app with npm run dev or npm run preview`);
  const photo = await put("photo.jpg", await jpeg(v.photo, PLATE_EDGE));
  const plate = v.plate ? await put("plate.jpg", await jpeg(v.plate, PLATE_EDGE)) : null;
  const litPlate = v.litPlate ? await put("lit.jpg", await jpeg(v.litPlate, PLATE_EDGE)) : null;
  // The 3D guides each take was generated from: stored ones, or rendered here from the same set (no GPU).
  const set = v.litPlate ?? v.plate ?? v.photo;
  let surface: DepthSurface | null = null;
  const guide = async (cam: RigCamera, end: boolean): Promise<Blob | null> => {
    try {
      if (!surface) {
        const bmp = await createImageBitmap(v.plate ?? v.photo);
        setOutputAspect(bmp.width / bmp.height);
        bmp.close();
        const lit = await createImageBitmap(set);
        const aspect = lit.width / lit.height;
        lit.close();
        surface = buildSurface(await depthFor(set), aspect, { relief: RELIEF[v.relief] });
      }
      const rack = cam.move === "rack-focus" ? rackFocus(surface, cam.focus?.fstop ?? 2, cam.amount) : null;
      const pose = end ? endPose(surface, cam.cam, cam.move, cam.amount) : cam.cam;
      return await renderGuide({ image: set, surface, ...guideSize(outputAspect() * 2000, 2000), camera: pose, lit: false, background: FILL_GREY, focus: (end ? rack?.end : rack?.start) ?? cam.focus });
    } catch {
      return null; // the loader takes bundles without guides
    }
  };
  const shots: Record<string, BundleShot> = {};
  const used = new Set<string>();
  for (const [cam, s] of Object.entries(v.shots)) {
    let stem = safe(cam);
    while (used.has(stem)) stem += "-x";
    used.add(stem);
    const ext = s.clip?.type.includes("webm") ? "webm" : "mp4";
    shots[cam] = {
      status: s.status, trim: s.trim, error: s.error,
      a: s.a ? await put(`${stem}-a.jpg`, await jpeg(s.a, STILL_EDGE)) : undefined,
      b: s.b ? await put(`${stem}-b.jpg`, await jpeg(s.b, STILL_EDGE)) : undefined,
      clip: s.clip ? await put(`${stem}.${ext}`, s.clip) : undefined,
    };
    const camera = v.cameras.find((c) => c.id === cam);
    if (s.a && camera) {
      const ga = s.ga ?? await guide(camera, false), gb = s.gb ?? (s.b ? await guide(camera, true) : null);
      if (ga) shots[cam].ga = await put(`${stem}-guide-a.jpg`, await jpeg(ga, STILL_EDGE));
      if (gb) shots[cam].gb = await put(`${stem}-guide-b.jpg`, await jpeg(gb, STILL_EDGE));
    }
  }
  const bundle: SampleBundle = {
    format: "eve-sample", v: 1, id, exported: new Date().toISOString(),
    project: {
      v: 1, steps: v.steps, photo, plate, litPlate, litPlan: v.litPlan ?? null, step: v.step, reached: v.reached, relief: v.relief, sensor: v.sensor,
      plan: v.plan, cameras: v.cameras, scenePrompt: v.scenePrompt, order: v.order, shots, sample: id,
    },
  };
  // Written last: a bundle without project.json is never picked up.
  const json = JSON.stringify(bundle, null, 1);
  await post("project.json", json);
  files.push({ name: "project.json", bytes: json.length });
  const clips = Object.values(v.shots).filter((s) => s.clip).length;
  return { id, cameras: v.cameras.length, clips, files, totalBytes: files.reduce((n, f) => n + f.bytes, 0) };
}

declare global {
  interface Window { __eveExportProject?: (id: string) => ReturnType<typeof exportProject> }
}

/** Adds `window.__eveExportProject(id)` when the app runs on this machine (dev or local preview), never on a public host. */
export function installSampleExporter() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (import.meta.env.DEV || local) window.__eveExportProject = exportProject;
}
