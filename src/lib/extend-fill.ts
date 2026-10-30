/**
 * Extend through an edit model, for images the outpaint models decline.
 *
 * Bria Expand and FLUX Outpaint run their own moderation inside the model
 * and answer some images with the new area left empty (flat grey /
 * magenta). An edit model can do the same job when it is shown the job:
 *
 * 1. `prepareFillCanvas` — the canvas the user drew, the original in its
 *    place and the new room flat neutral grey. (Blurred margins were tried
 *    first: edit models read blur as part of the picture — bokeh — and
 *    keep it.)
 * 2. The edit model is asked to fill the grey with scene.
 * 3. `compositeFill` — an edit model redraws the whole picture and moves
 *    or rescales the original a little, so the original is first FOUND in
 *    the answer (scale + offset search on small grey copies), then laid
 *    back exactly there with a soft seam. Laying it where the canvas said
 *    doubled walls and edges wherever the model had shifted them.
 *
 * Edit models draw only a fixed set of ratios. A drawn canvas between two
 * of them (1.68 when the model has 16:9 and 3:2) made the model reframe the
 * whole scene to fit, so the original could no longer be found. The canvas
 * sent is therefore grown with grey to the nearest ratio the model draws
 * (`padToRatio`) and the answer is cropped back to the drawn canvas.
 *
 * Browser-only (canvas), apart from `padToRatio` and the search helpers.
 * The layout itself is `extendLayout` in tools.ts.
 */
import { extendLayout, type ParamValues } from "./extend";
import { drawBlurred } from "./canvas-blur";

/** Edit models answer around 2K; a bigger upload only costs time. */
const SEND_EDGE = 2048;
/** The finished file may be larger than what the model returned. */
const OUT_EDGE = 4096;
/** The neutral the model is told to fill. */
export const FILL_GREY = "#808080";

function canvas2d(w: number, h: number) {
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

type Layout = { width: number; height: number; x: number; y: number };

/**
 * The drawn canvas grown, centred, to the ratio among `ratios` that needs
 * the least extra room. `x`/`y` are where the drawn canvas sits inside it.
 * No usable ratios: the canvas as it is.
 */
export function padToRatio(c: { width: number; height: number }, ratios: readonly string[] = []): Layout {
  const own = c.width / c.height;
  let best: Layout = { width: c.width, height: c.height, x: 0, y: 0 };
  let bestArea = Infinity;
  for (const ratio of ratios) {
    const [a, b] = ratio.split(":").map(Number);
    if (!(a > 0 && b > 0)) continue;
    const r = a / b;
    const width = r >= own ? Math.round(c.height * r) : c.width;
    const height = r >= own ? c.height : Math.round(c.width / r);
    const area = width * height;
    if (area < bestArea) {
      bestArea = area;
      best = { width, height, x: Math.round((width - c.width) / 2), y: Math.round((height - c.height) / 2) };
    }
  }
  return best;
}

/** The drawn canvas, the padded one sent to the model, and the original's place in the padded one. */
function fillLayout(values: ParamValues, width: number, height: number, ratios?: readonly string[]) {
  const c = extendLayout(values, width, height);
  const pad = padToRatio(c, ratios);
  return { c, pad, placed: { width: pad.width, height: pad.height, x: pad.x + c.x, y: pad.y + c.y } };
}

/** `ratios`: what the model draws — the canvas is grown to the nearest of them. */
export async function prepareFillCanvas(source: Blob, values: ParamValues, ratios?: readonly string[]): Promise<Blob> {
  const bmp = await createImageBitmap(source);
  try {
    const { placed } = fillLayout(values, bmp.width, bmp.height, ratios);
    const k = Math.min(1, SEND_EDGE / Math.max(placed.width, placed.height));
    const { canvas, ctx } = canvas2d(placed.width * k, placed.height * k);
    ctx.fillStyle = FILL_GREY;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, placed.x * k, placed.y * k, bmp.width * k, bmp.height * k);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bmp.close();
  }
}

