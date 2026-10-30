/**
 * The paperwork a set runs on: the camera report (CSV), the lighting plot
 * (a printable top-down SVG of fixtures and cameras) and an EDL of the cut
 * (CMX3600, 24 fps, reels = shot IDs). Pure functions; the caller downloads.
 */
import type { DepthSurface } from "./depth-mesh";
import { lens } from "./camera-lens";
import { LENSES, SENSORS, cameraHeight, frameMm, metres, outputAspect, slate, takeName, tilt, type Sensor } from "./cine";
import { MOVES, TEMPLATES, type RigCamera } from "./rig";
import { lightPoint, type SceneLight } from "@/components/tools/depth-scene";
import { FIXTURES, ROLES } from "@/components/tools/scene-rig";

export interface ReportShot {
  camera: RigCamera;
  index: number;
  /** How many takes the camera has; the file is the circled one. */
  takes?: number;
  /** Cut length, seconds (after trim). */
  seconds: number;
  /** The take's file, if one was made. */
  ext: string | null;
  take?: number;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function cameraReport(s: DepthSurface, sensor: Sensor, shots: ReportShot[]): string {
  const head = ["Shot", "Size", "Lens (mm)", "Camera", "Lens character", "T-stop", "Height (m, approx.)", "Tilt (deg)", "Move", "Sound", "Duration (s)", "Takes", "Circled take"];
  const rows = shots.map(({ camera: c, index, seconds, ext, take, takes }) => [
    slate(index),
    TEMPLATES.find((t) => t.id === c.template)?.label ?? "",
    Math.round(frameMm(s, c.cam.focal ?? s.baseFocal, sensor)),
    SENSORS[sensor].label,
    LENSES[c.lens ?? "clean"].label,
    c.focus ? `T${c.focus.fstop.toFixed(1)}` : "",
    cameraHeight(s, c.cam).toFixed(2),
    tilt(c.cam),
    MOVES.find((m) => m.id === c.move)?.label ?? "",
    c.sound === false ? "off" : "on",
    seconds.toFixed(2),
    takes ?? (ext ? 1 : 0),
    ext ? takeName(index, ext, take ?? 1) : "",
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Top-down lighting plot: the set, every unit with its role and colour temperature, every camera. */
export function lightingPlot(s: DepthSurface, lights: SceneLight[], cameras: RigCamera[], title = "Scene 1"): string {
  const W = 1100, H = 850, cx = 430, cy = 330;
  const m = metres(s);
  // Pivot-centred plan coordinates: x right, z towards the original camera.
  const plan = (x: number, z: number) => ({ x, z: z + s.pivot });
  const pts = [
    ...lights.map((l) => { const p = lightPoint(s, l); return plan(p[0], p[2]); }),
    ...cameras.map((c) => { const r = lens(s, c.cam).r, a = (c.cam.azimuth * Math.PI) / 180; return { x: r * Math.sin(a), z: r * Math.cos(a) }; }),
    plan(s.bounds.min[0], s.bounds.min[2]), plan(s.bounds.max[0], s.bounds.max[2]),
  ];
  const reach = Math.max(...pts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.z)))) || 1;
  const k = 280 / reach;
  const P = (p: { x: number; z: number }) => ({ x: cx + p.x * k, y: cy + p.z * k });
  const a = P(plan(s.bounds.min[0], s.bounds.min[2])), b = P(plan(s.bounds.max[0], s.bounds.max[2]));
  const set = `<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.max(6, Math.abs(b.y - a.y))}" fill="#e9e9ec" stroke="#999" stroke-dasharray="4 3"/>`
    + `<text x="${(a.x + b.x) / 2}" y="${Math.min(a.y, b.y) - 8}" text-anchor="middle" font-size="12" fill="#666">SET</text>`;
  const units = lights.map((l, i) => {
    const p3 = lightPoint(s, l), p = P(plan(p3[0], p3[2]));
    const f = l.fixture ? FIXTURES[l.fixture].label : l.kind === "sun" ? "Sun / HMI" : l.kind === "spot" ? "Spot" : "Point";
    const role = l.role ? ROLES[l.role] : `Unit ${i + 1}`;
    const temp = l.kelvin ? `${l.kelvin} K` : `gel ${l.colour}`;
    return `<g><line x1="${p.x}" y1="${p.y}" x2="${cx}" y2="${cy}" stroke="${l.colour}" stroke-width="1.5" stroke-dasharray="2 3"/>`
      + `<circle cx="${p.x}" cy="${p.y}" r="11" fill="${l.colour}" stroke="#111" stroke-width="1.5"/>`
      + `<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="10" font-weight="700" fill="#111">${i + 1}</text>`
      + `<text x="${p.x + 16}" y="${p.y - 2}" font-size="12" font-weight="600" fill="#111">${esc(role)} · ${esc(f)}</text>`
      + `<text x="${p.x + 16}" y="${p.y + 13}" font-size="11" fill="#555">${esc(temp)}</text></g>`;
  }).join("");
  const cams = cameras.map((c, i) => {
    const r = lens(s, c.cam).r, ang = (c.cam.azimuth * Math.PI) / 180;
    const p = P({ x: r * Math.sin(ang), z: r * Math.cos(ang) });
    const look = Math.atan2(cx - p.x, cy - p.y), half = Math.atan(outputAspect() * Math.tan((lens(s, c.cam).fovY * Math.PI) / 360)), L = 46;
    const ray = (sgn: number) => `${p.x + L * Math.sin(look + sgn * half)},${p.y + L * Math.cos(look + sgn * half)}`;
    return `<g><polygon points="${p.x},${p.y} ${ray(-1)} ${ray(1)}" fill="rgba(255,190,0,0.18)" stroke="#c48a00"/>`
      + `<rect x="${p.x - 14}" y="${p.y - 9}" width="28" height="18" rx="4" fill="#111"/>`
      + `<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#ffd60a">${slate(c.slate ?? i)}</text></g>`;
  }).join("");
  const scaleM = Math.max(0.5, Math.round((100 / k) * m * 2) / 2);
  const bar = `<line x1="40" y1="${H - 40}" x2="${40 + (scaleM / m) * k}" y2="${H - 40}" stroke="#111" stroke-width="3"/><text x="40" y="${H - 50}" font-size="11" fill="#333">≈ ${scaleM} m</text>`;
  const legend = lights.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.role ? ROLES[l.role] : "—")}</td><td>${esc(l.fixture ? FIXTURES[l.fixture].label : l.kind ?? "point")}</td><td>${l.kelvin ? `${l.kelvin} K${l.tint ? ` ${l.tint > 0 ? "+" : ""}${l.tint} M/G` : ""}` : esc(l.colour)}</td><td>${l.strength.toFixed(2)}</td></tr>`).join("");
  const table = `<foreignObject x="770" y="60" width="300" height="${H - 120}"><div xmlns="http://www.w3.org/1999/xhtml" style="font:12px Inter,Helvetica,sans-serif;color:#111">`
    + `<b style="font-size:13px">Units</b><table style="border-collapse:collapse;margin-top:6px;width:100%" cellpadding="3"><tr style="text-align:left;color:#666"><th>#</th><th>Role</th><th>Fixture</th><th>Colour</th><th>Level</th></tr>${legend}</table>`
    + `<p style="margin-top:18px"><b style="font-size:13px">Cameras</b></p>${cameras.map((c, i) => `<div>${slate(c.slate ?? i)} · ${TEMPLATES.find((t) => t.id === c.template)?.label} · ${MOVES.find((x) => x.id === c.move)?.label}</div>`).join("")}`
    + `<p style="margin-top:18px;color:#777">Distances approximate — estimated from a single still.</p></div></foreignObject>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, Helvetica, sans-serif">`
    + `<rect width="${W}" height="${H}" fill="#fff"/><text x="40" y="44" font-size="20" font-weight="700" fill="#111">Lighting plot — ${esc(title)}</text>`
    + `<text x="40" y="64" font-size="12" fill="#666">EVE Tools for ComfyUI · top-down, camera side at the bottom</text>`
    + set + units + cams + `<circle cx="${cx}" cy="${cy}" r="3" fill="#111"/>` + bar + table + `</svg>`;
}

