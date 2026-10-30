/**
 * A photo's depth map as a 3D surface seen by the camera that took it.
 *
 * Camera at the origin looking down −Z (three.js convention), so from the
 * original camera the textured surface reprojects exactly onto the photo.
 * Triangles almost edge-on to that camera are the "rubber sheet" a depth
 * map stretches across a silhouette. They are kept apart (`seams`): from
 * the front they complete the photo without a crack, from a new viewpoint
 * they are drawn as holes instead of smeared pixels.
 */
import type { DepthMap } from "@/lib/depth";

/** Degrees the photo's long side spans — a typical phone/35 mm lens. */
const LONG_SIDE_FOV = 60;
/** That lens as a 35 mm-equivalent focal length (36 mm across the long side). */
export const BASE_FOCAL = 18 / Math.tan(((LONG_SIDE_FOV / 2) * Math.PI) / 180);
/** Grid cells along the photo's long side. */
const CELLS = 448;
/**
 * A silhouette: a triangle whose corners differ in depth by more than this
 * share AND that is nearly edge-on to the camera. Both together — a floor
 * seen at a grazing angle is steep but smooth, a step in depth is a jump.
 */
const DEPTH_STEP = 0.035;
const EDGE_ON = 0.22;

export interface DepthSurface {
  positions: Float32Array;
  /** Axis-aligned bounds, used to keep the orbit camera outside the surface. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** From a smoothed copy of the depth: the raw map's fine noise would scatter the light. */
  normals: Float32Array;
  uvs: Float32Array;
  /** Grid cells across and down. */
  cols: number;
  rows: number;
  index: Uint32Array;
  /** The silhouette triangles left out of `index`. */
  seams: Uint32Array;
  /** Per vertex, 1 on a silhouette falling to 0 a few cells in: where a new view feathers the edge. */
  edge: Float32Array;
  /** Vertical field of view, degrees. */
  fovY: number;
  /** The photo's lens as a 35 mm-equivalent focal length. */
  baseFocal: number;
  aspect: number;
  /** Distance to the scene's middle (median depth): the orbit's pivot. */
  pivot: number;
  /** Extent of the scene, for sizing lights and handles. */
  scale: number;
}

export function verticalFov(aspect: number): number {
  const half = (LONG_SIDE_FOV / 2) * (Math.PI / 180);
  const tanY = aspect >= 1 ? Math.tan(half) / aspect : Math.tan(half);
  return (2 * Math.atan(tanY) * 180) / Math.PI;
}

