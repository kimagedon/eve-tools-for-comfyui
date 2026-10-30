/**
 * The edit: shots played in order on one canvas — clips, or stills held
 * with a slow push when a clip could not be made — hard cuts by default,
 * crossfades on request. Each clip carries its own sound, cut with the picture. The same loop drives Play and Export, so what is exported is
 * exactly what was watched. Export records the canvas with MediaRecorder:
 * MP4 where the browser can, WebM otherwise.
 */

export interface SequenceClip {
  kind: "video" | "image";
  src: string;
  /** Trim as fractions of the source's length. */
  trim: [number, number];
  /** False: the clip is silent in the mix. */
  audio?: boolean;
}

/** How long a still holds before trim, seconds. */
export const STILL_SECONDS = 3;
export const CROSSFADE = 0.5;

type Loaded = { el: HTMLVideoElement | HTMLImageElement; video: boolean; in: number; dur: number; start: number; w: number; h: number; x: number; gain?: GainNode };

/** The dissolve into each shot: the crossfade, never more than half of either shot, so the cut never runs backwards. */
export function dissolves(durations: number[], crossfade: boolean): number[] {
  return durations.map((d, i) => (crossfade && i > 0 ? Math.min(CROSSFADE, d / 2, durations[i - 1] / 2) : 0));
}

async function load(clip: SequenceClip): Promise<Omit<Loaded, "start" | "x" | "gain">> {
  if (clip.kind === "image") {
    const img = new Image();
    img.src = clip.src;
    await img.decode();
    const full = STILL_SECONDS;
    return { el: img, video: false, in: clip.trim[0] * full, dur: Math.max(0.3, (clip.trim[1] - clip.trim[0]) * full), w: img.naturalWidth, h: img.naturalHeight };
  }
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = clip.src;
  await new Promise<void>((resolve, reject) => { v.onloadedmetadata = () => resolve(); v.onerror = () => reject(new Error("A clip could not be read")); });
  const full = v.duration || STILL_SECONDS;
  const at = clip.trim[0] * full;
  v.currentTime = at;
  await new Promise<void>((resolve) => { v.onseeked = () => resolve(); setTimeout(resolve, 800); });
  return { el: v, video: true, in: at, dur: Math.max(0.3, (clip.trim[1] - clip.trim[0]) * full), w: v.videoWidth, h: v.videoHeight };
}

/** Cover-fit `el` into the canvas, scaled by `zoom` round the centre. */
function draw(ctx: CanvasRenderingContext2D, l: Loaded, zoom: number) {
  const { width: W, height: H } = ctx.canvas;
  const k = Math.max(W / l.w, H / l.h) * zoom;
  const w = l.w * k, h = l.h * k;
  ctx.drawImage(l.el, (W - w) / 2, (H - h) / 2, w, h);
}

export interface PlayOptions {
  crossfade: boolean;
  signal?: AbortSignal;
  /** Seconds played and the total. */
  onTime?: (t: number, total: number) => void;
  /** Every clip is loaded; the first frame is next. */
  onStart?: () => void;
  /** Export: the clips' sound goes here (crossfaded with the picture) instead of the speakers. */
  audio?: { ctx: AudioContext; dest: MediaStreamAudioDestinationNode };
  /** Playback: the clips' sound on the speakers (clips marked silent stay silent). */
  sound?: boolean;
  /** The browser refused sound without a click: playback went on muted. */
  onMuted?: () => void;
  /** The shot on screen changed (index into `clips`). */
  onShot?: (i: number) => void;
  /** Start at this shot. */
  from?: number;
  /** Delivery aspect (width / height): the canvas is this frame and every shot is cover-fitted into it, never stretched. Default: the first shot's own. */
  aspect?: number;
  /** Handles for the running sequence: jump to a shot, turn the sound on. */
  control?: (c: SequenceControl) => void;
}

export interface SequenceControl {
  seek: (i: number) => void;
  unmute: () => void;
}

