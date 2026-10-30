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
  /** The camera body / format of THIS camera (sessions from before: the scene's body). */
  sensor?: Sensor;
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
  { id: "reverse", label: "REV", name: "Reverse", move: "orbit-left" },
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

/** A camera's body: its own, else the scene's (sessions from before bodies were per camera). */
export const bodyOf = (c: Pick<RigCamera, "sensor">, fallback: Sensor): Sensor => c.sensor ?? fallback;

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
 * nearest the middle; never the sky, a ceiling, a floor or the far background.
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
  // A subject is something in the set, not the sky, a ceiling or the far background:
  // cells in the top 30 % of the frame or in the far third of the depth are never picked.
  for (let y = Math.round(H * 0.3); y <= Math.round(H * 0.85); y++) for (let x = Math.round(W * 0.2); x <= Math.round(W * 0.8); x++) {
    const u = x / W, v = y / H;
    const near = zMax > zMin ? 1 - (depth(u, v) - zMin) / (zMax - zMin) : 0.5;
    if (near < 0.33) continue;
    // Floors and ceilings (a surface facing up or down) are where things stand, not the subject.
    if (Math.abs(surfacePoint(s, u, v).normal[1]) > 0.6) continue;
    let g = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) g += Math.abs(lum(Math.min(W - 1, x + dx), Math.min(H - 1, y + dy)) - lum(x, y));
    const centre = 1 - Math.hypot(u - 0.5, v - 0.55);
    const score = (g + 4) * (0.25 + near) * centre;
    if (score > best.score) best = { u, v, score };
  }
  if (best.score < 0) return subjectPoint(s);
  return surfacePoint(s, best.u, best.v).anchor;
}

/** The default subject: the centre of the frame's lower third. */
export const subjectPoint = (s: DepthSurface) => surfacePoint(s, 0.5, 2 / 3).anchor;

/** Where the lens sits for a pose (the same orbit the 3D view uses). */
export function cameraPosition(s: DepthSurface, c: SceneCamera): Vec3 {
  const az = (c.azimuth * Math.PI) / 180, el = (c.elevation * Math.PI) / 180, r = lens(s, c).r;
  return [r * Math.sin(az) * Math.cos(el), r * Math.sin(el), -s.pivot + r * Math.cos(az) * Math.cos(el)];
}
/** The real tilt of a pose, degrees (positive looks up): from the lens to what it aims at. */
export function lookTilt(s: DepthSurface, c: SceneCamera): number {
  const p = cameraPosition(s, c), t = c.target ?? ([0, 0, -s.pivot] as Vec3);
  return (Math.atan2(t[1] - p[1], Math.hypot(t[0] - p[0], t[2] - p[2])) * 180) / Math.PI;
}
/** A low angle looks up at least this much. */
export const LOW_TILT = 10;

/**
 * A template's start pose, as a coverage plan sets it: a wide on the whole
 * set, a medium and a close-up aimed at the subject from either side, a low
 * angle from below the eye line tilted up, and the reverse — the furthest
 * honest angle round the set, looking back across it (a full 180° reverse is
 * past anything the photo saw: the person drags the camera there and the
 * studio says the model invents it). Lenses are real mm on the chosen sensor.
 */