function sample(depth: DepthMap, u: number, v: number): number {
  const x = Math.min(depth.width - 1, Math.max(0, u * depth.width - 0.5));
  const y = Math.min(depth.height - 1, Math.max(0, v * depth.height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(depth.width - 1, x0 + 1), y1 = Math.min(depth.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const d = depth.data, w = depth.width;
  const top = d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx;
  const bottom = d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * `depth` null: a flat photo at distance 2 (the fallback when depth failed).
 * `pad`: the depth map (and its texture) reach this fraction of the photo past
 * each edge — the background layer, which carries on beyond the frame.
 * `push`: move the surface this share farther away (the background sits just behind).
 * `cut`: keep silhouettes apart as `seams` (the photo's own layer); off, every triangle is in `index`.
 */
export function buildSurface(depth: DepthMap | null, aspect: number, opts: { pad?: number; push?: number; cut?: boolean; relief?: number } = {}): DepthSurface {
  const { pad = 0, push = 0, cut = true, relief = 1 } = opts;
  const fovY = depth?.fovY ?? verticalFov(aspect);
  const tanY = Math.tan((fovY / 2) * (Math.PI / 180));
  const tanX = tanY * aspect;
  const span = 1 + 2 * pad;
  const cells = Math.round(CELLS * (pad ? 0.5 : 1) * span);
  const cols = aspect >= 1 ? cells : Math.max(8, Math.round(cells * aspect));
  const rows = aspect >= 1 ? Math.max(8, Math.round(cells / aspect)) : cells;
  const vw = cols + 1, vh = rows + 1;
  const positions = new Float32Array(vw * vh * 3);
  const uvs = new Float32Array(vw * vh * 2);
  const zs = new Float32Array(vw * vh);
  // Compress depth along camera rays: the original projection stays exact.
  // A bounded log profile keeps distant sky from engulfing a rear-view camera.
  const strength = Math.max(0, Math.min(1, relief));
  // The median is only needed to compress; at full relief skip sorting a megapixel of depth.
  const samples = depth && strength !== 1 ? Float32Array.from(depth.data, (d) => 1 / Math.max(0.02, d)).sort() : null;
  const center = samples ? samples[Math.floor(samples.length / 2)] : 2;
  for (let j = 0; j < vh; j++) {
    const v = j / rows;
    for (let i = 0; i < vw; i++) {
      const u = i / cols;
      const raw = depth ? 1 / Math.max(0.02, sample(depth, u, v)) : 2;
      const ratio = Math.log(raw / center);
      const z = (strength === 1 ? raw : center * Math.exp(0.5 * Math.tanh(ratio * strength / 0.5))) * (1 + push);
      const k = j * vw + i;
      // Where on the photo's own frame this is (beyond 0..1 in the padding).
      const fu = -pad + u * span, fv = -pad + v * span;
      positions[k * 3] = (fu - 0.5) * 2 * tanX * z;
      positions[k * 3 + 1] = (0.5 - fv) * 2 * tanY * z;
      positions[k * 3 + 2] = -z;
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = 1 - v;
      zs[k] = z;
    }
  }

  const index: number[] = [];
  const seams: number[] = [];
  const edgeOn = (a: number, b: number, c: number) => {
    const p = positions;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const e1x = p[b * 3] - ax, e1y = p[b * 3 + 1] - ay, e1z = p[b * 3 + 2] - az;
    const e2x = p[c * 3] - ax, e2y = p[c * 3 + 1] - ay, e2z = p[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const cx = (ax + p[b * 3] + p[c * 3]) / 3, cy = (ay + p[b * 3 + 1] + p[c * 3 + 1]) / 3, cz = (az + p[b * 3 + 2] + p[c * 3 + 2]) / 3;
    const dot = Math.abs(nx * cx + ny * cy + nz * cz);
    const len = Math.hypot(nx, ny, nz) * Math.hypot(cx, cy, cz);
    if (len === 0) return true;
    const za = -az, zb = -p[b * 3 + 2], zc = -p[c * 3 + 2];
    const step = Math.max(za, zb, zc) / Math.min(za, zb, zc) - 1;
    return step > DEPTH_STEP && dot / len < EDGE_ON;
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * vw + i, b = a + 1, c = a + vw, d = c + 1;
      // Counter-clockwise seen from the camera.
      const triangles = Math.abs(Math.log(zs[a] / zs[d])) < Math.abs(Math.log(zs[b] / zs[c]))
        ? [[a, c, d], [a, d, b]] : [[a, c, b], [b, c, d]];
      for (const [x, y, z] of triangles) (cut && edgeOn(x, y, z) ? seams : index).push(x, y, z);
    }
  }

  // The model's own normals where it gives them (smooth, true to the surface); else from smoothed depth.
  const normals = depth?.normals && !pad ? sampleNormals(depth, vw, vh) : smoothNormals(zs, vw, vh, tanX * span, tanY * span);

  // Distance in cells from the nearest silhouette, as a 1 → 0 ramp.
  // Seeded on the near side of each silhouette only: the object's rim
  // feathers, the surface behind it stays solid.
  const RINGS = 2;
  const dist = new Uint8Array(vw * vh).fill(255);
  const queue: number[] = [];
  for (let t = 0; t < seams.length; t += 3) {
    const tri = [seams[t], seams[t + 1], seams[t + 2]];
    const zmin = Math.min(zs[tri[0]], zs[tri[1]], zs[tri[2]]);
    for (const v of tri) if (zs[v] <= zmin * 1.01 && dist[v] !== 0) { dist[v] = 0; queue.push(v); }
  }
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q], d = dist[v];
    if (d >= RINGS) continue;
    const i = v % vw, j = (v - i) / vw;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= vw || nj >= vh) continue;
      const n = nj * vw + ni;
      if (dist[n] > d + 1) { dist[n] = d + 1; queue.push(n); }
    }
  }
  const edge = new Float32Array(vw * vh);
  for (let v = 0; v < edge.length; v++) edge[v] = dist[v] > RINGS ? 0 : 1 - dist[v] / (RINGS + 1);

  const sorted = Float32Array.from(zs).sort();
  const pivot = sorted[Math.floor(sorted.length / 2)];
  const bounds: DepthSurface["bounds"] = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let k = 0; k < positions.length; k += 3) for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis], positions[k + axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], positions[k + axis]);
  }
  const baseFocal = 18 / (aspect >= 1 ? tanX : tanY);
  return { positions, bounds, normals, uvs, cols, rows, index: Uint32Array.from(index), seams: Uint32Array.from(seams), edge, fovY, baseFocal, aspect, pivot, scale: pivot * tanY * 2 };
}

