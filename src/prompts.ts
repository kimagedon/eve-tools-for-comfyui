/**
 * Every word the edit model is told. Lights and cameras are placed by hand in
 * 3D; these turn that setup into plain language that rides along with the
 * 3D guide image.
 */

/** What an edit model is told when it fills an Extend canvas. */
export function fillPrompt(extra: unknown): string {
  const add = String(extra ?? "").trim();
  return "Outpaint this image. The flat grey areas around the photo are empty canvas. "
    + "Fill all of the grey with a seamless, natural continuation of the photo's scene — same style, lighting, perspective, grain and level of detail, so no edge or seam is visible. "
    + "Do not change, move or rescale the existing photo. Leave no grey, borders or frames."
    + (add ? ` In the new area: ${add}` : "");
}
/** Extend through the inpainting graph: the model only sees the clean photo, so it is asked for a wider view of it. */
export function widenPrompt(extra: unknown): string {
  const add = String(extra ?? "").trim();
  return "A wider view of the same place: continue the scene naturally beyond the original frame — "
    + "same architecture, light sources, lighting, perspective, colour grade, lens and film grain. Continue the space outward with new, plausible content; never repeat, tile or mirror the original picture, and keep surfaces (floors, roads, walls) as the same material with the same texture scale. Photorealistic and seamless, no borders, no text, no people."
    + (add ? ` Beyond the frame: ${add}` : "");
}
/** What an edit model is told when it fills an Inpaint area. */
export function inpaintPrompt(what: unknown): string {
  const want = String(what ?? "").trim();
  return "The flat grey area in this photo is a hole to fill. "
    + (want ? `Fill it with: ${want}. ` : "Fill it so it blends in naturally. ")
    + "Match the photo's style, lighting, perspective, grain and detail so no edge is visible. Change nothing outside the grey area. Leave no grey.";
}

export interface StudioLight {
  azimuth: number;
  elevation: number;
  colour: string;
  strength: number;
  /** 0.5 (right up against the subject) – 2 (far away); 1 = a usual studio distance. */
  distance?: number;
  kind?: "point" | "spot" | "sun";
  /** Spot: full cone angle, degrees. */
  beam?: number;
  /** The unit, as the gaffer names it (Fresnel, HMI…). */
  fixture?: string;
  kelvin?: number;
  role?: "key" | "fill" | "back" | "practical";
  /** A flash / strobe unit: the photo reads flash-lit. */
  flash?: boolean;
  /** A practical: where its source is in the frame ("upper left"). */
  frame?: string;
}

/** Plain-language direction of a point on the orbit, seen from the camera. */
export function orbitDirection(azimuth: number, elevation: number): string {
  const a = ((azimuth % 360) + 360) % 360;
  const side = a < 22.5 || a >= 337.5 ? "from the front (the camera side)"
    : a < 67.5 ? "from the front right" : a < 112.5 ? "from the right side" : a < 157.5 ? "from behind on the right"
      : a < 202.5 ? "from directly behind the subject" : a < 247.5 ? "from behind on the left" : a < 292.5 ? "from the left side" : "from the front left";
  const height = elevation >= 70 ? "almost straight overhead" : elevation >= 40 ? "high above" : elevation >= 15 ? "slightly above" : elevation >= -3 ? "at eye level" : "from below";
  return `${side}, ${height} (azimuth ${Math.round(a)}°, elevation ${Math.round(elevation)}°)`;
}

export function colourWords(hex: string): string {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  if ([r, g, b].some((n) => !Number.isFinite(n))) return "white";
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 28) return `neutral white (${hex})`;
  const name = r >= g && r >= b ? (g > b + 40 ? "warm amber" : b > g + 30 ? "magenta" : "warm red-orange")
    : g >= r && g >= b ? (b > r ? "teal-green" : "green") : (r > g ? "violet" : "cool blue");
  return `${name} (${hex})`;
}