export function templateCamera(s: DepthSurface, t: Template, sensor: Sensor = "s35", target: Vec3 = subjectPoint(s), maxZoom = Infinity): SceneCamera {
  const r = orbitLimits(s);
  const base = s.baseFocal ?? BASE_FOCAL;
  // Template lenses are real mm of the cut on this sensor, never tighter than the still resolves (maxZoom).
  const mm = (v: number, dolly = 1) => Math.round(Math.min(sceneFocal(s, v, sensor), base * maxZoom * dolly));
  switch (t) {
    // The wide is the plate's own lens, cropped just enough that the frame is all picture — the whole set.
    case "wide": return { azimuth: 0, elevation: 0, focal: Math.round(fillFocal(s)), dolly: 1 };
    case "medium": return { azimuth: -Math.round(Math.min(14, r.azimuth * 0.6)), elevation: Math.round(Math.min(2, r.elevation)), focal: mm(33, 0.85), dolly: 0.85, target };
    case "close": return { azimuth: Math.round(Math.min(10, r.azimuth * 0.45)), elevation: 0, focal: mm(50, 0.7), dolly: 0.7, target };
    case "low": {
      // Below the eye line (the full reach down), aimed up: the aim is raised until the lens looks up ≥ LOW_TILT.
      const cam: SceneCamera = { azimuth: Math.round(Math.min(6, r.azimuth * 0.3)), elevation: -Math.max(6, Math.round(r.elevation)), focal: mm(25), dolly: 0.8, target };
      const p = cameraPosition(s, cam);
      const lift = p[1] + Math.hypot(target[0] - p[0], target[2] - p[2]) * Math.tan((LOW_TILT * Math.PI) / 180);
      return { ...cam, target: [target[0], Math.max(target[1], lift), target[2]] };
    }
    case "reverse": {
      // The far side of the reach, looking back across the subject: the honest reverse.
      const az = Math.round(r.azimuth);
      return { azimuth: az, elevation: Math.round(Math.min(2, r.elevation)), focal: mm(35, 0.9), dolly: 0.9, target: [target[0] - 0.08 * s.scale, target[1], target[2]] };
    }
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
  return { id: `c${Date.now().toString(36)}${n}`, slate, sensor, template: t, cam: templateCamera(s, t, sensor, target, maxZoom), move: TEMPLATES.find((x) => x.id === t)!.move, focus: null };
}

/** A target nudged sideways (scene x), for trucks and for arcs the reach cannot carry. */
function shifted(s: DepthSurface, c: SceneCamera, by: number): Vec3 {
  const t = c.target ?? ([0, 0, -s.pivot] as Vec3);
  return [t[0] + by * s.scale, t[1], t[2]];
}

/**
 * Where the move ends. The Amount is mapped per move so that 70–100 % always
 * reads clearly on screen (and 40 % is a usual, moderate move):
 * - Arc: a real orbit round the subject, 8°–30°, a little past the reach at most.
 * - Pedestal: 5°–18° of rise, at most just past the reach.
 * - Truck: camera and aim slide sideways together, clamped so the end stays inside the reach (no warp).
 * - Pedestal: camera and aim rise together (tilt kept), so the set is revealed, not tilted.
 * - Dolly out: 1.1×–2.2× the distance; dolly in to 0.15× at most.
 */
export const DEFAULT_AMOUNT = 0.4;
export function endPose(s: DepthSurface, c: SceneCamera, move: Move, amount = DEFAULT_AMOUNT): SceneCamera {
  const a = Math.max(0, Math.min(1, amount));
  // The old scale for the dolly in / push-in: 0.4 is the move as it always was.
  const f = a / DEFAULT_AMOUNT;
  const r = orbitLimits(s);
  const dolly = c.dolly ?? 1;
  const focal = c.focal ?? s.baseFocal ?? BASE_FOCAL;
  const aim = c.target ?? ([0, 0, -s.pivot] as Vec3);
  const arc = (sign: number): SceneCamera => {
    const want = 8 + 22 * a;
    // Room to that side within the reach; a few degrees past it at most (the guide stays mostly photo).
    const room = Math.max(0, r.azimuth - sign * c.azimuth) + 6;
    return { ...c, azimuth: Math.round((c.azimuth + sign * Math.min(want, Math.max(room, 8))) * 10) / 10 };
  };
  const truck = (sign: number): SceneCamera => {
    const room = Math.max(0, r.azimuth - sign * c.azimuth);
    const deg = Math.min(room, 3 + 11 * a);
    if (deg <= 0.1) return { ...c };
    const p = cameraPosition(s, c);
    const radius = Math.hypot(p[0], p[2] + s.pivot) || s.pivot;
    // Camera slides sideways by d; the aim slides the same d, so the lens never turns (a truck, not a pan).
    const rad = (v: number) => (v * Math.PI) / 180;
    const d = radius * (Math.sin(rad(c.azimuth + sign * deg)) - Math.sin(rad(c.azimuth)));
    return { ...c, azimuth: Math.round((c.azimuth + sign * deg) * 10) / 10, target: [aim[0] + d, aim[1], aim[2]] };
  };
  switch (move) {
    case "dolly-in": {
      const end = { ...c, dolly: dolly * Math.max(0.15, 1 - 0.4 * f) };
      const stopped = lens(s, end).r > s.pivot * end.dolly * 1.05;
      return stopped ? { ...end, focal: clamp(focal * (1 + 0.3 * f), 4, 500) } : end;
    }
    case "dolly-out": return { ...c, dolly: Math.min(DOLLY_MAX, dolly * (1.1 + 1.1 * a)) };
    case "truck-left": return truck(-1);
    case "truck-right": return truck(1);
    case "orbit-left": return arc(-1);
    case "orbit-right": return arc(1);
    case "crane-up": {
      const want = 5 + 13 * a;
      const to = Math.min(c.elevation + want, Math.max(c.elevation + 5, r.elevation + 2));
      const end = { ...c, elevation: Math.round(to * 10) / 10 };
      // A pedestal rises straight up: the aim rises with the lens, so the tilt holds.
      const rise = cameraPosition(s, end)[1] - cameraPosition(s, c)[1];
      return { ...end, target: [aim[0], aim[1] + rise, aim[2]] };
    }
    case "push-in": return { ...c, focal: clamp(focal * (1 + 0.7 * f), 4, 500) };
    case "rack-focus": return { ...c };
    case "static": return { ...c };
  }
}
const DOLLY_MAX = 12;

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
    case "orbit-left": case "orbit-right": return `${Math.round(Math.abs(e.azimuth - c.azimuth))}°`;
    case "truck-left": case "truck-right": { const d = Math.abs((e.target?.[0] ?? 0) - (c.target?.[0] ?? 0)); return `${Math.round((d / s.scale) * 100)}% of the frame`; }
    case "crane-up": { const p0 = cameraPosition(s, c), p1 = cameraPosition(s, e); return `${Math.round(e.elevation - c.elevation)}° · rises ${Math.round(((p1[1] - p0[1]) / s.scale) * 100)}% of the frame`; }
    case "rack-focus": return "near → far";
    case "static": return "locked off";
  }
}

