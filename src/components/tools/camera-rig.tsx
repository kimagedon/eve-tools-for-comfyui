/**
 * Cameras: 3–5 cameras on ONE 3D set of the lit plate. Left, the set from
 * above — the cameras round it, drag one to stand elsewhere; right, the
 * live view through the selected camera, cut to 2.39:1. Coverage templates
 * place a camera in one click within what the lens saw; past that the note
 * says honestly that the model will invent the rest. Every camera also has
 * a move, which sets the end pose its shot travels to.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Plus, Trash2, Volume2, VolumeX } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { BASE_FOCAL, orbitLimits, surfacePoint, type DepthSurface } from "@/lib/depth-mesh";
import { MAX_CAMERAS, MOVES, TEMPLATES, bodyOf, lookTilt, pickSubject, endPose, moveAmount, newCamera, nextSlate, slateIndex, rackFocus, subjectPoint, templateCamera, type RigCamera, type Template } from "@/lib/rig";
import { LENSES, SENSORS, SENSOR_GROUPS, aspectLabel, outputAspect, cameraHeight, equivalentMm, frameMm, hfov, lensMm, lensStops, sceneFocal, slate, subjectDistance, type LensLook, type Sensor } from "@/lib/cine";
import { FOCAL, FSTOP, RELIEF, reframeSetup, type Relief } from "./scene-rig";
import { DOLLY, DepthScene, lightPoint, type DepthSceneHandle, type SceneCamera, type SceneLight } from "./depth-scene";
import { Viewfinder } from "@/components/ui/cine";
import { renderGuide } from "./guide-renderer";
import { FILL_GREY } from "@/lib/extend-fill";

import { BuildingBadge, BuildingPhoto, CameraDial, useImage, useSurface } from "./light-studio";
import { StageState, StudioShell, fitRect, useStage, useStudioRun, useStudioSource, type Rect, type StudioProps } from "./studio";

/** True when the outer band of a guide is noticeably the flat empty grey (nothing of the photo there). */
async function greyEdges(guide: Blob): Promise<boolean> {
  const bmp = await createImageBitmap(guide);
  const w = 120, h = 50, c = new OffscreenCanvas(w, h), ctx = c.getContext("2d");
  if (!ctx) { bmp.close(); return false; }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = ctx.getImageData(0, 0, w, h).data, g = parseInt(FILL_GREY.slice(1, 3), 16);
  let grey = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x > 3 && x < w - 4 && y > 2 && y < h - 3) continue;
    const i = (y * w + x) * 4;
    n++;
    if (Math.abs(d[i] - g) < 4 && Math.abs(d[i + 1] - g) < 4 && Math.abs(d[i + 2] - g) < 4) grey++;
  }
  return grey / n > 0.02;
}

const pill = (on: boolean) => `rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${on ? "bg-white text-black" : "text-white/70 hover:text-white"}`;
const round = "flex h-7 w-7 items-center justify-center rounded-full text-white/70 ring-1 ring-inset ring-white/20 hover:bg-white/10 hover:text-white disabled:opacity-35";
const toggle = (on: boolean) => `rounded-full px-3 py-1 text-[12px] font-medium ring-1 ring-inset transition-colors ${on ? "bg-white text-black ring-white" : "text-white/75 ring-white/20 hover:text-white"}`;
const fromT = ([lo, hi]: [number, number], t: number) => lo * (hi / lo) ** t;
const toT = ([lo, hi]: [number, number], v: number) => Math.log(v / lo) / Math.log(hi / lo);

const MAP = 240;
const MAP_R = 84;

/**
 * The set from above: the photo's wall at the top, the arc the 3D can show
 * lit, every camera a small frustum looking at the middle. Drag to move the
 * selected camera round (azimuth) and in or out (distance).
 */
