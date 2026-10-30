/**
 * Relight and Reframe setups as plain data, shared by the studio (where a
 * person places lights and moves the camera by hand) and batch shooting (where
 * an agent describes the same setup in numbers): the lighting presets, a
 * light hung from a point on the photo, what the model is told about each
 * light and about the camera, and the size of the 3D guide sent with them.
 */
import type { ParamValues } from "@/lib/extend";
import type { StudioLight } from "@/prompts";
import { BASE_FOCAL, orbitLimits, surfacePoint, type DepthSurface } from "@/lib/depth-mesh";
import { lens } from "@/lib/camera-lens";
import { kelvinHex } from "@/lib/cine";
import { lightPoint, type Fixture, type LightKind, type LightRole, type SceneCamera, type SceneLight, type Vec3 } from "./depth-scene";

/** Fixture types, as the gaffer names them, on top of the renderer's three kinds. */
/** `words` describe the light a unit gives, never the device: told "LED panel", an image model draws one. */
export const FIXTURES: Record<Fixture, { label: string; kind: LightKind; beam?: number; offset?: number; words: string }> = {
  fresnel: { label: "Fresnel", kind: "spot", beam: 30, words: "a focused, hard-edged beam with a crisp pool and clean shadow edges" },
  openface: { label: "Open face", kind: "spot", beam: 60, words: "harsh, wide, unfocused hard light with strong, sharp shadows" },
  led: { label: "LED panel", kind: "point", words: "even, soft-edged light with a gentle falloff" },
  softbox: { label: "Softbox", kind: "point", offset: 0.45, words: "very soft, wrapping light with feathered, almost shadowless edges" },
  practical: { label: "Practical", kind: "point", offset: 0.08, words: "a warm, motivated glow from a light source already visible in the scene" },
  hmi: { label: "Sun / HMI", kind: "sun", words: "strong daylight-balanced hard light, like sun through a window" },
};
/**
 * The fixture library, as a gaffer or a photographer picks a unit (generic
 * names, no brands). Each maps to a render kind and a mesh family, a beam,
 * a size (throw), a default colour temperature, a level in stops against a
 * 1K-class key, and `words` for the LIGHT it gives — never the device.
 */
