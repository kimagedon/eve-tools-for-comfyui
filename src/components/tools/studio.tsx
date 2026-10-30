/**
 * The studio — the one stage every step of the set opens into. A dark stage,
 * the work drawn on the photo itself, a glow in the theme's colours while
 * the model works, the answer decoded first and revealed with
 * opacity/transform only, and one info line —
 * "model · in → out · host · time" — that never leaves.
 *
 * Each step is its own component composing these pieces: it owns what is
 * drawn on the stage and the controls under it; the studio owns running,
 * the phases and the chrome. The stepper and the server status come from
 * the app through `ChromeContext`.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LensMark, scrub } from "@/components/ui/cine";
import { CONNECT_NOTE, askForServer, isOfflineError } from "@/lib/samples-offline";

export type Phase =
  | { kind: "edit" }
  | { kind: "running"; started: number; note?: string }
  | { kind: "done"; src: string; size?: { w: number; h: number }; label: string }
  | { kind: "failed"; error: string };

export type Rect = { x: number; y: number; w: number; h: number };

/** What every step gets from the app: the photo it works on and where its answer goes. */
export interface StudioProps {
  /** The image to work on: the uploaded photo, or the previous step's answer. */
  source: () => Promise<Blob>;
  /** The step's answer, handed on down the chain. */
  onResult?: (result: Blob) => void;
  /** On to the next step. */
  onNext?: () => void;
}

/** App-level chrome drawn in every studio's title bar. */
export interface Chrome {
  /** The step switcher, centred in the title bar. */
  stepper?: React.ReactNode;
  /** Right side of the title bar: server status, theme. */
  right?: React.ReactNode;
  /** The host the model runs on, for the info line. */
  host?: string;
  /** Back to the landing; the project stays saved. */
  onHome?: () => void;
}
export const ChromeContext = createContext<Chrome>({});

/** The photo's bytes, object URL and natural size. */
export function useStudioSource(source: () => Promise<Blob>) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    source().then(async (b) => {
      const bitmap = await createImageBitmap(b);
      const dims = { w: bitmap.width, h: bitmap.height };
      bitmap.close();
      if (!alive) return;
      made = URL.createObjectURL(b);
      setBlob(b); setUrl(made); setSize(dims);
    }).catch((error) => { if (alive) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [source]);
  return { blob, url, size, loadError };
}

/** The stage element and its size. */
export function useStage() {
  const ref = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, stage };
}

/** A rect of aspect w:h fitted into the stage (fractions of it), centred. */
export function fitRect(stage: { w: number; h: number }, w: number, h: number, fw = 0.88, fh = 0.84): Rect {
  const k = Math.min((stage.w * fw) / w, (stage.h * fh) / h);
  return { w: w * k, h: h * k, x: (stage.w - w * k) / 2, y: (stage.h - h * k) / 2 };
}

/** What a run is doing, in the app's own words (the action button's label → its -ing form). */
const VERB: Record<string, string> = { Extend: "Extending", Relight: "Relighting", Shoot: "Rendering" };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Phases, the run itself and the reveal. `job` does the work (usually a
 * ComfyUI graph) and resolves with the answer; `check` may reject it (an
 * empty fill) with a reason.
 */
export function useStudioRun(label: string, onResult?: (result: Blob) => void) {
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const editing = phase.kind === "edit" || phase.kind === "failed";
  const resultUrl = useRef<string | null>(null);
  const resultBlob = useRef<Blob | null>(null);
  useEffect(() => () => { if (resultUrl.current) URL.revokeObjectURL(resultUrl.current); }, []);

  // Each run gets a token; Back while running bumps it, so a late answer
  // never takes over the screen the user has moved on to.
  const token = useRef(0);
  const back = useCallback(() => { token.current++; setPhase({ kind: "edit" }); }, []);

  const run = useCallback(async (job: () => Promise<Blob>, check?: (result: Blob) => Promise<string | null>) => {
    const mine = ++token.current;
    const started = performance.now();
    setPhase({ kind: "running", started });
    try {
      const b = await job();
      if (mine !== token.current) return;
      const refused = check ? await check(b).catch(() => null) : null;
      if (refused) { setPhase({ kind: "failed", error: refused }); return; }
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
      resultUrl.current = URL.createObjectURL(b);
      resultBlob.current = b;
      const bmp = await createImageBitmap(b).catch(() => null);
      const size = bmp ? { w: bmp.width, h: bmp.height } : undefined;
      bmp?.close();
      // Decode now: a multi-megapixel image decoded on first paint stalls the reveal.
      const pre = new Image();
      pre.src = resultUrl.current;
      await pre.decode().catch(() => {});
      if (mine !== token.current) return;
      setPhase({ kind: "done", src: resultUrl.current, size, label: `${label} · ${seconds(performance.now() - started)}` });
      onResult?.(b);
    } catch (error) {
      if (mine !== token.current) return;
      if (isOfflineError(error)) askForServer();
      setPhase({ kind: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }, [label, onResult]);

  // Reveal: the decoded result fades in and settles from a hair larger —
  // opacity and transform only, so the compositor runs it without stalls.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (phase.kind !== "done") { setRevealed(false); return; }
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setRevealed(true)));
    return () => cancelAnimationFrame(raf);
  }, [phase.kind]);

  // How many prompts are ahead in the ComfyUI queue (0 once this one runs).
  const [ahead, setAhead] = useState(0);
  const onQueue = useCallback((n: number) => setAhead(n), []);
  useEffect(() => { if (phase.kind !== "running") setAhead(0); }, [phase.kind]);
  return { phase, setPhase, editing, run, revealed, result: () => resultBlob.current, back, ahead, onQueue };
}