function RigMap({ cameras, selected, reach, units, onSelect, onPlace }: {
  cameras: RigCamera[];
  selected: string | null;
  reach: { azimuth: number };
  /** The lighting plan's units, placed like the cameras (bearing round the subject, distance in camera units). */
  units: { id: string; azimuth: number; distance: number; colour: string; role: string }[];
  onSelect: (id: string) => void;
  onPlace: (azimuth: number, dolly: number) => void;
}) {
  const C = { x: MAP / 2, y: MAP / 2 - 22 };
  const rad = (d: number) => (d * Math.PI) / 180;
  const at = (a: number, d: number) => ({ x: C.x + MAP_R * d * Math.sin(rad(a)), y: C.y + MAP_R * d * Math.cos(rad(a)) });
  const place = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * MAP - C.x, y = (e.clientY - r.top) / r.height * MAP - C.y;
    let a = (Math.atan2(x, y) * 180) / Math.PI;
    if (a > 180) a -= 360;
    onPlace(Math.round(a), Math.min(1.25, Math.max(0.3, Math.hypot(x, y) / MAP_R)));
  };
  const arc = (from: number, to: number, r: number) => {
    const p = (d: number) => `${C.x + r * Math.sin(rad(d))} ${C.y + r * Math.cos(rad(d))}`;
    return `M ${p(from)} A ${r} ${r} 0 0 0 ${p(to)}`;
  };
  const mono = { fontFamily: "var(--font-mono)", letterSpacing: "0.06em" } as const;
  return (
    <div className="rounded-2xl bg-black/60 p-2 ring-1 ring-inset ring-white/[0.1] backdrop-blur-xl">
      <svg width={MAP} height={MAP} viewBox={`0 0 ${MAP} ${MAP}`} className="touch-none" role="group" aria-label="Camera and lighting plot"
        onPointerDown={(e) => { if ((e.target as Element).closest("[data-cam]")) return; e.currentTarget.setPointerCapture(e.pointerId); place(e); }}
        onPointerMove={(e) => { if (e.buttons) place(e); }}>
        {/* Distance rings, a hairline grid */}
        {[0.5, 1].map((d) => <circle key={d} cx={C.x} cy={C.y} r={MAP_R * d} fill="none" stroke="rgba(255,255,255,0.07)" strokeDasharray="2 4" />)}
        <line x1={C.x} y1={8} x2={C.x} y2={MAP - 8} stroke="rgba(255,255,255,0.05)" />
        <line x1={8} y1={C.y} x2={MAP - 8} y2={C.y} stroke="rgba(255,255,255,0.05)" />
        {/* What the lens saw: the arc the 3D holds up */}
        <path d={arc(-reach.azimuth, reach.azimuth, MAP_R)} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={4} strokeLinecap="round" />
        {/* The set: a box, as on a plot */}
        <rect x={C.x - 46} y={C.y - 30} width={92} height={36} fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.24)" />
        <path d={`M ${C.x - 4} ${C.y} H ${C.x + 4} M ${C.x} ${C.y - 4} V ${C.y + 4}`} stroke="rgba(255,255,255,0.5)" />
        {/* Lighting units: a filled lamp in its colour, a short throw towards the subject */}
        {units.map((u) => {
          const p = at(u.azimuth, Math.min(1.25, u.distance));
          const k = 9 / (Math.hypot(C.x - p.x, C.y - p.y) || 1);
          return (
            <g key={u.id} pointerEvents="none">
              <line x1={p.x} y1={p.y} x2={p.x + (C.x - p.x) * k} y2={p.y + (C.y - p.y) * k} stroke={u.colour} strokeOpacity={0.8} />
              <circle cx={p.x} cy={p.y} r={4.5} fill={u.colour} stroke="#000" strokeOpacity={0.6} />
            </g>
          );
        })}
        {(() => {
          // Cameras can stand close together: each slate is pushed out along its
          // own bearing until it clears the others, with a leader to the camera.
          const placed: { x: number; y: number }[] = [];
          return cameras.map((c, i) => {
            const p = at(c.cam.azimuth, Math.min(1.25, c.cam.dolly ?? 1));
            const dx = p.x - C.x, dy = p.y - C.y, len = Math.hypot(dx, dy) || 1;
            let k = 20, q = { x: p.x + (dx / len) * k, y: p.y + (dy / len) * k };
            while (placed.some((o) => Math.abs(o.x - q.x) < 26 && Math.abs(o.y - q.y) < 16) && k < 90) { k += 9; q = { x: p.x + (dx / len) * k, y: p.y + (dy / len) * k }; }
            placed.push(q);
            const look = Math.atan2(C.x - p.x, C.y - p.y);
            const half = Math.atan(18 / (c.cam.focal ?? BASE_FOCAL));
            const L = 30;
            const ray = (sg: number) => `${p.x + L * Math.sin(look + sg * half)} ${p.y + L * Math.cos(look + sg * half)}`;
            const on = c.id === selected;
            const deg = (-look * 180) / Math.PI + 90;
            return (
              <g key={c.id} data-cam className="cursor-pointer" onPointerDown={(e) => { e.stopPropagation(); onSelect(c.id); }}>
                {/* The lens's field: a faint frustum; the camera itself a wedge, as in the plot teaser */}
                <path d={`M ${p.x} ${p.y} L ${ray(-1)} L ${ray(1)} Z`} fill={on ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.03)"} stroke="rgba(255,255,255,0.3)" strokeOpacity={on ? 0.9 : 0.5} />
                <line x1={p.x} y1={p.y} x2={C.x} y2={C.y} stroke="rgba(255,255,255,0.14)" strokeDasharray="3 5" />
                <path transform={`translate(${p.x} ${p.y}) rotate(${deg})`} d="M9 0 L-5 -4.5 L-5 4.5 z" fill={on ? "#f5f5f7" : "rgba(245,245,247,0.45)"} />
                <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="rgba(255,255,255,0.25)" />
                <rect x={q.x - 12} y={q.y - 7.5} width={24} height={15} rx={3} fill={on ? "#f5f5f7" : "#111"} stroke={on ? "none" : "rgba(255,255,255,0.3)"} />
                <text x={q.x} y={q.y + 3} textAnchor="middle" fontSize="8.5" fontWeight={600} fill={on ? "#000" : "rgba(255,255,255,0.85)"} style={mono}>{slate(c.slate ?? i)}</text>
              </g>
            );
          });
        })()}
      </svg>
    </div>
  );
}

