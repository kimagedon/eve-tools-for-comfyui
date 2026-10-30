/**
 * The numbers a camera department works in. The 3D scene thinks in 35 mm
 * full-frame-equivalent focal lengths and unitless distances; these map
 * them to the lens on the chosen sensor, horizontal FOV, metres, slates
 * and colour temperature. Distances are estimates (a single photo has no
 * absolute scale), so they are always shown with "≈".
 */
import type { DepthSurface } from "./depth-mesh";
import { lens } from "./camera-lens";

/** The camera / format: its gate sets the field of view, its look goes into every prompt. */
export type Sensor = "lf" | "ff" | "s35" | "film35" | "film16" | "super8" | "stills" | "compact" | "phone";
export type SensorGroup = "Digital cinema" | "Film" | "Stills";
/** Gate width (mm), crop against full frame, and the words that describe the format's look. */
export const SENSORS: Record<Sensor, { label: string; short: string; width: number; crop: number; group: SensorGroup; look: string }> = {
  lf: { label: "Large format", short: "LF", width: 54.12, crop: 36 / 54.12, group: "Digital cinema", look: "large-format digital cinema camera, very shallow depth of field, smooth tonal roll-off, immersive wide field" },
  ff: { label: "Full frame", short: "FF", width: 36, crop: 1, group: "Digital cinema", look: "full-frame digital cinema camera, clean detail, shallow depth of field" },
  s35: { label: "Super 35", short: "S35", width: 24.89, crop: 36 / 24.89, group: "Digital cinema", look: "Super 35 digital cinema camera, natural cinematic depth of field, rich dynamic range" },
  film35: { label: "35 mm film", short: "35", width: 24.89, crop: 36 / 24.89, group: "Film", look: "shot on 35 mm motion-picture film, fine organic grain, soft halation around highlights, filmic colour" },
  film16: { label: "16 mm film", short: "16", width: 12.52, crop: 36 / 12.52, group: "Film", look: "16 mm film, visible grain, softer resolution, gentle halation, slightly lifted blacks" },
  super8: { label: "Super 8", short: "S8", width: 5.79, crop: 36 / 5.79, group: "Film", look: "Super 8 film, heavy grain, soft focus, warm faded colour, slight gate weave and vignette" },
  stills: { label: "Full-frame stills camera", short: "FF stills", width: 36, crop: 1, group: "Stills", look: "full-frame stills camera photograph, crisp detail, natural depth of field" },
  compact: { label: "Compact point-and-shoot", short: "Compact", width: 13.2, crop: 36 / 13.2, group: "Stills", look: "compact point-and-shoot camera, deep focus, direct flash look, slight digital noise, snapshot feel" },
  phone: { label: "Phone", short: "Phone", width: 9.8, crop: 36 / 9.8, group: "Stills", look: "smartphone camera, deep focus, crisp HDR processing, slightly wide-angle rendering" },
};
export const SENSOR_GROUPS: SensorGroup[] = ["Digital cinema", "Film", "Stills"];

/** Lens character: plain words for how the glass draws — bokeh, flare, contrast, falloff. */
export type LensLook = "clean" | "clinical" | "warm" | "vintage-swirl" | "japanese" | "soft" | "anamorphic" | "macro";
export const LENSES: Record<LensLook, { label: string; short: string; look: string }> = {
  clean: { label: "Modern clean", short: "Modern clean", look: "modern cine prime, clean neutral rendering, round bokeh, controlled flare" },
  clinical: { label: "Clinical sharp (German)", short: "Clinical", look: "clinically sharp German-style cine prime, high micro-contrast, edge-to-edge sharpness, crisp round bokeh, minimal flare" },
  warm: { label: "Warm classic (British)", short: "Warm classic", look: "warm classic British-style cine lens, gentle contrast, creamy skin tones, smooth bokeh, soft warm flare" },
  "vintage-swirl": { label: "Soviet vintage (swirly bokeh)", short: "Soviet vintage", look: "Soviet vintage lens, swirly bokeh, soft corners, low contrast, ghosting flares, sharpness falling off to the edges" },
  japanese: { label: "Japanese modern", short: "Japanese modern", look: "modern Japanese-style cine lens, balanced sharpness, clean colour, smooth round bokeh, subtle flare" },
  soft: { label: "Soft vintage", short: "Soft vintage", look: "soft vintage glass, blooming highlights, low contrast, dreamy glow, gentle veiling flare" },
  anamorphic: { label: "Anamorphic (oval bokeh, horizontal flares)", short: "Anamorphic", look: "anamorphic lens, oval bokeh, horizontal streak flares, 2.39:1 widescreen squeeze, slight barrel distortion and edge falloff" },
  macro: { label: "Macro", short: "Macro", look: "macro lens, extreme close focus, razor-thin depth of field, fine texture detail" },
};
/** The words a still and a clip are prompted with for this camera and glass. */
export const cameraLook = (sensor: Sensor, lens: LensLook = "clean") => `${SENSORS[sensor].look}; ${LENSES[lens].look}.`;
export const PRIMES = [14, 18, 25, 35, 50, 75, 100, 135];
/**
 * The lenses a body really offers. Cinema and film bodies take the primes (real mm
 * on that gate); a phone has its fixed modules and a compact its zoom stops, both
 * named as photographers know them — full-frame equivalent (ultra-wide 13, main 24,
 * 2× 48, tele 77 on a phone). `mm` is the lens on the body's own sensor.
 */
