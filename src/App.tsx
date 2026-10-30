/**
 * EVE Tools for ComfyUI — one photo becomes a film set.
 * Set → 3D → Light → Cameras → Shoot, on one screen. Every step can be
 * reopened; what it makes flows on down the chain.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setFilm, setMonochrome } from "@/lib/monochrome";
import { Check, Moon, Plus, Sun, X } from "lucide-react";
import { isDemo, queueStatus, serverLabel } from "@/comfy";
import { HeroLoop, LensBackdrop, LensMark } from "@/components/ui/cine";
import { ExtendStudio } from "@/components/tools/extend-editor";
import { LightStudio, type LightPlan } from "@/components/tools/light-studio";
import { CameraRig } from "@/components/tools/camera-rig";
import { Shoot, type EarlierScene, type Shot, type Shots } from "@/components/tools/shoot";
import { loadSession, saveSession } from "@/lib/persist";
import { useServerAttention } from "@/lib/samples-offline";
import { BackendChooser, StatusDot, statusWord, useServer, useServerStatus } from "@/components/ui/backend";
import { GuideRendererHost } from "@/components/tools/guide-renderer";
import type { DepthSurface } from "@/lib/depth-mesh";
import type { RigCamera } from "@/lib/rig";
import { outputAspect, setOutputAspect, type Sensor } from "@/lib/cine";
import { ChromeContext, type Chrome } from "@/components/tools/studio";
import type { Relief } from "@/components/tools/scene-rig";

const STEPS = [
  { id: "set", label: "Extend" },
  { id: "light", label: "Light" },
  { id: "cameras", label: "Cameras" },
  { id: "shoot", label: "Shoot" },
  { id: "result", label: "Result" },
] as const;
type Step = (typeof STEPS)[number]["id"];
/** Each step's address in the browser history (Back / Forward walk the steps; the landing has none). */
const HASH: Record<Step, string> = { set: "extend", light: "light", cameras: "cameras", shoot: "shoot", result: "result" };
const stepOfHash = (h: string) => (Object.keys(HASH) as Step[]).find((k) => HASH[k] === h.replace(/^#/, ""));

// ?demo=0 ends recording mode for this tab (?demo=1 is remembered per tab by isDemo()).
try { if (new URLSearchParams(location.search).get("demo") === "0") sessionStorage.removeItem("eve-tools.demo"); } catch { /* private window */ }

/** A still the app can work with: decoded, its size known, transparency flattened onto black. */
type Still = { blob: Blob; w: number; h: number };
const NOT_AN_IMAGE = "This file isn't an image we can read";
/** Below this many pixels on the short side the stills come back soft. */
const LOW_RES = 512;
/**
 * Decodes the file before anything is kept: an empty, non-image or broken file is refused (null).
 * Alpha is flattened onto black once, here, so Extend, Light and every later step see the same
 * pixels; a GIF becomes its first frame for the same reason.
 */
async function readStill(file: Blob): Promise<Still | null> {
  if (!file.size) return null;
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { return null; }
  const w = bmp.width, h = bmp.height;
  try {
    if (!w || !h) return null;
    // JPEG has no alpha; anything else is checked on a small copy first.
    if (/jpe?g/i.test(file.type)) return { blob: file, w, h };
    const k = Math.min(1, 256 / Math.max(w, h));
    const pw = Math.max(1, Math.round(w * k)), ph = Math.max(1, Math.round(h * k));
    const probe = new OffscreenCanvas(pw, ph).getContext("2d", { willReadFrequently: true });
    if (!probe) return { blob: file, w, h };
    probe.drawImage(bmp, 0, 0, pw, ph);
    const px = probe.getImageData(0, 0, pw, ph).data;
    let alpha = false;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 255) { alpha = true; break; }
    if (!alpha && !/gif/i.test(file.type)) return { blob: file, w, h };
    const flat = new OffscreenCanvas(w, h);
    const ctx = flat.getContext("2d");
    if (!ctx) return { blob: file, w, h };
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0);
    return { blob: await flat.convertToBlob({ type: "image/png" }), w, h };
  } catch {
    return null;
  } finally {
    bmp.close();
  }
}