/** Seconds since `started`, ticking while a run is in flight. */
function useElapsed(phase: Phase) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (phase.kind !== "running") return;
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [phase.kind]);
  return phase.kind === "running" ? seconds(Math.max(0, now - phase.started)) : null;
}

/** The theme-coloured glow around `rect` while running; fades out on the answer. */
export function StudioGlow({ phase, rect }: { phase: Phase; rect: Rect; label?: string }) {
  if (phase.kind !== "running" && phase.kind !== "done") return null;
  return (
    <>
    {/* The fade lives on a wrapper: the glow's own breathing animation owns its opacity. */}
    <div aria-hidden className={`pointer-events-none absolute transition-opacity duration-[1200ms] ease-out ${phase.kind === "done" ? "opacity-0" : "opacity-100"}`}
      style={{ left: rect.x - 2, top: rect.y - 2, width: rect.w + 4, height: rect.h + 4 }}>
      <div className="eve-ai-halo"><div className="eve-ai-glow absolute inset-0" /></div>
      <div className="eve-ai-glow absolute inset-0" />
      {/* One anamorphic streak across the frame as the run starts. */}
      {phase.kind === "running" && <div key={phase.started} className="eve-streak" />}
    </div>
    </>
  );
}

/**
 * The answer, revealed in `rect`. With `before` (the photo it came from):
 * a Before / After divider to drag across it — the photo on the left of the
 * line, the result on the right — like Photos' compare.
 */
export function StudioResult({ phase, rect, revealed, before }: { phase: Phase; rect: Rect; revealed: boolean; before?: string | null }) {
  const [split, setSplit] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  if (phase.kind !== "done") return null;
  const at = (event: React.PointerEvent<HTMLDivElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    setSplit(Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)));
  };
  const s = split ?? 0;
  return (
    <div className="absolute will-change-[opacity,transform]"
      style={{
        left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        opacity: revealed ? 1 : 0, transform: revealed ? "scale(1)" : "scale(1.02)",
        transition: "opacity 400ms cubic-bezier(.2,.8,.2,1), transform 600ms cubic-bezier(.2,.8,.2,1)",
        cursor: before ? "ew-resize" : undefined, touchAction: "none",
      }}
      onPointerDown={before ? (e) => { setDragging(true); e.currentTarget.setPointerCapture(e.pointerId); at(e); } : undefined}
      onPointerMove={before ? (e) => { if (dragging) at(e); } : undefined}
      onPointerUp={() => setDragging(false)}
      onDoubleClick={before ? () => setSplit(null) : undefined}>
      <img src={phase.src} alt="" draggable={false} decoding="sync" className="absolute inset-0 h-full w-full object-contain" />
      {before && (
        <>
          <img src={before} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            style={{ clipPath: `inset(0 ${(1 - s) * 100}% 0 0)`, transition: dragging ? "none" : "clip-path 500ms cubic-bezier(.22,1,.36,1)" }} />
          {split !== null && (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]" style={{ left: `${s * 100}%` }}>
              <span className="absolute left-1/2 top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[11px] font-semibold text-black shadow-lg">⇆</span>
            </div>
          )}
          <span className="vf-l pointer-events-none" style={{ left: 10, top: 10, opacity: split !== null && s > 0.08 ? 1 : 0 }}>Before</span>
          <span className="vf-l pointer-events-none" style={{ right: 10, top: 10, opacity: split === null || s < 0.92 ? 1 : 0 }}>After</span>
          {split === null && (
            <button type="button" onClick={(e) => { e.stopPropagation(); setSplit(0.5); }} onPointerDown={(e) => e.stopPropagation()}
              className="eve-press absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[12px] font-medium text-white/90 ring-1 ring-inset ring-white/20 backdrop-blur hover:bg-black/75">Compare</button>
          )}
        </>
      )}
    </div>
  );
}