/** Luminance of an image drawn at w×h. */
function grey(src: CanvasImageSource, w: number, h: number): Float32Array {
  const { ctx } = canvas2d(w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return out;
}

/**
 * Where the original sits in the model's answer, in answer pixels.
 * Starts from where the canvas put it and searches ±8% scale and a small
 * offset window for the least difference.
 */
export function locateOriginal(
  answer: { data: Float32Array; w: number; h: number },
  original: (scale: number) => { data: Float32Array; w: number; h: number },
  guess: { x: number; y: number; scale: number },
): { x: number; y: number; scale: number; err: number } {
  let best = { x: guess.x, y: guess.y, scale: guess.scale, err: Infinity };
  for (let ds = -0.08; ds <= 0.0801; ds += 0.01) {
    const scale = guess.scale * (1 + ds);
    const o = original(scale);
    const gx = Math.round(guess.x - (o.w - original(guess.scale).w) / 2);
    const gy = Math.round(guess.y - (o.h - original(guess.scale).h) / 2);
    const R = Math.max(4, Math.round(o.w * 0.06));
    for (let oy = gy - R; oy <= gy + R; oy++) {
      for (let ox = gx - R; ox <= gx + R; ox++) {
        if (ox < 0 || oy < 0 || ox + o.w > answer.w || oy + o.h > answer.h) continue;
        let err = 0, n = 0;
        // Inner 90%: the model blends the original's very edge into the fill.
        const mx = Math.round(o.w * 0.05), my = Math.round(o.h * 0.05);
        for (let y = my; y < o.h - my; y += 2) {
          const ar = (oy + y) * answer.w + ox, orow = y * o.w;
          for (let x = mx; x < o.w - mx; x += 2) {
            err += Math.abs(answer.data[ar + x] - o.data[orow + x]);
            n++;
          }
        }
        err /= Math.max(1, n);
        if (err < best.err) best = { x: ox, y: oy, scale, err };
      }
    }
  }
  return best;
}

/** Require both pixel agreement and structural correlation before restoring source pixels. */
export function alignedPatch(answer: { data: Float32Array; w: number; h: number }, original: { data: Float32Array; w: number; h: number }, x: number, y: number): boolean {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x + original.w > answer.w || y + original.h > answer.h) return false;
  let n = 0, sa = 0, sb = 0, aa = 0, bb = 0, ab = 0, error = 0;
  for (let j = 0; j < original.h; j += 2) for (let i = 0; i < original.w; i += 2) {
    const a = answer.data[(y + j) * answer.w + x + i], b = original.data[j * original.w + i];
    n++; sa += a; sb += b; aa += a * a; bb += b * b; ab += a * b; error += Math.abs(a - b);
  }
  if (n < 16 || error / n > 12) return false;
  const variance = Math.sqrt(Math.max(0, aa - sa * sa / n) * Math.max(0, bb - sb * sb / n));
  return variance < n ? error / n <= 3 : (ab - sa * sb / n) / variance >= 0.9;
}

/**
 * The model's answer laid onto the output canvas: the original FOUND in it
 * (scale + offset search), then the answer mapped so the original lands
 * at `c` exactly, colour-matched to the original's own pixels outside
 * `exclude` (the area the model was asked to change). Returns the canvas
 * and its scale against source pixels.
 */
/**
 * `exact`: the graph kept the original exactly where the canvas put it (the
 * inpaint-style outpaint), so the answer maps back by the canvas alone — no
 * search, whose thumbnail and 1 % scale steps cost 5–15 px and doubled seams.
 */