/**
 * Frame lines over the live view (which is cut 2.39:1): the 1.85 and 16:9
 * extractions share its height, action safe sits 93% in, thirds on top.
 */
function FrameLines({ rect }: { rect: Rect }) {
  // 1.85 and 16:9 sit only a few pixels apart: one label at the top, one at the bottom.
  // Only extractions narrower than the delivery frame are drawn.
  const line = (ratio: number, label: string, top: boolean) => {
    if (ratio >= rect.w / rect.h - 0.01) return null;
    const w = Math.min(rect.w, rect.h * ratio);
    return (
      <div key={label} className="absolute top-0 h-full border-x border-dashed border-white/45" style={{ left: (rect.w - w) / 2, width: w }}>
        <span className="vf-l" style={{ right: 4, ...(top ? { top: 26 } : { bottom: 26 }), opacity: 0.6 }}>{label}</span>
      </div>
    );
  };
  return (
    <div aria-hidden className="pointer-events-none absolute" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      {line(1.85, "1.85", true)}
      {line(16 / 9, "16:9", false)}
      <div className="absolute border border-white/30" style={{ inset: "3.5%" }}></div>
      {[1, 2].map((i) => <div key={`v${i}`} className="absolute bottom-0 top-0 w-px bg-white/20" style={{ left: `${(i * 100) / 3}%` }} />)}
      {[1, 2].map((i) => <div key={`h${i}`} className="absolute left-0 right-0 h-px bg-white/20" style={{ top: `${(i * 100) / 3}%` }} />)}
    </div>
  );
}