/** One quiet line over the studio: a question with Yes / No, or a note that closes itself. */
function StudioBar({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div role="status" className="eve-hub-in fixed left-1/2 top-[68px] z-[10090] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-full bg-[#111]/95 py-1.5 pl-4 pr-1.5 text-[12.5px] text-white/85 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl">
      {children}
      <button type="button" onClick={onClose} aria-label="Dismiss" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

type Theme = "light" | "dark";
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try { const t = localStorage.getItem("eve-set-theme"); if (t === "light" || t === "dark") return t; } catch { /* private window */ }
    // A grading suite is dark: dark unless the viewer chose light.
    return "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("eve-set-theme", theme); } catch { /* per session */ }
  }, [theme]);
  return [theme, setTheme] as const;
}

/** Progress at a glance: done steps carry a check, a stale one an amber dot, the ones ahead stay dim. */
function Stepper({ step, open: allowed, done, stale, onStep }: { step: Step; open: boolean[]; done: boolean[]; stale: boolean[]; onStep: (s: Step) => void }) {
  return (
    <nav aria-label="Steps" className="flex items-center gap-0.5 rounded-full bg-white/[0.05] p-0.5 ring-1 ring-inset ring-white/[0.08]">
      {STEPS.map((s, i) => {
        const on = s.id === step, open = allowed[i], state = on ? "" : stale[i] ? ", needs a new pass" : done[i] ? ", done" : "";
        return (
          <button key={s.id} type="button" disabled={!open} aria-current={on ? "step" : undefined} aria-label={`${i + 1} ${s.label}${state}`} onClick={() => onStep(s.id)}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors duration-200 ease-out sm:px-3 ${on ? "bg-white text-black" : open ? "text-white/70 hover:text-white" : "text-white/30"}`}>
            {!on && stale[i] ? <span aria-hidden className="mx-[3px] h-[5px] w-[5px] rounded-full bg-amber-400" />
              : !on && done[i] ? <Check aria-hidden className="h-3 w-3 text-white/70" strokeWidth={2.5} />
              : <span className={`font-mono text-[10.5px] tabular-nums ${on ? "text-black/40" : "text-white/30"}`}>{i + 1}</span>}
            {/* Below 1100 px the title bar is tight: numbers only (a phone gives the stepper its own row, so the current step keeps its name). */}
            <span className={on ? "hidden max-md:inline min-[1100px]:inline" : "hidden min-[1100px]:inline"}>{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** The sample sets: a 1920 px plate (examples/<id>.jpg), a thumbnail (examples/<id>.webp). */
const SAMPLES = [
  { file: "hotel-corridor.jpg", label: "Hotel corridor" },
  { file: "white-room.jpg", label: "White room" },
  { file: "piazza-night.jpg", label: "Piazza, night" },
  { file: "beach-circus.jpg", label: "Beach circus" },
  { file: "red-lounge.jpg", label: "Red lounge" },
  { file: "night-diner.jpg", label: "Night diner" },
  { file: "night-highway.jpg", label: "Night highway" },
  { file: "villa-ballroom.jpg", label: "Villa ballroom" },
];

/** Sample sets that are actually there (served from public/examples). */
type SampleEntry = (typeof SAMPLES)[number];
function useSamples() {
  const [ok, setOk] = useState<SampleEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const has = (url: string, type: string) => fetch(url, { method: "HEAD" }).then((r) => r.ok && (r.headers.get("content-type") ?? "").includes(type)).catch(() => false);
    Promise.all(SAMPLES.map(async (x) => (await has(`${import.meta.env.BASE_URL}examples/${x.file}`, "image/") ? x : null))).then((list) => { if (alive) setOk(list.filter((x): x is SampleEntry => !!x)); });
    return () => { alive = false; };
  }, []);
  return ok;
}

/** Before any still: a title card — the lens and its streak, a 2.39 frame, sample sets as film frames. */
function Landing({ onPhoto, theme, onTheme, onRestore, error }: { onPhoto: (b: Blob, name?: string) => void; theme: Theme; onTheme: () => void; onRestore?: () => void; error?: string | null }) {
  const [hot, setHot] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const samples = useSamples();
  // Any file goes to the app, which decodes it before keeping it (and says so when it can't).
  const take = (files: FileList | null) => { const f = files?.[0]; if (f) onPhoto(f, f.name); };
  // A thumbnail always starts a fresh project at Extend with that plate.
  const open = async (file: string) => {
    setLoading(file);
    try { const r = await fetch(`${import.meta.env.BASE_URL}examples/${file}`); if (r.ok) onPhoto(await r.blob(), SAMPLES.find((x) => x.file === file)?.label); } finally { setLoading(null); }
  };
  return (
    <div className="eve-landing relative flex min-h-full flex-col" onDragOver={(e) => { e.preventDefault(); setHot(true); }} onDragLeave={() => setHot(false)}
      onDrop={(e) => { e.preventDefault(); setHot(false); take(e.dataTransfer.files); }}>
      <header className="relative z-20 flex h-[56px] shrink-0 items-center justify-between px-5">
        <div className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em]"><LensMark size={18} />EVE Tools <span className="font-normal text-[var(--muted)]">for ComfyUI</span></div>
        <ThemeButton theme={theme} onTheme={onTheme} light />
      </header>
      {/* One stacking context with the backdrop, so the hero's black screens away against it. */}
      <main className={`relative isolate flex flex-1 flex-col items-center justify-center gap-8 px-4 pb-8 md:gap-11 md:pb-10 transition-[box-shadow] duration-300 ${hot ? "shadow-[inset_0_0_0_1px_var(--foreground)]" : ""}`}>
        <LensBackdrop />
        <div className="relative flex w-full flex-col items-center gap-4 text-center md:gap-6">
          <HeroLoop sphere="min(17vh, 180px, 42vw)" />
          <h1 className="eve-step-in text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[44px] md:text-[56px]">One photo. A whole film set.</h1>
          {/* The only click that opens the picker; a drop anywhere on the page works too. */}
          <label className="eve-cta">
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
            <Plus aria-hidden className="h-4 w-4" strokeWidth={2.25} />Load a still
          </label>
          <p role="status" aria-live="polite" className={`-mt-1 min-h-[18px] text-[12.5px] text-[var(--muted)] transition-opacity duration-300 md:-mt-3 ${error ? "opacity-100" : "opacity-0"}`}>{error ?? ""}</p>
        </div>
        {samples.length > 0 && (
          <div className="eve-hub-in flex w-full flex-col items-center gap-3" style={{ animationDelay: "120ms" }}>
            {/* Eight frames, 4 × 2 on a desktop: film frames with their names, nothing else. */}
            <div className="grid w-full max-w-[820px] grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
              {samples.map((x) => (
                <div key={x.file} className="group relative min-w-0">
                <button type="button" onClick={() => void open(x.file)} disabled={!!loading} aria-label={`Open sample set: ${x.label}`}
                  className="eve-press flex w-full min-w-0 flex-col gap-1 text-left">
                  <span className="relative block aspect-[2.39/1] w-full overflow-hidden ring-1 ring-[var(--hairline)] transition-shadow duration-300 group-hover:ring-[var(--foreground)]">
                    <img src={`${import.meta.env.BASE_URL}examples/${x.file.replace(/\.jpg$/, ".webp")}`} alt="" loading="lazy" decoding="async"
                      onError={(e) => { const i = e.currentTarget; if (!i.dataset.full) { i.dataset.full = "1"; i.src = `${import.meta.env.BASE_URL}examples/${x.file}`; } }}
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]" />
                  </span>
                  <span className="truncate text-[11.5px] text-[var(--muted)] transition-colors group-hover:text-[var(--foreground)]">{loading === x.file ? "Loading…" : x.label}</span>
                </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Where the work runs: quiet, at the foot of the page. */}
        <div className="eve-hub-in" style={{ animationDelay: "160ms" }}>
          <BackendChooser compact trailing={onRestore && (
            <button type="button" onClick={onRestore} className="text-[11.5px] text-[var(--muted)] underline decoration-[var(--hairline)] underline-offset-4 transition-colors hover:text-[var(--foreground)]">Restore last session</button>
          )} />
        </div>
      </main>
    </div>
  );
}

/** The ComfyUI server: host and a live dot; click to change the address. */
function ServerPill() {
  const [url] = useServer();
  // One missed ping is "Reconnecting" (grey), never an error; two in a row are offline.
  const status = useServerStatus(url);
  const [open, setOpen] = useState(false);
  // A busy server says so: how many prompts it holds (polled every 3 s while the tab is visible).
  const [queued, setQueued] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void queueStatus().then((q) => { if (alive) setQueued(q.running + q.pending); }).catch(() => { if (alive) setQueued(0); });
    };
    tick();
    const t = window.setInterval(tick, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [url]);
  const box = useRef<HTMLDivElement>(null);
  // A run found no server: the pill lights up to show where to connect one.
  const attention = useServerAttention();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", esc); };
  }, [open]);
  // Every on-screen name of the server goes through serverLabel(): in recording mode it is never shown.
  const demo = isDemo();
  const host = serverLabel();
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog"
        title={demo ? undefined : status.state === "online" && status.gpu ? `ComfyUI on ${status.gpu}` : statusWord(status)}
        aria-label={`ComfyUI server: ${host}, ${statusWord(status)}`}
        className={`eve-press flex h-7 max-w-[150px] min-[1100px]:max-w-[240px] items-center gap-1.5 rounded-full px-2.5 font-mono text-[10.5px] tracking-[0.02em] ring-1 ring-inset transition-[box-shadow,color] duration-300 hover:bg-white/[0.08] hover:text-white ${attention ? "text-white ring-white/80 shadow-[0_0_0_4px_rgba(255,255,255,0.12)]" : "text-white/75 ring-white/[0.14]"}`}>
        <StatusDot status={status} />
        <span className="hidden truncate sm:inline">{host}</span>
        {queued > 0 && <span className="whitespace-nowrap font-sans text-[12px] text-white/45">{queued} in queue</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="ComfyUI server" className="eve-hub-in absolute right-0 top-9 z-50 w-[min(440px,92vw)] rounded-2xl bg-[#0a0a0a]/95 p-4 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl">
          <BackendChooser tone="studio" onChosen={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** The host the info lines name. */
export function serverHost() {
  return serverLabel();
}

function ThemeButton({ theme, onTheme, light }: { theme: Theme; onTheme: () => void; light?: boolean }) {
  return (
    <button type="button" onClick={onTheme} aria-label={theme === "dark" ? "Light theme" : "Dark theme"} title={theme === "dark" ? "Light theme" : "Dark theme"}
      className={`eve-press flex h-7 w-7 items-center justify-center rounded-full ring-1 ring-inset ${light ? "text-[var(--muted)] ring-[var(--hairline)] hover:text-[var(--foreground)]" : "text-white/70 ring-white/20 hover:bg-white/10 hover:text-white"}`}>
      {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </button>
  );
}

/** What survives a reload. */
type SavedTake = { status: Shot["status"]; trim: [number, number]; error?: string; a?: Blob; b?: Blob; clip?: Blob; ga?: Blob; gb?: Blob };
type Saved = {
  v: 1;
  photo: Blob; plate: Blob | null; litPlate: Blob | null;
  /** "3d" only in records from before the 3D step merged into Light. */
  step: Step | "3d"; reached: number; relief: Relief; sensor: Sensor;
  /** 4 = step indices without the old 3D step; absent = the old five steps. */
  steps?: 4;
  plan: LightPlan | null; cameras: RigCamera[]; scenePrompt: string; order: string[];
  /** The light plan the lit plate was made with. */
  litPlan?: string | null;
  shots: Record<string, SavedTake & { take?: number; setup?: string; takes?: (SavedTake & { take: number; seconds?: number })[] }>;
  /** A pre-rendered sample project: its id (src/samples.ts). */
  sample?: string | null;
  /** This scene: the still it came from and when it was started. */
  scene?: { id: string; name: string; time: number };
  /** Earlier scenes of this visit, kept with their takes. */
  archive?: { id: string; name: string; time: number; sensor: Sensor; cameras: RigCamera[]; order: string[]; shots: Saved["shots"] }[];
};
/** Shots to plain blobs for IndexedDB, and back to playable media. */
const packShots = (shots: Shots): Saved["shots"] => Object.fromEntries(Object.entries(shots).map(([id, x]) => [id, { status: x.status, trim: x.trim, error: x.error, a: x.a?.blob, b: x.b?.blob, clip: x.clip?.blob, take: x.take, setup: x.setup, ga: x.ga?.blob, gb: x.gb?.blob,
  takes: x.takes?.map((t) => ({ take: t.take, status: t.status, trim: t.trim, error: t.error, seconds: t.seconds, a: t.a?.blob, b: t.b?.blob, clip: t.clip?.blob, ga: t.ga?.blob, gb: t.gb?.blob })) }]));
function unpackShots(saved: Saved["shots"]): Shots {
  const m = (b?: Blob) => (b ? { blob: b, url: URL.createObjectURL(b) } : undefined);
  return Object.fromEntries(Object.entries(saved).map(([id, x]) => {
    // A run cut short by the reload keeps what it had made.
    const status: Shot["status"] = x.clip ? "done" : x.a ? (x.status === "failed" ? "failed" : "storyboard") : x.status === "failed" ? "failed" : "idle";
    const takes = x.takes?.map((t) => ({ take: t.take, status: t.status, trim: t.trim, error: t.error, seconds: t.seconds, a: m(t.a), b: m(t.b), clip: m(t.clip), ga: m(t.ga), gb: m(t.gb) }));
    return [id, { status, trim: x.trim, error: x.error, a: m(x.a), b: m(x.b), clip: m(x.clip), take: x.take, setup: x.setup, ga: m(x.ga), gb: m(x.gb), takes }];
  }));
}
const newScene = (name = "Still") => ({ id: `s${Date.now().toString(36)}`, name: name.replace(/\.[a-z0-9]+$/i, ""), time: Date.now() });

export function App() {
  const [theme, setTheme] = useTheme();
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");
  const [photo, setPhoto] = useState<Blob | null>(null);
  // The set's plate: the extended frame, or the photo itself until Extend has run.
  const [plate, setPlate] = useState<Blob | null>(null);
  const [step, setStep] = useState<Step>("set");
  const [reached, setReached] = useState(0);
  const [relief, setRelief] = useState<Relief>("balanced");
  const [plan, setPlan] = useState<LightPlan | null>(null);
  const [sensor, setSensor] = useState<Sensor>("s35");
  // The relit plate every camera shoots; the plate itself if Relight was skipped.
  const [litPlate, setLitPlate] = useState<Blob | null>(null);
  // The plan the lit plate was relit with; a different plan now means the plate is stale.
  const [litPlan, setLitPlan] = useState<string | null>(null);
  const planKey = plan ? JSON.stringify({ l: plan.lights.map(({ id: _id, ...l }) => l), a: plan.ambient }) : null;
  const stale = !!litPlate && litPlan != null && planKey !== litPlan;
  const [cameras, setCameras] = useState<RigCamera[]>([]);
  const [surface, setSurface] = useState<DepthSurface | null>(null);
  const [scenePrompt, setScenePrompt] = useState("");
  const [shots, setShots] = useState<Shots>({});
  const [order, setOrder] = useState<string[]>([]);
  const [scene, setScene] = useState(() => newScene());
  const [archive, setArchive] = useState<EarlierScene[]>([]);
  // Opened from a pre-rendered sample bundle (README material; no UI path opens one now).
  const [sample, setSample] = useState<string | null>(null);
  // A new lit plate means a new rig; a new plate, a new set (lighting and rig start over).
  const newRig = () => { setCameras([]); setSurface(null); setShots({}); setOrder([]); };
  // A new set starts in the default look: Color, Digital.
  const newSet = () => { setLitPlate(null); setLitPlan(null); newRig(); setMonochrome(false); setFilm(false); };

  // The session survives a reload: restored once, then saved (debounced) on every change.
  const [hydrated, setHydrated] = useState(false);
  // A reload and a sample bundle restore the same record.
  const restore = (v: Saved) => {
    setSample(v.sample ?? null);
    setPhoto(v.photo); setPlate(v.plate); setLitPlate(v.litPlate); setLitPlan(v.litPlan ?? null); setRelief(v.relief); setSensor(v.sensor); setPlan(v.plan);
    setCameras(v.cameras); setScenePrompt(v.scenePrompt); setOrder(v.order);
    // The 3D step lives inside Light now: old records open there, their step indices one lower past it.
    setStep(v.step === "3d" ? "light" : v.step); setReached(v.steps === 4 || v.reached <= 1 ? v.reached : v.reached - 1);
    setShots(unpackShots(v.shots));
    const sc = v.scene ?? newScene();
    setScene(sc);
    // The restored scene leaves the earlier ones; scenes already in memory keep their media.
    setArchive((now) => {
      const mem = new Map(now.map((x) => [x.id, x]));
      return (v.archive ?? []).filter((x) => x.id !== sc.id).map((x) => mem.get(x.id) ?? { ...x, shots: unpackShots(x.shots) });
    });
  };
  const snapshot = (): Saved => ({
    v: 1, steps: 4, photo: photo!, plate, litPlate, litPlan, step, reached, relief, sensor, plan, cameras, scenePrompt, order, sample,
    shots: packShots(shots), scene, archive: archive.map((x) => ({ ...x, shots: packShots(x.shots) })),
  });
  /** Leaving a scene with takes: it joins the earlier scenes, newest first. */
  const shelve = () => {
    if (!Object.values(shots).some((x) => x.a || x.clip)) return;
    setArchive((a) => [{ ...scene, sensor, cameras, order, shots }, ...a.filter((x) => x.id !== scene.id)]);
  };
  // A reload starts fresh on the landing; the last session waits behind "Restore last session".
  const [lastSession, setLastSession] = useState<Saved | null>(null);
  useEffect(() => {
    void loadSession<Saved>().then((v) => {
      if (v?.v === 1 && v.photo) setLastSession(v);
      setHydrated(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => {
      // On the landing the last session is kept for "Restore last session".
      if (!photo) return;
      void saveSession(snapshot());
    }, 800);
    return () => clearTimeout(timer);
  }, [hydrated, photo, plate, litPlate, litPlan, step, reached, relief, sensor, plan, cameras, scenePrompt, order, shots, sample, scene, archive]);

  // The delivery frame follows the plate: the format chosen in Extend (or the photo's own, if skipped).
  const [, setDelivery] = useState(outputAspect());
  useEffect(() => {
    const b = plate ?? photo;
    if (!b) return;
    let alive = true;
    void createImageBitmap(b).then((bmp) => { if (alive) { setOutputAspect(bmp.width / bmp.height); setDelivery(outputAspect()); } bmp.close(); }).catch(() => {});
    return () => { alive = false; };
  }, [plate, photo]);

  const go = useCallback((s: Step) => {
    setStep(s);
    setReached((r) => Math.max(r, STEPS.findIndex((x) => x.id === s)));
  }, []);
  const photoSource = useCallback(async () => photo!, [photo]);
  const plateSource = useCallback(async () => (plate ?? photo)!, [plate, photo]);
  const litSource = useCallback(async () => (litPlate ?? plate ?? photo)!, [litPlate, plate, photo]);
  // Result opens once there is something to watch.
  const hasTake = Object.values(shots).some((x) => x.a || x.clip);
  // Result also opens for the earlier scenes of this visit.
  const open = [true, reached >= 1, reached >= 2, reached >= 2 && cameras.length > 0, hasTake || archive.length > 0];

  /** Back to the landing: the project is saved and waits behind "Restore last session". */
  const home = () => {
    const v = snapshot();
    void saveSession(v); setLastSession(v);
    shelve();
    setPhoto(null); setPlate(null); newSet(); setPlan(null); setStep("set"); setReached(0); setSample(null); setScenePrompt("");
  };
  /** A fresh project from a decoded still, at Extend. */
  const startNew = (still: Still, name?: string) => {
    setScene(newScene(name)); setPhoto(still.blob); setPlate(null); newSet(); setPlan(null); setSample(null); setScenePrompt("");
    setStep("set"); setReached(0);
    setLandingError(null);
    setNote(Math.min(still.w, still.h) < LOW_RES ? `Small still (${still.w} × ${still.h}) — results will be soft; ${LOW_RES * 2} px or more on the short side works best` : null);
  };
  // Every file is decoded before it is kept: a bad one leaves the saved session untouched.
  const [landingError, setLandingError] = useState<string | null>(null);
  const fromLanding = async (b: Blob, name?: string) => {
    setLandingError(null);
    const still = await readStill(b);
    if (still) startNew(still, name); else setLandingError(NOT_AN_IMAGE);
  };
  // A quiet note over the studio (a small still), and a still dropped on a studio step waiting for Yes / No.
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 7000);
    return () => window.clearTimeout(t);
  }, [note]);
  const [dropped, setDropped] = useState<{ file: File; error?: string } | null>(null);
  const acceptDrop = async () => {
    if (!dropped) return;
    const still = await readStill(dropped.file);
    if (!still) { setDropped({ ...dropped, error: NOT_AN_IMAGE }); return; }
    setDropped(null);
    // The current project is saved and its takes join the earlier scenes.
    const v = snapshot();
    void saveSession(v);
    shelve();
    startNew(still, dropped.file.name);
  };

  // The latest state for the window listeners below (registered once).
  const live = useRef({ photo, step, open: [] as boolean[], home, lastSession, restore });

  // A file dropped anywhere never navigates the browser away. On the landing its own handler takes it;
  // on a studio step the still waits behind a question.
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const over = (e: DragEvent) => { if (files(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      if (handled || !live.current.photo) return;
      const f = e.dataTransfer?.files[0];
      if (f) setDropped({ file: f });
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  }, []);

  // Browser history: one entry per step, the landing below them. A reload always lands on the landing.
  const replaceNext = useRef(false);
  useEffect(() => {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    const want = photo ? `#${HASH[step]}` : "";
    if (location.hash === want) return;
    const url = want || location.pathname + location.search;
    if (replaceNext.current) { replaceNext.current = false; history.replaceState(null, "", url); } else history.pushState(null, "", url);
  }, [hydrated, photo, step]);
  useEffect(() => {
    const pop = () => {
      const now = live.current, target = stepOfHash(location.hash);
      if (!location.hash) { if (now.photo) now.home(); return; }
      if (!now.photo) {
        // Forward from the landing: back into the saved project, if there is one.
        if (now.lastSession) { replaceNext.current = true; now.restore(now.lastSession); setLastSession(null); }
        else history.replaceState(null, "", location.pathname + location.search);
        return;
      }
      const i = target ? STEPS.findIndex((x) => x.id === target) : -1;
      if (target && now.open[i]) setStep(target);
      else history.replaceState(null, "", `#${HASH[now.step]}`);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  const chrome = useMemo<Chrome>(() => ({
    stepper: <Stepper step={step} open={open} onStep={go} stale={STEPS.map((x) => x.id === "light" && stale)}
      done={STEPS.map((x) => ({ set: !!plate || !!litPlate || cameras.length > 0, light: !!litPlate || cameras.length > 0, cameras: cameras.length > 0 && reached >= 3, shoot: hasTake, result: false } as Record<Step, boolean>)[x.id])} />,
    host: serverHost(),
    // The mark goes home: the project is saved and waits behind "Restore last session".
    onHome: home,
    right: (
      <>
        <ServerPill />
        <button type="button" onClick={() => { shelve(); setPhoto(null); setPlate(null); newSet(); setPlan(null); setStep("set"); setReached(0); setSample(null); setScenePrompt(""); }}
          className="eve-press h-7 rounded-full px-3 text-[12px] font-medium text-white/75 ring-1 ring-inset ring-white/[0.14] hover:bg-white/[0.08] hover:text-white">New<span className="hidden sm:inline"> still</span></button>
        {/* No theme toggle here: the studio is black in both themes (a grading suite); the landing keeps it. */}
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [step, reached, go, theme, cameras.length, sample, hasTake, stale, scene, archive, shots, plate, litPlate, litPlan, relief, sensor, plan, cameras, scenePrompt, order]);

  live.current = { photo, step, open, home, lastSession, restore };

  if (!hydrated) return null;
  if (!photo) return <Landing onPhoto={(b, name) => void fromLanding(b, name)} theme={theme} onTheme={toggleTheme} error={landingError}
    onRestore={lastSession ? () => { setLandingError(null); restore(lastSession); setLastSession(null); } : undefined} />;

  return (
    <ChromeContext.Provider value={chrome}>
      <div key={step} className="eve-step-in">
      {step === "set" && <ExtendStudio source={photoSource} onResult={(b) => { setPlate(b); newSet(); setSample(null); }} onNext={() => go("light")} />}
      {step === "light" && <LightStudio source={plateSource} initial={plan} onPlan={setPlan} relief={relief} onRelief={setRelief} stale={stale}
        onResult={(b) => { setLitPlate(b); setLitPlan(planKey); newRig(); setSample(null); }} onNext={() => go("cameras")} />}
      {step === "cameras" && <CameraRig source={litSource} relief={relief} stale={stale} cameras={cameras} onCameras={setCameras} onSurface={setSurface} sensor={sensor} onSensor={setSensor} lights={plan?.lights}
        prompt={scenePrompt} setPrompt={setScenePrompt} onNext={() => go("shoot")} />}
      {(step === "shoot" || step === "result") && (litPlate ?? plate ?? photo) && <Shoot key={step} mode={step === "result" ? "result" : "shoot"} plate={(litPlate ?? plate ?? photo)!} surface={surface} relief={relief} stale={stale} cameras={cameras} prompt={scenePrompt}
        sensor={sensor} plan={plan} shots={shots} setShots={setShots} order={order} setOrder={setOrder} onResult={() => go("result")} earlier={archive} />}
      </div>
      <GuideRendererHost />
      {dropped ? (
        <StudioBar onClose={() => setDropped(null)}>
          {dropped.error ? <span className="truncate">{dropped.error}</span> : (
            <>
              <span className="truncate">Start a new set from this still?</span>
              <button type="button" onClick={() => void acceptDrop()} className="eve-press h-6 shrink-0 rounded-full bg-white px-3 text-[12px] font-semibold text-black hover:bg-white/90">Yes</button>
              <button type="button" onClick={() => setDropped(null)} className="eve-press h-6 shrink-0 rounded-full px-3 text-[12px] font-medium text-white/75 ring-1 ring-inset ring-white/20 hover:bg-white/10 hover:text-white">No</button>
            </>
          )}
        </StudioBar>
      ) : note && <StudioBar onClose={() => setNote(null)}><span className="truncate">{note}</span></StudioBar>}
    </ChromeContext.Provider>
  );
}