/**
 * A rack pulls focus from the nearest thing in the lower frame to the back of
 * the set, wide open (T2 at most) so the difference is strong. The camera
 * does not move. The amount sets how deep the pull lands (40 %: two thirds).
 */
export function rackFocus(s: DepthSurface, fstop = 2, amount = DEFAULT_AMOUNT): { start: SceneFocus; end: SceneFocus } {
  const a = Math.max(0, Math.min(1, amount));
  const depth = (u: number, v: number) => -surfacePoint(s, u, v).anchor[2];
  let near = { u: 0.5, v: 0.82, z: Infinity }, far = { u: 0.5, v: 0.4, z: -Infinity };
  for (let v = 0.2; v <= 0.95; v += 0.05) for (let u = 0.2; u <= 0.8; u += 0.05) {
    const z = depth(u, v);
    if (v >= 0.55 && z < near.z) near = { u, v, z };
    if (v <= 0.65 && z > far.z) far = { u, v, z };
  }
  // The far key: towards the deepest point by the amount (never less than half way).
  const k = 0.5 + 0.5 * a;
  const end = surfacePoint(s, near.u + (far.u - near.u) * k, near.v + (far.v - near.v) * k).anchor;
  const t = Math.min(fstop, 2);
  return { start: { point: surfacePoint(s, near.u, near.v).anchor, fstop: t }, end: { point: end, fstop: t } };
}

const MOTION: Record<Move, (amount: string) => string> = {
  "static": () => "A locked-off static camera on a tripod, no camera movement at all, only the natural life of the scene",
  "dolly-in": (a) => `A smooth, clearly visible dolly-in toward the subject, the camera travelling forward about ${a} of the distance`,
  "dolly-out": (a) => `A smooth, clearly visible dolly-out pulling back away from the subject, the camera travelling backwards about ${a}, the frame widening to reveal more of the surroundings`,
  "truck-left": (a) => `A smooth, clearly visible lateral truck to the left, the camera sliding sideways on a track (${a}) without turning, parallax between foreground and background, straight lines stay straight`,
  "truck-right": (a) => `A smooth, clearly visible lateral truck to the right, the camera sliding sideways on a track (${a}) without turning, parallax between foreground and background, straight lines stay straight`,
  "orbit-left": (a) => `A smooth, clearly visible arc shot circling to the left around the subject, about ${a} of orbit, the subject stays centred while the background swings behind it, strong parallax`,
  "orbit-right": (a) => `A smooth, clearly visible arc shot circling to the right around the subject, about ${a} of orbit, the subject stays centred while the background swings behind it, strong parallax`,
  "crane-up": (a) => `A smooth, clearly visible pedestal up, the whole camera rising straight up (${a}) without tilting, revealing more of the set from above`,
  "push-in": (a) => `A smooth, clearly visible push-in, the frame tightening ${a} on the subject`,
  "rack-focus": () => "Rack focus from foreground to background, camera locked: a locked-off tripod shot, no zoom, no camera movement, the framing never changes; only the focus pulls from the sharp foreground to the sharp background while the foreground falls soft",
};

/** What LTX is told for a camera's move: named strongly, with its size. */
export function motionPrompt(move: Move, scene: string, amount = ""): string {
  const what = scene.trim();
  return `${MOTION[move](amount || "a third")}, steady cinematic camera, continuous motion from the first frame to the last, natural motion of light and air, no cuts, photorealistic, consistent lighting.${what ? ` ${what}` : ""}`;
}

/** The look every still shares, so the shots cut together. */
export const sharedLook = () => `Cinematic film still, ${aspectLabel()} frame. One continuous scene: the same set, lighting and colour grade in every shot.`;
