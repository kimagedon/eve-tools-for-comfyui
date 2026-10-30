/**
 * The camera rig as plain data: coverage templates placed within what the
 * lens saw, the move each camera makes (its end pose), and the words LTX
 * gets for that move. One set, one lighting plan, many cameras.
 */
import { BASE_FOCAL, orbitLimits, surfacePoint, type DepthSurface } from "./depth-mesh";
import type { SceneCamera, SceneFocus, Vec3 } from "@/components/tools/depth-scene";
import { aspectLabel, outputAspect, sceneFocal, type LensLook, type Sensor } from "./cine";
import { lens } from "./camera-lens";

export type Template = "wide" | "medium" | "close" | "low" | "reverse";
export type Move = "static" | "dolly-in" | "dolly-out" | "truck-left" | "truck-right" | "orbit-left" | "orbit-right" | "crane-up" | "push-in" | "rack-focus";

export interface RigCamera {
  id: string;
  /** Setup letter index (0 → 1A), fixed for the camera's life so takes and the EDL never re-letter. */
  slate?: number;
  /** How strong the move is, 0–1 (0.4 = the usual move). */
  amount?: number;
  /** The shot's own sound from LTX (default on). */
  sound?: boolean;
  /** Lens character: how the glass draws (default modern clean). */
  lens?: LensLook;
  template: Template;
  cam: SceneCamera;
  move: Move;
  focus: SceneFocus | null;
}

/** Shot sizes, as on a shot list. */
export const TEMPLATES: { id: Template; label: string; name: string; move: Move }[] = [
  { id: "wide", label: "WS", name: "Wide", move: "dolly-in" },
  { id: "medium", label: "MS", name: "Medium", move: "orbit-left" },
  { id: "close", label: "CU", name: "Close-up", move: "push-in" },
  { id: "low", label: "LA", name: "Low angle", move: "crane-up" },
  { id: "reverse", label: "REV", name: "Reverse", move: "orbit-right" },
];

/** Camera moves, in grip terms. */
export const MOVES: { id: Move; label: string }[] = [
  { id: "static", label: "Static" },
  { id: "dolly-in", label: "Dolly in" },
  { id: "dolly-out", label: "Dolly out" },
  { id: "truck-left", label: "Truck L" },
  { id: "truck-right", label: "Truck R" },
  { id: "orbit-left", label: "Arc L" },
  { id: "orbit-right", label: "Arc R" },
  { id: "crane-up", label: "Pedestal up" },
  { id: "push-in", label: "Push-in" },
  { id: "rack-focus", label: "Rack focus" },
];

/** Every shot is cut to this frame. */
/** The delivery frame (the format chosen in Extend); see cine.ts. */
export { outputAspect } from "./cine";
export const MAX_CAMERAS = 5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The widest lens whose 2.39 frame the plate fills from its own camera position. */
export function fillFocal(s: DepthSurface): number {
  return (s.baseFocal ?? BASE_FOCAL) * Math.max(1, outputAspect() / s.aspect) * 1.03;
}

/**
 * The subject a medium or close-up aims at: inside the central half of the plate,
 * the cell with the most local contrast weighted by nearness — the prominent thing
 * nearest the middle, never an empty patch of floor.
 */
export function pickSubject(s: DepthSurface, image: CanvasImageSource & { width: number; height: number }): Vec3 {
  const W = 64, H = Math.max(8, Math.round(64 / s.aspect));
  const c = new OffscreenCanvas(W, H), ctx = c.getContext("2d");
  if (!ctx) return subjectPoint(s);
  ctx.drawImage(image, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const lum = (x: number, y: number) => { const i = (y * W + x) * 4; return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; };
  const depth = (u: number, v: number) => -surfacePoint(s, u, v).anchor[2];
  let zMin = Infinity, zMax = -Infinity;
  for (let y = 2; y < H - 2; y += 2) for (let x = 2; x < W - 2; x += 2) { const z = depth(x / W, y / H); zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); }
  let best = { u: 0.5, v: 0.55, score: -1 };
  for (let y = Math.round(H * 0.25); y <= Math.round(H * 0.75); y++) for (let x = Math.round(W * 0.25); x <= Math.round(W * 0.75); x++) {
    let g = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) g += Math.abs(lum(x + dx, y + dy) - lum(x, y));
    const u = x / W, v = y / H;
    const near = zMax > zMin ? 1 - (depth(u, v) - zMin) / (zMax - zMin) : 0.5;
    const centre = 1 - Math.hypot(u - 0.5, v - 0.5);
    const score = g * (0.35 + near) * centre;
    if (score > best.score) best = { u, v, score };
  }
  return surfacePoint(s, best.u, best.v).anchor;
}

