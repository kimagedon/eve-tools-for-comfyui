// Minimal ComfyUI HTTP/WebSocket client: upload -> prompt -> progress -> fetch output.
import { editGraph, outpaintGraph, shotFlfGraph, shotI2vGraph, type ApiGraph, type ShotParams } from './workflows';

const SERVER_KEY = 'eve-tools.server';

export function getServer(): string {
  try {
    return localStorage.getItem(SERVER_KEY) || import.meta.env.VITE_COMFY_URL || 'http://127.0.0.1:8188';
  } catch {
    return import.meta.env.VITE_COMFY_URL || 'http://127.0.0.1:8188';
  }
}

export function setServer(url: string) {
  try {
    localStorage.setItem(SERVER_KEY, url.replace(/\/+$/, ''));
  } catch {
    /* private mode: the default stays */
  }
}

export class ComfyError extends Error {
  constructor(
    message: string,
    readonly kind: 'offline' | 'missing-model' | 'oom' | 'validation' | 'execution' | 'timeout' | 'cancelled',
  ) {
    super(message);
  }
}

export type Progress = { value: number; max: number; node?: string };
export type RunOptions = {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  timeoutMs?: number;
  /**
   * 'high' puts the prompt ahead of everything already waiting in the ComfyUI
   * queue (FIFO among high-priority prompts), e.g. stills ahead of queued LTX
   * shots. Never preempts the prompt that is running. Ignored on Comfy Cloud.
   */
  priority?: 'normal' | 'high';
  /** While the prompt waits: how many prompts run or wait ahead of it (0 once it runs). */
  onQueue?: (ahead: number) => void;
};

/** randomUUID needs a secure context; getRandomValues does not (plain-http LAN hosts). */
const uid = () => globalThis.crypto?.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const clientId = uid();

/** "cloud" = Comfy Cloud through the app server's /cloud proxy (it holds the key). */
export const isCloud = () => getServer() === 'cloud';
/**
 * Comfy Cloud refuses browser calls from other sites, so Cloud goes through a relay:
 * the dev/preview server's /cloud proxy, or (on the hosted page) the public relay
 * set at build time. The user's own key rides in each request; nothing is stored there.
 */
export const CLOUD_BASE: string = import.meta.env.VITE_CLOUD_RELAY || '/cloud';
const base = () => (isCloud() ? CLOUD_BASE : getServer());

/** Recording mode (?demo=1, remembered for the tab): the server is never named on screen. */
export function isDemo(): boolean {
  try {
    if (new URLSearchParams(location.search).get('demo') === '1') sessionStorage.setItem('eve-tools.demo', '1');
    return sessionStorage.getItem('eve-tools.demo') === '1';
  } catch {
    return false;
  }
}

/** The server as shown in the UI: Comfy Cloud, the host, or just "ComfyUI" in demo mode. */
export function serverLabel(): string {
  if (isCloud()) return 'Comfy Cloud';
  if (isDemo()) return 'ComfyUI';
  try {
    return new URL(getServer()).host;
  } catch {
    return getServer();
  }
}

/** The visitor's own Comfy Cloud key: kept in this browser only, sent to this app's /cloud proxy. */
const CLOUD_KEY = 'eve-tools.cloud-key';
export function getCloudKey(): string {
  try { return localStorage.getItem(CLOUD_KEY) ?? ''; } catch { return ''; }
}
export function setCloudKey(key: string | null) {
  try { if (key) localStorage.setItem(CLOUD_KEY, key); else localStorage.removeItem(CLOUD_KEY); } catch { /* per session */ }
}
export const cloudHeaders = (key = getCloudKey()): Record<string, string> => (key ? { 'X-Comfy-Cloud-Key': key } : {});

