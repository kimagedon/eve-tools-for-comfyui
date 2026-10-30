/**
 * 3D geometry from one photo, on this Mac, run by ONNX Runtime Web. No key,
 * no upload: the photo never leaves the machine.
 *
 * With WebGPU: MoGe-2 (ViT-S) — a monocular *geometry* model. It returns a
 * point per pixel and the surface normals, so walls and floors come out flat
 * and the lens's real field of view is known. Its points are exact up to a
 * shift along the view axis; `recoverFocalShift` finds the focal length and
 * that shift by making every point lie on its own pixel's ray (MoGe's own
 * recipe), which turns them into a true pinhole reconstruction.
 *
 * Without WebGPU (CPU only, where MoGe would take ~15 s): Depth Anything V2
 * Small, relative depth on an assumed lens — rougher, but quick.
 *
 * The runtime ships inside the app (public/ort, copied by
 * scripts/copy-ort.mjs). Weights are fetched once from Hugging Face at a
 * pinned revision, checked against their SHA-256 and kept in Cache Storage.
 */
import type * as Ort from "onnxruntime-web";

const MODELS = {
  // Geometry, for WebGPU.
  moge: {
    url: "https://huggingface.co/Ruicheng/moge-2-vits-normal-onnx/resolve/e50ffda41565591092adea54c6ac83d6212e1e23/model.onnx",
    bytes: 140852051, sha256: "24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0", provider: "webgpu",
  },
  // Relative depth, for the CPU (int8; the fp16 build aborts on WASM).
  dav2: {
    url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_quantized.onnx",
    bytes: 27258801, sha256: "fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d", provider: "wasm",
  },
} as const;
type ModelId = keyof typeof MODELS;
const CACHE = "eve-models-v1";
/** The models' long side; both sides must be multiples of 14. */
const INPUT_EDGE = 518;
/** MoGe-2's working resolution, in ViT tokens (its default level). */
const MOGE_TOKENS = 1800;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** MoGe's depth is refined against the photo at this long side (guided filter). */
const REFINE_EDGE = 1024;
/** Depth Anything has no lens: assume the photo's long side spans this many degrees. */
const ASSUMED_LONG_FOV = 60;
/** Depth Anything's relative nearness t → nearness NEAR_FLOOR + (1 − NEAR_FLOOR)·t (a gentle range). */
const NEAR_FLOOR = 0.3;

export interface DepthMap {
  width: number;
  height: number;
  /** Nearness per pixel, row-major: 1 / distance along the view axis, the nearest point at 1. */
  data: Float32Array;
  /** The lens's vertical field of view, degrees. */
  fovY: number;
  /** Unit normals per pixel facing the camera (x right, y up, z towards the camera), when the model gives them. */
  normals?: Float32Array;
  /** The normals' own grid (the model's resolution; `data` may be finer). */
  normalsWidth?: number;
  normalsHeight?: number;
  model: ModelId;
}

export type DepthProgress = (p: { stage: "download"; fraction: number } | { stage: "estimate" }) => void;

let ortPromise: Promise<typeof Ort> | null = null;
export function loadOrt(): Promise<typeof Ort> {
  const base = `${import.meta.env.BASE_URL}ort/`;
  const url = `${base}ort.min.mjs`;
  ortPromise ??= (import(/* @vite-ignore */ url) as Promise<typeof Ort>).then((ort) => {
    ort.env.wasm.wasmPaths = base;
    // No cross-origin isolation in the WebView: threads would fail to start.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    // Only warnings and worse reach the console (its info lines were logged as errors).
    ort.env.logLevel = "warning";
    return ort;
  }).catch((error) => { ortPromise = null; throw error; });
  return ortPromise;
}

export async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch { return false; }
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function weights(id: ModelId, onProgress?: DepthProgress): Promise<Uint8Array> {
  return downloadModel(MODELS[id], onProgress);
}