/** The default subject: the centre of the frame's lower third. */
export const subjectPoint = (s: DepthSurface) => surfacePoint(s, 0.5, 2 / 3).anchor;

/**
 * A template's start pose, as a coverage plan sets it: a wide on the whole
 * set, a medium and a close-up aimed at the subject from either side, a low
 * angle tilted up, and the reverse — beyond what the photo saw, so the model
 * invents it (the studio says so). Lenses are real mm on the chosen sensor.
 */
export function templateCamera(s: DepthSurface, t: Template, sensor: Sensor = "s35", target: Vec3 = subjectPoint(s), maxZoom = Infinity): SceneCamera {
  const r = orbitLimits(s);
  const base = s.baseFocal ?? BASE_FOCAL;
  // Template lenses are real mm of the cut on this sensor, never tighter than the still resolves (maxZoom).
  const mm = (v: number, dolly = 1) => Math.round(Math.min(sceneFocal(s, v, sensor), base * maxZoom * dolly));
  switch (t) {
    // The wide is the plate's own lens, cropped just enough that a 2.39 frame is all picture.
    case "wide": return { azimuth: 0, elevation: 0, focal: Math.round(fillFocal(s)), dolly: 1 };
    case "medium": return { azimuth: -Math.round(Math.min(14, r.azimuth * 0.6)), elevation: Math.round(Math.min(2, r.elevation)), focal: mm(33, 0.85), dolly: 0.85, target };
    case "close": return { azimuth: Math.round(Math.min(10, r.azimuth * 0.45)), elevation: 0, focal: mm(50, 0.7), dolly: 0.7, target };
    case "low": return { azimuth: Math.round(Math.min(6, r.azimuth * 0.3)), elevation: -Math.round(r.elevation), focal: mm(25), dolly: 0.8, target };
    case "reverse": return { azimuth: 180, elevation: 2, focal: mm(35), dolly: 1, target };
  }
}