async function call(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(base() + path, isCloud() ? { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...cloudHeaders() } } : init);
  } catch {
    throw new ComfyError(`No connection to ComfyUI at ${serverLabel()}`, 'offline');
  }
  if (!res.ok) {
    // Proxies and gateways (429, 502–504, Cloudflare 52x) are passing weather, not a failed job.
    // Comfy Cloud without a paid plan: not passing weather, a clear answer.
    if (res.status === 402 || (res.status === 429 && isCloud())) throw new ComfyError(CLOUD_PLAN, 'validation');
    if (res.status === 429 || (res.status >= 502 && res.status <= 504) || (res.status >= 520 && res.status <= 530))
      throw new ComfyError(`ComfyUI at ${serverLabel()} answered ${res.status} — retrying`, 'offline');
    const text = await res.text().catch(() => '');
    throw classify(text || `${res.status} ${res.statusText}`, res.status === 400 ? 'validation' : 'execution');
  }
  return res;
}

export const CLOUD_PLAN = 'Comfy Cloud API needs an active subscription';

function classify(raw: string, fallback: ComfyError['kind']): ComfyError {
  if (/FREE_TIER_NOT_ALLOWED|subscription|payment required/i.test(raw)) return new ComfyError(CLOUD_PLAN, 'validation');
  if (/out of memory|OutOfMemory|CUDA error: out of memory/i.test(raw)) return new ComfyError('GPU out of memory', 'oom');
  if (/value_not_in_list|not in list|No such file/i.test(raw) && /safetensors|gguf|ckpt/i.test(raw)) {
    const file = raw.match(/[\w.-]+\.(safetensors|gguf|ckpt)/)?.[0];
    return new ComfyError(`Model missing on the server${file ? `: ${file}` : ''} — see scripts/models.md`, 'missing-model');
  }
  return new ComfyError(raw.slice(0, 600), fallback);
}

/** The server's queue: prompts running and waiting (local/remote ComfyUI; Cloud reports nothing). */
export async function queueStatus(): Promise<{ running: number; pending: number; order: string[] }> {
  if (isCloud()) return { running: 0, pending: 0, order: [] };
  const j = await (await call('/queue')).json();
  const sort = (q: [number, string][]) => [...q].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const running = sort(j.queue_running ?? []), pending = sort(j.queue_pending ?? []);
  return { running: running.length, pending: pending.length, order: [...running, ...pending] };
}

export async function ping(): Promise<{ gpu: string; vramFree: number }> {
  const res = await call('/system_stats');
  const j = await res.json();
  const d = j.devices?.[0] ?? {};
  return { gpu: String(d.name ?? 'unknown'), vramFree: Number(d.vram_free ?? 0) };
}

// Upload dedupe: identical bytes go up once per session and server. The file is
// named by its content hash, so the server's LoadImage cache (keyed on file
// content) also hits and downstream nodes, e.g. the text encoder for the same
// plate + prompt, are reused.
const uploadsByHash = new Map<string, Promise<string>>();
const uploadsByBlob = new WeakMap<Blob, { base: string; name: Promise<string> }>();