/** `guide`: "pair" — a 3D preview of the setup is sent as image 2. */
export function relightPrompt(lightsJson: unknown, ambient: unknown, extra: unknown, guide?: unknown): string {
  let lights: StudioLight[] = [];
  try { lights = JSON.parse(String(lightsJson ?? "[]")) as StudioLight[]; } catch { /* none */ }
  const sorted = [...lights].sort((a, b) => b.strength - a.strength);
  const role = (l: StudioLight, i: number) => {
    if (l.role) return { key: "Key light", fill: "Fill light", back: "Rim / back light", practical: "Practical light" }[l.role];
    const a = ((l.azimuth % 360) + 360) % 360;
    if (a > 135 && a < 225) return "Rim / back light";
    return i === 0 ? "Key light" : i === 1 ? "Fill light" : "Accent light";
  };
  const power = (s: number) => (s >= 1.1 ? "very strong, hard" : s >= 0.75 ? "strong, hard" : s >= 0.45 ? "medium, soft" : "gentle, very soft");
  // Never "placed very close" alone: told that, the model draws the unit into the picture.
  const reach = (d = 1) => (d <= 0.75 ? ", close to the subject yet out of shot (the source itself is never visible): a bright pool of light with fast falloff and deep contrast"
    : d >= 1.4 ? ", far away: broad, even light with long, parallel shadows" : "");
  const source = (l: StudioLight) => l.kind === "spot" ? `spotlight (a ${Math.round(l.beam ?? 35)}° cone with a soft edge, a defined pool of light and darkness outside it)`
    : l.kind === "sun" ? "sunlight (parallel, hard-edged light with crisp, long shadows)" : "light";
  const tone = (l: StudioLight) => l.kelvin ? `${Math.round(l.kelvin)} K ${l.kelvin < 4000 ? "warm tungsten" : l.kelvin > 6500 ? "cool daylight" : "daylight"} (${l.colour})` : colourWords(l.colour);
  const unit = (l: StudioLight) => `${source(l)}${l.fixture ? ` — ${l.fixture}` : ""}`;
  // A practical is a source the scene already shows: where it is in the frame, and that it glows there.
  const practical = (l: StudioLight) => l.role === "practical";
  const place = (l: StudioLight) => practical(l)
    ? `from a light source already visible in the frame${l.frame ? ` (${l.frame})` : ""}: a motivated light — that lamp or bulb glows and casts a small, soft, warm pool with quick falloff around itself`
    : `${orbitDirection(l.azimuth, l.elevation)}${l.kind === "sun" ? "" : reach(l.distance)}${l.role === "back" ? ", drawing a thin bright rim along the subject's edges that separates it from the background" : ""}`;
  const rig = sorted.map((l, i) => `${role(l, i)}: ${power(l.strength)} ${tone(l)} ${practical(l) ? "practical glow" : unit(l)} ${place(l)}.`).join(" ");
  const hasPractical = lights.some(practical);
  const mood = ambient === "dark" ? "The rest of the scene falls into deep, moody shadow." : ambient === "bright" ? "The scene stays bright and airy, with lifted shadows." : "Balanced overall exposure.";
  const add = String(extra ?? "").trim();
  const pair = guide === "pair";
  return `Relight ${pair ? "image 1" : "this photo"}. Change only the lighting — keep the subject, identity, pose, composition, framing, materials, colours of objects and background exactly as they are. `
    + `Lighting setup: ${rig} ${mood} `
    + (lights.some((l) => l.flash) ? "Flash-lit: a frozen, crisp moment with clean specular catchlights and no motion blur. " : "")
    + "Shadows, highlights, reflections and colour spill must follow these light positions physically, as if the photo had been shot under this setup. "
    + (hasPractical
      ? "The practical light is a source already in the photo: it glows where it is, nothing new is added for it. Every other lighting unit is off camera, outside the frame: show only the light it casts. "
      : "All lighting units are off camera, outside the frame: show only the light they cast. ")
    + "The light sources are outside the frame: never add lamps, light panels, softboxes, bounce cards, diffusion frames, umbrellas, reflectors, stands, cables or any other object — the set dressing stays exactly as it is. "
    + "The sky stays sky and the far background stays as it is: no glowing shape, panel or lamp appears in it, and only light falls on the scene."
    + (pair ? " Image 2 is a rough 3D preview of exactly this setup on the same scene: match where its light pools fall, their colours, their falloff and the direction of its shadows (its bright areas are light falling on surfaces, never objects) — but take every detail, texture and the photographic quality from image 1. The result is image 1, relit; never copy image 2's flat, plastic look." : "")
    + (add ? ` Also: ${add}` : "");
}