/** A camera's slate index: its own, or (sessions from before slates were kept) its place in the rig. */
export const slateIndex = (c: RigCamera, all: RigCamera[]) => c.slate ?? Math.max(0, all.indexOf(c));
/** The lowest setup letter no camera holds. */
export function nextSlate(all: RigCamera[]): number {
  const used = new Set(all.map((c) => slateIndex(c, all)));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

export function newCamera(s: DepthSurface, t: Template, n: number, sensor: Sensor = "s35", slate = n, target?: Vec3, maxZoom?: number): RigCamera {
  return { id: `c${Date.now().toString(36)}${n}`, slate, template: t, cam: templateCamera(s, t, sensor, target, maxZoom), move: TEMPLATES.find((x) => x.id === t)!.move, focus: null };
}

/** A target nudged sideways (scene x), for trucks and for arcs the reach cannot carry. */
function shifted(s: DepthSurface, c: SceneCamera, by: number): Vec3 {
  const t = c.target ?? ([0, 0, -s.pivot] as Vec3);
  return [t[0] + by * s.scale, t[1], t[2]];
}

/**
 * Where the move ends — a step large enough to read on screen, clamped to
 * what the lens saw when the start was inside it. A dolly the set's surface
 * stops short also tightens the lens, so it still travels.
 */
export const DEFAULT_AMOUNT = 0.4;
export function endPose(s: DepthSurface, c: SceneCamera, move: Move, amount = DEFAULT_AMOUNT): SceneCamera {
  // Every step scales with the amount; 0.4 is the move as it always was.
  const f = Math.max(0, Math.min(1, amount)) / DEFAULT_AMOUNT;
  const r = orbitLimits(s);
  const base = s.baseFocal ?? BASE_FOCAL;
  const inside = Math.abs(c.azimuth) <= r.azimuth + 0.5 && Math.abs(c.elevation) <= r.elevation + 0.5;
  const az = (v: number) => (inside ? clamp(v, -r.azimuth, r.azimuth) : v);
  const el = (v: number) => (inside ? clamp(v, -r.elevation, r.elevation) : v);
  const dolly = c.dolly ?? 1;
  const focal = c.focal ?? base;
  const arc = (sign: number): SceneCamera => {
    const to = az(c.azimuth + sign * 15 * f);
    // Short reach: the rest of the move becomes a sideways track so it still reads.
    return Math.abs(to - c.azimuth) < 10 * f ? { ...c, azimuth: to, target: shifted(s, c, sign * 0.12 * f) } : { ...c, azimuth: to };
  };
  switch (move) {
    case "dolly-in": {
      const end = { ...c, dolly: dolly * Math.max(0.15, 1 - 0.4 * f) };
      const stopped = lens(s, end).r > s.pivot * end.dolly * 1.05;
      return stopped ? { ...end, focal: clamp(focal * (1 + 0.3 * f), 4, 500) } : end;
    }
    case "dolly-out": return { ...c, dolly: dolly / Math.max(0.15, 1 - 0.4 * f) };
    case "truck-left": return { ...c, azimuth: az(c.azimuth - 10 * f), dolly: dolly * (1 - 0.05 * f), target: shifted(s, c, -0.1 * f) };
    case "truck-right": return { ...c, azimuth: az(c.azimuth + 10 * f), dolly: dolly * (1 - 0.05 * f), target: shifted(s, c, 0.1 * f) };
    case "orbit-left": return arc(-1);
    case "orbit-right": return arc(1);
    case "crane-up": {
      const to = el(c.elevation + 12 * f);
      // The reach ate the rise: raise the aim too, so the move still reads.
      return Math.abs(to - c.elevation) < 6 * f ? { ...c, elevation: to, target: ((t) => [t[0], t[1] + 0.12 * f * s.scale, t[2]] as Vec3)(c.target ?? ([0, 0, -s.pivot] as Vec3)) } : { ...c, elevation: to };
    }
    case "push-in": return { ...c, focal: clamp(focal * (1 + 0.7 * f), 4, 500) };
    case "rack-focus": return { ...c };
    case "static": return { ...c };
  }
}

/** How big the move is, as the info line and the prompt say it ("Dolly in · 40%"). */
export function moveAmount(s: DepthSurface, c: SceneCamera, move: Move, amount = DEFAULT_AMOUNT): string {
  const e = endPose(s, c, move, amount);
  const r0 = lens(s, c).r, r1 = lens(s, e).r;
  switch (move) {
    case "dolly-in": case "dolly-out": {
      const travel = `${Math.round(Math.abs(1 - r1 / r0) * 100)}%`;
      const f = (e.focal ?? 1) / (c.focal ?? 1);
      return f > 1.05 ? `${travel} + ${f.toFixed(1)}× lens` : travel;
    }
    case "push-in": return `${((e.focal ?? 1) / (c.focal ?? 1)).toFixed(1)}×`;
    case "orbit-left": case "orbit-right": case "truck-left": case "truck-right": return `${Math.round(Math.abs(e.azimuth - c.azimuth))}°`;
    case "crane-up": { const d = Math.round(e.elevation - c.elevation); return e.target !== c.target ? `+${d}° + tilt` : `+${d}°`; }
    case "rack-focus": return "near → far";
    case "static": return "locked off";
  }
}

/** A rack pulls focus from the foreground to the back of the set. */
export function rackFocus(s: DepthSurface, fstop = 2, amount = DEFAULT_AMOUNT): { start: SceneFocus; end: SceneFocus } {
  // The pull travels deeper into the set with the amount.
  const v = Math.max(0.08, 0.82 - 0.52 * (Math.max(0, Math.min(1, amount)) / DEFAULT_AMOUNT));
  return { start: { point: surfacePoint(s, 0.5, 0.82).anchor, fstop }, end: { point: surfacePoint(s, 0.5, v).anchor, fstop } };
}

const MOTION: Record<Move, (amount: string) => string> = {
  "static": () => "A locked-off static camera on a tripod, no camera movement at all, only the natural life of the scene",
  "dolly-in": (a) => `A smooth, clearly visible dolly-in toward the subject, the camera travelling forward about ${a} of the distance`,
  "dolly-out": (a) => `A smooth, clearly visible dolly-out away from the subject, the camera travelling back about ${a}`,
  "truck-left": (a) => `A smooth, clearly visible lateral truck to the left, the camera tracking sideways (${a}), parallax between foreground and background`,
  "truck-right": (a) => `A smooth, clearly visible lateral truck to the right, the camera tracking sideways (${a}), parallax between foreground and background`,
  "orbit-left": (a) => `A smooth, clearly visible arc to the left around the subject, about ${a}, strong parallax`,
  "orbit-right": (a) => `A smooth, clearly visible arc to the right around the subject, about ${a}, strong parallax`,
  "crane-up": (a) => `A smooth, clearly visible pedestal up, the camera rising (${a}) and revealing more of the set`,
  "push-in": (a) => `A smooth, clearly visible push-in, the frame tightening ${a} on the subject`,
  "rack-focus": () => "A locked-off camera with a clearly visible rack focus from the foreground to the background",
};

/** What LTX is told for a camera's move: named strongly, with its size. */
export function motionPrompt(move: Move, scene: string, amount = ""): string {
  const what = scene.trim();
  return `${MOTION[move](amount || "a third")}, steady cinematic camera, continuous motion from the first frame to the last, natural motion of light and air, no cuts, photorealistic, consistent lighting.${what ? ` ${what}` : ""}`;
}

/** The look every still shares, so the shots cut together. */
export const sharedLook = () => `Cinematic film still, ${aspectLabel()} frame. One continuous scene: the same set, lighting and colour grade in every shot.`;