async function placeAnswer(res: ImageBitmap, src: ImageBitmap, c: { width: number; height: number; x: number; y: number }, exclude?: OffscreenCanvas, exact = false) {
  // Search on small copies: the answer at ~256 px on its long side.
  const t = 256 / Math.max(res.width, res.height);
  const aw = Math.round(res.width * t), ah = Math.round(res.height * t);
  const answer = { data: grey(res, aw, ah), w: aw, h: ah };
  // Where the canvas expected the original, in answer pixels (the model
  // may have returned a slightly different ratio — scale per axis).
  const sx = aw / c.width, sy = ah / c.height;
  const cache = new Map<number, { data: Float32Array; w: number; h: number }>();
  const original = (scale: number) => {
    const key = Math.round(scale * 1e4);
    let o = cache.get(key);
    if (!o) {
      const w = Math.max(8, Math.round(src.width * scale)), h = Math.max(8, Math.round(src.height * scale));
      o = { data: grey(src, w, h), w, h };
      cache.set(key, o);
    }
    return o;
  };
  const guess = { x: c.x * sx, y: c.y * sy, scale: (sx + sy) / 2 };
  let found = exact ? { ...guess, err: 0 } : locateOriginal(answer, original, guess);
  const aligned = exact || alignedPatch(answer, original(found.scale), found.x, found.y);
  // A model that redrew the scene has no faithful copy of the original to
  // find; a "best" match there is noise. Trust the canvas layout instead.
  if (found.err > 28) found = { ...guess, err: found.err };

  // Output: exactly the canvas laid out for the run. The answer is mapped
  // through the found placement, so its framing or ratio never stretches it.
  const cap = Math.min(1, OUT_EDGE / Math.max(c.width, c.height));
  const out = canvas2d(c.width * cap, c.height * cap);
  const g = cap / found.scale; // thumbnail px → output px
  // Backdrop for any strip the model's framing does not reach: the answer
  // stretched over the whole canvas (a blur would fade to dark there).
  out.ctx.drawImage(res, 0, 0, out.canvas.width, out.canvas.height);
  if (!exact) out.ctx.drawImage(res, c.x * cap - found.x * g, c.y * cap - found.y * g, aw * g, ah * g);

  // Match the model's colour to the original: per-channel gain from the two
  // versions of the original's area (minus what was meant to change).
  const w = Math.round(src.width * cap), h = Math.round(src.height * cap);
  const x = Math.round(c.x * cap), y = Math.round(c.y * cap);
  const mine = canvas2d(64, 64), theirs = canvas2d(64, 64);
  mine.ctx.drawImage(src, 0, 0, 64, 64);
  theirs.ctx.drawImage(out.canvas, x, y, w, h, 0, 0, 64, 64);
  let keep: Uint8ClampedArray | null = null;
  if (exclude) {
    const k = canvas2d(64, 64);
    k.ctx.drawImage(exclude, 0, 0, 64, 64);
    keep = k.ctx.getImageData(0, 0, 64, 64).data;
  }
  const mean = (d: Uint8ClampedArray) => {
    const m = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (keep && keep[i + 3] > 8) continue;
      m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; n++;
    }
    return m.map((v) => v / Math.max(1, n));
  };
  const want = mean(mine.ctx.getImageData(0, 0, 64, 64).data), got = mean(theirs.ctx.getImageData(0, 0, 64, 64).data);
  const gain = want.map((v, i) => Math.min(1.3, Math.max(0.77, (v + 1) / (got[i] + 1))));
  if (gain.some((v) => Math.abs(v - 1) > 0.01)) {
    const img = out.ctx.getImageData(0, 0, out.canvas.width, out.canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i] * gain[0]; d[i + 1] = d[i + 1] * gain[1]; d[i + 2] = d[i + 2] * gain[2];
    }
    out.ctx.putImageData(img, 0, 0);
  }
  return { ...out, cap, aligned, rect: { x, y, w, h } };
}

/** The drawn canvas cut out of the padded one: what the user asked for, nothing more. */
async function cropToDrawn(padded: OffscreenCanvas, pad: Layout, c: { width: number; height: number }, cap: number): Promise<Blob> {
  const out = canvas2d(c.width * cap, c.height * cap);
  // Rounded as `placeAnswer` rounds the original's place: an unextended side ends exactly on it.
  out.ctx.drawImage(padded, -Math.round(pad.x * cap), -Math.round(pad.y * cap));
  return await out.canvas.convertToBlob({ type: "image/png" });
}

/** `ratios`: the same list `prepareFillCanvas` was given. */
/**
 * Extend for an inpainting graph: the same layout at ~1 MP on a 16 px grid,
 * transparent where the world is to grow (the graph turns alpha into its noise mask).
 */
export async function prepareOutpaintCanvas(source: Blob, values: ParamValues, ratios?: readonly string[]): Promise<Blob> {
  const bmp = await createImageBitmap(source);
  try {
    const { placed } = fillLayout(values, bmp.width, bmp.height, ratios);
    const k = Math.sqrt(1_000_000 / (placed.width * placed.height));
    const w = Math.round((placed.width * k) / 16) * 16, h = Math.round((placed.height * k) / 16) * 16;
    const kx = w / placed.width, ky = h / placed.height;
    const { canvas, ctx } = canvas2d(w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bmp, placed.x * kx, placed.y * ky, bmp.width * kx, bmp.height * ky);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bmp.close();
  }
}

