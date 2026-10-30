
/**
 * Light and Camera steps of the set, on the photo turned into a 3D
 * scene (local depth → DepthScene) right where the photo sits.
 *
 * Relight: lights hang off the scene's own surfaces — click to put the
 * selected one there, drag a light to slide it along walls and floor, drag
 * elsewhere to look round. The scene is shaded live, and that preview goes
 * to the model with the photo as the setup to follow.
 *
 * Reframe: drag to move the camera (within what the lens saw — at most ±45° round, ±30° up/down); Lens swaps
 * the lens with optical zoom (4–500 mm); Focus adds depth of field — click
 * to focus. The model gets the scene seen from there, with what the photo
 * never showed left grey in the generation guide. The editor leaves missing
 * surfaces empty, without invented background layers.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Move, Plus, Rotate3d, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react";
import type { GizmoMode } from "./light-rig3d";
import { film, monochrome, onMonochrome, setFilm, setMonochrome } from "@/lib/monochrome";
import { Slider } from "@/components/ui/slider";
import { relightPrompt, reframePrompt } from "@/prompts";
import { runEdit } from "@/comfy";
import { depthFor } from "@/lib/depth";
import { LightColourPicker } from "./light-colour-picker";
import { BASE_FOCAL, buildSurface, orbitLimits, surfacePoint, type DepthSurface } from "@/lib/depth-mesh";
import { FILL_GREY } from "@/lib/extend-fill";
import { AMBIENT, FIXTURES, FOCAL, LIBRARY, PRESETS, RELIEF, ROLES, guideSize, libraryPatch, libraryUnit, type LibraryUnit, behindSubject, presetLights, relightParams, type Ambient, type Relief } from "./scene-rig";
import { fmtStops, kelvinHex, stops } from "@/lib/cine";
import { LensLoader, LensMark, Viewfinder } from "@/components/ui/cine";
import { DOLLY, DepthScene, FRONT, type DepthSceneHandle, type Fixture, type LightKind, type LightRole, type SceneCamera, type SceneFocus, type SceneLight } from "@/components/tools/depth-scene";
import { StageState, StudioGlow, StudioResult, StudioShell, fitRect, resultRect, useStage, useStudioRun, useStudioSource, type Rect, type StudioProps } from "@/components/tools/studio";

/** The scene's one lighting plan, shared by every camera. */
export type LightPlan = { lights: SceneLight[]; ambient: Ambient };

/** Slider position 0..1 ↔ a value on a log scale. */
const fromT = ([lo, hi]: [number, number], t: number) => lo * (hi / lo) ** t;
const toT = ([lo, hi]: [number, number], v: number) => Math.log(v / lo) / Math.log(hi / lo);

export function useImage(url: string | null) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!url) return;
    const el = new Image();
    el.onload = () => setImg(el);
    el.src = url;
  }, [url]);
  return img;
}

type Building = { stage: "download"; fraction: number } | { stage: "estimate" } | null;

/** The photo's measured 3D surface: local depth, or a flat card if depth could not be had. */
export function useSurface(blob: Blob | null, size: { w: number; h: number } | null, relief = 0.35) {
  const [surface, setSurface] = useState<DepthSurface | null>(null);
  const [building, setBuilding] = useState<Building>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [rough, setRough] = useState(false);
  useEffect(() => {
    if (!blob || !size) return;
    let alive = true;
    const aspect = size.w / size.h;
    setFailed(null);
    setBuilding({ stage: "estimate" });
    depthFor(blob, (p) => { if (alive) setBuilding(p); })
      .then((d) => {
        if (!alive) return;
        setSurface(buildSurface(d, aspect, { relief }));
        setRough(d.model !== "moge");
        setBuilding(null);

      })
      .catch((error) => {
        if (!alive) return;
        setFailed(error instanceof Error ? error.message : String(error));
        setSurface(buildSurface(null, aspect));
        setBuilding(null);
      });
    return () => { alive = false; };
  }, [blob, size, relief]);
  // A WebView without WebGPU gets the quick relative-depth model: say so.
  return { surface, building, failed: failed ?? (rough ? "rough 3D: no WebGPU here" : null) };
}

export function BuildingBadge({ building }: { building: Building }) {
  if (!building) return null;
  const pct = building.stage === "download" ? Math.round(building.fraction * 100) : null;
  // Quiet text at the foot of the stage, never over the picture; a hairline when there is a percentage.
  return (
    <div aria-live="polite" className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5">
      <span className="eve-shimmer text-[13px]">{pct != null ? `Downloading depth model — ${pct}%` : "Building 3D…"}</span>
      {pct != null && <span className="block h-[2px] w-40 overflow-hidden rounded-full bg-white/10"><span className="block h-full rounded-full bg-white/60 transition-[width] duration-300" style={{ width: `${pct}%` }} /></span>}
    </div>
  );
}