const FPS = 24;
function tc(frames: number, hour = 0): string {
  const f = frames % FPS, s = Math.floor(frames / FPS) % 60, m = Math.floor(frames / FPS / 60) % 60, h = hour + Math.floor(frames / FPS / 3600);
  return [h, m, s, f].map((v) => String(v).padStart(2, "0")).join(":");
}

export interface EdlEvent {
  index: number;
  /** Source in / out, seconds into the take. */
  srcIn: number;
  srcOut: number;
  file: string;
}

/**
 * CMX3600 EDL of the cut: one video event per shot, reel = shot ID. With a
 * crossfade each dissolve takes x frames (never more than half of either
 * shot): the outgoing event ends x frames early, and the dissolve event
 * opens with the outgoing reel at its last x frames — records never overlap,
 * and the total matches what Play shows.
 */
export function edl(events: EdlEvent[], crossfadeFrames = 0, title = "EVE SET SC1"): string {
  const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
  const src = events.map((e) => ({ inF: Math.round(e.srcIn * FPS), outF: Math.round(e.srcOut * FPS) }));
  const len = src.map((s) => s.outF - s.inF);
  const xs = len.map((l, i) => (crossfadeFrames > 0 && i > 0 ? Math.max(0, Math.min(crossfadeFrames, Math.floor(l / 2), Math.floor(len[i - 1] / 2))) : 0));
  let rec = 0;
  events.forEach((e, i) => {
    const n = String(i + 1).padStart(3, "0");
    const reel = slate(e.index).padEnd(8, " ");
    // This event stops where the dissolve into the next one begins.
    const out = src[i].outF - (xs[i + 1] ?? 0);
    const dur = out - src[i].inF;
    if (xs[i] > 0) {
      const prev = events[i - 1], prevOut = src[i - 1].outF - xs[i];
      lines.push(`${n}  ${slate(prev.index).padEnd(8, " ")} V     C        ${tc(prevOut)} ${tc(prevOut)} ${tc(rec, 1)} ${tc(rec, 1)}`);
      lines.push(`${n}  ${reel} V     D    ${String(xs[i]).padStart(3, "0")} ${tc(src[i].inF)} ${tc(out)} ${tc(rec, 1)} ${tc(rec + dur, 1)}`);
      lines.push(`* FROM CLIP NAME: ${prev.file}`, `* TO CLIP NAME: ${e.file}`, "");
    } else {
      lines.push(`${n}  ${reel} V     C        ${tc(src[i].inF)} ${tc(out)} ${tc(rec, 1)} ${tc(rec + dur, 1)}`);
      lines.push(`* FROM CLIP NAME: ${e.file}`, "");
    }
    rec += dur;
  });
  return lines.join("\r\n");
}

export function download(data: Blob | string, name: string, type = "text/plain") {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
