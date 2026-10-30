/**
 * Shoot: every camera rolls on the same lit set. For each camera the 3D
 * guide is rendered at the start and the end of its move, Qwen-Image-Edit
 * turns both into photoreal stills, and LTX interpolates the move between
 * them. The filmstrip under the viewer is the timeline: drag to reorder,
 * trim the selected shot, crossfade, play, export. A shot whose clip could
 * not be made keeps its stills — storyboard mode.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Play, RotateCcw, Square, VolumeX } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { ComfyError, ping, pipeline, runEdit, runShot, serverLabel } from "@/comfy";
import { FILL_GREY } from "@/lib/extend-fill";
import type { DepthSurface } from "@/lib/depth-mesh";
import { MOVES, sharedLook, TEMPLATES, endPose, motionPrompt, moveAmount, rackFocus, slateIndex, type RigCamera } from "@/lib/rig";
import { CROSSFADE, STILL_SECONDS, exportSequence, playSequence, type SequenceClip, type SequenceControl } from "@/lib/sequence";
import { zip } from "@/lib/zip";
import { aspectLabel, cameraLook, outputAspect, slate, takeName, type Sensor } from "@/lib/cine";
import { cameraReport, download, edl, lightingPlot } from "@/lib/paperwork";
import { useSurface, type LightPlan } from "./light-studio";
import { reframePrompt } from "@/prompts";
import { CONNECT_NOTE, askForServer } from "@/lib/samples-offline";
import { renderGuide } from "./guide-renderer";
import type { SceneCamera } from "./depth-scene";
import { RELIEF, guideSize, reframeSetup, type Relief } from "./scene-rig";
import { StudioGlow, StudioShell, fitRect, useStage, type Phase, type Rect } from "./studio";
import { Viewfinder, scrub, timecode } from "@/components/ui/cine";

type Media = { blob: Blob; url: string };
export interface Shot {
  status: "idle" | "stills" | "clip" | "done" | "storyboard" | "failed";
  a?: Media;
  b?: Media;
  clip?: Media;
  error?: string;
  /** In / out as fractions of the shot. */
  trim: [number, number];
  /** The clip's real length, read from the file. */
  seconds?: number;
  /** Take number: every roll of a camera is the next take (1A_T1, 1A_T2…). */
  take?: number;
  /** The 3D guides the stills were generated from (start, end): what was planned vs what came out. */
  ga?: Media;
  gb?: Media;
  /** The camera setup the take was shot with: a different one now marks it "Changed". */
  setup?: string;
  /** Every earlier take of this camera. The shot's own fields are the circled take, the one in the cut. */
  takes?: Take[];
}
export type Shots = Record<string, Shot>;
/** A scene left earlier in this visit: its still's name, when it was started, and its takes. */
export interface EarlierScene { id: string; name: string; time: number; sensor: Sensor; cameras: RigCamera[]; order: string[]; shots: Shots }

/** The circled takes of a scene, in cut order, as the sequence plays them. */
function cutOf(order: string[], shots: Shots, cameras: RigCamera[]): SequenceClip[] {
  return order.flatMap((id): SequenceClip[] => {
    const s = shots[id];
    if (s?.clip) return [{ kind: "video", src: s.clip.url, trim: s.trim, audio: cameras.find((c) => c.id === id)?.sound !== false }];
    if (s?.a) return [{ kind: "image", src: s.a.url, trim: s.trim }];
    return [];
  });
}
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scene";
const clock = (t: number) => new Date(t).toTimeString().slice(0, 5);
/** One take of a camera, kept when the camera rolls again. */
export type Take = Pick<Shot, "status" | "a" | "b" | "clip" | "seconds" | "trim" | "error" | "ga" | "gb"> & { take: number };

const takeOf = (s: Shot): Take => ({ take: s.take ?? 1, status: s.status, a: s.a, b: s.b, clip: s.clip, seconds: s.seconds, trim: s.trim, error: s.error, ga: s.ga, gb: s.gb });
/** All takes of a shot, oldest first: the kept ones and the circled one. */
export const allTakes = (s: Shot | undefined): Take[] =>
  !s ? [] : [...(s.takes ?? []), ...(s.a || s.clip ? [takeOf(s)] : [])].sort((x, y) => x.take - y.take);
/** The shot with take `n` circled; the one circled before goes back with the others. */
export function circle(s: Shot, n: number): Shot {
  const t = s.takes?.find((x) => x.take === n);
  if (!t) return s;
  return { ...s, ...t, takes: [...(s.takes ?? []).filter((x) => x !== t), ...(s.a || s.clip ? [takeOf(s)] : [])] };
}

const media = (blob: Blob): Media => ({ blob, url: URL.createObjectURL(blob) });
/** What LTX is asked for; the timeline uses each clip's real length once it is known. */
const SECONDS = 4;
/** A shot's full length before trim: the clip's own, or how long a still holds. */
const length = (s: Shot) => (s.clip ? s.seconds ?? SECONDS : STILL_SECONDS);

/** A take's file extension from what it really is (sample stills are JPEG, ComfyUI's PNG). */
function extOf(b: Blob, fallback: string): string {
  const t = b.type;
  return t.includes("jpeg") ? "jpg" : t.includes("png") ? "png" : t.includes("webp") ? "webp" : t.includes("webm") ? "webm" : t.includes("mp4") || t.startsWith("video") ? "mp4" : fallback;
}

/** A video file's length in seconds. */
function videoSeconds(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : SECONDS);
    v.onerror = () => resolve(SECONDS);
    v.src = url;
  });
}