/** A lens in words: how it draws, not just its number. */
export function lensWords(focal: number): string {
  if (focal <= 8) return `an EXTREME ${focal} mm ultra-wide fisheye lens: an unmistakable, dramatic fisheye effect, sweeping panoramic coverage, strongly curved lines near the borders, pronounced edge stretching and a tiny distant background; do not soften this into an ordinary wide-angle photograph`;
  if (focal >= 300) return `an EXTREME ${focal} mm super-telephoto lens: an unmistakable super-telephoto effect with an exceptionally narrow field of view, powerful optical magnification and tightly isolated detail; when the specified camera position is far away, show strongly flattened depth and stacked background planes; do not substitute an ordinary portrait-lens look`;
  if (focal <= 16) return `a ${focal} mm ultra-wide lens: very wide field of view, with visible barrel distortion`;
  if (focal <= 24) return `a ${focal} mm wide-angle lens: wide field of view, slight barrel distortion`;
  if (focal <= 40) return `a ${focal} mm lens: slightly wide field of view`;
  if (focal <= 70) return `a ${focal} mm standard lens: standard field of view`;
  if (focal <= 120) return `a ${focal} mm short telephoto lens: narrow field of view and optical magnification`;
  return `a ${focal} mm long telephoto lens: very narrow field of view and strong optical magnification`;
}