export interface LibraryUnit {
  id: string; label: string; group: string; family: Fixture; kind: LightKind;
  beam?: number; offset?: number; kelvin: number; tint?: number; stops: number; words: string; flash?: boolean;
}
const U = (group: string, family: Fixture, kind: LightKind, kelvin: number, stops: number, words: string, rest: Partial<LibraryUnit> & { id: string; label: string }): LibraryUnit => ({ group, family, kind, kelvin, stops, words, ...rest });
const T = "Tungsten", H = "HMI", L = "LED", F = "Fluorescent", S = "Soft sources", X = "Flash / strobe", P = "Practicals";
export const LIBRARY: LibraryUnit[] = [
  U(T, "fresnel", "spot", 3200, -1, "a small, focused hard beam with a crisp pool and clean shadow edges", { id: "t650", label: "Fresnel 650 W", beam: 30 }),
  U(T, "fresnel", "spot", 3200, 0, "a focused, hard-edged warm beam with a crisp pool and clean shadow edges", { id: "t1k", label: "Fresnel 1K", beam: 32 }),
  U(T, "fresnel", "spot", 3200, 1, "a strong focused hard beam, crisp shadows, a defined warm pool", { id: "t2k", label: "Fresnel 2K", beam: 34 }),
  U(T, "fresnel", "spot", 3200, 2.3, "a powerful hard beam that reaches far, long crisp shadows", { id: "t5k", label: "Fresnel 5K", beam: 36, offset: 0.5 }),
  U(T, "fresnel", "spot", 3200, 3.3, "a very powerful hard beam from far away, parallel crisp shadows like a low sun", { id: "t10k", label: "Fresnel 10K", beam: 38, offset: 0.6 }),
  U(T, "openface", "spot", 3200, -0.5, "harsh, wide, unfocused hard light with strong, sharp shadows", { id: "o800", label: "Open face 800 W", beam: 60 }),
  U(T, "openface", "spot", 3200, 1, "harsh, broad, unfocused hard light with strong, sharp, slightly doubled shadows", { id: "o2k", label: "Open face 2K", beam: 65 }),
  U(T, "openface", "spot", 3200, 0.5, "a punchy, narrow, intense hard beam with an oval hot centre", { id: "par1k", label: "PAR 1K", beam: 18 }),
  U(H, "hmi", "spot", 5600, 1.5, "hard, crisp daylight beam with clean shadow edges", { id: "h12", label: "HMI Fresnel 1.2K", beam: 30 }),
  U(H, "hmi", "spot", 5600, 3, "strong, hard daylight beam with long, crisp shadows", { id: "h4", label: "HMI Fresnel 4K", beam: 32, offset: 0.55 }),
  U(H, "hmi", "sun", 5600, 4.5, "sun-like hard daylight from far away, parallel crisp shadows", { id: "h18", label: "HMI Fresnel 18K", offset: 0.8 }),
  U(H, "openface", "spot", 5600, 2, "a punchy, intense daylight beam, hard and slightly sharp-edged", { id: "hp18", label: "HMI PAR 1.8K", beam: 22 }),
  U(H, "openface", "spot", 5600, 3, "an intense daylight shaft, hard, crisp and far-reaching", { id: "hp4", label: "HMI PAR 4K", beam: 20, offset: 0.55 }),
  U(H, "hmi", "sun", 5600, 4.5, "a hard daylight shaft like direct sun through a window", { id: "hp18k", label: "HMI PAR 18K", offset: 0.8 }),
  U(L, "led", "point", 4300, -0.5, "even, soft-edged light with a gentle falloff", { id: "lsoft", label: "LED soft panel" }),
  U(L, "led", "point", 4300, 0, "soft, even light, gentle falloff and soft shadow edges", { id: "l1x1", label: "LED 1×1 bi-colour panel" }),
  U(L, "fresnel", "spot", 5600, 0.5, "a clean focused beam with crisp shadow edges", { id: "lfres", label: "LED Fresnel", beam: 30 }),
  U(L, "led", "point", 4300, -1.5, "a thin line of soft light with a long, narrow specular streak", { id: "ltube", label: "LED tube", offset: 0.12 }),
  U(L, "softbox", "point", 4300, 0, "large, soft, even light with feathered shadows", { id: "lmat", label: "LED mat", offset: 0.35 }),
  U(F, "softbox", "point", 5600, -0.5, "soft, flat, slightly green-tinged fluorescent light with soft shadows", { id: "f4b", label: "Fluorescent 4-bank 4 ft", tint: -15, offset: 0.3 }),
  U(S, "practical", "point", 3200, -1, "a soft, round, all-round glow, gentle wrap and soft shadows", { id: "lantern", label: "Chinese lantern", offset: 0.15 }),
  U(S, "practical", "point", 5600, 2, "a large, soft, shadowless overhead glow over the whole set", { id: "balloon", label: "Balloon light", offset: 0.5 }),
  U(S, "softbox", "point", 4300, -0.5, "very soft, wrapping bounced light, almost shadowless", { id: "book", label: "Book light", offset: 0.3 }),
  U(S, "softbox", "point", 5600, 0.5, "large, very soft wrapping light through a big diffusion frame, feathered edges", { id: "frame12", label: "12×12 frame (bounce / diffusion)", offset: 0.55 }),
  U(X, "fresnel", "spot", 5600, 1, "brief crisp flash, hard light with a hard specular catchlight", { id: "mono", label: "Monolight, bare", beam: 70, flash: true }),
  U(X, "softbox", "point", 5600, 0.5, "brief crisp flash through a softbox: soft, even light with a square catchlight", { id: "monosb", label: "Monolight + softbox", flash: true, offset: 0.4 }),
  U(X, "softbox", "point", 5600, 0.5, "brief crisp flash, large soft wrapping light with a round catchlight", { id: "octa", label: "Octabox", flash: true, offset: 0.45 }),
  U(X, "led", "point", 5600, 0, "brief crisp flash, a narrow soft strip of light that rims edges", { id: "strip", label: "Strip box", flash: true, offset: 0.3 }),
  U(X, "openface", "spot", 5600, 0.5, "brief crisp flash, punchy yet smooth light with sculpted falloff and a ring catchlight", { id: "dish", label: "Beauty dish", beam: 55, flash: true }),
  U(X, "softbox", "point", 5600, 0.3, "brief crisp flash, broad soft spilling light through an umbrella", { id: "umbshoot", label: "Umbrella, shoot-through", flash: true, offset: 0.4 }),
  U(X, "softbox", "point", 5600, 0.3, "brief crisp flash, broad bounced light with a soft edge and a round catchlight", { id: "umbref", label: "Umbrella, reflective", flash: true, offset: 0.4 }),
  U(X, "led", "point", 5600, -0.5, "brief crisp flash straight from the lens axis: flat, even, a thin shadow halo and a ring catchlight", { id: "ring", label: "Ring flash", flash: true, offset: 0.1 }),
  U(X, "fresnel", "spot", 5600, -0.5, "brief crisp small flash, hard light with a small hard catchlight", { id: "speed", label: "Speedlight", beam: 50, flash: true }),
  U(P, "practical", "point", 2700, -2, "a warm, motivated glow from a bare bulb already visible in the scene", { id: "bulb", label: "Bulb", offset: 0.08 }),
  U(P, "practical", "point", 2700, -2, "a warm, motivated pool from a table lamp already in the scene, shaded and soft", { id: "lamp", label: "Table lamp", offset: 0.1 }),
  U(P, "practical", "point", 1900, -3, "a tiny, very warm, flickering candle glow with very fast falloff", { id: "candle", label: "Candle", offset: 0.05 }),
  U(P, "practical", "point", 3200, -2, "a saturated, glowing neon line of coloured light", { id: "neon", label: "Neon tube", offset: 0.08 }),
  U(P, "practical", "point", 1900, -1, "an orange, flickering firelight glow with moving soft shadows", { id: "fire", label: "Fire / flicker", offset: 0.12 }),
];
/** A library unit applied to a light: what it changes. */
export function libraryPatch(u: LibraryUnit, keyStrength = 0.8): Partial<SceneLight> {
  return {
    model: u.id, fixture: u.family, kind: u.kind, beam: u.beam, offset: u.offset ?? 0.32, kelvin: u.kelvin, tint: u.tint ?? 0,
    colour: kelvinHex(u.kelvin, u.tint ?? 0), strength: clamp(keyStrength * 2 ** u.stops, 0.1, 1.5),
  };
}
export const libraryUnit = (id?: string) => (id ? LIBRARY.find((u) => u.id === id) : undefined);