const EQUIVALENT_STOPS: Partial<Record<Sensor, number[]>> = { phone: [13, 24, 48, 77], compact: [24, 28, 35, 50, 70, 105] };
export function lensStops(sensor: Sensor): { mm: number; label: string; equivalent: boolean }[] {
  const eq = EQUIVALENT_STOPS[sensor];
  if (!eq) return PRIMES.map((p) => ({ mm: p, label: String(p), equivalent: false }));
  return eq.map((e) => ({ mm: e / SENSORS[sensor].crop, label: String(e), equivalent: true }));
}

/** The scene's full-frame-equivalent focal → the lens on this sensor, and back. */
export const lensMm = (equivalent: number, sensor: Sensor) => equivalent / SENSORS[sensor].crop;
export const equivalentMm = (mm: number, sensor: Sensor) => mm * SENSORS[sensor].crop;
/**
 * The lens on this sensor that frames what the 2.39 output shows. The scene's
 * focal is anchored to the plate (its own aspect), but every guide and still is
 * cut 2.39, so the real horizontal half-angle is 2.39 · tan(fovY / 2). Linear:
 * mm = f · k with k = gate / (2 · 2.39 · tan(plate fovY / 2) · baseFocal).
 */
/**
 * The delivery frame: the format chosen in Extend (the plate's own aspect after it),
 * 2.39 until a plate says otherwise. One value read by Cameras, Shoot, the cut and the paperwork.
 */
let delivery = 2.39;
export const outputAspect = () => delivery;
export function setOutputAspect(a: number) { if (Number.isFinite(a) && a > 0.3 && a < 4) delivery = Math.round(a * 1000) / 1000; }
/** "2.39:1", "16:9", "9:16" — for prompts and labels. */
export function aspectLabel(a = delivery): string {
  const named: [number, string][] = [[16 / 9, "16:9"], [9 / 16, "9:16"], [4 / 3, "4:3"], [3 / 2, "3:2"], [1, "1:1"], [4 / 5, "4:5"]];
  const hit = named.find(([v]) => Math.abs(v - a) < 0.01);
  return hit ? hit[1] : a >= 1 ? `${a.toFixed(2)}:1` : `1:${(1 / a).toFixed(2)}`;
}
const frameK = (s: { fovY: number; baseFocal: number }, sensor: Sensor) => SENSORS[sensor].width / (2 * delivery * Math.tan((s.fovY * Math.PI) / 360) * s.baseFocal);
export const frameMm = (s: { fovY: number; baseFocal: number }, focal: number, sensor: Sensor) => focal * frameK(s, sensor);
export const sceneFocal = (s: { fovY: number; baseFocal: number }, mm: number, sensor: Sensor) => mm / frameK(s, sensor);

/** Horizontal field of view, degrees. */
export const hfov = (mm: number, sensor: Sensor) => (2 * Math.atan(SENSORS[sensor].width / (2 * mm)) * 180) / Math.PI;

/**
 * Metres per scene unit. One photo has no absolute scale: assume the frame
 * spans about 2.8 m vertically at the subject — a room or a street front.
 */
const FRAME_HEIGHT_M = 2.8;
/** The original camera's lens height, eye level. */
const EYE_M = 1.6;
export const metres = (s: DepthSurface) => FRAME_HEIGHT_M / s.scale;

export type CamPose = { azimuth: number; elevation: number; focal: number | null; dolly?: number };

/** ≈ metres from the lens to the subject (the set's pivot). */
export function subjectDistance(s: DepthSurface, c: CamPose): number {
  return lens(s, c).r * metres(s);
}
/** ≈ lens height above the floor, metres. */
export function cameraHeight(s: DepthSurface, c: CamPose): number {
  const r = lens(s, c).r * metres(s);
  return Math.max(0.1, EYE_M + r * Math.sin((c.elevation * Math.PI) / 180));
}
/** Tilt, degrees: negative looks down. */
export const tilt = (c: CamPose) => -Math.round(c.elevation);

/** Slate: scene 1, one setup letter per camera — 1A, 1B, 1C… */
export const slate = (index: number, scene = 1) => `${scene}${String.fromCharCode(65 + (index % 26))}`;
export const takeName = (index: number, ext = "mp4", take = 1) => `${slate(index)}_T${take}.${ext}`;

/** Black-body colour of `kelvin` (Tanner Helland's fit), with a green(−)/magenta(+) tint. */
export function kelvinHex(kelvin: number, tint = 0): string {
  const t = kelvin / 100;
  let r: number, g: number, b: number;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * (t - 60) ** -0.1332047592; g = 288.1221695283 * (t - 60) ** -0.0755148492; }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  // Tint: magenta lifts red and blue, green lifts green.
  const k = tint / 100;
  // Strong enough to read: full green (−100) takes ~40 % off red and blue; full magenta ~40 % off green.
  const gr = Math.max(0, -k), mg = Math.max(0, k);
  r *= 1 - gr * 0.4; b *= 1 - gr * 0.4; g *= 1 - mg * 0.4;
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Intensity relative to the key, in stops. */
export const stops = (strength: number, key: number) => Math.log2(Math.max(1e-3, strength) / Math.max(1e-3, key));
export const fmtStops = (v: number) => (Math.abs(v) < 0.05 ? "0 st" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} st`);