/** Equal minimum margins on all four sides; no asymmetric percentage padding. */
export function sceneRect(stage: { w: number; h: number }, w: number, h: number): Rect {
  const inset = 24;
  return fitRect(stage, w, h, Math.max(0, stage.w - inset * 2) / stage.w, Math.max(0, stage.h - inset * 2) / stage.h);
}

export function BuildingPhoto({ url, rect, aspect, loading }: { url: string; rect: Rect; aspect: number; loading: boolean }) {
  return <div aria-hidden className="pointer-events-none absolute overflow-hidden transition-opacity duration-700 motion-reduce:transition-none"
    style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, opacity: loading ? 1 : 0 }}>
    <img src={url} alt="" draggable={false} className="absolute max-w-none" style={{
      height: rect.h, width: rect.h * aspect, left: (rect.w - rect.h * aspect) / 2, top: 0,
      filter: "blur(4px)", opacity: 0.85,
    }} />
  </div>;
}

type CameraPhoto = { url: string; aspect: number };
function CameraThumbnail({ photo, scale = 1, cy = 60, tilt = 0 }: { photo: CameraPhoto; scale?: number; cy?: number; tilt?: number }) {
  const w = Math.min(52, 44 * photo.aspect) * scale, h = w / photo.aspect;
  return <foreignObject x={60 - w / 2} y={cy - h / 2} width={w} height={h} pointerEvents="none" style={{ transform: `perspective(120px) rotateX(${tilt}deg)`, transformOrigin: "center", transformBox: "fill-box" }}>
    <img src={photo.url} alt="" draggable={false} style={{ width: "100%", height: "100%", borderRadius: 3, boxShadow: "inset 0 0 0 1px rgba(255,255,255,.25)" }} />
  </foreignObject>;
}

/** Matching side-view and distance controls, separate from the orbit compass. */
export function CameraDial({ kind, value, onChange, photo }: { photo: CameraPhoto; kind: "elevation" | "distance" | "lens"; value: number; onChange: (v: number) => void }) {
  const elevation = kind === "elevation", lens = kind === "lens";
  const range = lens ? FOCAL : DOLLY;
  const t = elevation ? (value + 75) / 150 : toT(range, value);
  const change = (t: number) => onChange(elevation ? -75 + t * 150 : fromT(range, t));
  const point = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width * 120 - 60, dy = (e.clientY - r.top) / r.height * 120 - 60;
    change(Math.max(0, Math.min(1, elevation ? (40 - dy) / 80 : (dx + 40) / 80)));
  };
  return <div className="rounded-2xl bg-black/60 p-1.5 ring-1 ring-inset ring-white/[0.1] backdrop-blur-xl">
    <svg width="120" height="120" viewBox="0 0 120 120" role="slider" tabIndex={0} aria-label={elevation ? "Camera elevation" : lens ? "Lens focal length" : "Camera distance"}
      aria-valuemin={elevation ? -75 : range[0]} aria-valuemax={elevation ? 75 : range[1]} aria-valuenow={value}
      className="cursor-pointer touch-none outline-none focus-visible:rounded-xl focus-visible:ring-1 focus-visible:ring-white/60"
      onKeyDown={(e) => { if (["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(e.key)) { e.preventDefault(); change(e.key === "Home" ? 0 : e.key === "End" ? 1 : Math.max(0, Math.min(1, t + (["ArrowLeft", "ArrowDown"].includes(e.key) ? -0.02 : 0.02)))); } }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); point(e); }} onPointerMove={(e) => { if (e.buttons) point(e); }}>
      {elevation ? <>
        <g transform="translate(-12 0)"><CameraThumbnail photo={photo} tilt={value} /></g>
        <path d="M 98 20 V 100" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="6" strokeLinecap="round" />
        <path d={`M 98 60 V ${100 - t * 80}`} fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="6" strokeLinecap="round" />
        <path d="M 91 60 H 105" stroke="rgba(255,255,255,.4)" strokeWidth="1" />
        <circle cx="98" cy={100 - t * 80} r="7" fill="#f5f5f7" stroke="#000" strokeOpacity=".5" />
        <text x="50" y="20" textAnchor="middle" fill="rgba(255,255,255,.6)" fontSize="8">Up</text>
        <text x="50" y="105" textAnchor="middle" fill="rgba(255,255,255,.6)" fontSize="8">Down</text>
      </> : <>
        <CameraThumbnail photo={photo} scale={lens ? 0.55 + t * 0.7 : 1.25 - t * 0.7} cy={49} />
        <path d="M 20 98 H 100" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="6" strokeLinecap="round" />
        <path d={`M 20 98 H ${20 + t * 80}`} fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="6" strokeLinecap="round" />
        <circle cx={20 + t * 80} cy="98" r="7" fill="#f5f5f7" stroke="#000" strokeOpacity=".5" />
        <text x="20" y="85" textAnchor="middle" fill="rgba(255,255,255,.6)" fontSize="8">{lens ? "Wide" : "+"}</text>
        <text x="100" y="85" textAnchor="middle" fill="rgba(255,255,255,.6)" fontSize="8">{lens ? "Tele" : "−"}</text>
      </>}
    </svg>
    <div className="pb-0.5 text-center text-[10.5px] tabular-nums text-white/70">{elevation ? `${Math.abs(Math.round(value))}° ${value >= 0 ? "up" : "down"}` : lens ? `Lens · ${Math.round(value)} mm` : `Distance ×${value.toFixed(2)}`}</div>
  </div>;
}

/** A popover anchored to its button, fixed (the controls bar clips overflow); closes on a click outside. */
function Popover({ label, button, children, width = 260 }: { label: string; button: (open: boolean) => React.ReactNode; children: (close: () => void) => React.ReactNode; width?: number }) {
  const [open, setOpen] = useState<{ left: number; bottom: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(null); };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-haspopup="dialog" aria-expanded={!!open} aria-label={label}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setOpen((o) => (o ? null : { left: Math.max(8, Math.min(window.innerWidth - width - 8, r.left)), bottom: window.innerHeight - r.top + 8 })); }}>{button(!!open)}</button>
      {open && (
        <div role="dialog" aria-label={label} className="eve-hub-in fixed z-[10080] max-h-[70vh] overflow-y-auto rounded-2xl bg-[#1c1c1e]/95 p-1.5 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl" style={{ ...open, width }}>
          {children(() => setOpen(null))}
        </div>
      )}
    </div>
  );
}