export async function compositeFill(result: Blob, source: Blob, values: ParamValues, onUnaligned?: () => void, ratios?: readonly string[], o: { exact?: boolean } = {}): Promise<Blob> {
  const [src, res] = await Promise.all([createImageBitmap(source), createImageBitmap(result)]);
  try {
    const { c, pad, placed } = fillLayout(values, src.width, src.height, ratios);
    const { canvas, ctx, cap, aligned, rect: { x, y, w, h } } = await placeAnswer(res, src, placed, undefined, o.exact);
    if (!aligned) {
      // Never paste an unrelated crop onto a redrawn scene. Keep the paid
      // answer, framed as the drawn canvas — its ratio is the padded one.
      onUnaligned?.();
      const whole = canvas2d(placed.width * cap, placed.height * cap);
      whole.ctx.drawImage(res, 0, 0, whole.canvas.width, whole.canvas.height);
      return await cropToDrawn(whole.canvas, pad, c, cap);
    }
    // The original, with a wide soft seam on the sides that grew.
    const f = Math.max(12, Math.round(Math.min(w, h) * 0.07));
    const layer = canvas2d(w, h);
    layer.ctx.drawImage(src, 0, 0, w, h);
    const mask = canvas2d(w, h);
    mask.ctx.fillStyle = "#fff";
    const grownR = c.width - src.width - c.x > 0, grownB = c.height - src.height - c.y > 0;
    const l = c.x > 0 ? f : -3 * f, tp = c.y > 0 ? f : -3 * f, r = grownR ? f : -3 * f, b = grownB ? f : -3 * f;
    mask.ctx.fillRect(l, tp, w - l - r, h - tp - b);
    const soft = canvas2d(w, h);
    drawBlurred(soft.ctx, mask.canvas, 0, 0, w, h, f / 2);
    layer.ctx.globalCompositeOperation = "destination-in";
    layer.ctx.drawImage(soft.canvas, 0, 0);
    ctx.drawImage(layer.canvas, x, y);
    return await cropToDrawn(canvas, pad, c, cap);
  } finally {
    src.close();
    res.close();
  }
}

// ── Inpaint ─────────────────────────────────────────────────────────
// The same trick inside the picture: the painted area goes neutral grey,
// an edit model fills it, and everything outside the (softened) mask is
// the original again — so nothing the user did not paint can change.

/** The source with the painted area (alpha of `mask`) flat grey. */
export async function prepareInpaintCanvas(source: Blob, mask: Blob): Promise<Blob> {
  const [src, m] = await Promise.all([createImageBitmap(source), createImageBitmap(mask)]);
  try {
    const k = Math.min(1, SEND_EDGE / Math.max(src.width, src.height));
    const { canvas, ctx } = canvas2d(src.width * k, src.height * k);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    const hole = canvas2d(canvas.width, canvas.height);
    hole.ctx.drawImage(m, 0, 0, canvas.width, canvas.height);
    hole.ctx.globalCompositeOperation = "source-in";
    hole.ctx.fillStyle = FILL_GREY;
    hole.ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(hole.canvas, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    src.close();
    m.close();
  }
}

export async function compositeInpaint(result: Blob, source: Blob, mask: Blob): Promise<Blob> {
  const [src, res, m] = await Promise.all([createImageBitmap(source), createImageBitmap(result), createImageBitmap(mask)]);
  try {
    const c = { width: src.width, height: src.height, x: 0, y: 0 };
    const hole = canvas2d(src.width, src.height);
    hole.ctx.drawImage(m, 0, 0, src.width, src.height);
    const { canvas, ctx, rect: { w, h } } = await placeAnswer(res, src, c, hole.canvas);
    // Grow the painted area a little and soften it: the model's pixels
    // inside, the original outside, a seam nobody can find.
    const f = Math.max(6, Math.round(Math.min(w, h) * 0.012));
    const soft = canvas2d(w, h);
    drawBlurred(soft.ctx, hole.canvas, -f / 2, -f / 2, w + f, h + f, f);
    const layer = canvas2d(w, h);
    layer.ctx.drawImage(src, 0, 0, w, h);
    layer.ctx.globalCompositeOperation = "destination-out";
    layer.ctx.drawImage(soft.canvas, 0, 0);
    layer.ctx.drawImage(soft.canvas, 0, 0); // twice: the core of the hole fully the model's
    ctx.drawImage(layer.canvas, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    src.close();
    res.close();
    m.close();
  }
}

/** A painted alpha mask as the black-edits / white-keeps PNG data URI Ideogram reads. */
export async function blackWhiteMask(mask: Blob): Promise<string> {
  const m = await createImageBitmap(mask);
  try {
    const { canvas, ctx } = canvas2d(m.width, m.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const ink = canvas2d(m.width, m.height);
    ink.ctx.drawImage(m, 0, 0);
    ink.ctx.globalCompositeOperation = "source-in";
    ink.ctx.fillStyle = "#000";
    ink.ctx.fillRect(0, 0, m.width, m.height);
    ctx.drawImage(ink.canvas, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Could not read the mask"));
      reader.readAsDataURL(blob);
    });
  } finally {
    m.close();
  }
}
