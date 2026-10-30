import { orbitClearance, type DepthSurface } from "./depth-mesh";

/** Focal length changes projection only; Distance alone moves the camera. */
export function lens(s: DepthSurface, c: { focal: number | null; dolly?: number; azimuth: number; elevation: number }) {
  const f = c.focal ?? s.baseFocal;
  const tanY = Math.tan(s.fovY * Math.PI / 360) * (s.baseFocal / f);
  const requested = s.pivot * Math.max(0.02, c.dolly ?? 1);
  const r = Math.max(requested, orbitClearance(s, c.azimuth, c.elevation));
  const barrel = c.focal != null && f < 24 ? 0.42 * Math.min(1, (24 - f) / 12) : 0;
  return { fovY: 2 * Math.atan(tanY) * 180 / Math.PI, r, barrel, f };
}