/** Plays the clips on `canvas`, resolving when the sequence ends or is stopped. */
export async function playSequence(canvas: HTMLCanvasElement, clips: SequenceClip[], o: PlayOptions): Promise<void> {
  if (!clips.length) return;
  const loaded = (await Promise.all(clips.map(load))) as Loaded[];
  // Stopped while loading: no resize, no start.
  if (o.signal?.aborted) return;
  const xs = dissolves(loaded.map((l) => l.dur), o.crossfade);
  let t0 = 0;
  loaded.forEach((l, i) => { l.x = xs[i]; t0 -= l.x; l.start = t0; t0 += l.dur; });
  const total = t0;
  // Speakers: each clip's own sound, unless it is marked silent or the browser forbids it.
  let speakers = !!o.sound && !o.audio;
  const voiced = (i: number) => loaded[i].video && clips[i].audio !== false;
  const voice = () => loaded.forEach((l, i) => { if (l.video && !o.audio) (l.el as HTMLVideoElement).muted = !(speakers && voiced(i)); });
  voice();
  if (o.audio) {
    for (const [i, l] of loaded.entries()) {
      if (!l.video || clips[i].audio === false) continue;
      const v = l.el as HTMLVideoElement;
      v.muted = false;
      l.gain = o.audio.ctx.createGain();
      l.gain.gain.value = 0;
      o.audio.ctx.createMediaElementSource(v).connect(l.gain).connect(o.audio.dest);
    }
  }
  // The frame: the delivery aspect at the first shot's resolution (long side ≤ 1920, even sides for H.264).
  const a = o.aspect && Number.isFinite(o.aspect) && o.aspect > 0 ? o.aspect : loaded[0].w / loaded[0].h;
  const long = Math.min(1920, Math.max(loaded[0].w, loaded[0].h));
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  canvas.width = even(a >= 1 ? long : long * a);
  canvas.height = even(a >= 1 ? long / a : long);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas here");
  o.onStart?.();
  let begin = performance.now() - (loaded[o.from ?? 0]?.start ?? 0) * 1000;
  let shown = -1;
  const pauseAll = () => loaded.forEach((l) => { if (l.video) (l.el as HTMLVideoElement).pause(); });
  o.control?.({
    seek: (i) => { if (!loaded[i]) return; begin = performance.now() - loaded[i].start * 1000; pauseAll(); },
    unmute: () => { speakers = true; voice(); loaded.forEach((l) => { const v = l.el as HTMLVideoElement; if (l.video && !v.paused) void v.play().catch(() => {}); }); },
  });
  const start = (v: HTMLVideoElement) => void v.play().catch((e: unknown) => {
    // Autoplay with sound refused: carry on muted and say so once.
    if (!(e instanceof DOMException && e.name === "NotAllowedError") || v.muted) return;
    speakers = false; voice(); o.onMuted?.();
    void v.play().catch(() => {});
  });
  await new Promise<void>((resolve) => {
    const stop = () => { pauseAll(); resolve(); };
    o.signal?.addEventListener("abort", stop, { once: true });
    const frame = () => {
      if (o.signal?.aborted) { stop(); return; }
      const t = (performance.now() - begin) / 1000;
      if (t >= total) { o.onTime?.(total, total); stop(); return; }
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const l of loaded) {
        const local = t - l.start;
        const active = local >= 0 && local < l.dur;
        if (l.video) {
          const v = l.el as HTMLVideoElement;
          if (active && v.paused) { v.currentTime = l.in + local; start(v); }
          if (!active && !v.paused) v.pause();
        }
        const alpha = active ? (l.x > 0 ? Math.min(1, local / l.x) : 1) : 0;
        if (l.gain) l.gain.gain.value = alpha;
        if (!active) continue;
        ctx.globalAlpha = alpha;
        // A still holds with a slow push, so storyboard mode still moves.
        draw(ctx, l, l.video ? 1 : 1 + 0.05 * ((l.in + local) / STILL_SECONDS));
      }
      ctx.globalAlpha = 1;
      // The shot on screen: the last one started (during a dissolve, the incoming one).
      let on = 0;
      loaded.forEach((l, i) => { if (t >= l.start) on = i; });
      if (on !== shown) { shown = on; o.onShot?.(on); }
      o.onTime?.(t, total);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

function recorderType(): { mime: string; ext: string } {
  const types: [string, string][] = [["video/mp4;codecs=avc1.640028,mp4a.40.2", "mp4"], ["video/mp4;codecs=avc1.640028", "mp4"], ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9,opus", "webm"], ["video/webm;codecs=vp9", "webm"], ["video/webm", "webm"]];
  const hit = types.find(([t]) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
  if (!hit) throw new Error("This browser cannot record video");
  return { mime: hit[0], ext: hit[1] };
}

/** Plays the sequence once while recording the canvas; resolves with the file. */
export async function exportSequence(canvas: HTMLCanvasElement, clips: SequenceClip[], o: PlayOptions): Promise<{ blob: Blob; ext: string }> {
  const { mime, ext } = recorderType();
  // Picture from the canvas, sound from the clips (mixed in WebAudio, crossfaded with the picture).
  // The AudioContext is made here, inside the Export click, so the browser lets it run.
  const ctx = new AudioContext();
  void ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const done = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
  try {
    // Recording starts once every clip is loaded, so the file opens on the first frame.
    await playSequence(canvas, clips, { ...o, audio: { ctx, dest }, onStart: () => { rec.start(250); o.onStart?.(); } });
  } finally {
    if (rec.state !== "inactive") rec.stop(); else rec.onstop?.(new Event("stop"));
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  }
  await done;
  return { blob: new Blob(parts, { type: mime.split(";")[0] }), ext };
}