export function CameraRig({ source, onNext, relief, cameras, onCameras, onSurface, prompt, setPrompt, sensor, onSensor, lights = [], stale }: StudioProps & {
  /** The light plan changed after Relight: the plate is out of date. */
  stale?: boolean;
  relief: Relief;
  /** The lighting plan, drawn on the plot. */
  lights?: SceneLight[];
  sensor: Sensor;
  onSensor: (s: Sensor) => void;
  cameras: RigCamera[];
  onCameras: (c: RigCamera[] | ((prev: RigCamera[]) => RigCamera[])) => void;
  onSurface: (s: DepthSurface | null) => void;
  prompt: string;
  setPrompt: (v: string) => void;
}) {
  const { blob, url, size, loadError } = useStudioSource(source);
  const { phase, setPhase, editing } = useStudioRun("Cameras");
  const { ref: stageRef, stage } = useStage();
  const img = useImage(url);
  const { surface, building, failed } = useSurface(blob, size, RELIEF[relief]);
  const [ready, setReady] = useState(false);
  const scene = useRef<DepthSceneHandle>(null);
  const [selected, setSelected] = useState<string | null>(cameras[0]?.id ?? null);
  // Play (default) loops the selected camera's move; Start / End hold a key to edit.
  const [preview, setPreview] = useState<"play" | "start" | "end">("play");
  const [lines, setLines] = useState(true);
  const [mmText, setMmText] = useState<string | null>(null);

  useEffect(() => { onSurface(surface); }, [surface, onSurface]);
  // First visit: three cameras of coverage, ready to roll.
  useEffect(() => {
    if (!surface) return;
    if (cameras.length) return;
    const first = (["wide"] as Template[]).map((t, i) => newCamera(surface, t, i, sensor, i, subject ?? undefined, maxZoom));
    onCameras(first);
    setSelected(first[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, cameras.length]);

  // Saved cameras are kept as designed — only corrupt numbers are brought back into the editor's own limits.
  const clamped = useRef(false);
  useEffect(() => {
    if (!surface || clamped.current || !cameras.length) return;
    clamped.current = true;
    const fix = (c: RigCamera): RigCamera => {
      const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
      const cam = {
        ...c.cam,
        azimuth: n(c.cam.azimuth, -180, 180, 0),
        elevation: n(c.cam.elevation, -75, 75, 0),
        focal: n(c.cam.focal, FOCAL[0], FOCAL[1], surface.baseFocal),
        dolly: n(c.cam.dolly, DOLLY[0], DOLLY[1], 1),
      };
      return JSON.stringify(cam) === JSON.stringify(c.cam) ? c : { ...c, cam };
    };
    if (cameras.some((c) => fix(c) !== c)) onCameras((cs) => cs.map(fix));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, cameras.length]);

  // The live preview keeps the silhouette bridges (`bridges`, no rips, like Light); guides get the honest cut surface.

  /**
   * A default should never open on grey void: render the camera's guide small,
   * and while the frame's edge band shows the empty-grey background, tighten
   * the lens a step (the reverse is past the photo by design, so it is left).
   */
  const fit = async (c: RigCamera) => {
    if (!surface || !blob) return;
    const lim = orbitLimits(surface);
    // A pose past the reach is past the photo by design: left as it is.
    if (Math.abs(c.cam.azimuth) > lim.azimuth + 0.5 || Math.abs(c.cam.elevation) > lim.elevation + 0.5) return;
    let focal = c.cam.focal ?? surface.baseFocal;
    // The wide stays the whole set: at most three small steps tighter.
    for (let k = 0; k < (c.template === "wide" ? 3 : 9); k++) {
      const shot = await renderGuide({ image: blob, surface, ...(outputAspect() >= 1 ? { width: Math.round(100 * outputAspect()), height: 100 } : { width: 100, height: Math.round(100 / outputAspect()) }), camera: { ...c.cam, focal }, lit: false, background: FILL_GREY }).catch(() => null);
      if (!shot || !(await greyEdges(shot))) break;
      focal = Math.min(500, focal * 1.08);
    }
    if (focal === c.cam.focal) return;
    // Only if the camera is still the template it was (the person may have moved on).
    onCameras((cs) => cs.map((x) => (x.id === c.id && x.template === c.template && x.cam.focal === c.cam.focal ? { ...x, cam: { ...x.cam, focal: Math.round(focal) } } : x)));
  };
  const fittedKeys = useRef(new Set<string>());
  useEffect(() => {
    for (const c of cameras) {
      const key = `${c.id}:${c.template}`;
      if (fittedKeys.current.has(key)) continue;
      fittedKeys.current.add(key);
      void fit(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, surface, blob]);

  // Where a medium or close-up looks: the prominent thing nearest the middle (contrast × nearness).
  const subject = useMemo(() => (surface && img ? pickSubject(surface, img) : null), [surface, img]);
  // Templates never frame tighter than ~3× the plate's own pixels at that spot (an output still is ~1536 px wide).
  const maxZoom = size ? Math.max(1, (3 * size.w) / 1536) : Infinity;
  const sel = cameras.find((c) => c.id === selected) ?? cameras[0];
  // The body is per camera; the scene's (last chosen) body is the default for cameras from before.
  const body: Sensor = sel ? bodyOf(sel, sensor) : sensor;
  const update = (patch: Partial<RigCamera>) => { if (sel) onCameras((cs) => cs.map((c) => (c.id === sel.id ? { ...c, ...patch } : c))); };
  // Editing while the move plays pauses into the start key (the one being edited).
  const setCam = (cam: SceneCamera) => { setPreview((p) => (p === "play" ? "start" : p)); update({ cam }); };
  const reach = surface ? orbitLimits(surface) : { azimuth: 20, elevation: 10 };
  const base = surface?.baseFocal ?? BASE_FOCAL;

  const add = () => {
    if (!surface || cameras.length >= MAX_CAMERAS) return;
    const used = new Set(cameras.map((c) => c.template));
    const t = TEMPLATES.find((x) => !used.has(x.id))?.id ?? "medium";
    // A new camera starts on the previous camera's body.
    const prev = sel ?? cameras[cameras.length - 1];
    const c = newCamera(surface, t, cameras.length, prev ? bodyOf(prev, sensor) : sensor, nextSlate(cameras), subject ?? undefined, maxZoom);
    onCameras((cs) => [...cs, c]);
    setSelected(c.id);
  };
  const remove = () => {
    if (!sel || cameras.length <= 1) return;
    const rest = cameras.filter((c) => c.id !== sel.id);
    onCameras(rest);
    setSelected(rest[0].id);
  };
  const applyTemplate = (t: Template) => {
    if (!surface || !sel) return;
    // The wide is the whole set: never on macro glass.
    update({ template: t, cam: templateCamera(surface, t, body, subject ?? sel.cam.target ?? subjectPoint(surface), maxZoom), move: TEMPLATES.find((x) => x.id === t)!.move, ...(t === "wide" && sel.lens === "macro" ? { lens: "clean" as const } : {}) });
    setPreview("play");
  };

  const setup = useMemo(() => (surface && sel ? reframeSetup(surface, sel.cam, { fstop: sel.focus?.fstop ?? null, aspect: aspectLabel(), recoverDetail: false, prompt }) : null), [surface, sel, prompt]);
  const end = surface && sel ? endPose(surface, sel.cam, sel.move, sel.amount) : null;
  const shown = preview === "end" && end ? end : sel?.cam;
  const playing = preview === "play" && !!sel && !!end;

  // The view sits right of the map, the dials on the far right.
  // The plot sits left and the dials right on a desktop; on a phone the view takes the width and the plot shrinks above it.
  const compact = stage.w < 760;
  const left = compact ? 0 : Math.min(MAP + 40, stage.w * 0.3), right = compact ? 0 : Math.min(150, stage.w * 0.15);
  const units = surface ? lights.map((l, i) => {
    const p = lightPoint(surface, l), X = p[0], Z = p[2] + surface.pivot;
    return { id: l.id, azimuth: (Math.atan2(X, Z) * 180) / Math.PI, distance: Math.hypot(X, Z) / surface.pivot, colour: l.colour,
      role: l.role ? { key: "K", fill: "F", back: "B", practical: "P" }[l.role] : String(i + 1) };
  }) : [];
  const area = { w: Math.max(1, stage.w - left - right), h: stage.h };
  const fitted = fitRect(area, outputAspect(), 1, 0.94, 0.88);
  const view: Rect = compact ? { ...fitted, y: 12 } : { ...fitted, x: fitted.x + left };

  const idx = sel ? cameras.indexOf(sel) : 0;
  // The lens that frames the 2.39 cut on this sensor (the scene's focal is anchored to the plate's aspect).
  const toMm = (f: number) => (surface ? frameMm(surface, f, body) : lensMm(f, body));
  const toFocal = (mmv: number) => (surface ? sceneFocal(surface, mmv, body) : equivalentMm(mmv, body));
  const mmExact = toMm(sel?.cam.focal ?? base);
  const mm = Math.round(mmExact);
  // Phones and compacts are named by their full-frame equivalent.
  const mmEq = Math.round(mmExact * SENSORS[body].crop);
  // The field takes the lens on this sensor; the scene's 4–500 mm (full-frame equivalent) is its range.
  const mmRange: [number, number] = [Math.ceil(toMm(4)), Math.floor(toMm(500))];
  const [flash, setFlash] = useState(false);
  const setMm = (v: number) => {
    const clamped = Math.min(mmRange[1], Math.max(mmRange[0], v));
    if (clamped !== v) { setFlash(true); setTimeout(() => setFlash(false), 700); }
    if (sel) setCam({ ...sel.cam, focal: Math.min(500, Math.max(4, toFocal(clamped))) });
  };
  // Every lens change (prime, mm field, template, body, another camera) says itself once, big and quiet, in the frame.
  const [readout, setReadout] = useState<{ text: string; sub: string; on: boolean; light?: boolean } | null>(null);
  const lensKey = `${mm}|${body}|${sel?.lens ?? "clean"}`;
  const lastLens = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const was = lastLens.current;
    lastLens.current = lensKey;
    if (was == null || was === lensKey) return;
    const eqv = lensStops(body)[0]?.equivalent;
    setReadout({ text: eqv ? `${mmEq} mm` : `${mm} mm`, sub: `${SENSORS[body].label}${eqv ? ` · equivalent, ${mmExact.toFixed(1)} mm actual` : ""} · ${LENSES[sel?.lens ?? "clean"].short} · ${Math.round(hfov(mm, body))}°`, on: true });
    // Ink follows the picture under the text: dark on a light frame, light on a dark one (sampled as the zoom lands too).
    const sample = () => {
      void scene.current?.luma([0.3, 0.38, 0.4, 0.26]).then((l) => { if (l != null) setReadout((r) => r && { ...r, light: l > 0.55 }); });
    };
    const f = requestAnimationFrame(sample), s2 = setTimeout(sample, 420);
    const t = setTimeout(() => setReadout((r) => r && { ...r, on: false }), 1200);
    return () => { clearTimeout(t); clearTimeout(s2); cancelAnimationFrame(f); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lensKey, ready]);
  const info = sel && surface ? [stale ? "Relight stale" : "", slate(sel ? slateIndex(sel, cameras) : idx), TEMPLATES.find((t) => t.id === sel.template)?.label, `${MOVES.find((m) => m.id === sel.move)?.label} · ${moveAmount(surface, sel.cam, sel.move, sel.amount)}`, `${mm} mm ${SENSORS[body].short}`, `HFOV ${Math.round(hfov(mm, body))}°`,
    sel.focus ? `T${sel.focus.fstop.toFixed(1)}` : "", `≈${cameraHeight(surface, sel.cam).toFixed(1)} m high`, `tilt ${Math.round(lookTilt(surface, sel.cam)) > 0 ? "+" : ""}${Math.round(lookTilt(surface, sel.cam))}°`,
    `≈${subjectDistance(surface, sel.cam).toFixed(1)} m to subject`].filter(Boolean).join(" · ") : "";
  // Past ~12 mm or ~200 mm (full-frame equivalent) one still cannot hold the frame: say so.
  const eq = sel?.cam.focal ?? base;
  const notice = failed && !building ? failed : setup?.beyond ? "Beyond the lens' reach — the model invents what the photo never saw"
    : eq < 12 || eq > 200 ? "Past what the still resolves — the model invents most of the frame"
      : sel?.template === "reverse" && Math.abs(sel.cam.azimuth) <= reach.azimuth + 0.5 ? "Reverse at the furthest honest angle — drag the camera round the plot for a full reverse (the model invents it)"
      : stale ? "Relight is stale — the plan changed after Relight" : undefined;
  // A rack is previewed as it will be shot: focus near at the start, far at the end.
  const rack = surface && sel?.move === "rack-focus" ? rackFocus(surface, sel.focus?.fstop ?? 2, sel.amount) : null;
  const shownFocus = rack ? rack[preview === "end" ? "end" : "start"] : sel?.focus ?? null;
  // Only the chosen move moves the camera; a Static camera is frozen.
  const play = playing && sel && end && sel.move !== "static" ? { from: sel.cam, to: end, fromFocus: rack?.start ?? null, toFocus: rack?.end ?? null, seconds: 4, loop: "cut" as const } : null;

  const W = size?.w ?? 1, H = size?.h ?? 1;
  const photo = url ? { url, aspect: W / H } : null;

  const stageContent = (
    <>
      <StageState size={size} loadError={loadError} />
      {size && url && stage.w > 0 && (
        <>
          {surface && img && sel && shown && (
            <>
              <div aria-hidden className="pointer-events-none absolute bg-black" style={{ left: view.x, top: view.y, width: view.w, height: view.h }} />
              <DepthScene ref={scene} image={img} surface={surface} width={view.w} height={view.h} lit={false} bridges flattenBeyond={[3.5, 6]} overscan={1}
                className="eve-scene absolute transition-opacity duration-300" style={{ left: view.x, top: view.y }}
                camera={shown} onCamera={preview !== "end" ? setCam : undefined} play={play}
                limits={{ azimuth: 180, elevation: 75, focal: FOCAL, dolly: DOLLY }} freeOrbit
                focus={shownFocus} onFocus={preview !== "end" && sel.focus ? (point) => update({ focus: { ...sel.focus!, point } }) : undefined} onPlace={preview !== "end" ? (point) => update({ cam: { ...sel.cam, target: point }, focus: sel.focus ? { ...sel.focus, point } : null }) : undefined}
                interactive={editing && preview !== "end"} onReady={() => setReady(true)} />
              {/* Whatever the mesh does not reach melts into black at the frame's edge. */}
              <div aria-hidden className="pointer-events-none absolute" style={{ left: view.x, top: view.y, width: view.w, height: view.h, boxShadow: "inset 0 0 36px 14px #000" }} />
              <div aria-hidden className="pointer-events-none absolute border border-white/20" style={{ left: view.x, top: view.y, width: view.w, height: view.h }} />
              <Viewfinder rect={view} />
              {lines && <FrameLines rect={view} />}
              {readout && (
                <div aria-hidden className="pointer-events-none absolute flex flex-col items-center justify-center ease-out"
                  style={{ left: view.x, top: view.y, width: view.w, height: view.h, opacity: readout.on ? 1 : 0, transition: `opacity ${readout.on ? 150 : 600}ms ease-out` }}>
                  {/* A soft scrim always sits behind the readout, so it reads on any plate (a white cyc, sky, snow). */}
                  <div className="flex flex-col items-center rounded-[32px] px-7 py-4" style={{ background: "rgba(0,0,0,0.4)", boxShadow: "0 0 48px 28px rgba(0,0,0,0.4)" }}>
                    <div className="tabular-nums" style={{ fontFamily: '-apple-system, "SF Pro Display", system-ui, sans-serif', fontSize: 48, fontWeight: 400, letterSpacing: "-0.02em", lineHeight: 1, color: "rgba(255,255,255,0.94)", textShadow: "0 1px 18px rgba(0,0,0,0.55)" }}>{readout.text}</div>
                    <div className="mt-2 text-[12px] tracking-[0.01em]" style={{ color: "rgba(255,255,255,0.78)", textShadow: "0 1px 10px rgba(0,0,0,0.6)" }}>{readout.sub}</div>
                  </div>
                </div>
              )}
            </>
          )}
          <BuildingPhoto url={url} rect={view} aspect={W / H} loading={!!building || !surface || !img || !ready} />
          <BuildingBadge building={building} />
          {surface && photo && (
            <div className="eve-hub-in absolute" style={compact
              ? { left: "50%", top: view.y + view.h + 14, transformOrigin: "top center", transform: `translateX(-50%) scale(${Math.max(0.5, Math.min(1, (stage.h - view.y - view.h - 24) / (MAP + 60)))})` }
              : { left: 12, top: 12, transformOrigin: "top left", transform: `scale(${Math.min(1, Math.max(0.6, (stage.h - 24) / (MAP + 60)))})` }}>
              <RigMap cameras={cameras} selected={sel?.id ?? null} reach={reach} units={units}
                onSelect={(id) => setSelected(id)}
                onPlace={(azimuth, dolly) => { if (sel) setCam({ ...sel.cam, azimuth, dolly }); }} />
            </div>
          )}
          {surface && photo && sel && editing && (
            <div className="absolute hidden flex-col gap-2 md:flex" style={{ right: 12, top: 12, transformOrigin: "top right", transform: `scale(${Math.min(1, Math.max(0.55, (stage.h - 24) / 470))})` }}>
              <CameraDial photo={photo} kind="elevation" value={sel.cam.elevation} onChange={(elevation) => setCam({ ...sel.cam, elevation })} />
              <CameraDial photo={photo} kind="distance" value={sel.cam.dolly ?? 1} onChange={(dolly) => setCam({ ...sel.cam, dolly })} />
            </div>
          )}
        </>
      )}
    </>
  );

  const controls = sel && (
    <>
      <div role="radiogroup" aria-label="Cameras" className="flex items-center gap-1">
        {cameras.map((c, i) => (
          <button key={c.id} type="button" role="radio" aria-checked={c.id === sel.id} onClick={() => setSelected(c.id)}
            className={`${pill(c.id === sel.id)} tabular-nums ring-1 ring-inset ring-white/15`}>{slate(slateIndex(c, cameras))}</button>
        ))}
        <button type="button" onClick={add} disabled={!surface || cameras.length >= MAX_CAMERAS} title="Add camera" aria-label="Add camera" className={round}><Plus className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={remove} disabled={cameras.length <= 1} title="Remove camera" aria-label="Remove camera" className={round}><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
      <div role="radiogroup" aria-label="Shot size" className="flex gap-0.5 rounded-full bg-white/[0.08] p-0.5">
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={sel.template === t.id} title={t.label} onClick={() => applyTemplate(t.id)} className={pill(sel.template === t.id)}>{t.name}</button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <select aria-label={`Camera body of ${slate(slateIndex(sel, cameras))}`} title={`Camera / format of ${slate(slateIndex(sel, cameras))} (this camera only)`} value={body} onChange={(e) => {
          const next = e.target.value as Sensor;
          // Only this camera changes body, and it keeps its lens: same mm, a different field of view.
          // Cameras from before per-camera bodies are pinned to the body they had, so they never reframe.
          onCameras((cs) => cs.map((c) => {
            if (c.id !== sel.id) return c.sensor ? c : { ...c, sensor };
            const was = bodyOf(c, sensor);
            // A phone or a compact has no interchangeable glass: switching to or from one keeps the framing instead.
            const fixedGlass = lensStops(was)[0]?.equivalent || lensStops(next)[0]?.equivalent;
            const focal = surface && !fixedGlass ? Math.min(500, Math.max(4, sceneFocal(surface, frameMm(surface, c.cam.focal ?? surface.baseFocal, was), next))) : c.cam.focal;
            return { ...c, sensor: next, cam: { ...c.cam, focal } };
          }));
          onSensor(next);
        }}
          className="h-7 w-[104px] cursor-pointer truncate rounded-full bg-white/10 px-2 text-[12px] font-medium text-white outline-none ring-1 ring-inset ring-white/15" style={{ colorScheme: "dark" }}>
          {SENSOR_GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {(Object.keys(SENSORS) as Sensor[]).filter((k) => SENSORS[k].group === g).map((k) => <option key={k} value={k}>{SENSORS[k].label}</option>)}
            </optgroup>
          ))}
        </select>
        <div role="radiogroup" aria-label="Prime" className="flex gap-0.5 rounded-full bg-white/[0.08] p-0.5">
          {lensStops(body).map((p) => {
            const on = p.equivalent ? mmEq === Number(p.label) : mm === p.mm;
            return (
              <button key={p.label} type="button" role="radio" aria-checked={on} title={p.equivalent ? `${p.label} mm equivalent (${p.mm.toFixed(1)} mm on this sensor)` : `${p.label} mm`}
                onClick={() => { setMm(p.equivalent ? p.mm : Math.round(p.mm)); setMmText(null); }} className={`${pill(on)} !px-2 tabular-nums`}>{p.label}</button>
            );
          })}
        </div>
        <input aria-label="Focal length, mm" inputMode="numeric" value={mmText ?? String(mm)} onChange={(e) => setMmText(e.target.value)}
          onBlur={() => { const v = Number(mmText); if (mmText != null && Number.isFinite(v) && v > 0) setMm(v); setMmText(null); }}
          title={`${mmRange[0]}–${mmRange[1]} mm on ${SENSORS[body].label}`}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className={`h-7 w-12 rounded-full bg-white/[0.08] px-2 text-center text-[12px] tabular-nums text-white outline-none ring-1 ring-inset transition-shadow duration-200 ${flash ? "ring-[#ff453a]" : "ring-white/15"} focus-visible:ring-white/40`} />
        <span className="text-[11.5px] text-white/50">mm</span>
        <select aria-label="Lens character" title="Lens character" value={sel.lens ?? "clean"} onChange={(e) => update({ lens: e.target.value as LensLook })}
          className="h-7 w-[104px] cursor-pointer truncate rounded-full bg-white/10 px-2 text-[12px] font-medium text-white outline-none ring-1 ring-inset ring-white/15 focus-visible:ring-white/60" style={{ colorScheme: "dark" }}>
          {(Object.keys(LENSES) as LensLook[]).map((k) => <option key={k} value={k}>{LENSES[k].label}</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2 text-[11.5px] text-white/60">
        Move
        <select aria-label="Move" value={sel.move} onChange={(e) => update({ move: e.target.value as RigCamera["move"] })}
          className="h-7 cursor-pointer rounded-full bg-white/10 px-2 text-[12px] font-medium text-white outline-none ring-1 ring-inset ring-white/15 focus-visible:ring-white/60" style={{ colorScheme: "dark" }}>
          {MOVES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      {sel.move !== "static" && (
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] text-white/60">Amount</span>
          <div className="w-24"><Slider min={0} max={1} step={0.01} value={[sel.amount ?? 0.4]} onValueChange={(v) => update({ amount: Array.isArray(v) ? v[0] : v })} /></div>
          <span className="w-9 text-[11px] tabular-nums text-white/55">{Math.round((sel.amount ?? 0.4) * 100)}%</span>
        </div>
      )}
      <button type="button" role="switch" aria-checked={sel.sound !== false} onClick={() => update({ sound: sel.sound === false })} title="The shot's own sound (LTX)"
        className={`${toggle(sel.sound !== false)} inline-flex items-center gap-1.5`}>{sel.sound === false ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}Sound</button>
      <div role="radiogroup" aria-label="Preview" className="flex gap-0.5 rounded-full bg-white/[0.08] p-0.5">
        {(["play", "start", "end"] as const).map((p) => (
          <button key={p} type="button" role="radio" aria-checked={preview === p} onClick={() => setPreview(p)} aria-label={p === "play" ? "Play the move" : undefined}
            className={`${pill(preview === p)} inline-flex items-center gap-1`}>{p === "play" ? <><Play className="h-3 w-3" fill="currentColor" />Play</> : p === "start" ? "Start" : "End"}</button>
        ))}
      </div>
      <button type="button" role="switch" aria-checked={lines} onClick={() => setLines((v) => !v)} className={toggle(lines)}>Frame lines</button>
      <div className="flex items-center gap-2">
        <button type="button" role="switch" aria-checked={!!sel.focus} disabled={!surface}
          onClick={() => update({ focus: sel.focus || !surface ? null : { point: sel.cam.target ?? surfacePoint(surface, 0.5, 0.5).anchor, fstop: 2.8 } })} className={toggle(!!sel.focus)} title="Depth of field — focus follows the aim point">Focus</button>
        {sel.focus && (
          <>
            <div className="w-24"><Slider min={0} max={1} step={0.002} value={[toT(FSTOP, sel.focus.fstop)]} onValueChange={(v) => update({ focus: { ...sel.focus!, fstop: fromT(FSTOP, Array.isArray(v) ? v[0] : v) } })} /></div>
            <span className="w-10 text-[11px] tabular-nums text-white/55">T{sel.focus.fstop.toFixed(1)}</span>
          </>
        )}
      </div>
    </>
  );

  return (
    <StudioShell label="Shoot →" phase={phase} setPhase={setPhase} editing={editing}
      stageRef={stageRef} stage={stageContent} controls={controls}
      prompt={prompt} setPrompt={setPrompt} promptPlaceholder="Scene notes (optional)"
      info={info} canRun={!!surface && cameras.length > 0} onRun={() => onNext?.()} notice={notice} />
  );
}