function sampleNormals(depth: DepthMap, vw: number, vh: number): Float32Array {
  const n = depth.normals!, out = new Float32Array(vw * vh * 3);
  const nw = depth.normalsWidth ?? depth.width, nh = depth.normalsHeight ?? depth.height;
  for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
    const x = Math.min(nw - 1, Math.round((i / (vw - 1)) * (nw - 1)));
    const y = Math.min(nh - 1, Math.round((j / (vh - 1)) * (nh - 1)));
    const k = (y * nw + x) * 3, o = (j * vw + i) * 3;
    out[o] = n[k]; out[o + 1] = n[k + 1]; out[o + 2] = n[k + 2];
  }
  return out;
}

/** Box-blur the depth grid (two passes each way), then normals by central differences. */
function smoothNormals(zs: Float32Array, vw: number, vh: number, tanX: number, tanY: number): Float32Array {
  const R = 3;
  const a = Float32Array.from(zs), b = new Float32Array(zs.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < vh; j++) {
      for (let i = 0; i < vw; i++) {
        let s = 0, n = 0;
        for (let k = Math.max(0, i - R); k <= Math.min(vw - 1, i + R); k++) { s += a[j * vw + k]; n++; }
        b[j * vw + i] = s / n;
      }
    }
    for (let j = 0; j < vh; j++) {
      for (let i = 0; i < vw; i++) {
        let s = 0, n = 0;
        for (let k = Math.max(0, j - R); k <= Math.min(vh - 1, j + R); k++) { s += b[k * vw + i]; n++; }
        a[j * vw + i] = s / n;
      }
    }
  }
  const at = (i: number, j: number) => {
    const z = a[j * vw + i], u = i / (vw - 1), v = j / (vh - 1);
    return [(u - 0.5) * 2 * tanX * z, (0.5 - v) * 2 * tanY * z, -z];
  };
  const normals = new Float32Array(vw * vh * 3);
  for (let j = 0; j < vh; j++) {
    for (let i = 0; i < vw; i++) {
      const r = at(Math.min(vw - 1, i + 1), j), l = at(Math.max(0, i - 1), j);
      const up = at(i, Math.max(0, j - 1)), down = at(i, Math.min(vh - 1, j + 1));
      const tx = [r[0] - l[0], r[1] - l[1], r[2] - l[2]];
      const ty = [up[0] - down[0], up[1] - down[1], up[2] - down[2]];
      let nx = tx[1] * ty[2] - tx[2] * ty[1], ny = tx[2] * ty[0] - tx[0] * ty[2], nz = tx[0] * ty[1] - tx[1] * ty[0];
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const k = (j * vw + i) * 3;
      normals[k] = nx; normals[k + 1] = ny; normals[k + 2] = nz;
    }
  }
  return normals;
}

/**
 * How far the camera may turn and still look at what the photo holds: a
 * share of the lens's own field of view (a long lens saw a narrow wedge of
 * the world; turning past it only shows what was never there).
 */
export function orbitLimits(s: DepthSurface, max = { azimuth: 45, elevation: 30 }) {
  const tanY = Math.tan((s.fovY / 2) * (Math.PI / 180));
  const fovX = (2 * Math.atan(tanY * s.aspect) * 180) / Math.PI;
  // …and never so far that the camera passes close to the nearest surface
  // (at distance 1): the swing moves it about pivot·angle sideways.
  const reach = (Math.atan(0.45 / s.pivot) * 180) / Math.PI;
  return {
    azimuth: Math.round(Math.min(max.azimuth, Math.max(10, Math.min(fovX * 0.55, reach)))),
    elevation: Math.round(Math.min(max.elevation, Math.max(6, Math.min(s.fovY * 0.45, reach * 0.8)))),
  };
}

/** The surface point (and its normal) under the photo's (u, v), 0..1 from the top left. */
export function surfacePoint(s: DepthSurface, u: number, v: number): { anchor: [number, number, number]; normal: [number, number, number] } {
  const i = Math.round(Math.min(1, Math.max(0, u)) * s.cols), j = Math.round(Math.min(1, Math.max(0, v)) * s.rows);
  const k = (j * (s.cols + 1) + i) * 3;
  return {
    anchor: [s.positions[k], s.positions[k + 1], s.positions[k + 2]],
    normal: [s.normals[k], s.normals[k + 1], s.normals[k + 2]],
  };
}


/** Conservative camera clearance along the orbit direction, relative to its pivot. */
export function orbitClearance(s: DepthSurface, azimuth: number, elevation: number): number {
  const az = azimuth * Math.PI / 180, el = elevation * Math.PI / 180;
  const direction = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  let support = s.pivot * direction[2];
  for (let axis = 0; axis < 3; axis++) support += direction[axis] * (direction[axis] >= 0 ? s.bounds.max[axis] : s.bounds.min[axis]);
  // Keep a small physical gap, allowing close wide-angle views without crossing the surface.
  const margin = Math.max(0.005, Math.min(s.pivot * 0.005, -s.bounds.max[2] * 0.05));
  return Math.max(0.005, support + margin);
}