async function contentHash(blob: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null; // insecure context: fall back to Blob identity only
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function uploadOnce(blob: Blob, filename: string): Promise<string> {
  const fd = new FormData();
  fd.append('image', blob, filename);
  fd.append('overwrite', 'true');
  const res = await call('/upload/image', { method: 'POST', body: fd });
  const j = await res.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

/** Upload an image to the ComfyUI input folder; the same bytes are uploaded only once per session. */
export function upload(blob: Blob, name = 'eve-tools.png'): Promise<string> {
  const b = base();
  const known = uploadsByBlob.get(blob);
  if (known && known.base === b) return known.name;
  const named = (async () => {
    const hash = await contentHash(blob);
    if (!hash) return uploadOnce(blob, `${uid().slice(0, 8)}-${name}`);
    const key = `${b}|${hash}`;
    let pending = uploadsByHash.get(key);
    if (!pending) {
      pending = uploadOnce(blob, `eve-${hash}.${name.split('.').pop() || 'png'}`);
      uploadsByHash.set(key, pending);
      pending.catch(() => uploadsByHash.delete(key));
    }
    return pending;
  })();
  uploadsByBlob.set(blob, { base: b, name: named });
  named.catch(() => uploadsByBlob.delete(blob));
  return named;
}

/** Forget uploaded files (e.g. after the server's input folder was cleared). */
export function forgetUploads() {
  uploadsByHash.clear();
}

type OutFile = { filename: string; subfolder: string; type: string };

/** Queue a graph and resolve with the files of its save nodes. */
export async function run(graph: ApiGraph, opts: RunOptions = {}): Promise<OutFile[]> {
  const { signal, onProgress, timeoutMs = 15 * 60_000, priority = 'normal' } = opts;
  // A task started after Stop must not reach the GPU.
  if (signal?.aborted) throw new ComfyError('Cancelled', 'cancelled');
  const body: Record<string, unknown> = { prompt: graph, client_id: clientId };
  // ComfyUI's queue is a heap on "number": a large negative, time-ordered number
  // runs before every normal prompt yet keeps high-priority prompts FIFO
  // ("front": true would make them LIFO).
  if (priority === 'high' && !isCloud()) body.number = Date.now() - 1e13;
  const ws = openSocket();
  let id: string;
  try {
    const res = await call('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    if (j.node_errors && Object.keys(j.node_errors).length) throw classify(JSON.stringify(j.node_errors), 'validation');
    id = j.prompt_id;
  } catch (e) {
    ws?.close();
    throw e;
  }

  return new Promise<OutFile[]>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      ws?.close();
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else {
        // The job is done; fetching its outputs gets a few tries through a flaky proxy.
        const fetchOutputs = (left: number): Promise<OutFile[]> =>
          outputs(id).catch((e) => (left > 0 && ((e instanceof ComfyError && e.kind === 'offline') || e instanceof SyntaxError)
            ? new Promise<OutFile[]>((r) => setTimeout(() => r(fetchOutputs(left - 1)), 1500)) : Promise.reject(e)));
        fetchOutputs(3).then(resolve, reject);
      }
    };
    const onAbort = () => {
      void cancel(id);
      finish(new ComfyError('Cancelled', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => { void cancel(id); finish(new ComfyError('ComfyUI did not answer in time', 'timeout')); }, timeoutMs);
    let transient = 0;
    // Stop pressed while /prompt was in flight: the listener above never fires for a past abort.
    if (signal?.aborted) queueMicrotask(onAbort);

    // History polling is the source of truth; the socket only adds progress.
    let started = false;
    const poll = setInterval(async () => {
      try {
        if (!started && opts.onQueue && !isCloud()) {
          const q = await queueStatus().catch(() => null);
          const at = q ? q.order.indexOf(id) : -1;
          if (at >= 0) opts.onQueue(at);
          if (at === 0) started = true;
        }
        if (isCloud()) {
          const { status } = await (await call(`/job/${id}/status`)).json();
          transient = 0;
          if (status === 'success') finish();
          else if (['error', 'non_retryable_error', 'lost', 'cancelled'].includes(status)) {
            const job = await (await call(`/jobs/${id}`)).json().catch(() => ({}));
            const err = job.execution_error;
            finish(classify(err?.exception_message ?? (typeof err === 'string' ? err : `Comfy Cloud job ${status}`), 'execution'));
          }
          return;
        }
        const h = await (await call(`/history/${id}`)).json();
        transient = 0;
        const entry = h[id];
        if (!entry) return;
        if (entry.status?.status_str === 'error') {
          const msg = entry.status.messages?.find((m: [string, unknown]) => m[0] === 'execution_error')?.[1];
          finish(classify(msg?.exception_message ?? JSON.stringify(msg ?? entry.status), 'execution'));
        } else if (entry.status?.completed) finish();
      } catch (e) {
        // A missed poll (network blip, gateway page, half a JSON body) is retried; only a run of them fails the job.
        if ((e instanceof ComfyError && e.kind === 'offline') || e instanceof SyntaxError) {
          if (++transient < 40) return;
        }
        finish(e as Error);
      }
    }, 1500);

    if (ws)
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        const m = JSON.parse(ev.data);
        if (m.data?.prompt_id !== id) return;
        if (m.type === 'progress') onProgress?.({ value: m.data.value, max: m.data.max, node: m.data.node });
        if (m.type === 'execution_error') finish(classify(m.data.exception_message ?? 'Execution error', 'execution'));
        if (m.type === 'executing' && m.data.node === null) finish();
      };
  });
}

function openSocket(): WebSocket | null {
  if (isCloud()) return null; // Cloud wants the key in the socket URL; polling keeps it server-side.
  try {
    return new WebSocket(getServer().replace(/^http/, 'ws') + `/ws?clientId=${clientId}`);
  } catch {
    return null;
  }
}

async function outputs(id: string): Promise<OutFile[]> {
  const raw = isCloud() ? (await (await call(`/jobs/${id}`)).json()).outputs : (await (await call(`/history/${id}`)).json())[id]?.outputs;
  const files: OutFile[] = [];
  for (const out of Object.values<Record<string, OutFile[]>>(raw ?? {}))
    for (const key of ['images', 'videos', 'gifs', 'video']) for (const f of out[key] ?? []) if (f.type === 'output') files.push(f);
  if (!files.length) throw new ComfyError('The workflow finished without an output file', 'execution');
  return files;
}

export async function cancel(id?: string) {
  const json = { 'Content-Type': 'application/json' };
  // Comfy Cloud: only this tab's own job is cancelled (deleted by its prompt id). Its
  // /interrupt is account-wide — it would kill the account's other sessions' jobs —
  // so it is never sent there, and without an id nothing is touched.
  if (isCloud()) {
    if (id) await call('/queue', { method: 'POST', headers: json, body: JSON.stringify({ delete: [id] }) }).catch(() => {});
    return;
  }
  await call('/queue', { method: 'POST', headers: json, body: JSON.stringify({ delete: id ? [id] : [] }) }).catch(() => {});
  // With an id only that prompt is interrupted, if it is the one running; another
  // tab's or user's job on the same GPU is left alone.
  await call('/interrupt', { method: 'POST', headers: json, body: JSON.stringify(id ? { prompt_id: id } : {}) }).catch(() => {});
}

export async function fetchFile(f: OutFile): Promise<Blob> {
  const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
  return (await call(`/view?${q}`)).blob();
}

const seed = () => Math.floor(Math.random() * 2 ** 48);

/** One or two images + prompt -> image (Qwen-Image-Edit). */
export async function runEdit(images: Blob[], prompt: string, opts: RunOptions = {}): Promise<Blob> {
  const [image1, image2] = await Promise.all(images.slice(0, 2).map((b, i) => upload(b, `in${i + 1}.png`)));
  const files = await run(editGraph({ image1, image2, prompt, seed: seed() }), opts);
  return fetchFile(files[0]);
}

/** Extend: transparent canvas + the clean photo -> the canvas filled (Qwen-Image-Edit inpainting). */
export async function runOutpaint(canvas: Blob, original: Blob, prompt: string, opts: RunOptions = {}): Promise<Blob> {
  const [c, o] = await Promise.all([upload(canvas, 'canvas.png'), upload(original, 'original.png')]);
  const files = await run(outpaintGraph({ canvas: c, original: o, prompt, seed: seed() }), opts);
  return fetchFile(files[0]);
}

/** Still(s) -> MP4 shot (LTX). With a last frame the camera move is interpolated between the two. */
export async function runShot(
  first: Blob,
  last: Blob | null,
  p: Omit<ShotParams, 'first' | 'last' | 'seed'>,
  opts: RunOptions = {},
): Promise<Blob> {
  const [f, l] = await Promise.all([upload(first, 'first.png'), last ? upload(last, 'last.png') : Promise.resolve(undefined)]);
  const params = { ...p, first: f, last: l, seed: seed() };
  const files = await run(l ? shotFlfGraph(params) : shotI2vGraph(params), { timeoutMs: 20 * 60_000, ...opts });
  return fetchFile(files[0]);
}

const cancelled = () => ({ status: 'rejected', reason: new ComfyError('Cancelled', 'cancelled') }) as const;

/**
 * Run tasks with a concurrency cap (ComfyUI executes one prompt at a time per GPU;
 * the cap keeps uploads ahead). Once `signal` aborts no new task starts and the
 * ones not started settle as rejected 'cancelled'.
 */
export async function pool<T>(tasks: (() => Promise<T>)[], limit = 2, signal?: AbortSignal): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      if (signal?.aborted) {
        results[i] = cancelled();
        continue;
      }
      results[i] = await tasks[i]().then(
        (value) => ({ status: 'fulfilled', value }) as const,
        (reason) => ({ status: 'rejected', reason }) as const,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export type PipelineResult<S, C> = { stills: PromiseSettledResult<S>; clip?: PromiseSettledResult<C> };

/**
 * Two-stage pipeline for Shoot: the stills of job i+1 are made while the clip of
 * job i renders, so the GPU never waits for the browser between jobs.
 *
 *   const results = await pipeline(cameras, {
 *     stills: (c, signal) => makeStills(c, signal),        // runEdit(..., { signal, priority: 'high' })
 *     clip: (c, [a, b], signal) => runShot(a, b, p, { signal }),
 *     signal, ahead: 1,
 *     onStills: (c, s) => update(c.id, ...), onClip: (c, clip) => update(c.id, ...),
 *   });
 *
 * - stills run one job at a time, at most `ahead` jobs ahead of the clip being
 *   rendered (default 1: stills N+1 while clip N renders); a failed stills
 *   stage skips that job's clip and the pipeline moves on.
 * - clips run one at a time in job order; a clip that fails does not stop the
 *   rest (its stills stay: storyboard mode).
 * - pass priority 'high' to the stills' runEdit calls so they go ahead of a
 *   clip already waiting in the ComfyUI queue (another tab, another user).
 * - on abort nothing new is queued and unstarted stages settle as 'cancelled'.
 */
export async function pipeline<J, S, C>(
  jobs: J[],
  o: {
    stills: (job: J, signal: AbortSignal) => Promise<S>;
    clip: (job: J, stills: S, signal: AbortSignal) => Promise<C>;
    signal?: AbortSignal;
    ahead?: number;
    onStills?: (job: J, stills: S, index: number) => void;
    onClip?: (job: J, clip: C, index: number) => void;
  },
): Promise<PipelineResult<S, C>[]> {
  const signal = o.signal ?? new AbortController().signal;
  const ahead = Math.max(1, o.ahead ?? 1);
  const results: PipelineResult<S, C>[] = jobs.map(() => ({ stills: cancelled() }));
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };
  const stillsDone = jobs.map(gate);
  // Opened when clip i starts (or is skipped): stills may run at most `ahead` jobs past it.
  const clipStarted = jobs.map(gate);
  // A throwing UI callback must not stall the gates.
  const safely = (f: () => void) => {
    try {
      f();
    } catch (e) {
      console.error(e);
    }
  };
  const settle = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> =>
    p.then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);

  const stillsChain = (async () => {
    for (let i = 0; i < jobs.length; i++) {
      if (i - ahead >= 0) await clipStarted[i - ahead].p;
      if (!signal.aborted) {
        const s = (results[i].stills = await settle(o.stills(jobs[i], signal)));
        if (s.status === 'fulfilled') safely(() => o.onStills?.(jobs[i], s.value, i));
      }
      stillsDone[i].open();
    }
  })();

  for (let i = 0; i < jobs.length; i++) {
    await stillsDone[i].p;
    clipStarted[i].open();
    const s = results[i].stills;
    if (s.status !== 'fulfilled') continue;
    if (signal.aborted) {
      results[i].clip = cancelled();
      continue;
    }
    const c = (results[i].clip = await settle(o.clip(jobs[i], s.value, signal)));
    if (c.status === 'fulfilled') safely(() => o.onClip?.(jobs[i], c.value, i));
  }
  await stillsChain;
  return results;
}