/** `guide`: "pair" — the 3D re-projection is image 1, the photo image 2; "alone" — only the re-projection is sent. */
export function reframePrompt(cameraJson: unknown, extra: unknown, guide?: unknown, focusJson?: unknown, compact = false): string {
  let cam = { azimuth: 0, elevation: 0, zoom: 1, focal: 0, lens: false, dolly: 1, cameraDistance: 0, fieldOfView: 0, framingScale: 1 };
  try { cam = { ...cam, ...(JSON.parse(String(cameraJson ?? "{}")) as Partial<typeof cam>) }; } catch { /* front */ }
  let focus: { fstop: number } | null = null;
  try { focus = focusJson ? (JSON.parse(String(focusJson)) as { fstop: number }) : null; } catch { /* none */ }
  const a = cam.azimuth; // + = the camera moved to its right
  const turn = Math.abs(a) < 2 ? "stays in front of the scene" : `swings ${Math.round(Math.abs(a))}° round the scene to the ${a > 0 ? "right" : "left"}`;
  const rise = Math.abs(cam.elevation) < 2 ? "at the same height" : cam.elevation > 0 ? `rising ${Math.round(cam.elevation)}° and looking down` : `dropping ${Math.round(-cam.elevation)}° and looking up`;
  const resolvedDistance = Number(cam.cameraDistance);
  const d = Number.isFinite(resolvedDistance) && resolvedDistance > 0 ? resolvedDistance : Number(cam.dolly) || 1;
  const fly = Math.abs(Math.log(d)) < 0.05 ? "" : d < 1 ? `, moving in to about ${Math.round(d * 100)}% of the original distance (closer)` : `, pulling back to about ${d.toFixed(1)}× the original distance (farther)`;
  const zoom = fly + (cam.lens && cam.focal ? `, shot on ${lensWords(cam.focal)} (35 mm-equivalent focal length)` : "")
    + (cam.lens ? ", keep the camera at the specified position: do not automatically move backward to preserve the original subject size" : "")
    + (cam.framingScale > 1.05 ? `, optical framing approximately ${cam.framingScale.toFixed(1)}× tighter than the source: crop into the scene accordingly, even if only a small detail remains in frame; do not fit the whole subject back into the image` : cam.framingScale > 0 && cam.framingScale < 0.95 ? `, framing approximately ${(1 / cam.framingScale).toFixed(1)}× wider than the source` : "")
    + (cam.fieldOfView > 0 && cam.fieldOfView < 180 ? `, vertical field of view approximately ${cam.fieldOfView.toFixed(1)} degrees` : "")
    + (focus ? `, with a shallow depth of field at f/${focus.fstop}: what is in focus in the guide stays crisp, everything nearer or farther falls off into soft, natural bokeh` : "");
  const add = String(extra ?? "").trim();
  if (compact) {
    const source = guide === "pair" ? "Match image 1 camera/framing; image 2 supplies identity, textures and lighting. Repair grey holes and stretched edges."
      : guide === "alone" ? "Keep this guide viewpoint/framing; repair grey holes and stretched edges."
        : "Rephotograph the same scene; preserve identity, materials, lighting and style. Reveal hidden parts consistently.";
    const optics = !cam.lens || !cam.focal ? "" : cam.focal <= 8
      ? `EXTREME ${cam.focal}mm fisheye: panoramic view, curved lines, strong edge stretching.`
      : cam.focal >= 300 ? `EXTREME ${cam.focal}mm super-telephoto: tiny field of view, powerful magnification; far backgrounds appear stacked.`
        : `${cam.focal}mm lens (35mm equivalent).`;
    const framing = cam.framingScale > 1.05 ? `Crop ${cam.framingScale.toFixed(1)}x tighter; allow detail-only framing.`
      : cam.framingScale > 0 && cam.framingScale < 0.95 ? `Frame ${(1 / cam.framingScale).toFixed(1)}x wider.` : "";
    const parts = [source, `Camera ${Math.round(Math.abs(a))}deg ${a >= 0 ? "right" : "left"}, ${Math.round(Math.abs(cam.elevation))}deg ${cam.elevation >= 0 ? "above" : "below"}; distance ${d.toFixed(2)}x original.`, optics,
      cam.lens ? "Keep that distance; no automatic retreat to fit the subject." : "", framing,
      cam.fieldOfView > 0 ? `Vertical FOV ${cam.fieldOfView.toFixed(1)}deg.` : "", focus ? `f/${focus.fstop}: keep guide focus, natural bokeh elsewhere.` : "", add];
    const result = parts.filter(Boolean).join(" ");
    return result;
  }
  const fix = "Flat grey areas are parts the original camera never saw; smeared or stretched streaks and torn edges are artefacts of the reprojection. "
    + "Keep the viewpoint, perspective, framing and the position and size of everything exactly as shown, fill every grey area with a natural, seamless continuation of the scene, and repair the stretched and torn parts. ";
  if (guide === "pair") {
    return `Image 1 is a rough 3D re-projection of image 2 (the original photo) from a new camera position: the camera ${turn}, ${rise}${zoom}. ${fix}`
      + "Take every person, object, identity, texture, colour and the lighting from image 2. Image 2 is the set: fill every grey area consistently with it — the same walls, floor, sky, materials and light continuing naturally — never flat grey, never a new room. The result is a clean, real photograph of image 2's scene from image 1's viewpoint, with no grey left."
      + (add ? ` Also: ${add}` : "");
  }
  if (guide === "alone") {
    return `This image is a rough 3D re-projection of a photo seen from a new camera position (the camera ${turn}, ${rise}${zoom}). ${fix}`
      + "Same style, colours and lighting. Fill the grey areas naturally as the same place continuing, never as flat grey or a blank wall. The result is a clean, real photograph from exactly this viewpoint, with no grey left."
      + (add ? ` Also: ${add}` : "");
  }
  const far = Math.abs(a) > 100 ? " The camera is now on the far side, looking back at the scene from behind: everything the original camera never saw — the backs of objects and people, the other side of the room — must be invented to match what is visible, in the same place, scale and style."
    : Math.abs(a) > 40 ? " Much of what the camera now sees was hidden in the photo: build it to match the visible parts exactly." : "";
  return `Show exactly the same scene from a new camera position: the camera ${turn}, ${rise}${zoom}.${far} `
    + "Keep every person, object, identity, clothing, lighting, colours and style identical; reveal newly visible parts consistently with the scene. Same image quality, a real photograph from the new viewpoint."
    + (add ? ` Also: ${add}` : "");
}

