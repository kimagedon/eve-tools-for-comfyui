/**
 * Extend canvas geometry: how much room each side of the photo grows by, as
 * fractions of the source, and the pixel canvas that follows from it.
 */
export type ParamValues = Record<string, number | boolean | string>;

/**
 * The canvas an extension aims for: the source widened or heightened to
 * `ratio`, then grown by `room` on every side, the source centred.
 */
export function extendCanvas(width: number, height: number, ratio: string, room: number) {
  let w = width, h = height;
  if (ratio !== "source") {
    const [a, b] = ratio.split(":").map(Number);
    const target = a / b;
    if (target > width / height) w = Math.round(height * target);
    else h = Math.round(width / target);
  }
  w = Math.round(w * (1 + room));
  h = Math.round(h * (1 + room));
  if (w <= width && h <= height) throw new Error("Pick another shape or add room — nothing to extend");
  return { width: w, height: h, x: Math.round((w - width) / 2), y: Math.round((h - height) / 2) };
}

/**
 * Room added per side as fractions of the source ("left,top,right,bottom"),
 * drawn by hand in the Extend editor. Fractions, not pixels, so the layout
 * holds for whatever size the original turns out to be.
 */
export type ExtendSides = { left: number; top: number; right: number; bottom: number };
export const encodeSides = (s: ExtendSides) => [s.left, s.top, s.right, s.bottom].map((v) => Math.max(0, v).toFixed(5)).join(",");
export function decodeSides(text: string): ExtendSides | null {
  const v = text.split(",").map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return { left: v[0], top: v[1], right: v[2], bottom: v[3] };
}

/** The canvas for an Extend run: the editor's drawn sides when present, else shape + room. */
export function extendLayout(v: ParamValues, width: number, height: number) {
  const sides = typeof v.sides === "string" ? decodeSides(v.sides) : null;
  if (!sides) return extendCanvas(width, height, String(v.ratio), Number(v.room));
  const x = Math.round(sides.left * width), y = Math.round(sides.top * height);
  const w = width + x + Math.round(sides.right * width), h = height + y + Math.round(sides.bottom * height);
  if (w <= width && h <= height) throw new Error("Drag an edge outward — nothing to extend");
  return { width: w, height: h, x, y };
}

