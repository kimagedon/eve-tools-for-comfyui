
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GrowLayers } from "./grow-layers";
import { RotateCcw } from "lucide-react";
import { encodeSides, type ExtendSides, type ParamValues } from "@/lib/extend";
import { compositeFill, prepareOutpaintCanvas } from "@/lib/extend-fill";
import { widenPrompt } from "@/prompts";
import { runOutpaint } from "@/comfy";
import { StageState, StudioGlow, StudioResult, StudioShell, useStage, useStudioRun, useStudioSource, type StudioProps } from "@/components/tools/studio";

/**
 * Extend, the way Photos crops — but outwards. The photo sits in a frame;
 * dragging the frame's edges or corners out grows the canvas, dragging the
 * photo moves it inside the canvas. A shape preset locks the frame's ratio.
 * While the model works the frame glows; the answer is revealed from the
 * original outwards, in place: the edit model fills a grey canvas, then the
 * original is found in its answer and laid back pixel for pixel.
 */

type Handle = "l" | "r" | "t" | "b" | "tl" | "tr" | "bl" | "br" | "move";

/** The formats a camera department frames for; `pill` ones sit in the bar, the rest under More. */
const PRESETS: { id: string; label: string; name?: string; ratio?: number; pill?: boolean }[] = [
  { id: "scope", label: "2.39", name: "Scope", ratio: 2.39, pill: true },
  { id: "1.85", label: "1.85", name: "Flat", ratio: 1.85, pill: true },
  { id: "16:9", label: "16:9", name: "HD", ratio: 16 / 9, pill: true },
  { id: "2.00", label: "2.00", name: "Univisium", ratio: 2, pill: true },
  { id: "free", label: "Free", pill: true },
  { id: "2.76", label: "2.76:1", name: "Ultra Panavision 70", ratio: 2.76 },
  { id: "1.90", label: "1.90:1", name: "IMAX Digital", ratio: 1.9 },
  { id: "1.43", label: "1.43:1", name: "IMAX 70mm", ratio: 1.43 },
  { id: "3:2", label: "3:2", name: "Full Frame (stills)", ratio: 3 / 2 },
  { id: "4:3", label: "4:3", name: "Academy 1.33", ratio: 4 / 3 },
  { id: "1.66", label: "1.66:1", name: "European", ratio: 1.66 },
  { id: "1:1", label: "1:1", name: "Square", ratio: 1 },
  { id: "4:5", label: "4:5", name: "Portrait", ratio: 4 / 5 },
  { id: "9:16", label: "9:16", name: "Vertical", ratio: 9 / 16 },
];
/** No side grows past this many source widths / heights. */
const MAX_SIDE = 2;
const NONE: ExtendSides = { left: 0, top: 0, right: 0, bottom: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Extra room (in source units) split between two sides in their current proportion. */
function split(total: number, a: number, b: number): [number, number] {
  const sum = a + b;
  const share = sum > 1e-6 ? a / sum : 0.5;
  return [total * share, total * (1 - share)];
}

/**
 * Sides (fractions of the source) whose canvas has `ratio`. The axis the
 * user is dragging keeps its value; the other one follows, never shrinking
 * below the source.
 */
function lockRatio(s: ExtendSides, ratio: number, w: number, h: number, drive: "x" | "y"): ExtendSides {
  let cw = w * (1 + s.left + s.right);
  let ch = h * (1 + s.top + s.bottom);
  if (drive === "x") ch = cw / ratio; else cw = ch * ratio;
  if (cw < w) { cw = w; ch = cw / ratio; }
  if (ch < h) { ch = h; cw = ch * ratio; }
  const [l, r] = split(cw / w - 1, s.left, s.right);
  const [t, b] = split(ch / h - 1, s.top, s.bottom);
  return { left: l, right: r, top: t, bottom: b };
}

/** The smallest canvas of `ratio` around the source, centred — or 20% room when the shape is the source's own. */
function presetSides(ratio: number, w: number, h: number): ExtendSides {
  const src = w / h;
  if (Math.abs(src - ratio) < 0.01) return { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 };
  if (ratio > src) { const x = (h * ratio / w - 1) / 2; return { left: x, right: x, top: 0, bottom: 0 }; }
  const y = (w / ratio / h - 1) / 2;
  return { left: 0, right: 0, top: y, bottom: y };
}

/**
 * True when the room around the original came back as one flat colour —
 * a model that declined to fill it and answered with the grey canvas.
 */
async function emptyFill(result: Blob, s: ExtendSides): Promise<boolean> {
  const bitmap = await createImageBitmap(result);
  const w = 160, h = Math.max(1, Math.round((160 * bitmap.height) / bitmap.width));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) { bitmap.close(); return false; }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const data = ctx.getImageData(0, 0, w, h).data;
  // The source's rect in the result, grown a little so its edge is not sampled.
  const cw = 1 + s.left + s.right, ch = 1 + s.top + s.bottom;
  const x0 = (s.left / cw) * w - 2, x1 = ((s.left + 1) / cw) * w + 2;
  const y0 = (s.top / ch) * h - 2, y1 = ((s.top + 1) / ch) * h + 2;
  const lum: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
    const i = (y * w + x) * 4;
    lum.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
  }
  if (lum.length < 40) return false;
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  const sd = Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length);
  return sd < 3;
}