/** The fitted rect of the answer: its own aspect inside the box the work occupied. */
export function resultRect(phase: Phase, box: Rect): Rect {
  if (phase.kind !== "done" || !phase.size) return box;
  const k = Math.min(box.w / phase.size.w, box.h / phase.size.h);
  const w = phase.size.w * k, h = phase.size.h * k;
  return { w, h, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2 };
}

/** How many to make — one control for every tool (Series frames, variants). */
export function CountPicker({ label, counts, value, onChange }: { label: string; counts: number[]; value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-[11.5px] text-white/60">
      {label}
      <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 min-w-14 cursor-pointer rounded-full bg-white/10 px-2 text-[12px] font-medium tabular-nums text-white outline-none ring-1 ring-inset ring-white/15 focus-visible:ring-white/60"
        style={{ colorScheme: "dark" }}>
        {counts.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

const STAGE_FADE = "linear-gradient(to bottom, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%)";

/** The chrome: title bar with the stepper, stage, controls, info line and the action buttons. */
export function StudioShell({
  label, phase, setPhase, editing, stageRef, stageHandlers, stage, controls,
  prompt, setPrompt, promptPlaceholder, info, canRun, onRun, notice, onBack, backLabel = "Back", next, progress, hideRun, runAria, queue = 0,
}: {
  /** Prompts ahead of this one in the ComfyUI queue. */
  queue?: number;
  /** While running: what is rendering ("Rendering 1B"). */
  progress?: string;
  /** The run button and the step's name ("Extend", "Relight"). */
  label: string;
  phase: Phase;
  setPhase: (p: Phase) => void;
  editing: boolean;
  stageRef: React.RefObject<HTMLDivElement | null>;
  stageHandlers?: React.HTMLAttributes<HTMLDivElement>;
  stage: React.ReactNode;
  /** Step controls above the prompt row (presets, lights, cameras). */
  controls?: React.ReactNode;
  prompt?: string;
  setPrompt?: (v: string) => void;
  promptPlaceholder?: string;
  /** "model · in → out" for the current state. */
  info: string;
  canRun: boolean;
  /** The step shows its own primary action on the stage (Shoot before the first take): no second one here. */
  hideRun?: boolean;
  /** Accessible name for the run button when its label alone is ambiguous. */
  runAria?: string;
  onRun: () => void;
  /** A hint floating over the stage while nothing is set up yet. */
  notice?: string;
  /** While running: back to editing. */
  onBack?: () => void;
  /** The running-state button's word ("Back"; Shoot says "Stop"). */
  backLabel?: string;
  /** After a result (or any time, for steps without a model): on to the next step. */
  next?: { label: string; onClick: () => void; enabled?: boolean };
}) {
  const chrome = useContext(ChromeContext);
  const elapsed = useElapsed(phase);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      if (phase.kind === "done") next?.onClick(); else if (canRun) onRun();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase.kind, canRun, onRun, next]);
  // No HUD: while a model runs, one quiet line says what is rendering and for how long.
  void info;
  return (
    <div className="eve-studio fixed inset-0 flex flex-col bg-black text-white" aria-label={label}>
      {/* Title bar: the mark, the stepper (centred; its own row on a phone), server and theme. */}
      <div className="relative flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-white/[0.07] px-4 py-2.5 md:h-[56px] md:flex-nowrap md:py-0">
        <button type="button" onClick={chrome.onHome} aria-label="Home" title="Home"
          className="eve-press -mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13px] font-semibold tracking-[-0.01em] text-white/90 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30">
          <LensMark size={18} />
          <span className="hidden sm:inline">EVE Tools <span className="font-normal text-white/45">for ComfyUI</span></span>
        </button>
        <div className="order-last flex w-full justify-center md:absolute md:left-1/2 md:order-none md:w-auto md:-translate-x-1/2">{chrome.stepper}</div>
        <div className="flex items-center justify-end gap-2">{chrome.right}</div>
      </div>

      {/* The stage clips, so anything reaching its edge (the glow, Extend's
          growth) fades out over the last few pixels instead of ending in a line. */}
      <div ref={stageRef} className="relative min-h-0 flex-1 select-none overflow-hidden" {...stageHandlers}
        style={{ maskImage: STAGE_FADE, WebkitMaskImage: STAGE_FADE }}>
        {stage}
        {notice && editing && (
          <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-[12px] text-white/85">{notice}</div>
        )}
      </div>

      {/* Fixed heights all the way down, so switching step or phase never
          resizes the stage and nothing on it jumps. */}
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-white/[0.07] px-4 pb-4 pt-3">
        <div className="flex h-[72px] w-full max-w-[1180px] items-center justify-start gap-x-4 gap-y-2 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:content-center md:justify-center md:overflow-hidden"
          style={{ visibility: editing && controls ? "visible" : "hidden" }}>
          {controls}
        </div>
        <div className="flex h-9 w-full max-w-[860px] items-center gap-3">
          {editing && setPrompt ? (
            <input value={prompt ?? ""} onChange={(e) => setPrompt(e.target.value)} placeholder={promptPlaceholder}
              className="h-9 min-w-0 flex-1 rounded-full bg-white/[0.06] px-4 text-[12.5px] text-white outline-none ring-1 ring-inset ring-white/[0.12] transition-shadow duration-200 placeholder:text-white/35 focus-visible:ring-white/40" />
          ) : <div className="flex-1" />}
          <div className="relative z-10 flex shrink-0 items-center gap-3">
            
            {phase.kind === "running" && <span aria-live="polite" className="eve-shimmer whitespace-nowrap text-[13px] tabular-nums">{queue > 0 ? `In queue · ${queue} ahead` : <>{progress ?? `${VERB[label] ?? "Working"}…`} {elapsed}</>}</span>}
            {phase.kind === "failed" && (isOfflineError(phase.error)
              // No server is not an error: one calm line; the server pill lights up.
              ? <span className="max-w-[360px] truncate text-[11.5px] text-white/60" title={CONNECT_NOTE}><span className="sm:hidden">Connect a ComfyUI server</span><span className="hidden sm:inline">{CONNECT_NOTE}</span></span>
              : <span className="max-w-[360px] truncate text-[11.5px] text-red-400" title={scrub(phase.error)}>{scrub(phase.error)}</span>)}
            {phase.kind === "done" ? (
              <>
                <button type="button" onClick={() => setPhase({ kind: "edit" })}
                  className="eve-press shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-[13px] font-medium text-white/85 ring-1 ring-inset ring-white/25 hover:bg-white/10">Back</button>
                {next && (
                  <button type="button" onClick={next.onClick} className="eve-press shrink-0 whitespace-nowrap rounded-full bg-white px-5 py-1.5 text-[13px] font-semibold text-black hover:bg-white/90">{next.label}</button>
                )}
              </>
            ) : (
              <>
                {phase.kind === "running" && onBack && (
                  <button type="button" onClick={onBack} title={backLabel === "Back" ? "Back to editing" : backLabel}
                    className="eve-press shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-[13px] font-medium text-white/85 ring-1 ring-inset ring-white/25 hover:bg-white/10">{backLabel}</button>
                )}
                {next && next.enabled !== false && phase.kind !== "running" && (
                  <button type="button" onClick={next.onClick}
                    className="eve-press shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-[13px] font-medium text-white/85 ring-1 ring-inset ring-white/25 hover:bg-white/10">{next.label}</button>
                )}
                {!hideRun && <button type="button" onClick={onRun} disabled={!canRun} aria-label={runAria}
                  className={`eve-press flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-5 py-1.5 text-[13px] font-semibold text-black transition-opacity hover:bg-white/90 ${phase.kind === "running" ? "" : "disabled:opacity-30"}`}>
                  {phase.kind === "failed" ? "Try again" : label}
                </button>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A loader / error over the stage until the photo is in. */
export function StageState({ size, loadError }: { size: unknown; loadError: string | null }) {
  if (loadError) return <div className="absolute inset-0 flex items-center justify-center text-[13px] text-red-400">{loadError}</div>;
  if (!size) return <div className="absolute inset-0 flex items-center justify-center"><span className="eve-shimmer text-[13px]">Loading…</span></div>;
  return null;
}