/** The fixture library, by category. */
function FixturePicker({ value, onPick }: { value: string; onPick: (u: LibraryUnit) => void }) {
  const groups = [...new Set(LIBRARY.map((u) => u.group))];
  return (
    <Popover label="Fixture" width={250} button={(open) => (
      <span className={`flex h-7 max-w-[170px] items-center gap-1 rounded-full bg-white/10 pl-3 pr-2 text-[12px] font-medium text-white ring-1 ring-inset ${open ? "ring-white/40" : "ring-white/15"}`}>
        <span className="truncate">{value}</span><ChevronDown className="h-3 w-3 shrink-0 text-white/50" />
      </span>
    )}>
      {(close) => groups.map((g) => (
        <div key={g} className="pb-1">
          <div className="px-2.5 pb-0.5 pt-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-white/35">{g}</div>
          {LIBRARY.filter((u) => u.group === g).map((u) => (
            <button key={u.id} type="button" onClick={() => { close(); onPick(u); }}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-white/[0.08] ${u.label === value ? "text-white" : "text-white/80"}`}>
              {u.label}<span className="font-mono text-[10px] tabular-nums text-white/35">{u.flash ? "flash" : `${u.kelvin} K`}</span>
            </button>
          ))}
        </div>
      ))}
    </Popover>
  );
}

const GRAIN = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")`;
/** Film preview (screen only): halation (an SVG bloom of the highlights), softer contrast, a warm cast. */
const FILM = "url(#eve-film-halation) contrast(0.9) saturate(0.88) brightness(1.03) sepia(0.16)";
const FILM_MONO = "url(#eve-film-halation-mono) grayscale(1) contrast(0.9) brightness(1.03)";
/** Halation: only what is near white survives, blurred, tinted red-orange (grey in B&W) and screened back over the image. */
function FilmHalation() {
  const bloom = (id: string, tint: string) => (
    <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
      <feComponentTransfer in="SourceGraphic" result="hi">
        <feFuncR type="linear" slope="2.6" intercept="-1.7" /><feFuncG type="linear" slope="2.6" intercept="-1.7" /><feFuncB type="linear" slope="2.6" intercept="-1.7" />
      </feComponentTransfer>
      <feGaussianBlur in="hi" stdDeviation="7" result="soft" />
      <feColorMatrix in="soft" type="matrix" values={tint} result="glow" />
      <feBlend in="SourceGraphic" in2="glow" mode="screen" />
    </filter>
  );
  return (
    <svg aria-hidden width="0" height="0" className="pointer-events-none absolute">
      {bloom("eve-film-halation", "0.75 0.25 0 0 0  0.2 0.25 0 0 0  0.05 0.05 0.05 0 0  0 0 0 1 0")}
      {bloom("eve-film-halation-mono", "0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0 0 0 1 0")}
    </svg>
  );
}
const Divider = () => <span aria-hidden className="h-4 w-px shrink-0 bg-white/10" />;
const tiny = "text-[10.5px] text-white/45";

const pill = (on: boolean) => `rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${on ? "bg-white text-black" : "text-white/70 hover:text-white"}`;
const round = "flex h-7 w-7 items-center justify-center rounded-full text-white/70 ring-1 ring-inset ring-white/20 hover:bg-white/10 hover:text-white disabled:opacity-35";

/** Where a light is, in the words relightPrompt uses: round the scene's middle, seen from the camera. */
export function LightStudio({ source, onResult, onNext, onPlan, initial, relief = "balanced", onRelief, stale }: StudioProps & {
  onPlan?: (plan: LightPlan) => void;
  initial?: LightPlan | null;
  /** The same depth relief as the 3D step, so lights hang on the same surfaces. */
  relief?: Relief;
  /** Relief chosen here (the 3D step lives inside Light). */
  onRelief?: (r: Relief) => void;
  /** The plan changed after the last Relight. */
  stale?: boolean;
}) {
  const { blob, url, size, loadError } = useStudioSource(source);
  const { phase, setPhase, editing, run: runJob, revealed, back, ahead, onQueue } = useStudioRun("Qwen-Image-Edit", onResult);
  const { ref: stageRef, stage } = useStage();
  const img = useImage(url);
  const { surface, building, failed } = useSurface(blob, size, RELIEF[relief]);
  const [sceneReady, setSceneReady] = useState(false);
  const scene = useRef<DepthSceneHandle>(null);
  // The plan carries over when the step is reopened (and across a reload).
  const [lights, setLights] = useState<SceneLight[]>(() => initial?.lights ?? []);
  const [selected, setSelected] = useState<string | null>(() => initial?.lights[0]?.id ?? null);
  const [ambient, setAmbient] = useState<keyof typeof AMBIENT>(() => initial?.ambient ?? "balanced");
  const [view, setView] = useState<SceneCamera>(FRONT);
  // Idle, the set breathes very gently so it reads as 3D; any handling pauses it, 1.5 s of rest resumes it.
  const [idle, setIdle] = useState(true);
  const idleTimer = useRef(0);
  const stir = () => {
    setIdle((v) => (v ? false : v));
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 1500);
  };
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);
  const front = () => setView(FRONT);
  // A relief change rebuilds the surface: the scene dims and comes back instead of flashing the photo.
  const rebuilding = !!building && !!surface;
  const [prompt, setPrompt] = useState("");
  // What the last preset's look needs beyond its units (slat shadows, rain): told to the model with the notes.
  const [presetWords, setPresetWords] = useState("");
  // The units drawn as fixtures on the set (screen only; never in the guide).
  const [fixtures, setFixtures] = useState(true);
  // Black & white for the whole set (lib/monochrome): preview here, prompts and graphs everywhere.
  const [mono, setMono] = useState(monochrome);
  const [filmLook, setFilmLook] = useState(film);
  useEffect(() => onMonochrome((m) => { setMono(m); setFilmLook(film()); }), []);
  // The gizmo: W = move, E = rotate (as in 3D editors).
  const [mode, setMode] = useState<GizmoMode>("move");
  // Move axes: Global (left/right, up, into the set) by default; Local = blue along the beam. T toggles.
  const [orient, setOrient] = useState<"global" | "local">("global");
  // The overhead grid: off, or its height (share of the frame's top at the set's middle).
  const [grid, setGrid] = useState<number | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "w" || e.key === "W") setMode("move");
      if (e.key === "e" || e.key === "E") setMode("rotate");
      if (e.key === "t" || e.key === "T") setOrient((o) => (o === "global" ? "local" : "global"));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // New lights start on the surface: upper left, then upper right, then low; key, fill, back, practical.
  const starter = (s: DepthSurface, n: number): SceneLight => {
    const role = (["key", "fill", "back", "practical"] as LightRole[])[n % 4];
    const fixture: Fixture = role === "key" ? "fresnel" : role === "fill" ? "softbox" : role === "back" ? "openface" : "practical";
    const kelvin = role === "practical" ? 2700 : role === "back" ? 3200 : 5600;
    const f = FIXTURES[fixture];
    const l: SceneLight = {
      id: `l${Date.now()}${n}`, ...surfacePoint(s, [0.28, 0.72, 0.3, 0.7][n % 4], [0.3, 0.3, 0.72, 0.72][n % 4]),
      offset: f.offset ?? 0.32, kind: f.kind, beam: f.beam, aim: f.kind === "point" ? undefined : surfacePoint(s, 0.5, 0.55).anchor,
      fixture, role, kelvin, tint: 0, colour: kelvinHex(kelvin), strength: [0.8, 0.4, 0.6, 0.35][n % 4],
    };
    // A back light starts where it does its job: behind the subject.
    return role === "back" ? { ...l, ...behindSubject(s, l) } : l;
  };
  useEffect(() => {
    if (!surface) return;
    setLights((ls) => {
      if (ls.length) return ls;
      const first = starter(surface, 0);
      setSelected(first.id);
      return [first];
    });
  }, [surface]);
  useEffect(() => { onPlan?.({ lights, ambient }); }, [lights, ambient, onPlan]);
  const sel = lights.find((l) => l.id === selected) ?? lights[0];
  const update = (id: string, patch: Partial<SceneLight>) => setLights((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const add = () => {
    if (!surface || lights.length >= 4) return;
    const l = starter(surface, lights.length);
    setLights((ls) => [...ls, l]);
    setSelected(l.id);
  };
  const remove = () => {
    if (lights.length <= 1 || !sel) return;
    const rest = lights.filter((l) => l.id !== sel.id);
    setLights(rest);
    setSelected(rest[0].id);
  };

  const applyPreset = (id: string) => {
    const preset = surface ? presetLights(surface, id) : null;
    if (!preset) return;
    // Each look brings its own units, jobs, Kelvin and gels (scene-rig PRESETS).
    const lit = preset.lights;
    setLights(lit);
    setSelected(lit[0].id);
    setAmbient(preset.ambient);
    setPresetWords(preset.words ?? "");
  };

  // Dev only: lets a smoke test take the exact guide Relight sends (it must never show fixtures or the gizmo).
  useEffect(() => {
    if (!import.meta.env.DEV || !size) return;
    const w = window as unknown as { __eveLightGuide?: () => Promise<Blob | undefined> };
    w.__eveLightGuide = async () => scene.current?.snapshot({ ...guideSize(size.w, size.h), camera: FRONT, lit: true, background: "photo" });
    return () => { delete w.__eveLightGuide; };
  }, [size]);

  const params = useMemo(() => (surface ? relightParams(surface, lights, ambient, prompt) : { lights: "[]", ambient, prompt: prompt.trim() }), [surface, lights, ambient, prompt]);
  const canRun = editing && !!blob && !!surface && lights.length > 0;
  const run = async () => {
    if (!canRun || !blob || !size) return;
    // The scene glides back to the photo's own view: that is what gets relit.
    front();
    const guide = await scene.current?.snapshot({ ...guideSize(size.w, size.h), camera: FRONT, lit: true, background: "photo" }).catch(() => undefined);
    // Photo + lit 3D preview as a pair; the photo alone when no preview could be drawn.
    void runJob(() => runEdit(guide ? [blob, guide] : [blob], relightPrompt(params.lights, params.ambient, [presetWords, params.prompt].filter(Boolean).join(" "), guide ? "pair" : undefined), { priority: "high", onQueue }));
  };

  const W = size?.w ?? 1, H = size?.h ?? 1;
  const photo = size && stage.w ? sceneRect(stage, W, H) : { x: 0, y: 0, w: 0, h: 0 };
  const key = lights.find((l) => l.role === "key") ?? lights[0];
  const fill = lights.find((l) => l.role === "fill");
  // Lighting ratio: (key + fill) : fill.
  const ratio = key && fill ? `Key:fill ${((key.strength + fill.strength) / fill.strength).toFixed(1).replace(/\.0$/, "")}:1` : key ? "No fill" : "";
  const info = phase.kind === "done" && phase.size ? `${phase.size.w}×${phase.size.h}`
    : [`${W}×${H}`, `${lights.length} unit${lights.length === 1 ? "" : "s"}`, ratio, key?.kelvin ? `Key ${key.kelvin} K` : ""].filter(Boolean).join(" · ");
  const moved = view.azimuth !== 0 || view.elevation !== 0 || Math.abs((view.dolly ?? 1) - 1) > 0.01;

  const stageContent = (
    <>
      <StageState size={size} loadError={loadError} />
      {size && url && stage.w > 0 && (
        <>
          <StudioGlow phase={phase} rect={photo} />
          {surface && img && (
            <>
              {/* A plain plate under the scene: where it has no surface, nothing (not even the glow) shows through. */}
              <div aria-hidden className="pointer-events-none absolute bg-[#111]" style={{ left: photo.x, top: photo.y, width: photo.w, height: photo.h }} />
              <div className="absolute" style={{ left: photo.x, top: photo.y, width: photo.w, height: photo.h }} onPointerDownCapture={stir} onPointerMoveCapture={stir} onWheelCapture={stir}>
              <DepthScene ref={scene} image={img} surface={surface} width={photo.w} height={photo.h} lit reveal
                play={idle && phase.kind !== "running" ? { from: view, to: { ...view, azimuth: view.azimuth + 2.5, elevation: view.elevation + 1, dolly: (view.dolly ?? 1) * 0.985 }, seconds: 6 } : null}
                className={`eve-scene absolute transition-[opacity,filter] ${mono ? "grayscale" : ""}  ${rebuilding ? "opacity-40 duration-300" : "duration-700"} ${phase.kind === "done" ? "opacity-0" : ""}`} style={{ left: 0, top: 0, filter: filmLook ? (mono ? FILM_MONO : FILM) : undefined }}
                camera={view} onCamera={setView} limits={{ ...orbitLimits(surface, { azimuth: 35, elevation: 25 }), dolly: [0.35, 3] }}
                lights={lights} ambient={AMBIENT[ambient]} selected={sel?.id ?? null} onSelect={setSelected}
                onLightMove={(id, anchor, normal) => update(id, { anchor, normal, dir: undefined, hung: undefined })}
                onPlace={(anchor, normal) => { if (sel) update(sel.id, { anchor, normal, dir: undefined, hung: undefined }); }}
                onLightWheel={(id, delta) => setLights((ls) => ls.map((l) => (l.id === id ? { ...l, offset: Math.min(0.8, Math.max(0.03, l.offset * Math.exp(delta * 0.002))) } : l)))}
                onLightAim={(id, aim) => update(id, { aim })}
                onLightNudge={(id, patch) => update(id, patch)} fixtures={fixtures} gizmoMode={mode} gizmoOrient={orient} grid={grid}
                onHang={(at) => { if (sel && surface) update(sel.id, { anchor: at, dir: [0, -1, 0], offset: 0.05, hung: true, aim: [at[0], at[1] - surface.scale, at[2]] }); }}
                interactive={editing} onReady={() => setSceneReady(true)} />
              </div>
            </>
          )}
          <BuildingPhoto url={url} rect={photo} aspect={W / H} loading={(!!building && !rebuilding) || !surface || !img || !sceneReady} />
          <BuildingBadge building={rebuilding ? null : building} />
          {/* Film: fine animated-free grain over the preview (screen only; the prompt carries the look to the model). */}
          {filmLook && sceneReady && phase.kind !== "done" && (
            <>
              <FilmHalation />
              {/* Lifted, slightly warm blacks: nothing on a print goes fully black. */}
              <div aria-hidden className="pointer-events-none absolute mix-blend-lighten" style={{ left: photo.x, top: photo.y, width: photo.w, height: photo.h, background: mono ? "rgb(24,24,24)" : "rgb(30,23,17)" }} />
              <div aria-hidden className="pointer-events-none absolute opacity-[0.3] mix-blend-overlay" style={{ left: photo.x, top: photo.y, width: photo.w, height: photo.h, backgroundImage: GRAIN }} />
            </>
          )}
          <Viewfinder rect={photo} hidden={phase.kind === "done" || !sceneReady} />
          <StudioResult phase={phase} rect={resultRect(phase, photo)} revealed={revealed} before={url} />
        </>
      )}
    </>
  );

  const setKelvin = (kelvin: number, tint = sel?.tint ?? 0) => { if (sel) update(sel.id, { kelvin, tint, colour: kelvinHex(kelvin, tint) }); };
  // A role is a job on the set: Back goes behind the subject, a Practical becomes a small warm source in frame.
  const setRole = (role: LightRole) => {
    if (!sel) return;
    if (role === "back" && surface) {
      // A practical cannot rim: a back light gets an open face unless it already has a unit.
      const fixture: Fixture = sel.fixture && sel.fixture !== "practical" ? sel.fixture : "openface";
      const f = FIXTURES[fixture];
      update(sel.id, { role, fixture, kind: f.kind, beam: f.beam ?? sel.beam, ...behindSubject(surface, sel) });
    } else if (role === "practical") {
      update(sel.id, { role, fixture: "practical", kind: "point", beam: undefined, offset: FIXTURES.practical.offset ?? 0.08, dir: undefined, kelvin: 2700, tint: 0, colour: kelvinHex(2700), strength: Math.min(sel.strength, 0.6) });
    } else update(sel.id, { role });
  };
  const setFixture = (fixture: Fixture) => {
    if (!sel) return;
    const f = FIXTURES[fixture];
    update(sel.id, { fixture, kind: f.kind, beam: f.beam ?? sel.beam, offset: f.offset ?? sel.offset, aim: f.kind === "point" ? sel.aim : sel.aim ?? (surface ? surfacePoint(surface, 0.5, 0.55).anchor : sel.anchor) });
  };
  const select = "h-7 cursor-pointer rounded-full bg-white/10 px-2 text-[12px] font-medium text-white outline-none ring-1 ring-inset ring-white/15";

  const seg = (on: boolean) => `flex h-6 items-center justify-center rounded-full px-2 text-[11.5px] font-medium transition-colors ${on ? "bg-white text-black" : "text-white/60 hover:text-white"}`;
  const unitLabel = sel ? libraryUnit(sel.model)?.label ?? FIXTURES[sel.fixture ?? (sel.kind === "sun" ? "hmi" : sel.kind === "spot" ? "fresnel" : "led")].label : "";
  const pickUnit = (u: LibraryUnit) => {
    if (!sel) return;
    const base = sel.id === key?.id ? 0.8 : key?.strength ?? 0.8;
    update(sel.id, { ...libraryPatch(u, base), aim: u.kind === "point" ? sel.aim : sel.aim ?? (surface ? surfacePoint(surface, 0.5, 0.55).anchor : sel.anchor) });
  };

  const controls = (
    <div className="flex min-w-max flex-col items-start gap-2 md:w-full md:min-w-0 md:items-center">
      {/* Primary: the units, the gizmo mode, the scene. */}
      <div className="flex items-center gap-3 whitespace-nowrap">
        <div role="radiogroup" aria-label="Units" className="flex items-center gap-1">
          {lights.map((l, i) => (
            <button key={l.id} type="button" role="radio" aria-checked={l.id === sel?.id} onClick={() => setSelected(l.id)}
              className={`flex h-7 items-center gap-1.5 ${pill(l.id === sel?.id)} ring-1 ring-inset ring-white/15`}>
              <span className="h-2.5 w-2.5 rounded-full ring-1 ring-black/20" style={{ background: l.colour }} />{l.role ? ROLES[l.role] : `Unit ${i + 1}`}
            </button>
          ))}
          <button type="button" onClick={add} disabled={!surface || lights.length >= 4} title="Add unit" aria-label="Add unit" className={round}><Plus className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={remove} disabled={lights.length <= 1} title="Strike unit" aria-label="Strike unit" className={round}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
        <Divider />
        <div role="radiogroup" aria-label="Gizmo" className="flex gap-0.5 rounded-full bg-white/[0.08] p-0.5">
          <button type="button" role="radio" aria-checked={mode === "move"} aria-label="Move (W)" title="Move (W)" onClick={() => setMode("move")} className={`${seg(mode === "move")} gap-1 !px-2.5 !text-[12px]`}><Move className="h-3.5 w-3.5" />Move</button>
          <button type="button" role="radio" aria-checked={mode === "rotate"} aria-label="Rotate (E)" title="Rotate (E)" onClick={() => setMode("rotate")} className={`${seg(mode === "rotate")} gap-1 !px-2.5 !text-[12px]`}><Rotate3d className="h-3.5 w-3.5" />Rotate</button>
        </div>
        <div role="radiogroup" aria-label="Axes" title="Axes (T)" className="flex gap-0.5 rounded-full bg-white/[0.08] p-0.5">
          {(["global", "local"] as const).map((o) => (
            <button key={o} type="button" role="radio" aria-checked={orient === o} onClick={() => setOrient(o)} title={o === "global" ? "Global: blue goes into the set (T)" : "Local: blue goes along the beam (T)"} className={`${seg(orient === o)} !text-[11.5px]`}>{o === "global" ? "Global" : "Local"}</button>
          ))}
        </div>
        <Divider />
        <Popover label="Scene" width={280} button={(open) => (
          <span className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium ring-1 ring-inset transition-colors ${open ? "bg-white/10 text-white ring-white/30" : "text-white/75 ring-white/15 hover:text-white"}`}><SlidersHorizontal className="h-3.5 w-3.5" />Scene</span>
        )}>
          {(close) => (
            <div className="flex flex-col gap-3 p-2">
              <div>
                {/* The look first: it decides which presets are offered and what every prompt says. */}
                <div className="flex flex-col gap-1.5 pb-2">
                  <div role="radiogroup" aria-label="Colour" className="flex gap-0.5 rounded-full bg-white/[0.08] p-0.5">
                    {([[false, "Color"], [true, "Black & White"]] as const).map(([m, label]) => (
                      <button key={label} type="button" role="radio" aria-checked={mono === m} onClick={() => setMonochrome(m)} className={`${seg(mono === m)} flex-1`}>{label}</button>
                    ))}
                  </div>
                  <div role="radiogroup" aria-label="Capture" className="flex gap-0.5 rounded-full bg-white/[0.08] p-0.5">
                    {([[false, "Digital"], [true, "Film"]] as const).map(([f, label]) => (
                      <button key={label} type="button" role="radio" aria-checked={filmLook === f} onClick={() => setFilm(f)} className={`${seg(filmLook === f)} flex-1`}>{label}</button>
                    ))}
                  </div>
                </div>
                <div className="max-h-[38vh] overflow-y-auto pr-0.5">
                  {/* One flat grid, by mood: night, then day, then studio. */}
                  <div className="grid grid-cols-2 gap-0.5">
                    {PRESETS.filter((pr) => !!pr.mono === mono).map((pr, k) => ({ pr, k, rank: pr.place === "Studio" ? 2 : pr.ambient === "dark" ? 0 : 1 }))
                      .sort((a, b) => a.rank - b.rank || a.k - b.k).map(({ pr }) => (
                      <button key={pr.id} type="button" aria-label={`Lighting preset: ${pr.label}`} onClick={() => { close(); applyPreset(pr.id); }}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-white/85 hover:bg-white/[0.08]">
                        <span className="flex shrink-0 -space-x-1">{pr.lights.map((l, n) => <span key={n} className={`h-2.5 w-2.5 rounded-full ring-2 ring-[#1c1c1e] ${mono ? "grayscale" : ""}`} style={{ background: l.colour ?? kelvinHex(l.kelvin ?? 5600, l.tint ?? 0) }} />)}</span><span className="truncate">{pr.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className={tiny}>Ambient</span>
                <div role="radiogroup" aria-label="Ambient" className="flex gap-0.5 rounded-full bg-white/[0.08] p-0.5">
                  {(Object.keys(AMBIENT) as (keyof typeof AMBIENT)[]).map((a) => (
                    <button key={a} type="button" role="radio" aria-checked={ambient === a} onClick={() => setAmbient(a)} className={seg(ambient === a)}>{a[0].toUpperCase() + a.slice(1)}</button>
                  ))}
                </div>
              </div>
              {onRelief && (
                <div className="flex items-center justify-between">
                  <span className={tiny}>Relief</span>
                  <div role="radiogroup" aria-label="Relief" className="flex gap-0.5 rounded-full bg-white/[0.08] p-0.5">
                    {(Object.keys(RELIEF) as Relief[]).map((r) => (
                      <button key={r} type="button" role="radio" aria-checked={relief === r} onClick={() => onRelief(r)} className={seg(relief === r)}>{r[0].toUpperCase() + r.slice(1)}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <button type="button" aria-pressed={grid != null} onClick={() => setGrid((g) => (g == null ? 0.72 : null))} title="Overhead grid — click it to hang the selected unit" className={seg(grid != null)}>Grid</button>
                {grid != null && <div className="w-28" title="Grid height"><Slider min={0.5} max={1.3} step={0.01} value={[grid]} onValueChange={(v) => setGrid(Array.isArray(v) ? v[0] : v)} /></div>}
              </div>
            </div>
          )}
        </Popover>
        <button type="button" aria-pressed={fixtures} onClick={() => setFixtures((v) => !v)} title="Show the lighting units on the set (never sent to the model)"
          className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium ring-1 ring-inset transition-colors ${fixtures ? "bg-white/10 text-white ring-white/30" : "text-white/55 ring-white/15 hover:text-white"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${fixtures ? "bg-[#ffd60a]" : "bg-white/30"}`} />Show lights
        </button>
        <button type="button" onClick={front} disabled={!moved} title="Back to the photo's view" aria-label="Reset view" className={round}><RotateCcw className="h-3.5 w-3.5" /></button>
      </div>
      {/* The inspector: the selected unit — fixture · colour · output. */}
      {sel && (
        <div className="flex items-center gap-3 whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            <FixturePicker value={unitLabel} onPick={pickUnit} />
            <select aria-label="Role" value={sel.role ?? "key"} onChange={(e) => setRole(e.target.value as LightRole)} className={select} style={{ colorScheme: "dark" }}>
              {(Object.keys(ROLES) as LightRole[]).map((r) => <option key={r} value={r}>{ROLES[r]}</option>)}
            </select>
          </div>
          <Divider />
          <div className="flex items-center gap-1.5">
            {[3200, 5600].map((k) => (
              <button key={k} type="button" onClick={() => setKelvin(k, 0)} title={k === 3200 ? "Tungsten" : "Daylight"} className={`${seg(sel.kelvin === k && !sel.tint)} tabular-nums`}>{k}</button>
            ))}
            {/* A gel colour has no colour temperature: Kelvin waits, dimmed, until it is moved on purpose. */}
            <div className={`w-20 transition-opacity duration-200 ${sel.kelvin ? "" : "opacity-40"}`} title={sel.kelvin ? "Colour temperature" : "Gel colour set — move to go back to Kelvin"}>
              <Slider min={2000} max={10000} step={50} value={[sel.kelvin ?? 5600]} onValueChange={(v) => setKelvin(Array.isArray(v) ? v[0] : v, 0)} />
            </div>
            <span className="w-11 font-mono text-[10.5px] tabular-nums text-white/55">{sel.kelvin ? `${sel.kelvin}K` : "Gel"}</span>
            {sel.kelvin != null && (
              <div className="w-12" title="Green ← → magenta"><Slider min={-100} max={100} step={5} value={[sel.tint ?? 0]} onValueChange={(v) => setKelvin(sel.kelvin!, Array.isArray(v) ? v[0] : v)} /></div>
            )}
            <LightColourPicker key={sel.id} value={sel.colour} onChange={(colour) => update(sel.id, { colour, kelvin: undefined })} />
          </div>
          <Divider />
          <div className="flex items-center gap-1.5">
            <span className={tiny}>Level</span>
            <div className="w-20"><Slider min={0.1} max={1.5} step={0.05} value={[sel.strength]} onValueChange={(v) => update(sel.id, { strength: Array.isArray(v) ? v[0] : v })} /></div>
            <span className="w-10 font-mono text-[10.5px] tabular-nums text-white/55">{!key || sel.id === key.id ? "key" : fmtStops(stops(sel.strength, key.strength))}</span>
            {sel.kind === "spot" && (
              <>
                <span className={tiny}>Beam</span>
                <div className="w-14"><Slider min={8} max={80} step={1} value={[sel.beam ?? 35]} onValueChange={(v) => update(sel.id, { beam: Array.isArray(v) ? v[0] : v })} /></div>
              </>
            )}
            <span className={tiny}>Throw</span>
            <div className="w-16"><Slider min={0.03} max={0.8} step={0.01} value={[sel.offset]} onValueChange={(v) => update(sel.id, { offset: Array.isArray(v) ? v[0] : v })} /></div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <StudioShell label="Relight" queue={ahead} onBack={back} phase={phase} setPhase={setPhase} editing={editing}
      stageRef={stageRef} stage={stageContent} controls={controls}
      prompt={prompt} setPrompt={setPrompt} promptPlaceholder="Notes (optional)"
      info={info} canRun={canRun} onRun={() => void run()}
      notice={failed && surface && !building ? `No depth: ${failed}` : stale && phase.kind !== "done" ? "Relight is stale — run again" : undefined}
      next={onNext ? { label: "Cameras →", onClick: onNext, enabled: !!surface } : undefined} />
  );
}