/** A model file: from Cache Storage, or downloaded once, size- and SHA-256-checked, then cached. */
export async function downloadModel({ url, bytes, sha256 }: { url: string; bytes: number; sha256: string }, onProgress?: DepthProgress): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      if (buf.byteLength === bytes) return new Uint8Array(buf);
      await cache.delete(url);
    }
  } catch { cache = null; }

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Could not download the 3D model (${res.status})`);
  const reader = res.body.getReader();
  const out = new Uint8Array(bytes);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > bytes) throw new Error("The 3D model download is larger than expected");
    out.set(value, got);
    got += value.length;
    onProgress?.({ stage: "download", fraction: got / bytes });
  }
  if (got !== bytes) throw new Error("The 3D model download was cut short");
  if (hex(await crypto.subtle.digest("SHA-256", out)) !== sha256) throw new Error("The 3D model failed its checksum");
  try { await cache?.put(url, new Response(out, { headers: { "content-type": "application/octet-stream" } })); } catch { /* used without caching */ }
  return out;
}

const sessions = new Map<ModelId, Promise<Ort.InferenceSession>>();
function session(id: ModelId, onProgress?: DepthProgress) {
  let s = sessions.get(id);
  if (!s) {
    s = (async () => {
      const ort = await loadOrt();
      const model = await weights(id, onProgress);
      return ort.InferenceSession.create(model, { executionProviders: [MODELS[id].provider], graphOptimizationLevel: "all" });
    })();
    s.catch(() => sessions.delete(id));
    sessions.set(id, s);
  }
  return s;
}

function pixelsOf(image: ImageBitmap) {
  const k = INPUT_EDGE / Math.max(image.width, image.height);
  const w = Math.max(14, Math.round((image.width * k) / 14) * 14);
  const h = Math.max(14, Math.round((image.height * k) / 14) * 14);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No canvas for depth");
  ctx.drawImage(image, 0, 0, w, h);
  return { rgba: ctx.getImageData(0, 0, w, h).data, w, h };
}

/**
 * MoGe's points are right up to a shift t along z. Find t (and the focal
 * length f, in px) so each point, projected, lands on its own pixel:
 * minimise Σ |f·(x, y)/(z + t) − (u, v)|² — f in closed form, t by golden section.
 */
export function recoverFocalShift(points: Float32Array, mask: Float32Array, w: number, h: number) {
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], us: number[] = [], vs: number[] = [];
  const step = Math.max(1, Math.floor(Math.max(w, h) / 64));
  for (let j = 0; j < h; j += step) for (let i = 0; i < w; i += step) {
    const k = j * w + i;
    if (mask[k] < 0.5) continue;
    xs.push(points[k * 3]); ys.push(points[k * 3 + 1]); zs.push(points[k * 3 + 2]);
    us.push(i + 0.5 - w / 2); vs.push(j + 0.5 - h / 2);
  }
  const n = xs.length;
  const zmin = Math.min(...zs), zmax = Math.max(...zs);
  const solve = (t: number) => {
    let ab = 0, aa = 0;
    for (let i = 0; i < n; i++) {
      const d = zs[i] + t;
      const ax = xs[i] / d, ay = ys[i] / d;
      ab += ax * us[i] + ay * vs[i];
      aa += ax * ax + ay * ay;
    }
    const f = ab / (aa || 1);
    let e = 0;
    for (let i = 0; i < n; i++) {
      const d = zs[i] + t;
      e += (f * xs[i] / d - us[i]) ** 2 + (f * ys[i] / d - vs[i]) ** 2;
    }
    return { f, e };
  };
  let lo = -0.95 * zmin, hi = Math.max(1, zmax * 2);
  const g = (Math.sqrt(5) - 1) / 2;
  let a = hi - g * (hi - lo), b = lo + g * (hi - lo);
  let ea = solve(a).e, eb = solve(b).e;
  for (let it = 0; it < 48; it++) {
    if (ea < eb) { hi = b; b = a; eb = ea; a = hi - g * (hi - lo); ea = solve(a).e; }
    else { lo = a; a = b; ea = eb; b = lo + g * (hi - lo); eb = solve(b).e; }
  }
  const t = (lo + hi) / 2;
  return { shift: t, focal: Math.abs(solve(t).f) };
}

async function moge(image: ImageBitmap, onProgress?: DepthProgress): Promise<DepthMap> {
  const { rgba, w, h } = pixelsOf(image);
  const n = w * h;
  const pixels = new Float32Array(3 * n); // 0..1 RGB: MoGe normalises itself
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) pixels[c * n + i] = rgba[i * 4 + c] / 255;
  const ort = await loadOrt();
  const s = await session("moge", onProgress);
  onProgress?.({ stage: "estimate" });
  const out = await s.run({
    image: new ort.Tensor("float32", pixels, [1, 3, h, w]),
    num_tokens: new ort.Tensor("int64", BigInt64Array.from([BigInt(MOGE_TOKENS)]), []),
  });
  const points = new Float32Array(await out.points.getData() as Float32Array);
  const normalRaw = new Float32Array(await out.normal.getData() as Float32Array);
  const mask = new Float32Array(await out.mask.getData() as Float32Array);
  for (const t of Object.values(out)) t.dispose();

  const { shift, focal } = recoverFocalShift(points, mask, w, h);
  // Distance along the view axis; what the model masks out (sky, glare) goes far back.
  const z = new Float32Array(n);
  let zmax = 0;
  for (let i = 0; i < n; i++) if (mask[i] >= 0.5) { z[i] = Math.max(1e-3, points[i * 3 + 2] + shift); zmax = Math.max(zmax, z[i]); }
  const valid = Array.from(z).filter((v) => v > 0).sort((p, q) => p - q);
  const near = valid.length ? valid[Math.floor(valid.length * 0.01)] : 1;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.min(1, near / (z[i] > 0 ? z[i] : zmax * 1.3 || 1));
  // OpenCV axes (y down, z forward) → ours (y up, z towards the camera).
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    normals[i * 3] = normalRaw[i * 3];
    normals[i * 3 + 1] = -normalRaw[i * 3 + 1];
    normals[i * 3 + 2] = -normalRaw[i * 3 + 2];
  }
  const fovY = (2 * Math.atan(h / 2 / focal) * 180) / Math.PI;
  const refined = refine(image, data, w, h);
  return { ...refined, fovY: Math.min(120, Math.max(15, fovY)), normals, normalsWidth: w, normalsHeight: h, model: "moge" };
}

async function depthAnything(image: ImageBitmap, onProgress?: DepthProgress): Promise<DepthMap> {
  const { rgba, w, h } = pixelsOf(image);
  const n = w * h;
  const pixels = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) pixels[c * n + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  const ort = await loadOrt();
  const s = await session("dav2", onProgress);
  onProgress?.({ stage: "estimate" });
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", pixels, [1, 3, h, w]) });
  const t = out[s.outputNames[0]];
  const raw = new Float32Array(await t.getData() as Float32Array);
  t.dispose();
  // Disparity → 0..1, ignoring the outer percent at each end, then a gentle nearness range.
  const sorted = Float32Array.from(raw).sort();
  const lo = sorted[Math.floor(n * 0.01)], hi = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
  const span = hi - lo || 1;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = NEAR_FLOOR + (1 - NEAR_FLOOR) * Math.min(1, Math.max(0, (raw[i] - lo) / span));
  const half = (ASSUMED_LONG_FOV / 2) * (Math.PI / 180);
  const tanY = w >= h ? Math.tan(half) * (h / w) : Math.tan(half);
  return { width: w, height: h, data, fovY: (2 * Math.atan(tanY) * 180) / Math.PI, model: "dav2" };
}

/** Mean over a (2r+1)² box, by a summed-area table. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
      out[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/**
 * The model's depth is coarse (518 px) and its edges sit a few pixels off
 * the photo's — background sticks to objects and stretches when the camera
 * moves. Upsample it to REFINE_EDGE and run a guided filter (He et al.) with
 * the photo's luminance as the guide, so depth edges snap to colour edges.
 */
function refine(image: ImageBitmap, near: Float32Array, w: number, h: number): { width: number; height: number; data: Float32Array } {
  const k = Math.min(1, REFINE_EDGE / Math.max(image.width, image.height));
  const W = Math.max(w, Math.round(image.width * k)), H = Math.max(h, Math.round(image.height * k));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { width: w, height: h, data: near };
  ctx.drawImage(image, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const n = W * H;
  const I = new Float32Array(n), p = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    I[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
    // Bilinear from the model's grid.
    const fx = Math.min(w - 1, Math.max(0, ((x + 0.5) / W) * w - 0.5)), fy = Math.min(h - 1, Math.max(0, ((y + 0.5) / H) * h - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    p[i] = (near[y0 * w + x0] * (1 - tx) + near[y0 * w + x1] * tx) * (1 - ty) + (near[y1 * w + x0] * (1 - tx) + near[y1 * w + x1] * tx) * ty;
  }
  const r = Math.max(2, Math.round(Math.max(W, H) / 160)), eps = 2e-4;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, W, H, r), mp = boxMean(p, W, H, r), mIp = boxMean(Ip, W, H, r), mII = boxMean(II, W, H, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i], vr = mII[i] - mI[i] * mI[i];
    a[i] = cov / (vr + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, W, H, r), mb = boxMean(b, W, H, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0.01, ma[i] * I[i] + mb[i]));
  return { width: W, height: H, data: out };
}

/** Geometry for `image`: MoGe-2 on the GPU, else Depth Anything on the CPU. */
export async function estimateDepth(image: ImageBitmap, onProgress?: DepthProgress): Promise<DepthMap> {
  if (await hasWebGpu()) {
    try { return await moge(image, onProgress); } catch { /* fall back to the CPU model */ }
  }
  return depthAnything(image, onProgress);
}

// One estimate per photo for the session: Relight and Reframe on the same
// photo share it, and going back and forth costs nothing.
const byBlob = new WeakMap<Blob, Promise<DepthMap>>();
export function depthFor(blob: Blob, onProgress?: DepthProgress): Promise<DepthMap> {
  let p = byBlob.get(blob);
  if (!p) {
    p = createImageBitmap(blob).then(async (bmp) => {
      try { return await estimateDepth(bmp, onProgress); } finally { bmp.close(); }
    });
    p.catch(() => byBlob.delete(blob));
    byBlob.set(blob, p);
  }
  return p;
}