/** One name for everything a cut exports: eve-tools-1A-1C-20261030-1650. */
function exportBase(slates: string[], kind = "cut") {
  const d = new Date(), p = (v: number) => String(v).padStart(2, "0");
  const range = slates.length ? (slates.length > 1 ? `${slates[0]}-${slates[slates.length - 1]}` : slates[0]) : "sc1";
  return `eve-tools-${range}-${kind}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** The plate cover-fitted into the 2.39 guide frame, so a beyond-reach still comes back at the cut's aspect. */
async function coverFit(plate: Blob): Promise<Blob> {
  const { width, height } = guideSize(outputAspect() * 2000, 2000);
  const bmp = await createImageBitmap(plate);
  const c = new OffscreenCanvas(width, height), ctx = c.getContext("2d")!;
  const k = Math.max(width / bmp.width, height / bmp.height);
  ctx.drawImage(bmp, (width - bmp.width * k) / 2, (height - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  bmp.close();
  return c.convertToBlob({ type: "image/png" });
}

/**
 * One take, told honestly: the 3D guide first, a slow wipe (~1.2 s) to what the
 * model generated from it, then the shot plays. Press and hold the frame, or hold
 * G, to see the guide again. One quiet word in the corner says which is which.
 */
function TakeView({ shot }: { shot: Shot }) {
  const [stage, setStage] = useState<"guide" | "wipe" | "play">(shot.ga ? "guide" : "play");
  const [hold, setHold] = useState(false);
  const [tag, setTag] = useState(true);
  useEffect(() => {
    if (!shot.ga) return;
    const t1 = setTimeout(() => setStage("wipe"), 700), t2 = setTimeout(() => setStage("play"), 1950), t3 = setTimeout(() => setTag(false), 3600);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [shot.ga]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key.toLowerCase() === "g" && !(e.target instanceof HTMLInputElement)) setHold(true); };
    const up = (e: KeyboardEvent) => { if (e.key.toLowerCase() === "g") setHold(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);
  // The take plays with its own sound; only if the browser refuses does a speaker appear.
  const [forced, setForced] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const showGuide = !!shot.ga && (hold || stage === "guide");
  const wiped = stage !== "guide" && !hold;
  return (
    <div className="absolute inset-0" onPointerDown={() => setHold(true)} onPointerUp={() => setHold(false)} onPointerLeave={() => setHold(false)}>
      {shot.a && <img src={shot.a.url} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
      {shot.clip && stage === "play" && (
        <video ref={video} key={shot.clip.url} src={shot.clip.url} className="eve-step-in absolute inset-0 h-full w-full object-cover" playsInline
          style={{ opacity: hold ? 0 : 1 }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            v.currentTime = shot.trim[0] * v.duration;
            v.muted = false;
            void v.play().catch(() => { v.muted = true; setForced(true); void v.play().catch(() => {}); });
          }}
          onTimeUpdate={(e) => { const v = e.currentTarget, a = shot.trim[0] * v.duration, b = shot.trim[1] * v.duration; if (v.currentTime >= b - 0.04 || v.currentTime < a - 0.1) v.currentTime = a; }}
          onEnded={(e) => { const v = e.currentTarget; v.currentTime = shot.trim[0] * v.duration; void v.play().catch(() => {}); }} />
      )}
      {shot.ga && (
        <img src={shot.ga.url} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover"
          style={{ clipPath: wiped ? "inset(0 0 0 100%)" : "inset(0 0 0 0)", transition: hold ? "clip-path 200ms ease-out" : "clip-path 1200ms cubic-bezier(.65,0,.35,1)" }} />
      )}
      {forced && <Speaker onClick={() => { const v = video.current; if (v) { v.muted = false; void v.play().catch(() => {}); } setForced(false); }} />}
      {shot.ga && <span className="vf-l transition-opacity duration-500" style={{ left: 10, top: 10, opacity: tag || hold ? 0.8 : 0 }}>{showGuide ? "3D guide" : "Generated"}</span>}
    </div>
  );
}

/** Shown only when the browser started playback muted: one click brings the sound. */
function Speaker({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} onPointerDown={(e) => e.stopPropagation()} aria-label="Turn sound on" title="Sound"
      className="eve-press absolute bottom-3 right-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white/85 ring-1 ring-inset ring-white/15 backdrop-blur hover:text-white">
      <VolumeX className="h-3.5 w-3.5" />
    </button>
  );
}

class Stopped extends Error { constructor() { super("Stopped"); } }
const STRIP = 92;

function why(error: unknown): string {
  if (error instanceof ComfyError) {
    if (error.kind === "offline") return CONNECT_NOTE;
    if (error.kind === "missing-model") return `A model is missing on the server: ${error.message}`;
    if (error.kind === "oom") return "The GPU ran out of memory — try fewer cameras at once";
  }
  return scrub(error instanceof Error ? error.message : String(error));
}

const WORKING = new Set<Shot["status"]>(["stills", "clip"]);

export function Shoot({ plate, surface: rigSurface, cameras, prompt, shots, setShots, order, setOrder, sensor, plan, relief, stale, mode = "shoot", onResult, earlier = [] }: {
  /** "result": the finished cut, full frame, with only the export actions. */
  mode?: "shoot" | "result";
  onResult?: () => void;
  /** Result: earlier scenes of this visit, with their takes. */
  earlier?: EarlierScene[];
  sensor: Sensor;
  relief: Relief;
  /** The light plan changed after Relight: the plate is out of date. */
  stale?: boolean;
  plan: LightPlan | null;
  plate: Blob;
  surface: DepthSurface | null;
  cameras: RigCamera[];
  prompt: string;
  shots: Shots;
  setShots: (f: (s: Shots) => Shots) => void;
  order: string[];
  setOrder: (o: string[]) => void;
}) {
  const { ref: stageRef, stage } = useStage();
  // Prompts ahead of ours in the ComfyUI queue while a still or a shot waits.
  const [ahead, setAhead] = useState(0);
  // Made and let go inside one effect, so a remount never leaves a revoked URL on screen.
  const [plateUrl, setPlateUrl] = useState<string | undefined>();
  useEffect(() => { const u = URL.createObjectURL(plate); setPlateUrl(u); return () => URL.revokeObjectURL(u); }, [plate]);
  // After a reload Cameras may not have been opened: the set is built here from the same plate.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (rigSurface) return;
    let alive = true;
    void createImageBitmap(plate).then((b) => { if (alive) setSize({ w: b.width, h: b.height }); b.close(); });
    return () => { alive = false; };
  }, [plate, rigSurface]);
  const own = useSurface(rigSurface ? null : plate, size, RELIEF[relief]);
  const surface = rigSurface ?? own.surface;
  const [rolling, setRolling] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(order[0] ?? null);
  const [crossfade, setCrossfade] = useState(false);
  const [playing, setPlaying] = useState<"play" | "export" | null>(null);
  const [time, setTime] = useState<{ t: number; total: number } | null>(null);
  const [file, setFile] = useState<{ url: string; name: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const stopPlay = useRef<AbortController | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // The timeline follows the rig: cameras added go to the end, removed ones leave.
  useEffect(() => {
    const ids = cameras.map((c) => c.id);
    const next = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))];
    if (next.join() !== order.join()) setOrder(next);
    if (!pick || !ids.includes(pick)) setPick(next[0] ?? null);
  }, [cameras, order, setOrder, pick]);

  const update = (id: string, patch: Partial<Shot>) => setShots((s) => ({ ...s, [id]: { ...(s[id] ?? { trim: [0, 1], status: "idle" }), ...patch } }));
  // Clips restored after a reload: read their real length once.
  useEffect(() => {
    for (const [id, s] of Object.entries(shots)) {
      if (s.clip && s.seconds == null) void videoSeconds(s.clip.url).then((seconds) => update(id, { seconds }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots]);

  /** The 3D guide of a pose: what the model is shown (and what the viewer wipes from). */
  const guideOf = (cam: SceneCamera, focus: RigCamera["focus"]) => renderGuide({ image: plate, surface: surface!, ...guideSize(outputAspect() * 2000, 2000), camera: cam, lit: false, background: FILL_GREY, focus });
  const still = async (c: RigCamera, cam: SceneCamera, signal: AbortSignal, focus = c.focus): Promise<{ img: Blob; guide: Blob }> => {
    if (!surface) throw new Error("The set has no 3D yet");
    const setup = reframeSetup(surface, cam, { fstop: focus?.fstop ?? null, aspect: aspectLabel(), recoverDetail: false, prompt });
    const words = [setup.params.prompt, sharedLook(), cameraLook(sensor, c.lens)].filter(Boolean).join(" ");
    // Stills jump the ComfyUI queue: they are what the person waits to see.
    const opts = { signal, priority: "high" as const, onQueue: setAhead };
    // Past what the photo saw there is no honest view: the plate and the words go alone.
    const guide = await guideOf(cam, focus);
    if (setup.beyond) return { img: await runEdit([await coverFit(plate)], reframePrompt(setup.params.camera, words, undefined, setup.params.focus), opts), guide };
    if (signal.aborted) throw new Stopped();
    return { img: await runEdit([guide], reframePrompt(setup.params.camera, words, "alone", setup.params.focus), opts), guide };
  };

  type Stills = { a: Blob; b: Blob; ga: Blob; gb: Blob; width: number; height: number };
  /** A stop keeps whatever was already made. */
  const stopped = (id: string) => setShots((s) => ({ ...s, [id]: { ...(s[id] ?? { trim: [0, 1] }), status: s[id]?.a ? "storyboard" : "idle", error: "Stopped" } }));

  /** Stage 1: the start and end stills of a camera's move; the start one shows the moment it lands. */
  /** A re-roll that is stopped or fails puts the previous take back instead of losing it. */
  const restore = (c: RigCamera, prev: Shot | undefined, e: unknown, signal: AbortSignal) => {
    if (prev && (prev.clip || prev.a)) { update(c.id, { a: prev.a, b: prev.b, clip: prev.clip, seconds: prev.seconds, take: prev.take, ga: prev.ga, gb: prev.gb, trim: prev.trim, takes: prev.takes, status: prev.status, error: signal.aborted ? "Stopped" : why(e) }); return true; }
    return false;
  };
  const makeStills = async (c: RigCamera, signal: AbortSignal): Promise<Stills> => {
    if (!surface) throw new Error("The set has no 3D yet");
    const prev = before.current[c.id];
    setQueued((q) => q.filter((id) => id !== c.id));
    // The take before stays with the others; the new one is the next number and is circled.
    const kept = allTakes(prev);
    update(c.id, { status: "stills", error: undefined, a: undefined, b: undefined, clip: undefined, seconds: undefined, ga: undefined, gb: undefined, trim: [0, 1],
      takes: kept, take: Math.max(0, ...kept.map((t) => t.take)) + 1, setup: setupOf(c) });
    try {
      // A rack keeps the camera still and pulls focus from the foreground to the back.
      const rack = c.move === "rack-focus" ? rackFocus(surface, c.focus?.fstop ?? 2, c.amount) : null;
      const sa = await still(c, c.cam, signal, rack?.start ?? c.focus), a = sa.img;
      if (signal.aborted) throw new Stopped();
      update(c.id, { a: media(a), ga: media(sa.guide) });
      const sb = await still(c, endPose(surface, c.cam, c.move, c.amount), signal, rack?.end ?? c.focus), b = sb.img;
      if (signal.aborted) throw new Stopped();
      const bmp = await createImageBitmap(a);
      const out = { a, b, ga: sa.guide, gb: sb.guide, width: bmp.width, height: bmp.height };
      bmp.close();
      return out;
    } catch (e) {
      if (!restore(c, prev, e, signal)) { if (signal.aborted) stopped(c.id); else update(c.id, { status: "failed", error: why(e) }); }
      throw e;
    }
  };

  /** Stage 2: LTX interpolates the move between the two stills. A failed clip keeps the stills. */
  const makeClip = async (c: RigCamera, st: Stills, signal: AbortSignal): Promise<Blob> => {
    if (!surface) throw new Error("The set has no 3D yet");
    try {
      return await runShot(st.a, st.b, { prompt: motionPrompt(c.move, [prompt, cameraLook(sensor, c.lens)].filter(Boolean).join(" "), moveAmount(surface, c.cam, c.move, c.amount)), width: st.width, height: st.height, seconds: SECONDS, audio: c.sound !== false }, { signal, onQueue: setAhead });
    } catch (e) {
      const prev = before.current[c.id];
      if (!(prev?.clip && restore(c, prev, e, signal))) { if (signal.aborted) stopped(c.id); else update(c.id, { status: "storyboard", error: why(e) }); }
      throw e;
    }
  };

  const before = useRef<Shots>({});
  /** What a take depends on: the camera, its glass and move, the body, the lit plate and the notes. */
  const setupOf = (c: RigCamera) => JSON.stringify([c.cam, c.move, c.amount ?? null, c.focus ?? null, c.lens ?? null, c.sound !== false, sensor, plate.size, prompt]);
  const changed = (c: RigCamera | undefined, s: Shot | undefined) => !!c && !!s?.setup && (!!s.a || !!s.clip) && s.setup !== setupOf(c);
  /** Cameras waiting their turn in this run, in order. */
  const [queued, setQueued] = useState<string[]>([]);
  const roll = async (only?: RigCamera | RigCamera[]) => {
    // One roll at a time: claimed before the ping, so a double press or Enter cannot start two.
    if (abort.current) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRolling(performance.now());
    setError(null);
    try { await ping(); } catch (e) {
      if (abort.current === ctrl) { abort.current = null; setRolling(null); }
      askForServer(); setError(why(e instanceof ComfyError ? e : new ComfyError(String(e), "offline"))); return;
    }
    before.current = shots;
    // Every camera rolls: the cut order sorts them, cameras missing from it still go (at the end).
    const ordered = order.map((id) => cameras.find((c) => c.id === id)!).filter(Boolean);
    const list = only ? (Array.isArray(only) ? only : [only]) : [...ordered, ...cameras.filter((c) => !order.includes(c.id))];
    setQueued(list.map((c) => c.id));
    if (!list.length) { if (abort.current === ctrl) { abort.current = null; setRolling(null); } setError("Add a camera in Cameras first"); return; }
    // Stills of the next camera render while the clip of this one does; clips go strictly in order.
    await pipeline(list, {
      stills: makeStills,
      clip: makeClip,
      signal: ctrl.signal,
      ahead: 1,
      onStills: (c, st) => update(c.id, { b: media(st.b), gb: media(st.gb), status: "clip" }),
      onClip: (c, clip) => {
        const m = media(clip);
        update(c.id, { clip: m, status: "done" });
        void videoSeconds(m.url).then((seconds) => update(c.id, { seconds }));
      },
    });
    // After a stop, nothing may stay "rendering" (a later camera's stills can land after the abort).
    if (ctrl.signal.aborted) setShots((s) => {
      const n = { ...s };
      for (const c of list) { const x = n[c.id]; if (x && WORKING.has(x.status)) n[c.id] = { ...x, status: x.a ? "storyboard" : "idle", error: "Stopped" }; }
      return n;
    });
    if (abort.current === ctrl) { abort.current = null; setRolling(null); setQueued([]); }
  };
  const stop = () => { abort.current?.abort(); abort.current = null; setRolling(null); setQueued([]); };
  /** Cameras with no take yet, in cut order (cameras missing from it at the end); failed ones wait for a Retake. */
  const missing = () => [...order.map((id) => cameras.find((c) => c.id === id)!).filter(Boolean), ...cameras.filter((c) => !order.includes(c.id))]
    .filter((c) => { const s = shots[c.id]; return !s?.a && !s?.clip && s?.status !== "failed"; });
  // Entering Shoot shoots: one take per camera that has none. Takes already there (even changed ones) are never re-spent.
  const autoRan = useRef(false);
  // Every camera has its take and nothing renders: on to Result once the last reveal has played.
  const allIn = cameras.length > 0 && cameras.every((c) => shots[c.id]?.status === "done");
  const rolledHere = useRef(false);
  useEffect(() => { if (rolling != null) rolledHere.current = true; }, [rolling]);
  useEffect(() => {
    if (mode !== "shoot" || !allIn || rolling != null || !rolledHere.current || !onResult) return;
    const t = setTimeout(onResult, 2600);
    return () => clearTimeout(t);
  }, [mode, allIn, rolling, onResult]);
  useEffect(() => {
    if (mode !== "shoot" || autoRan.current || !surface || abort.current) return;
    autoRan.current = true;
    const list = missing();
    // The stage shows the first camera being shot.
    if (list.length) { setPick(list[0].id); void roll(list); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, surface]);
  // Leaving Shoot (new still, new Relight, another step) stops the roll; finished takes stay.
  useEffect(() => () => abort.current?.abort(), []);

  // The cut: each shot's circled take, and which shot each clip is.
  const [clips, clipIds] = useMemo(() => {
    const ids: string[] = [];
    const list = order.flatMap((id): SequenceClip[] => {
      const s = shots[id];
      if (!s || (!s.clip && !s.a)) return [];
      ids.push(id);
      if (s.clip) return [{ kind: "video" as const, src: s.clip.url, trim: s.trim, audio: cameras.find((c) => c.id === id)?.sound !== false }];
      return [{ kind: "image" as const, src: s.a!.url, trim: s.trim }];
    });
    return [list, ids] as const;
  }, [order, shots, cameras]);
  // Playback follows the cut: the shot on screen is the one picked.
  const seq = useRef<SequenceControl | null>(null);
  const [muted, setMuted] = useState(false);
  const follow = { sound: true, onMuted: () => setMuted(true), onShot: (i: number) => { const id = clipIds[i]; if (id) setPick(id); }, control: (c: SequenceControl) => { seq.current = c; } };

  const play = async (mode: "play" | "export", list: SequenceClip[] = clips, stem?: string) => {
    if (!canvas.current || !list.length) return;
    stopPlay.current?.abort();
    const ctrl = new AbortController();
    stopPlay.current = ctrl;
    setPlaying(mode);
    try {
      const opts = { crossfade, signal: ctrl.signal, onTime: (t: number, total: number) => setTime({ t, total }), ...(mode === "play" ? follow : {}) };
      if (mode === "export") {
        const { blob, ext } = await exportSequence(canvas.current, list, opts);
        if (!ctrl.signal.aborted) {
          if (file) URL.revokeObjectURL(file.url);
          const url = URL.createObjectURL(blob);
          const name = `${stem ?? base("cut")}.${ext}`;
          setFile({ url, name });
          const a = document.createElement("a");
          a.href = url; a.download = name; a.click();
        }
      } else {
        await playSequence(canvas.current, list, opts);
      }
    } catch (e) {
      setError(why(e));
    } finally {
      if (stopPlay.current === ctrl) { stopPlay.current = null; setPlaying(null); setTime(null); }
    }
  };

  const base = (kind?: string) => exportBase(order.map((id) => cameras.find((c) => c.id === id)).filter((c): c is RigCamera => !!c).map((c) => slate(slateIndex(c, cameras))), kind);
  /** The cut as the editor gets it: shot, trimmed seconds and the take's file. */
  const cut = () => order.flatMap((id) => {
    const c = cameras.find((x) => x.id === id), s = shots[id];
    if (!c || !s || (!s.clip && !s.a)) return [];
    const full = length(s);
    return [{ camera: c, index: slateIndex(c, cameras), shot: s, srcIn: s.trim[0] * full, srcOut: s.trim[1] * full, ext: s.clip ? extOf(s.clip.blob, "mp4") : extOf(s.a!.blob, "png") }];
  });
  const report = () => {
    if (!surface) return;
    const rows = order.flatMap((id) => {
      const c = cameras.find((x) => x.id === id), s = shots[id];
      if (!c) return [];
      return [{ camera: c, index: slateIndex(c, cameras), take: s?.take ?? 1, takes: allTakes(s).length, seconds: s ? (s.trim[1] - s.trim[0]) * length(s) : SECONDS, ext: s?.clip ? extOf(s.clip.blob, "mp4") : s?.a ? extOf(s.a.blob, "png") : null }];
    });
    download(cameraReport(surface, sensor, rows), `${base()}-camera-report.csv`, "text/csv");
  };
  const plot = () => { if (surface) download(lightingPlot(surface, plan?.lights ?? [], cameras), `${base()}-lighting-plot.svg`, "image/svg+xml"); };
  const cutList = () => download(edl(cut().map((e) => ({ index: e.index, srcIn: e.srcIn, srcOut: e.srcOut, file: takeName(e.index, e.ext, e.shot.take ?? 1) })), crossfade ? Math.round(CROSSFADE * 24) : 0), `${base()}.edl`);
  /** Every take of every shot, slate-named, in one .zip: the clip and its start / end stills. */
  const [zipping, setZipping] = useState(false);
  const takes = async (sc?: EarlierScene) => {
    const order_ = sc?.order ?? order, cameras_ = sc?.cameras ?? cameras, shots_ = sc?.shots ?? shots;
    setZipping(true);
    try {
      const files = order_.flatMap((id) => {
        const c = cameras_.find((x) => x.id === id);
        if (!c) return [];
        const index = slateIndex(c, cameras_);
        return allTakes(shots_[id]).flatMap((t) => {
          const stem = takeName(index, "", t.take).replace(/\.$/, "");
          return [
            ...(t.clip ? [{ name: takeName(index, extOf(t.clip.blob, "mp4"), t.take), blob: t.clip.blob }] : []),
            ...(t.a ? [{ name: `${stem}_start.${extOf(t.a.blob, "png")}`, blob: t.a.blob }] : []),
            ...(t.b ? [{ name: `${stem}_end.${extOf(t.b.blob, "png")}`, blob: t.b.blob }] : []),
          ];
        });
      });
      if (files.length) download(await zip(files), `${sc ? stamp(sc, "takes") : base("takes")}.zip`, "application/zip");
    } catch (e) { setError(why(e)); } finally { setZipping(false); }
  };
  /** An earlier scene's file names: eve-tools-night-diner-cut-20261030-1550. */
  const stamp = (sc: EarlierScene, kind: string) => exportBase([], kind).replace("eve-tools-sc1-", `eve-tools-${slug(sc.name)}-`);
  /** Earlier scenes: their circled takes play in the preview, their cut and takes export like this one's. */
  const [earlyOpen, setEarlyOpen] = useState(() => mode === "result" && !clips.length);
  const [early, setEarly] = useState<{ media: Media; label: string } | null>(null);
  const exportEarlier = (sc: EarlierScene) => {
    resultLoop.current?.abort();
    void play("export", cutOf(sc.order, sc.shots, sc.cameras), stamp(sc, "cut")).then(() => setLoopKey((k) => k + 1));
  };
  /** One shot: its circled take as it came off the GPU, sound and all. */
  const single = () => {
    const e = cut()[0];
    if (!e) return;
    if (e.shot.clip) download(e.shot.clip.blob, takeName(e.index, e.ext, e.shot.take ?? 1));
    else void play("export");
  };

  const drop = (target: string) => {
    if (!dragging || dragging === target) return;
    const next = order.filter((id) => id !== dragging);
    next.splice(next.indexOf(target), 0, dragging);
    setOrder(next);
  };

  const view: Rect = stage.w ? fitRect({ w: stage.w, h: stage.h - STRIP }, outputAspect(), 1, 0.9, 0.86) : { x: 0, y: 0, w: 0, h: 0 };
  const cur = pick ? shots[pick] : undefined;
  const curCam = cameras.find((c) => c.id === pick);
  const working = rolling != null && Object.values(shots).some((s) => WORKING.has(s.status));
  const phase: Phase = rolling != null ? { kind: "running", started: rolling } : error ? { kind: "failed", error } : { kind: "edit" };
  const done = order.filter((id) => shots[id]?.status === "done").length;
  // Whether any camera has a take yet.
  const anyTake = order.some((id) => shots[id]?.a || shots[id]?.clip);
  // The quiet progress line: the first setup still rendering.
  const renderingId = order.find((id) => shots[id] && WORKING.has(shots[id].status));
  const renderingCam = renderingId ? cameras.find((c) => c.id === renderingId) : undefined;
  const rendering = renderingCam ? slate(slateIndex(renderingCam, cameras)) : null;
  const boards = order.filter((id) => shots[id]?.status === "storyboard").length;
  const info = [stale ? "Relight stale" : "", `Qwen-Image-Edit → LTX-2.5`, `${order.length} setups`, done ? `${done} clips` : "", boards ? `${boards} storyboard` : "",
    time ? `${time.t.toFixed(1)} / ${time.total.toFixed(1)} s` : ""].filter(Boolean).join(" · ");

  const tileStatus = (s: Shot | undefined) => {
    if (!s || s.status === "idle") return null;
    // Only an empty slot shows the little lens; over a picture nothing is drawn (the slot's glow says it works).
    if (s.status === "stills" && !s.a) return <span className="absolute inset-0 flex items-center justify-center"><span className="eve-shimmer text-[11px]">Rendering…</span></span>;
    if (s.status === "failed") return <span className="absolute inset-0 flex items-center justify-center" title={s.error}><AlertTriangle className="h-4 w-4 text-red-400" /></span>;
    return null;
  };

  // Takes from before guides were kept (or bundles without them): render the guide here — no GPU.
  useEffect(() => {
    if (!surface || !pick) return;
    const sh = shots[pick], c = cameras.find((x) => x.id === pick);
    if (!sh?.a || sh.ga || !c) return;
    let alive = true;
    const rack = c.move === "rack-focus" ? rackFocus(surface, c.focus?.fstop ?? 2, c.amount) : null;
    void guideOf(c.cam, rack?.start ?? c.focus).then((b) => { if (alive) update(pick, { ga: media(b) }); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick, surface, pick ? shots[pick]?.a : undefined]);

  // Result: the cut plays, big, on a loop; a take preview pauses it.
  const resultLoop = useRef<AbortController | null>(null);
  const [loopKey, setLoopKey] = useState(0);
  const [preview, setPreview] = useState<{ id: string; take: number } | null>(null);
  const startAt = useRef(0);
  useEffect(() => {
    if (mode !== "result" || !canvas.current || !clips.length || preview || early) return;
    const ctrl = new AbortController();
    resultLoop.current = ctrl;
    void (async () => {
      while (!ctrl.signal.aborted && canvas.current) {
        const from = Math.min(startAt.current, clips.length - 1);
        startAt.current = 0;
        try { await playSequence(canvas.current, clips, { crossfade, signal: ctrl.signal, onTime: (t, total) => setTime({ t, total }), from, ...follow }); } catch { break; }
      }
    })();
    return () => { ctrl.abort(); seq.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, clips, crossfade, loopKey, !!preview, !!early]);
  // A take chip previews that take; the slate (or circling) goes back to the cut at that shot.
  const previewTake = preview ? allTakes(shots[preview.id]).find((t) => t.take === preview.take) : undefined;
  const jump = (id: string) => {
    setPick(id);
    const i = clipIds.indexOf(id);
    if (i < 0) return;
    // Paused for a preview: the cut starts again at this shot; playing: it jumps there.
    if (preview || early) { startAt.current = i; setPreview(null); setEarly(null); } else seq.current?.seek(i);
  };
  const chip = (id: string, n: number) => {
    const s = shots[id];
    if (!s) return;
    // The second click on a previewed take circles it.
    if (preview?.id === id && preview.take === n) {
      if (n !== s.take) setShots((all) => ({ ...all, [id]: circle(all[id], n) }));
      startAt.current = Math.max(0, clipIds.indexOf(id));
      setPreview(null);
      return;
    }
    if (n === s.take) { jump(id); return; }
    setPick(id);
    setPreview({ id, take: n });
  };

  const stageContent = stage.w > 0 && (
    <>
      <StudioGlow phase={cur && WORKING.has(cur.status) ? { kind: "running", started: rolling ?? performance.now() } : { kind: "edit" }} rect={view}
        label={curCam ? `Rendering ${slate(slateIndex(curCam, cameras))}` : "Rendering"} />
      <div className="absolute overflow-hidden bg-[#0a0a0a] ring-1 ring-inset ring-white/[0.08]" style={{ left: view.x, top: view.y, width: view.w, height: view.h }}>
        {!cur?.a && !playing && mode === "shoot" && (
          // Before the first take: the lit set, dimmed; the edge glow says it is being shot.
          <>
            {plateUrl && <div className="absolute inset-0 opacity-30"><img src={plateUrl} alt="" draggable={false} className="eve-hub-in absolute inset-0 h-full w-full object-cover" /></div>}
            {!curCam && <div className="absolute inset-0 flex items-center justify-center"><span className="text-[13px] text-white/60">No cameras</span></div>}
          </>
        )}
        {cur?.a && mode === "shoot" && <TakeView key={`${pick}:${cur.take ?? 1}:${cur.clip ? "c" : "s"}:${cur.ga ? "g" : ""}`} shot={cur} />}
        <canvas ref={canvas} className="absolute inset-0 h-full w-full object-contain transition-opacity duration-300" style={{ opacity: playing || mode === "result" ? 1 : 0, background: playing || mode === "result" ? "#000" : "transparent" }} />
        {mode === "result" && previewTake && (
          <div key={`${preview!.id}:${preview!.take}`} className="eve-step-in absolute inset-0 bg-black">
            {previewTake.clip
              ? <video src={previewTake.clip.url} autoPlay loop playsInline className="absolute inset-0 h-full w-full object-cover"
                  onLoadedMetadata={(e) => { const v = e.currentTarget; v.muted = muted; void v.play().catch(() => { v.muted = true; void v.play().catch(() => {}); }); }} />
              : previewTake.a && <img src={previewTake.a.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            <span className="vf-l" style={{ left: 10, top: 10, opacity: 0.8 }}>{(() => { const c = cameras.find((x) => x.id === preview!.id); return c ? `${slate(slateIndex(c, cameras))} · T${previewTake.take}` : `T${previewTake.take}`; })()}</span>
          </div>
        )}
        {mode === "result" && early && (
          <div key={early.media.url} className="eve-step-in absolute inset-0 bg-black">
            {early.media.blob.type.startsWith("video")
              ? <video src={early.media.url} autoPlay loop playsInline className="absolute inset-0 h-full w-full object-cover"
                  onLoadedMetadata={(e) => { const v = e.currentTarget; v.muted = muted; void v.play().catch(() => { v.muted = true; void v.play().catch(() => {}); }); }} />
              : <img src={early.media.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            <span className="vf-l" style={{ left: 10, top: 10, opacity: 0.8 }}>{early.label}</span>
          </div>
        )}
        {(mode === "result" || playing === "play") && muted && <Speaker onClick={() => { setMuted(false); seq.current?.unmute(); }} />}
        {cur?.status === "storyboard" && !playing && <span className="absolute bottom-9 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-full bg-black/60 px-3 py-1 text-[11.5px] text-amber-200/90 ring-1 ring-inset ring-white/10 backdrop-blur" title={cur.error}>Still only — the clip failed</span>}
        {cur?.status === "failed" && !playing && <span className="absolute bottom-9 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-full bg-black/60 px-3 py-1 text-[11.5px] text-red-300 ring-1 ring-inset ring-white/10 backdrop-blur" title={cur.error}>{cur.error}</span>}
      </div>
      <Viewfinder rect={view} />
      {mode === "result" && earlyOpen && earlier.length > 0 && (
        // Earlier scenes of this visit: newest first, each with its slates, its cut and its takes.
        <div role="region" aria-label="Earlier scenes" className="eve-step-in absolute z-10 flex max-h-[46%] flex-col gap-3 overflow-y-auto rounded-xl bg-black/80 p-3 ring-1 ring-inset ring-white/10 backdrop-blur-xl"
          style={{ left: view.x + 12, bottom: stage.h - (view.y + view.h) + 12, width: Math.min(560, view.w - 24) }}>
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/45">Earlier scenes</span>
          {earlier.map((sc) => (
            <div key={sc.id} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 truncate font-medium text-white/90">{sc.name}</span>
                <span className="font-mono text-[10.5px] text-white/40">{clock(sc.time)}</span>
                <span className="flex-1" />
                <button type="button" disabled={!!playing} onClick={() => exportEarlier(sc)} className="rounded-full px-2 py-0.5 text-[11.5px] text-white/65 hover:text-white disabled:opacity-35">Export cut</button>
                <button type="button" disabled={zipping} onClick={() => void takes(sc)} className="rounded-full px-2 py-0.5 text-[11.5px] text-white/65 hover:text-white disabled:opacity-35">Export takes</button>
              </div>
              <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
                {sc.order.map((id) => {
                  const s = sc.shots[id], c = sc.cameras.find((x) => x.id === id);
                  const m = s?.clip ?? s?.a;
                  if (!m || !c) return null;
                  const name = `${sc.name} · ${slate(slateIndex(c, sc.cameras))} · T${s!.take ?? 1}`;
                  return (
                    <button key={id} type="button" onClick={() => setEarly({ media: m, label: name })} aria-label={`Play ${name}`}
                      className={`relative h-9 shrink-0 overflow-hidden rounded-[2px] ring-1 ${early?.media === m ? "ring-white" : "ring-white/15 hover:ring-white/50"}`} style={{ width: 36 * outputAspect() }}>
                      {s!.a && <img src={s!.a.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                      <span className="vf-l" style={{ left: 3, top: 3, fontSize: 8.5 }}>{slate(slateIndex(c, sc.cameras))}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {/* The filmstrip is the timeline: drag to reorder. */}
      <div className="absolute inset-x-0 flex justify-center" style={{ top: stage.h - STRIP + 8 }}>
        <div className="flex max-w-[92%] gap-2 overflow-x-auto px-1 py-1 [scrollbar-width:none]">
          {order.map((id, i) => {
            const s = shots[id], c = cameras.find((x) => x.id === id);
            const busy = !!s && WORKING.has(s.status);
            const takeRow = mode === "result" && order.some((x) => allTakes(shots[x]).length > 1);
            const th = takeRow ? 52 : 58, tw = th * outputAspect();
            return (
              <div key={id} draggable onDragStart={() => setDragging(id)} onDragEnd={() => setDragging(null)}
                onDragOver={(e) => e.preventDefault()} onDrop={() => drop(id)}
                className={`group relative shrink-0 transition ${dragging === id ? "opacity-40" : ""}`} style={{ width: tw, height: th + (takeRow ? 18 : 0) }}>
                {busy && <div aria-hidden className="pointer-events-none absolute -inset-[3px]" style={{ bottom: takeRow ? 15 : -3 }}><div className="eve-ai-glow absolute inset-0" /></div>}
                <button type="button" onClick={() => (mode === "result" || playing === "play" ? jump(id) : setPick(id))} title={c ? slate(slateIndex(c, cameras)) : undefined}
                  style={{ height: th }} className={`relative block w-full overflow-hidden rounded-[2px] bg-white/[0.04] transition-opacity duration-200 ${pick === id ? "ring-[1.5px] ring-white" : "opacity-70 ring-1 ring-white/[0.12] hover:opacity-100"}`}>
                  {s?.a && <img src={s.a.url} alt="" className="eve-hub-in absolute inset-0 h-full w-full object-cover" />}
                  {s?.clip && <video src={s.clip.url} muted loop playsInline className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity group-hover:opacity-100"
                    onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />}
                  {tileStatus(s)}
                  <span className="vf-l" style={{ left: 5, top: 5, fontSize: 9.5 }}>{c ? slate(slateIndex(c, cameras)) : i + 1}</span>
                </button>
                {mode === "result" && allTakes(s).length > 1 && (
                  // Film language: the takes of this slate; the ringed one is circled (in the cut).
                  <div className="absolute inset-x-0 flex justify-center gap-1" style={{ top: th + 2 }}>
                    {allTakes(s).map((t) => {
                      const circled = t.take === s!.take, seen = preview?.id === id && preview.take === t.take;
                      return (
                        <button key={t.take} type="button" onClick={() => chip(id, t.take)}
                          aria-label={circled ? `Take ${t.take}, circled` : seen ? `Circle take ${t.take}` : `Preview take ${t.take}`}
                          title={circled ? "Circled — in the cut" : seen ? "Click again to circle" : "Preview"}
                          className={`rounded-full px-1.5 font-mono text-[9.5px] leading-[15px] tabular-nums transition-colors ${circled ? "text-white ring-1 ring-white/85" : seen ? "bg-white text-black" : "text-white/50 hover:text-white"}`}>T{t.take}</button>
                      );
                    })}
                  </div>
                )}
                {queued.includes(id) && !s?.a && !busy && (
                  <span className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center" style={{ height: th }}>
                    <span className="text-[10.5px] text-white/55">In queue · {queued.indexOf(id) + 1}</span>
                  </span>
                )}
                {c && mode === "shoot" && rolling == null && (() => {
                  // A new take of this camera (T2, T3…); a take shot with another setup says so; an empty slot (stopped) shoots.
                  const has = !!(s?.a || s?.clip), loud = changed(c, s) || s?.status === "failed";
                  const word = changed(c, s) ? "Changed — Retake" : "Retake";
                  return (
                    <button type="button" onClick={() => void roll(c)} aria-label={`Retake ${slate(slateIndex(c, cameras))}`}
                      className={`absolute left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full px-2 py-[1px] text-[10px] font-medium backdrop-blur transition-opacity ${loud ? "bg-amber-300/90 text-black opacity-100" : has ? "bg-black/70 text-white/90 opacity-0 ring-1 ring-inset ring-white/15 group-hover:opacity-100 focus-visible:opacity-100" : "bg-white/10 text-white/85 ring-1 ring-inset ring-white/20 hover:bg-white/20"}`}
                      style={{ bottom: (takeRow ? 18 : 0) + 4 }}>
                      <RotateCcw className="h-2.5 w-2.5" />{word}
                    </button>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );

  // Delivery: the cut as one file, every take in one archive; the paperwork stays quiet beside them.
  const one = clips.length === 1 && allTakes(shots[clipIds[0]]).length === 1;
  const exportCut = () => {
    if (mode === "result") { resultLoop.current?.abort(); void play("export").then(() => setLoopKey((k) => k + 1)); }
    else void play("export");
  };
  const pill = "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold disabled:opacity-35";
  const exportControls = (
    <>
      {one ? (
        <button type="button" disabled={playing === "export"} onClick={single} className={`${pill} bg-white text-black hover:bg-white/90`}>
          {playing === "export" ? <span>Recording…</span> : <><Download className="h-3.5 w-3.5" />Export</>}
        </button>
      ) : (
        <>
          <button type="button" disabled={!clips.length || !!playing && playing !== "play"} onClick={exportCut} title="The edit as one MP4: hard cuts, with sound"
            className={`${pill} bg-white text-black hover:bg-white/90`}>
            {playing === "export" ? <span>Recording…</span> : <><Download className="h-3.5 w-3.5" />Export cut</>}
          </button>
          <button type="button" disabled={!clips.length || zipping} onClick={() => void takes()} title="Every take, slate-named, with its stills — one .zip"
            className={`${pill} text-white/85 ring-1 ring-inset ring-white/20 hover:bg-white/10`}>
            {zipping ? <span className="eve-shimmer">Packing…</span> : <><Download className="h-3.5 w-3.5" />Export takes</>}
          </button>
        </>
      )}
      {file && <a href={file.url} download={file.name} className="font-mono text-[11px] text-white/70 underline decoration-white/30 underline-offset-2 hover:decoration-white">{file.name}</a>}
      {mode === "result" && earlier.length > 0 && (
        <button type="button" aria-expanded={earlyOpen} onClick={() => { setEarlyOpen((v) => !v); if (earlyOpen) { setEarly(null); } }}
          className={`rounded-full px-2.5 py-1 text-[11.5px] ring-1 ring-inset transition-colors ${earlyOpen ? "bg-white/10 text-white ring-white/25" : "text-white/60 ring-white/12 hover:text-white"}`}>
          Earlier scenes <span className="tabular-nums text-white/40">{earlier.length}</span>
        </button>
      )}
    </>
  );
  // Shoot is the rendering view; watching and delivering the cut happen in Result.
  const controls = mode === "result" ? exportControls : null;

  return (
    <StudioShell label="Shoot" hideRun={mode === "result" || !error || rolling != null}
      next={mode === "shoot" && onResult ? { label: "Result →", onClick: onResult, enabled: anyTake && rolling == null } : undefined} runAria="Shoot the cameras that have no take" phase={phase} setPhase={() => setError(null)} editing={rolling == null}
      stageRef={stageRef} stage={stageContent} controls={controls}
      info={info} queue={rolling != null ? ahead : 0} progress={rendering ? `Rendering ${rendering}…` : undefined} canRun={rolling == null && !!surface && cameras.length > 0 && !playing} onRun={() => { setError(null); const l = missing(); void roll(l.length ? l : undefined); }}
      onBack={working || rolling != null ? stop : undefined} backLabel="Stop"
      notice={mode === "result" ? undefined : !surface ? (own.building ? "Building the set in 3D…" : "The set has no 3D yet") : stale ? "Relight is stale — the plan changed after Relight. Run Relight again before shooting." : undefined} />
  );
}