// ── Series ─────────────────────────────────────────────────────────
// One photo → a set of different frames from the same shoot. Every frame is
// one of these directions; style fidelity is the whole point of the prompt.
export type SeriesShot = { group: "distance" | "height" | "side" | "moment" | "framing"; text: string };

/** Every direction says where the camera stands and how the frame is cut — concrete enough that no two look alike. */
export const SERIES_SHOTS: SeriesShot[] = [
  { group: "distance", text: "a wide establishing shot: the camera steps far back (about 3× the distance) to show the whole space and its surroundings, the subject small" },
  { group: "distance", text: "a tight close-up: the camera comes right in, the subject's face or main detail filling most of the frame" },
  { group: "distance", text: "an extreme close-up of one telling detail — hands, a texture, an object — nothing else in frame" },
  { group: "distance", text: "a medium shot from waist height, a natural, intimate distance" },
  { group: "distance", text: "from far away with a long lens: strongly compressed perspective, the background pulled right behind the subject" },
  { group: "distance", text: "very close with a wide lens: immersive, the nearest things looming large in the foreground" },
  { group: "height", text: "a low angle from near the floor, looking up at the subject" },
  { group: "height", text: "a high angle from above head height, looking down at the scene" },
  { group: "height", text: "a straight top-down view, the camera directly overhead" },
  { group: "height", text: "a worm's-eye view at ground level, the floor in the foreground" },
  { group: "side", text: "from the subject's left side, about 90° round from the original camera: a clean profile" },
  { group: "side", text: "from the subject's right side, about 90° round from the original camera: a clean profile" },
  { group: "side", text: "from the front of the subject, facing it — the side the original camera did not see" },
  { group: "side", text: "from directly behind the subject, looking past it at what it faces" },
  { group: "side", text: "from the opposite side of the space, about 180° round, looking back towards where the original camera stood" },
  { group: "side", text: "the reverse shot: turning round to show what was behind the original camera" },
  { group: "moment", text: "a candid moment a few minutes later: the subject has changed pose naturally — looking up, stretching, turning" },
  { group: "moment", text: "the same place later in the day: the light lower and warmer, longer shadows" },
  { group: "moment", text: "towards dusk: softer, bluer light, lamps starting to glow" },
  { group: "moment", text: "a moment just before the original: arriving, settling in, getting ready" },
  { group: "moment", text: "a moment of movement: the subject caught mid-gesture with a little motion blur, the setting sharp" },
  { group: "moment", text: "a quiet moment when the light softens, as if a cloud passed: gentle, even light" },
  { group: "framing", text: "shot through something in the foreground — a doorway, a plant, a shelf — softly out of focus, framing the subject" },
  { group: "framing", text: "a reflection of the scene in a window, mirror or glossy surface" },
  { group: "framing", text: "what lies just to the left, outside the original frame, the subject at the right edge" },
  { group: "framing", text: "what lies just to the right, outside the original frame, the subject at the left edge" },
  { group: "framing", text: "a secondary object or corner of the space as the subject, the main subject soft in the background" },
  { group: "framing", text: "the environment dominating, the subject small and off to one side" },
  { group: "framing", text: "a centred, symmetrical composition, the camera square-on" },
  { group: "framing", text: "an off-centre composition with generous negative space" },
  { group: "framing", text: "a slightly tilted, handheld documentary framing" },
  { group: "framing", text: "backlit against the brightest light in the scene, the subject edged with light" },
  { group: "framing", text: "with blurred elements close to the lens framing the subject, very shallow depth of field" },
  { group: "framing", text: "looking through a window or opening between two spaces" },
  { group: "framing", text: "partly hidden behind an edge or a doorframe, as if glimpsed" },
  { group: "framing", text: "from a natural standing height a few metres to one side, as if a second photographer stood nearby" },
];