export const ROLES: Record<LightRole, string> = { key: "Key", fill: "Fill", back: "Back", practical: "Practical" };

export const AMBIENT = { dark: 0.3, balanced: 0.65, bright: 0.95 } as const;
export type Ambient = keyof typeof AMBIENT;
export const SWATCHES = ["#ffffff", "#ffe2bf", "#ffb36b", "#ff4fd8", "#4da3ff", "#4dffb8"];
/** The studio's depth relief choices: how far the measured depth is pressed flat. */
export const RELIEF = { soft: 0.15, balanced: 0.35, original: 1 } as const;
export type Relief = keyof typeof RELIEF;
export const MAX_LIGHTS = 4;
/** Reframe's lens and aperture ranges (distance: DOLLY in depth-scene). */
export const FOCAL: [number, number] = [4, 500];
export const FSTOP: [number, number] = [1.2, 16];

/** The guide's long side: enough for a model to follow, small enough to send. */
const GUIDE_EDGE = 1536;
export function guideSize(w: number, h: number) {
  const k = Math.min(1, GUIDE_EDGE / Math.max(w, h));
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

/**
 * A preset unit: where on the photo it hangs (u, v from the top left), the
 * library unit it is, its job, and a gel (colour) or a Kelvin/tint; `level`
 * overrides the library's own (0.1–1.5).
 */
type PresetLight = { u: number; v: number; model: string; role: LightRole; kelvin?: number; tint?: number; colour?: string; level?: number; offset?: number; beam?: number };
/** Film-inspired looks by place (no names), in colour and in black & white, built from the fixture library. */
export const PRESETS: { id: string; place: string; label: string; ambient: Ambient; mono?: boolean; lights: PresetLight[] }[] = [
  { id: "hong-kong-neon-rain", place: "Hong Kong", label: "Neon rain", ambient: "dark", lights: [{ u: 0.12, v: 0.5, model: "neon", role: "practical", colour: "#ff3fd0", level: 1.2, offset: 0.25 }, { u: 0.5, v: 0.04, model: "h12", role: "key", colour: "#5dff8a", level: 1.2, beam: 60 }] },
  { id: "hong-kong-corridor-green", place: "Hong Kong", label: "Corridor green", ambient: "dark", lights: [{ u: 0.5, v: 0.04, model: "h12", role: "key", colour: "#4dff5e", level: 1.4, beam: 70 }, { u: 0.5, v: 0.03, model: "f4b", role: "fill", colour: "#6dff7e", level: 0.8 }] },
  { id: "tokyo-convenience-store", place: "Tokyo", label: "Convenience store", ambient: "bright", lights: [{ u: 0.35, v: 0.04, model: "hp18", role: "key", colour: "#e6fff2", level: 1.2, beam: 70 }, { u: 0.7, v: 0.03, model: "f4b", role: "fill", colour: "#e4fff0", level: 0.6 }] },
  { id: "tokyo-paper-lantern", place: "Tokyo", label: "Paper lantern", ambient: "dark", lights: [{ u: 0.3, v: 0.3, model: "lantern", role: "practical", kelvin: 2700, level: 0.8 }, { u: 0.7, v: 0.28, model: "lantern", role: "practical", kelvin: 2700, level: 0.7 }] },
  { id: "los-angeles-sodium-night", place: "Los Angeles", label: "Sodium night", ambient: "dark", lights: [{ u: 0.06, v: 0.12, model: "hp18", role: "key", colour: "#ff9a3c", level: 1.1, offset: 0.7, beam: 30 }, { u: 0.85, v: 0.4, model: "lsoft", role: "fill", colour: "#3e5fa8", level: 0.2 }] },
  { id: "los-angeles-magic-hour", place: "Los Angeles", label: "Magic hour", ambient: "balanced", lights: [{ u: 0.03, v: 0.45, model: "h18", role: "key", colour: "#ffb36b", level: 1.15, offset: 0.8 }, { u: 0.98, v: 0.35, model: "frame12", role: "fill", kelvin: 7500, level: 0.3 }] },
  { id: "mexico-golden-dust", place: "Mexico", label: "Golden dust", ambient: "bright", lights: [{ u: 0.1, v: 0.15, model: "h18", role: "key", colour: "#ffc24a", level: 1.3, offset: 0.8 }] },
  { id: "mexico-cantina", place: "Mexico", label: "Cantina", ambient: "dark", lights: [{ u: 0.3, v: 0.3, model: "bulb", role: "practical", kelvin: 2400, level: 0.7 }, { u: 0.65, v: 0.3, model: "bulb", role: "practical", kelvin: 2400, level: 0.6 }] },
  { id: "texas-diner-neon", place: "Texas", label: "Diner neon", ambient: "dark", lights: [{ u: 0.1, v: 0.45, model: "neon", role: "practical", colour: "#ff3030", level: 1.1, offset: 0.25 }, { u: 0.9, v: 0.45, model: "neon", role: "practical", colour: "#3f7bff", level: 1.1, offset: 0.25 }] },
  { id: "texas-desert-noon", place: "Texas", label: "Desert noon", ambient: "bright", lights: [{ u: 0.5, v: 0.0, model: "h18", role: "key", kelvin: 5600, level: 1.4, offset: 0.8 }] },
  { id: "russia-winter-window", place: "Russia", label: "Winter window", ambient: "dark", lights: [{ u: 0.02, v: 0.3, model: "frame12", role: "key", colour: "#cfe0ff", level: 0.85 }] },
  { id: "russia-kitchen-lamp", place: "Russia", label: "Kitchen lamp", ambient: "dark", lights: [{ u: 0.5, v: 0.12, model: "bulb", role: "practical", kelvin: 2700, level: 0.9, offset: 0.1 }] },
  { id: "paris-café-night", place: "Paris", label: "Café night", ambient: "dark", lights: [{ u: 0.35, v: 0.35, model: "lamp", role: "practical", kelvin: 2700, level: 0.7 }, { u: 0.9, v: 0.3, model: "hp18", role: "fill", colour: "#7f9fe0", level: 0.35, offset: 0.6 }] },
  { id: "rome-baroque-candle", place: "Rome", label: "Baroque candle", ambient: "dark", lights: [{ u: 0.45, v: 0.85, model: "candle", role: "key", kelvin: 1900, level: 1.0, offset: 0.06 }] },
  { id: "rome-noon-piazza", place: "Rome", label: "Noon piazza", ambient: "bright", lights: [{ u: 0.4, v: 0.0, model: "h18", role: "key", kelvin: 5600, level: 1.3, offset: 0.8 }, { u: 0.5, v: 0.98, model: "frame12", role: "fill", kelvin: 5000, level: 0.35 }] },
  { id: "london-overcast-grey", place: "London", label: "Overcast grey", ambient: "bright", lights: [{ u: 0.5, v: 0.02, model: "frame12", role: "key", kelvin: 6500, level: 0.85 }] },
  { id: "new-york-rembrandt-studio", place: "New York", label: "Rembrandt studio", ambient: "dark", lights: [{ u: 0.25, v: 0.15, model: "t2k", role: "key", kelvin: 3200, level: 1.2, offset: 0.5, beam: 40 }] },
  { id: "studio-3-point", place: "Studio", label: "3-point", ambient: "balanced", lights: [{ u: 0.24, v: 0.28, model: "t2k", role: "key", kelvin: 5600, level: 1, offset: 0.45, beam: 45 }, { u: 0.96, v: 0.4, model: "octa", role: "fill", kelvin: 5600, level: 0.45 }, { u: 0.62, v: 0.1, model: "t1k", role: "back", kelvin: 5600, level: 0.7, beam: 30 }] },
  { id: "studio-silhouette", place: "Studio", label: "Silhouette", ambient: "dark", lights: [{ u: 0.5, v: 0.3, model: "h12", role: "back", kelvin: 5600, level: 1.4 }] },
  { id: "studio-moonlight-blue", place: "Studio", label: "Moonlight blue", ambient: "dark", lights: [{ u: 0.12, v: 0.08, model: "h4", role: "key", colour: "#8fb4ff", level: 0.9, offset: 0.6 }, { u: 0.85, v: 0.4, model: "lsoft", role: "fill", colour: "#4d6fb3", level: 0.18 }] },
  { id: "studio-firelight", place: "Studio", label: "Firelight", ambient: "dark", lights: [{ u: 0.45, v: 0.92, model: "fire", role: "key", colour: "#ff7a1f", level: 1.1, offset: 0.12 }] },
  { id: "new-york-noir-slats", place: "New York", label: "Noir slats", ambient: "dark", mono: true, lights: [{ u: 0.75, v: 0.08, model: "t5k", role: "key", kelvin: 4300, level: 1.45, offset: 0.6, beam: 22 }] },
  { id: "paris-nouvelle-vague-daylight", place: "Paris", label: "Nouvelle vague daylight", ambient: "bright", mono: true, lights: [{ u: 0.02, v: 0.25, model: "frame12", role: "key", kelvin: 5600, level: 0.9 }] },
  { id: "rome-neorealist-street", place: "Rome", label: "Neorealist street", ambient: "balanced", mono: true, lights: [{ u: 0.4, v: 0.0, model: "h18", role: "key", kelvin: 5600, level: 1.1, offset: 0.8 }] },
  { id: "tokyo-high-contrast-alley", place: "Tokyo", label: "High-contrast alley", ambient: "dark", mono: true, lights: [{ u: 0.85, v: 0.1, model: "hp4", role: "key", kelvin: 5600, level: 1.4, offset: 0.6, beam: 20 }] },
  { id: "moscow-winter-interior", place: "Moscow", label: "Winter interior", ambient: "dark", mono: true, lights: [{ u: 0.02, v: 0.3, model: "frame12", role: "key", colour: "#cfe0ff", level: 0.9 }, { u: 0.6, v: 0.15, model: "bulb", role: "practical", kelvin: 2700, level: 0.5 }] },
  { id: "studio-hard-key", place: "Studio", label: "Hard key", ambient: "dark", mono: true, lights: [{ u: 0.25, v: 0.15, model: "t2k", role: "key", kelvin: 5600, level: 1.3, offset: 0.5, beam: 35 }] },
  { id: "studio-soft-key", place: "Studio", label: "Soft key", ambient: "balanced", mono: true, lights: [{ u: 0.04, v: 0.3, model: "octa", role: "key", kelvin: 5600, level: 1.0 }] },
  { id: "studio-rim-only", place: "Studio", label: "Rim only", ambient: "dark", mono: true, lights: [{ u: 0.5, v: 0.3, model: "t1k", role: "back", kelvin: 5600, level: 1.2 }] },
];

/** The longest throw a preset gives each family (scene heights): big soft sources sit back on the set's edges. */
const PRESET_THROW: Partial<Record<Fixture, number>> = { softbox: 0.08, led: 0.1, practical: 0.08, fresnel: 0.16, openface: 0.16, hmi: 0.18 };

/** Spots and the sun point at the middle of the picture, where the subject usually is. */
const middle = (s: DepthSurface) => surfacePoint(s, 0.5, 0.55).anchor;

/** A preset's lights hung on this surface (back units behind the subject). */
export function presetLights(s: DepthSurface, id: string): { lights: SceneLight[]; ambient: Ambient } | null {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return null;
  const aim = middle(s);
  const lights = preset.lights.map((l, i): SceneLight => {
    const u = LIBRARY.find((x) => x.id === l.model)!;
    const lib = libraryPatch(u);
    const kelvin = l.colour ? undefined : l.kelvin ?? u.kelvin;
    const unit: SceneLight = {
      id: `l${Date.now()}${i}`, ...surfacePoint(s, l.u, l.v), ...lib, role: l.role,
      kelvin, tint: l.tint ?? lib.tint, colour: l.colour ?? kelvinHex(kelvin!, l.tint ?? lib.tint ?? 0),
      // On the set, never between the lens and the subject: a short throw off the surface it hangs on.
      strength: l.level ?? lib.strength!, offset: Math.min(PRESET_THROW[u.family] ?? 0.16, l.offset ?? lib.offset!), beam: u.kind === "spot" ? l.beam ?? u.beam : undefined,
      aim: u.kind === "point" ? undefined : aim,
    };
    return l.role === "back" ? { ...unit, ...behindSubject(s, unit) } : unit;
  });
  return { lights, ambient: preset.ambient };
}

/** How far out from its surface a light hangs, by name. */
export const LIGHT_DISTANCE = { close: 0.08, normal: 0.32, far: 0.6 } as const;

/** A light as an agent describes it: where on the photo (0..1 from the top left) and what it is like. */
export interface LightSpec {
  x: number;
  y: number;
  kind?: LightKind;
  colour?: string;
  /** 0.1 (gentle) – 1.5 (very strong, hard). */
  strength?: number;
  /** "close" | "normal" | "far", or the studio's offset 0.03–0.8 in scene widths. */
  distance?: keyof typeof LIGHT_DISTANCE | number;
  /** Spot: full cone angle, degrees. */
  beam?: number;
  /** Spot / Sun: the photo point it is aimed at (default: the middle). */
  aim?: { x: number; y: number };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const HEX = /^#[0-9a-f]{6}$/i;

/** One light hung on the surface from an agent's description. */
export function lightFromSpec(s: DepthSurface, spec: LightSpec, i: number): SceneLight {
  const x = Number(spec.x), y = Number(spec.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error(`Light ${i + 1}: x and y are the point on the photo it hangs over, 0..1 from the top left`);
  }
  const kind: LightKind = spec.kind === "spot" || spec.kind === "sun" ? spec.kind : "point";
  const distance = spec.distance ?? (kind === "sun" ? "far" : "normal");
  const offset = typeof distance === "number" ? clamp(distance, 0.03, 0.8) : LIGHT_DISTANCE[distance] ?? LIGHT_DISTANCE.normal;
  const colour = typeof spec.colour === "string" && HEX.test(spec.colour) ? spec.colour : i === 0 ? "#ffe2bf" : SWATCHES[(i * 3) % SWATCHES.length];
  const aim = kind === "point" ? undefined : spec.aim ? surfacePoint(s, clamp(Number(spec.aim.x), 0, 1), clamp(Number(spec.aim.y), 0, 1)).anchor : middle(s);
  return {
    id: `l${i}`, ...surfacePoint(s, x, y), kind, colour, offset, aim,
    strength: clamp(Number(spec.strength ?? (i === 0 ? 0.8 : 0.5)), 0.1, 1.5),
    beam: kind === "spot" ? clamp(Number(spec.beam ?? 35), 10, 120) : undefined,
  };
}

/** A light in words for the model: where it stands round the subject, not where it hangs. */
export function describeLight(position: Vec3, pivot: number, l: SceneLight): StudioLight {
  const [x, y, z] = [position[0], position[1], position[2] + pivot];
  const azimuth = ((Math.atan2(x, z) * 180) / Math.PI + 360) % 360;
  const elevation = (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;
  const distance = l.offset < 0.12 ? 0.6 : l.offset > 0.45 ? 1.6 : 1;
  return { azimuth, elevation, colour: l.colour, strength: l.strength, distance, kind: l.kind ?? "point", beam: l.beam, fixture: libraryUnit(l.model)?.words ?? (l.fixture ? FIXTURES[l.fixture].words : undefined), flash: libraryUnit(l.model)?.flash, kelvin: l.kelvin, role: l.role };
}

/** Where a point on the set is in the photo's frame, in words ("upper left"). */
function inFrame(s: DepthSurface, p: Vec3) {
  const tanY = Math.tan((s.fovY * Math.PI) / 360), depth = Math.max(1e-4, -p[2]);
  const u = 0.5 + p[0] / depth / (2 * tanY * s.aspect), v = 0.5 - p[1] / depth / (2 * tanY);
  const row = v < 0.34 ? "upper" : v > 0.66 ? "lower" : "middle";
  const col = u < 0.34 ? "left" : u > 0.66 ? "right" : "centre";
  return row === "middle" && col === "centre" ? "centre" : row === "middle" ? `middle ${col}` : `${row} ${col === "centre" ? "middle" : col}`;
}

/** What Relight sends: the lights described, the ambient level and the prompt. */
export function relightParams(s: DepthSurface, lights: SceneLight[], ambient: Ambient, prompt: string): ParamValues {
  const described = lights.map((l) => {
    const at = lightPoint(s, l);
    // A back light is told round the subject it rims (its aim), not round the set's middle.
    const subject = l.role === "back" ? l.aim ?? (l.dir ? l.anchor : null) : null;
    const position: Vec3 = subject ? [at[0] - subject[0], at[1] - subject[1], at[2] - subject[2] - s.pivot] : at;
    const d = describeLight(position, s.pivot, l);
    return l.role === "practical" ? { ...d, frame: inFrame(s, l.anchor) } : d;
  });
  return { lights: JSON.stringify(described), ambient, prompt: prompt.trim() };
}

const DEG = Math.PI / 180;
/**
 * A back light's place: behind the subject as the camera sees it (about 145°
 * round), raised 35° and kept on the side it came from — so it rims the
 * subject's edge instead of hiding straight behind it. It hangs off the
 * subject (`anchor` + `dir`), so its throw is its distance to the subject.
 */
export function behindSubject(s: DepthSurface, l: SceneLight): Pick<SceneLight, "anchor" | "dir" | "offset" | "aim"> {
  const subject = l.aim ?? middle(s);
  const [sx, , sz] = subject;
  const h = Math.hypot(sx, sz) || 1;
  // Away from the camera through the subject, and its right, both level.
  const fx = sx / h, fz = sz / h, rx = -fz, rz = fx;
  const side = lightPoint(s, l)[0] >= sx ? 1 : -1;
  const el = 35 * DEG, round = 35 * DEG;
  const back = Math.cos(el) * Math.cos(round), across = Math.cos(el) * Math.sin(round) * side;
  const dir: Vec3 = [fx * back + rx * across, Math.sin(el), fz * back + rz * across];
  // As far back as the set allows: still in front of whatever lies behind the subject, never inside a wall.
  const tanY = Math.tan((s.fovY * Math.PI) / 360);
  const clear = (offset: number) => {
    const p = subject.map((v, k) => v + dir[k] * offset * s.scale);
    const depth = Math.max(1e-4, -p[2]);
    const u = 0.5 + p[0] / depth / (2 * tanY * s.aspect), v = 0.5 - p[1] / depth / (2 * tanY);
    if (u < 0 || u > 1 || v < 0 || v > 1) return true;
    const wall = surfacePoint(s, u, v).anchor[2];
    // The subject itself (or something nearer) is in front of it there: hidden behind the subject, as a back light is.
    return wall > sz - 0.02 * s.scale || p[2] > wall + 0.03 * s.scale;
  };
  let offset = 0.06;
  for (let o = 0.45; o > 0.06; o -= 0.03) if (clear(o)) { offset = o; break; }
  return { anchor: subject, dir, offset, aim: subject };
}

const RECOVER_DETAIL = "Restore natural sharp detail in the already blurred background. Use deep depth of field, keeping the scene, identities and composition unchanged. Reconstruct plausible fine texture without sharpening halos.";

/**
 * What Reframe sends for this camera, and what the studio shows about it:
 * whether the camera left what the lens saw (`beyond` — then there is no
 * honest 3D view to send), and whether anything moved at all.
 */
export function reframeSetup(s: DepthSurface | null, cam: SceneCamera, o: { fstop: number | null; aspect: string; recoverDetail: boolean; prompt: string }) {
  const base = s?.baseFocal ?? BASE_FOCAL;
  const lensMoved = cam.focal != null && Math.abs(cam.focal - base) > 1;
  const dolly = cam.dolly ?? 1;
  const flown = Math.abs(Math.log(dolly)) > 0.03;
  const turned = Math.abs(cam.azimuth) >= 2 || Math.abs(cam.elevation) >= 2;
  const reach = s ? orbitLimits(s) : { azimuth: 20, elevation: 10 };
  const beyond = Math.abs(cam.azimuth) > reach.azimuth + 0.5 || Math.abs(cam.elevation) > reach.elevation + 0.5;
  const optical = s ? lens(s, cam) : null;
  const cameraDistance = optical && s ? optical.r / s.pivot : dolly;
  const fieldOfView = optical?.fovY;
  const params: ParamValues = {
    camera: JSON.stringify({ azimuth: cam.azimuth, elevation: cam.elevation, focal: Math.round(cam.focal ?? base), lens: lensMoved, beyond, dolly: Math.round(dolly * 100) / 100, cameraDistance: Math.round(cameraDistance * 100) / 100, fieldOfView, framingScale: (cam.focal ?? base) / base / cameraDistance }),
    focus: o.fstop != null ? JSON.stringify({ fstop: Math.round(o.fstop * 10) / 10 }) : "",
    prompt: [o.recoverDetail ? RECOVER_DETAIL : "", o.prompt.trim()].filter(Boolean).join(" "), ratio: o.aspect,
  };
  const moved = turned || lensMoved || flown || o.fstop != null || o.aspect !== "source" || o.recoverDetail;
  return { params, base, lensMoved, dolly, flown, turned, reach, beyond, cameraDistance, fieldOfView, moved };
}