/** CSS mask that feathers the photo's border on the sides that grow. */
function featherMask(sides: ExtendSides, w: number, h: number): string | undefined {
  const f = Math.max(10, Math.min(w, h) * 0.08);
  const fl = sides.left > 0.002 ? f : 0, fr = sides.right > 0.002 ? f : 0;
  const ft = sides.top > 0.002 ? f : 0, fb = sides.bottom > 0.002 ? f : 0;
  if (!fl && !fr && !ft && !fb) return undefined;
  return `linear-gradient(to right, transparent 0, #000 ${fl}px, #000 calc(100% - ${fr}px), transparent 100%), `
    + `linear-gradient(to bottom, transparent 0, #000 ${ft}px, #000 calc(100% - ${fb}px), transparent 100%)`;
}

export function ExtendStudio({ source, onResult, onNext }: StudioProps) {
  const { blob, url, size, loadError } = useStudioSource(source);
  const { phase, setPhase, editing, run: runJob, revealed, back, ahead, onQueue } = useStudioRun("Qwen-Image-Edit", onResult);
  const [sides, setSides] = useState<ExtendSides>(NONE);
  const [preset, setPreset] = useState("scope");
  const [more, setMore] = useState<{ left: number; bottom: number } | null>(null);
  const [prompt, setPrompt] = useState("");
  const { ref: stageRef, stage } = useStage();
  // Once the answer has faded in, the growing room under it goes: it never
  // stops moving, and any edge of it left uncovered reads as the result.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (phase.kind !== "done" || !revealed) { setSettled(false); return; }
    const timer = setTimeout(() => setSettled(true), 950);
    return () => clearTimeout(timer);
  }, [phase.kind, revealed]);

  const W = size?.w ?? 1, H = size?.h ?? 1;
  const cw = W * (1 + sides.left + sides.right);
  const ch = H * (1 + sides.top + sides.bottom);
  // The view zooms to the new canvas only when a drag ends, so the edge
  // under the pointer never runs away from it mid-drag.
  const fitFor = useCallback((s: ExtendSides) => {
    if (!stage.w || !size) return 1;
    const w = size.w * (1 + s.left + s.right), h = size.h * (1 + s.top + s.bottom);
    // Room around the frame to keep dragging; the source never drawn larger than ~half the stage.
    return Math.min(stage.w * 0.86 / w, stage.h * 0.82 / h, stage.w * 0.5 / size.w, stage.h * 0.56 / size.h);
  }, [stage.w, stage.h, size]);
  const [scale, setScale] = useState(1);
  const [dragging, setDragging] = useState<Handle | null>(null);
  useLayoutEffect(() => { if (!dragging) setScale(fitFor(sides)); }, [fitFor, sides, dragging]);

  // `pin` is where the photo (or, when moving the photo, the frame) stays
  // on screen for the whole drag, so the grabbed edge follows the pointer.
  const [drag, setDrag] = useState<{ handle: Handle; x: number; y: number; start: ExtendSides; scale: number; pin: { x: number; y: number } } | null>(null);
  // How hard the frame is being pulled: pointer speed, smoothed. The room
  // lights up and its edge stirs with it, then settles on release.
  const [energy, setEnergy] = useState(0);
  // Pointer events arrive faster than frames: the latest one is kept in refs and
  // committed once per animation frame, so React renders at most once per frame.
  const last = useRef<{ x: number; y: number; t: number } | null>(null);
  const pending = useRef<{ sides: ExtendSides; energy: number } | null>(null);
  const frameReq = useRef(0);
  const commit = (sides: ExtendSides, e: number) => {
    pending.current = { sides, energy: e };
    if (frameReq.current) return;
    frameReq.current = requestAnimationFrame(() => {
      frameReq.current = 0;
      const p = pending.current;
      if (p) { setSides(p.sides); setEnergy(p.energy); }
    });
  };
  const energyNow = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frameReq.current), []);
  // Centred at rest; pinned while dragging (see `drag.pin`), re-centred with a glide on release.
  const lx = sides.left * W * scale, ty = sides.top * H * scale;
  const pinned = drag?.pin;
  const fx = !pinned ? (stage.w - cw * scale) / 2 : drag.handle === "move" ? pinned.x : pinned.x - lx;
  const fy = !pinned ? (stage.h - ch * scale) / 2 : drag.handle === "move" ? pinned.y : pinned.y - ty;
  const frame = { w: cw * scale, h: ch * scale, x: fx, y: fy };
  const photo = { x: frame.x + lx, y: frame.y + ty, w: W * scale, h: H * scale };

  const ratio = PRESETS.find((p) => p.id === preset)?.ratio;
  const begin = (handle: Handle, event: React.PointerEvent) => {
    if (!editing || !size) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({ handle, x: event.clientX, y: event.clientY, start: sides, scale, pin: handle === "move" ? { x: frame.x, y: frame.y } : { x: photo.x, y: photo.y } });
    setDragging(handle);
    if (phase.kind === "failed") setPhase({ kind: "edit" });
  };
  const move = (event: React.PointerEvent) => {
    const d = drag;
    if (!d || !size) return;
    const now = performance.now(), l = last.current;
    if (l && now > l.t) {
      const speed = Math.hypot(event.clientX - l.x, event.clientY - l.y) / ((now - l.t) / 1000);
      energyNow.current = energyNow.current * 0.6 + Math.min(1, 0.25 + speed / 1400) * 0.4;
    }
    last.current = { x: event.clientX, y: event.clientY, t: now };
    const dx = (event.clientX - d.x) / d.scale / W;
    const dy = (event.clientY - d.y) / d.scale / H;
    const s = d.start;
    const sym = event.altKey;
    let next: ExtendSides = { ...s };
    if (d.handle === "move") {
      const left = clamp(s.left + dx, 0, s.left + s.right);
      const top = clamp(s.top + dy, 0, s.top + s.bottom);
      commit({ left, right: s.left + s.right - left, top, bottom: s.top + s.bottom - top }, energyNow.current);
      return;
    }
    const h = d.handle;
    if (h.includes("l")) { next.left = clamp(s.left - dx, 0, MAX_SIDE); if (sym) next.right = next.left; }
    if (h.includes("r")) { next.right = clamp(s.right + dx, 0, MAX_SIDE); if (sym) next.left = next.right; }
    if (h.includes("t")) { next.top = clamp(s.top - dy, 0, MAX_SIDE); if (sym) next.bottom = next.top; }
    if (h.includes("b")) { next.bottom = clamp(s.bottom + dy, 0, MAX_SIDE); if (sym) next.top = next.bottom; }
    // Shift temporarily locks the canvas proportions captured at drag start.
    const resizeRatio = ratio ?? (event.shiftKey ? W * (1 + s.left + s.right) / (H * (1 + s.top + s.bottom)) : undefined);
    if (resizeRatio) {
      const horizontal = h === "l" || h === "r";
      const vertical = h === "t" || h === "b";
      // A corner follows whichever axis the pointer moved further along.
      const driveX = horizontal || (!vertical && Math.abs(dx * W) >= Math.abs(dy * H));
      next = lockRatio(next, resizeRatio, W, H, driveX ? "x" : "y");
    }
    commit(next, energyNow.current);
  };
  const end = () => {
    // The last pending frame lands first, then the drag ends.
    if (frameReq.current) { cancelAnimationFrame(frameReq.current); frameReq.current = 0; if (pending.current) setSides(pending.current.sides); }
    pending.current = null; last.current = null; energyNow.current = 0;
    setDrag(null); setDragging(null); setEnergy(0);
  };

  const choosePreset = (id: string) => {
    setPreset(id);
    if (phase.kind === "failed") setPhase({ kind: "edit" });
    const r = PRESETS.find((p) => p.id === id)?.ratio;
    if (r && size) setSides(presetSides(r, W, H));
  };
  const reset = () => { setSides(NONE); setPreset("free"); setPhase({ kind: "edit" }); };
  // The default shape, Scope, is set as soon as the photo's size is known.
  useEffect(() => {
    if (!size) return;
    const r = PRESETS.find((p) => p.id === "scope")?.ratio;
    if (r) setSides(presetSides(r, size.w, size.h));
  }, [size]);

  const params = useMemo<ParamValues>(() => ({ ratio: "source", room: 0, sides: encodeSides(sides), prompt: prompt.trim() }), [sides, prompt]);
  const grown = sides.left + sides.right + sides.top + sides.bottom > 0.004;
  const canRun = editing && !!blob && grown;
  const run = () => {
    if (!canRun || !blob) return;
    const drawn = sides;
    void runJob(async () => {
      const sent = await prepareOutpaintCanvas(blob, params);
      const answer = await runOutpaint(sent, blob, widenPrompt(params.prompt), { priority: "high", onQueue });
      // The outpaint graph keeps the original where the canvas put it: map back exactly.
      return compositeFill(answer, blob, params, undefined, undefined, { exact: true });
    }, async (b) => (await emptyFill(b, drawn)) ? "The model returned the new area empty — try again" : null);
  };

  const outW = Math.round(cw), outH = Math.round(ch);
  const handles: { id: Handle; style: React.CSSProperties; cursor: string }[] = [
    { id: "l", style: { left: -10, top: 18, bottom: 18, width: 20 }, cursor: "ew-resize" },
    { id: "r", style: { right: -10, top: 18, bottom: 18, width: 20 }, cursor: "ew-resize" },
    { id: "t", style: { top: -10, left: 18, right: 18, height: 20 }, cursor: "ns-resize" },
    { id: "b", style: { bottom: -10, left: 18, right: 18, height: 20 }, cursor: "ns-resize" },
    { id: "tl", style: { left: -12, top: -12, width: 30, height: 30 }, cursor: "nwse-resize" },
    { id: "tr", style: { right: -12, top: -12, width: 30, height: 30 }, cursor: "nesw-resize" },
    { id: "bl", style: { left: -12, bottom: -12, width: 30, height: 30 }, cursor: "nesw-resize" },
    { id: "br", style: { right: -12, bottom: -12, width: 30, height: 30 }, cursor: "nwse-resize" },
  ];
  const animate = dragging ? "" : "transition-[left,top,width,height] duration-300 ease-[cubic-bezier(.2,.8,.2,1)]";
  const info = phase.kind === "done" && phase.size ? `${phase.size.w}×${phase.size.h}` : `${outW}×${outH}`;

  const stageContent = (
    <>
      <StageState size={size} loadError={loadError} />
      {size && url && stage.w > 0 && (
        <>
          <StudioGlow phase={phase} rect={frame} />
          {/* The new canvas: the photo growing into it */}
          {!settled && <div className={`absolute overflow-hidden bg-[#0a0a0a] ${animate}`} style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
            <GrowLayers url={url} photo={{ x: photo.x - frame.x, y: photo.y - frame.y, w: photo.w, h: photo.h }} running={phase.kind === "running" || phase.kind === "done"} energy={energy} />
          </div>}
          {/* The photo; drag it to move it inside the canvas */}
          {!settled && <img src={url} alt="" draggable={false} onPointerDown={(event) => begin("move", event)}
            className={`absolute ${animate} ${editing && grown ? "cursor-grab active:cursor-grabbing" : ""}`}
            style={{ left: photo.x, top: photo.y, width: photo.w, height: photo.h, ...(() => {
              const m = featherMask(sides, photo.w, photo.h);
              return m ? { WebkitMaskImage: m, maskImage: m, WebkitMaskComposite: "source-in", maskComposite: "intersect" } as React.CSSProperties : {};
            })() }} />}
          <StudioResult phase={phase} rect={frame} revealed={revealed} />
          {/* Frame, thirds while dragging, handles */}
          <div className={`pointer-events-none absolute ${animate}`} style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
            <div className="absolute inset-0 ring-1 ring-white/85" />
            {dragging && dragging !== "move" && (
              <div className="absolute inset-0">
                {[1, 2].map((i) => <div key={`v${i}`} className="absolute bottom-0 top-0 w-px bg-white/35" style={{ left: `${(i * 100) / 3}%` }} />)}
                {[1, 2].map((i) => <div key={`h${i}`} className="absolute left-0 right-0 h-px bg-white/35" style={{ top: `${(i * 100) / 3}%` }} />)}
              </div>
            )}
            {editing && (["tl", "tr", "bl", "br"] as const).map((c) => (
              <div key={c} className="absolute h-5 w-5 border-white" style={{
                [c.includes("t") ? "top" : "bottom"]: -3, [c.includes("l") ? "left" : "right"]: -3,
                borderTopWidth: c.includes("t") ? 3 : 0, borderBottomWidth: c.includes("b") ? 3 : 0,
                borderLeftWidth: c.includes("l") ? 3 : 0, borderRightWidth: c.includes("r") ? 3 : 0,
              }} />
            ))}
            {editing && (["l", "r", "t", "b"] as const).map((e) => (
              <div key={e} className="absolute bg-white" style={e === "l" || e === "r"
                ? { [e === "l" ? "left" : "right"]: -3, top: "50%", width: 3, height: 22, marginTop: -11 }
                : { [e === "t" ? "top" : "bottom"]: -3, left: "50%", height: 3, width: 22, marginLeft: -11 }} />
            ))}
            {dragging && (
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/70 px-2.5 py-1 font-mono text-[10.5px] tabular-nums tracking-[0.06em] text-white/85">
                {outW} × {outH}
              </div>
            )}
          </div>
          {editing && handles.map(({ id, style, cursor }) => (
            <div key={id} onPointerDown={(event) => begin(id, event)} className={`absolute ${animate}`}
              style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h, pointerEvents: "none" }}>
              <div className="absolute" style={{ ...style, cursor, pointerEvents: "auto", touchAction: "none" }} />
            </div>
          ))}
        </>
      )}
    </>
  );

  const current = PRESETS.find((p) => p.id === preset);
  const pillCls = (on: boolean) => `shrink-0 rounded-full px-3 py-1 text-[12px] font-medium tabular-nums ring-1 ring-inset transition-colors ${on ? "bg-white text-black ring-white" : "text-white/75 ring-white/20 hover:bg-white/10 hover:text-white"}`;
  const controls = (
    <div role="radiogroup" aria-label="Format" className="flex max-w-full items-center gap-1 overflow-x-auto">
      {PRESETS.filter((p) => p.pill).map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} title={p.name} onClick={() => choosePreset(p.id)} className={pillCls(preset === p.id)}>
          {p.label}
        </button>
      ))}
      <button type="button" aria-haspopup="menu" aria-expanded={!!more} className={pillCls(!!current && !current.pill)}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMore((m) => (m ? null : { left: r.left, bottom: window.innerHeight - r.top + 8 })); }}>
        {current && !current.pill ? current.label : "More"}
      </button>
      {more && (
        <>
          <div aria-hidden className="fixed inset-0 z-[10070]" onClick={() => setMore(null)} />
          <div role="menu" aria-label="More formats" className="eve-hub-in fixed z-[10080] w-[240px] rounded-2xl bg-[#111]/95 p-1.5 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl" style={more}>
            {PRESETS.filter((p) => !p.pill).map((p) => (
              <button key={p.id} type="button" role="menuitemradio" aria-checked={preset === p.id} onClick={() => { setMore(null); choosePreset(p.id); }}
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] hover:bg-white/[0.08] ${preset === p.id ? "text-white" : "text-white/75"}`}>
                <span className="tabular-nums">{p.label}</span><span className="text-[11.5px] text-white/45">{p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <button type="button" onClick={reset} title="Reset" aria-label="Reset"
        className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/70 ring-1 ring-inset ring-white/20 hover:bg-white/10 hover:text-white">
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
    </div>
  );


  return (
    <StudioShell label="Extend" queue={ahead} onBack={back} phase={phase} setPhase={setPhase} editing={editing}
      stageRef={stageRef} stageHandlers={{ onPointerMove: move, onPointerUp: end, onPointerCancel: end }}
      stage={stageContent} controls={controls}
      prompt={prompt} setPrompt={setPrompt} promptPlaceholder="Beyond the frame (optional)"
      info={info} canRun={canRun} onRun={run}
      next={onNext ? { label: phase.kind === "done" ? "Light →" : "Skip to Light →", onClick: onNext } : undefined} />
  );
}
