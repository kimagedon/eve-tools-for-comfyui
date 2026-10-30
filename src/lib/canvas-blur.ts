/**
 * Draw an image blurred, on any engine. `ctx.filter` does it directly where
 * the engine has it; where it does not (older WebKit — the desktop app's
 * engine), the image is shrunk into a small canvas and stretched back
 * with smoothing, which reads as the same soft blur.
 */
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const hasCanvasFilter = (ctx: Ctx) => typeof (ctx as { filter?: unknown }).filter === "string";

export function drawBlurred(ctx: Ctx, src: CanvasImageSource, dx: number, dy: number, dw: number, dh: number, blur: number, extra = "") {
  if (hasCanvasFilter(ctx)) {
    ctx.filter = `blur(${blur}px)${extra ? ` ${extra}` : ""}`;
    ctx.drawImage(src, dx, dy, dw, dh);
    ctx.filter = "none";
    return;
  }
  // Transparent room around the image so its edges can spread like a
  // real blur; two steps down keep the stretch smooth instead of blocky.
  const pad = blur * 2;
  const W = dw + pad * 2, H = dh + pad * 2;
  // A gaussian of radius r spreads about 2r; shrinking by that much matches it.
  const f = Math.max(2, blur * 2);
  const mid = new OffscreenCanvas(Math.max(1, Math.round(W / Math.sqrt(f))), Math.max(1, Math.round(H / Math.sqrt(f))));
  const small = new OffscreenCanvas(Math.max(1, Math.round(W / f)), Math.max(1, Math.round(H / f)));
  const m = mid.getContext("2d"), s = small.getContext("2d");
  if (!m || !s) { ctx.drawImage(src, dx, dy, dw, dh); return; }
  for (const c of [m, s, ctx]) { c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high"; }
  const k = mid.width / W;
  m.drawImage(src, pad * k, pad * k, dw * k, dh * k);
  s.drawImage(mid, 0, 0, small.width, small.height);
  m.clearRect(0, 0, mid.width, mid.height);
  m.drawImage(small, 0, 0, mid.width, mid.height);
  ctx.drawImage(mid, dx - pad, dy - pad, W, H);
}
