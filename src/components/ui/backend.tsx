/**
 * Where the work runs: Local (ComfyUI on this machine), Remote (any ComfyUI
 * URL — a RunPod pod, a studio box) or Comfy Cloud (through a relay, with the
 * visitor's own API key, kept only in this browser). One quiet segmented control, a live
 * status dot, the choice remembered. Nothing is chosen (grey) until the visitor picks.
 * Status is calm: one missed ping shows "Reconnecting", only two in a row mean offline.
 */
import { useEffect, useState } from "react";
import { CLOUD_BASE, cloudHeaders, getCloudKey, getServer, isDemo, ping, serverLabel, setCloudKey, setServer } from "@/comfy";

export type Backend = "local" | "remote" | "cloud";
export const LOCAL_URL = "http://127.0.0.1:8188";
const REMOTE_KEY = "eve-tools.remote";
const SERVER_EVENT = "eve-tools-server";

/** http(s)://host[:port], nothing else: a typo never becomes the server. */
const ADDRESS = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?\/?$/i;
export const validAddress = (url: string) => {
  if (!ADDRESS.test(url.trim())) return false;
  try { const p = new URL(url.trim()).port; return !p || Number(p) <= 65535; } catch { return false; }
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);
const isLoopback = (url: string) => { try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; } };

/** Has the visitor (or the build, via VITE_COMFY_URL) picked a server yet? */
export function hasChoice(): boolean {
  if (import.meta.env.VITE_COMFY_URL) return true;
  try { return localStorage.getItem("eve-tools.server") != null; } catch { return false; }
}

export function backendOf(url: string): Backend {
  if (url === "cloud") return "cloud";
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" ? "local" : "remote";
  } catch {
    return "remote";
  }
}

/** The remote to offer: the last one used, else the build's own server (VITE_COMFY_URL) when it is remote. */
const lastRemote = () => {
  let saved = "";
  try { saved = localStorage.getItem(REMOTE_KEY) ?? ""; } catch { /* private window */ }
  const env = (import.meta.env.VITE_COMFY_URL as string | undefined) ?? "";
  return saved || (env && backendOf(env) === "remote" ? env : "");
};

/** Switch the server and tell every view (the pill, the landing) at once. */
export function useServer(): [string, (url: string) => void] {
  const [url, setUrl] = useState(getServer);
  useEffect(() => {
    const sync = () => setUrl(getServer());
    window.addEventListener(SERVER_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(SERVER_EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  const choose = (next: string) => {
    const clean = next.trim().replace(/\/+$/, "");
    // Only Comfy Cloud or a well-formed address is ever stored.
    if (!clean || (clean !== "cloud" && !validAddress(clean))) return;
    if (backendOf(clean) === "remote") { try { localStorage.setItem(REMOTE_KEY, clean); } catch { /* per session */ } }
    setServer(clean);
    window.dispatchEvent(new Event(SERVER_EVENT));
  };
  return [url, choose];
}

export type Status = { state: "idle" | "checking" | "online" | "reconnecting" | "offline"; gpu?: string };

/** Ping every 10 s; a single miss retries in 3 s and stays calm. */
export function useServerStatus(url: string): Status {
  const [status, setStatus] = useState<Status>({ state: "checking" });
  useEffect(() => {
    let alive = true, misses = 0, timer = 0;
    setStatus({ state: "checking" });
    const check = () => {
      // Nothing is pinged (and nothing is red) until a server is picked; the pick is noticed within a second.
      if (!hasChoice()) {
        misses = 0;
        setStatus({ state: "idle" });
        timer = window.setTimeout(check, 1_000);
        return;
      }
      ping().then((p) => {
        if (!alive) return;
        misses = 0;
        setStatus({ state: "online", gpu: p.gpu });
        timer = window.setTimeout(check, 10_000);
      }).catch(() => {
        if (!alive) return;
        misses++;
        setStatus((s) => ({ state: misses >= 2 ? "offline" : s.state === "online" ? "reconnecting" : s.state === "offline" ? "offline" : "checking" }));
        timer = window.setTimeout(check, misses >= 2 ? 10_000 : 3_000);
      });
    };
    check();
    return () => { alive = false; clearTimeout(timer); };
  }, [url]);
  return status;
}

/** Comfy Cloud needs a relay: this app's /cloud proxy (dev or preview) or the hosted page's public one. */
type CloudProxy = { proxy: boolean };
let cloudProbe: Promise<CloudProxy> | null = null;
function probeCloud(): Promise<CloudProxy> {
  // A hosted build talks to the public relay: it exists.
  if (CLOUD_BASE !== "/cloud") return Promise.resolve({ proxy: true });
  cloudProbe ??= fetch("/cloud/__status").then(async (r) => {
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return { proxy: false };
    const j = await r.json();
    return { proxy: !!j.proxy };
  }).catch(() => ({ proxy: false }));
  return cloudProbe;
}

type CloudCheck = "checking" | "connected" | "plan" | "invalid" | "nokey" | "error";
/** A real call with the key: only a 200 from /cloud/user means connected. */
async function checkCloud(key: string): Promise<CloudCheck> {
  // The relay holds no key of its own: without the visitor's there is nothing to ask.
  if (!key.trim()) return "nokey";
  try {
    const r = await fetch(`${CLOUD_BASE}/user`, { headers: cloudHeaders(key) });
    if (r.ok) return "connected";
    const text = await r.text().catch(() => "");
    if (r.status === 402 || r.status === 429 || /FREE_TIER_NOT_ALLOWED/i.test(text)) return "plan";
    if (r.status === 401 || r.status === 403) return "invalid";
    if (r.status === 503) return "nokey";
    return "error";
  } catch {
    return "error";
  }
}
const CLOUD_WORD: Record<CloudCheck, string> = {
  checking: "Checking…", connected: "Connected", plan: "Needs an active subscription", invalid: "Invalid key", nokey: "Paste your API key", error: "Comfy Cloud is not answering",
};

/** Is there a ComfyUI at `url`? (2.5 s, no side effects.) */
async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/system_stats`, { signal: AbortSignal.timeout(2500) });
    return r.ok && (r.headers.get("content-type") ?? "").includes("json");
  } catch {
    return false;
  }
}

export function StatusDot({ status }: { status: Status }) {
  const c = status.state === "online" ? "bg-[#30d158] shadow-[0_0_6px_#30d158]" : status.state === "offline" ? "bg-[#ff453a]" : status.state === "idle" ? "bg-current opacity-35" : "animate-pulse bg-white/35";
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${c}`} />;
}

export const statusWord = (s: Status) => (s.state === "online" ? "Connected" : s.state === "offline" ? "Not reachable" : s.state === "reconnecting" ? "Reconnecting…" : s.state === "idle" ? "No server chosen" : "Checking…");

/**
 * The chooser: three tabs; the selected one is the server in use (none until the visitor picks).
 * Local switches at once (and says plainly when nothing runs there; a typed address is checked
 * first); Remote takes an address; Comfy Cloud takes an API key kept only in this browser and
 * sent with each request to the relay. Tabs never switch by themselves.
 * `tone` "page" uses the theme's tokens, "studio" the black chrome.
 */
export function BackendChooser({ tone = "page", onChosen, compact = false, trailing }: { tone?: "page" | "studio"; onChosen?: () => void; compact?: boolean; trailing?: React.ReactNode }) {
  const [url, choose] = useServer();
  const status = useServerStatus(url);
  const mode = backendOf(url);
  const demo = isDemo();
  const [cloud, setCloud] = useState<CloudProxy | null>(null);
  useEffect(() => { void probeCloud().then(setCloud); }, []);
  // The tab whose panel is open: the server in use, unless another tab is being set up; none before a pick.
  const [chosen, setChosen] = useState(hasChoice);
  const [open, setOpen] = useState<Backend | null>(() => (hasChoice() ? mode : null));
  useEffect(() => { if (hasChoice()) setOpen(mode); }, [mode]);
  const [local, setLocal] = useState(() => (mode === "local" ? url : LOCAL_URL));
  const [remote, setRemote] = useState(() => (mode === "remote" ? url : lastRemote()));
  const [key, setKey] = useState(getCloudKey);
  const [cloudState, setCloudState] = useState<CloudCheck | null>(null);
  const [hint, setHint] = useState<{ text: string; bad?: boolean } | null>(null);
  // Cloud in use: verified with a real call.
  useEffect(() => {
    if (mode !== "cloud") { setCloudState(null); return; }
    setCloudState("checking");
    void checkCloud(getCloudKey()).then(setCloudState);
  }, [mode]);

  const page = tone === "page";
  const track = page ? "bg-[var(--hairline)]" : "bg-white/[0.06] ring-1 ring-inset ring-white/[0.08]";
  const on = page ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm" : "bg-white text-black";
  const off = page ? "text-[var(--muted)] hover:text-[var(--foreground)]" : "text-white/65 hover:text-white";
  const quiet = page ? "text-[var(--muted)]" : "text-white/50";
  const field = page ? "bg-[var(--surface)] text-[var(--foreground)] ring-[var(--hairline)] placeholder:text-[var(--muted)]" : "bg-white/[0.06] text-white ring-white/[0.14] placeholder:text-white/35";
  const ghost = `h-7 shrink-0 rounded-full px-3 text-[12px] font-medium ring-1 ring-inset disabled:opacity-40 ${page ? "ring-[var(--hairline)] text-[var(--muted)] hover:text-[var(--foreground)]" : "ring-white/15 text-white/65 hover:text-white"}`;
  const cloudOff = cloud != null && !cloud.proxy;

  const useUrl = (next: string) => { setHint(null); choose(next); setChosen(true); onChosen?.(); };
  const pick = (b: Backend) => {
    setHint(null);
    setOpen(b);
    // Local switches at once; its status says whether ComfyUI runs here.
    if (b === "local") { setLocal(LOCAL_URL); if (mode !== "local" || !chosen) { choose(LOCAL_URL); setChosen(true); } }
    // Remote switches to the last address it knew; a new one goes through Connect.
    if (b === "remote") { const t = mode === "remote" && chosen ? url : lastRemote(); setRemote(t); if (t && validAddress(t) && (mode !== "remote" || !chosen)) { choose(t); setChosen(true); } }
    // Comfy Cloud waits for Connect with a key.
  };
  const connectLocal = async () => {
    const t = local.trim();
    if (!validAddress(t)) { setHint({ text: "Not a valid address", bad: true }); return; }
    if (!isLoopback(t)) { setHint({ text: "Not this machine — use Remote for another address", bad: true }); return; }
    setHint({ text: "Checking…" });
    if (await reachable(t)) useUrl(t);
    else setHint({ text: 'Nothing answers there — start ComfyUI with --enable-cors-header "*"', bad: true });
  };
  const connectRemote = async () => {
    const t = remote.trim();
    if (!t) return;
    if (!validAddress(t)) { setHint({ text: "Not a valid address", bad: true }); return; }
    setHint({ text: "Checking…" });
    if (await reachable(t)) useUrl(t);
    else setHint({ text: "Not reachable — check the address, and that ComfyUI allows this site (CORS)", bad: true });
  };
  const connectCloud = async () => {
    const k = key.trim();
    if (!k) { setCloudState("nokey"); return; }
    setCloudState("checking");
    const r = await checkCloud(k);
    setCloudState(r);
    if (r === "connected" || r === "plan") { setCloudKey(k); useUrl("cloud"); }
  };
  // The key leaves this browser; the Cloud tab stays open and asks for a new one.
  const removeKey = () => { setCloudKey(null); setKey(""); setCloudState("nokey"); setOpen("cloud"); };

  const tabs: [Backend, string][] = [["local", "Local"], ["remote", "Remote"], ["cloud", "Comfy Cloud"]];
  const segments = (
    <div role="radiogroup" aria-label="Where ComfyUI runs" className={`flex gap-0.5 rounded-full p-0.5 ${track}`}>
      {tabs.map(([b, label]) => (
        <button key={b} type="button" role="radio" aria-checked={open === b} onClick={() => pick(b)}
          className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors duration-200 ${b === "cloud" && cloudOff ? "opacity-40" : ""} ${open === b ? on : off}`}>{label}</button>
      ))}
    </div>
  );
  // One status for the open tab: green only for the server actually in use and answering.
  const dot = (state: Status["state"], word: string, bad = false) => (
    <span className={`flex items-center gap-1.5 text-[11.5px] ${bad ? "text-[#ff453a]" : quiet}`} aria-live="polite"><StatusDot status={{ state }} />{word}</span>
  );
  const statusLine = open === null
    ? dot("idle", "Choose where ComfyUI runs")
    : open === "local"
    ? (mode !== "local" || !chosen ? null : status.state === "online" ? dot("online", "Connected") : status.state === "offline" ? dot("offline", 'Not running — start ComfyUI with --enable-cors-header "*"', true) : dot("checking", statusWord(status)))
    : open === "remote"
    ? (mode !== "remote" || !chosen ? null : dot(status.state, statusWord(status), status.state === "offline"))
    : cloudOff ? <span className={`text-[11.5px] ${quiet}`}>Comfy Cloud works when you run the app locally — <a href="https://github.com/kimagedon/eve-tools-for-comfyui#run-it" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-[var(--foreground)]">npm run dev</a></span>
    : cloudState ? dot(cloudState === "connected" ? "online" : cloudState === "checking" ? "checking" : "offline", CLOUD_WORD[cloudState], cloudState !== "connected" && cloudState !== "checking") : null;

  const input = `h-7 min-w-0 flex-1 rounded-full px-3 font-mono text-[11px] outline-none ring-1 ring-inset focus-visible:ring-2 ${field}`;
  const panel = demo || open === null ? null : open === "local" ? (
    <form className="flex w-full max-w-[420px] items-center gap-2" onSubmit={(e) => { e.preventDefault(); void connectLocal(); }}>
      <input value={local} onChange={(e) => { setLocal(e.target.value); setHint(null); }} aria-label="Local ComfyUI address" aria-invalid={hint?.bad || undefined} spellCheck={false} className={input} />
      <button type="submit" className={`h-7 shrink-0 rounded-full px-3 text-[12px] font-medium ${on}`}>Connect</button>
    </form>
  ) : open === "remote" ? (
    <form className="flex w-full max-w-[420px] items-center gap-2" onSubmit={(e) => { e.preventDefault(); void connectRemote(); }}>
      <input value={remote} onChange={(e) => { setRemote(e.target.value); setHint(null); }} aria-label="Remote ComfyUI address" aria-invalid={hint?.bad || undefined} placeholder="https://<pod>-8188.proxy.runpod.net" spellCheck={false} className={input} />
      <button type="submit" className={`h-7 shrink-0 rounded-full px-3 text-[12px] font-medium ${on}`}>Connect</button>
    </form>
  ) : cloudOff ? null : (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-1.5">
      <form className="flex w-full items-center gap-2" onSubmit={(e) => { e.preventDefault(); void connectCloud(); }}>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} aria-label="API key" placeholder="API key" autoComplete="off" spellCheck={false} className={input} />
        <button type="submit" disabled={!key.trim()} className={`h-7 shrink-0 rounded-full px-3 text-[12px] font-medium disabled:opacity-40 ${on}`}>Connect</button>
        <button type="button" onClick={removeKey} disabled={!key && !getCloudKey()} className={ghost}>Remove</button>
      </form>
      <span className={`text-[10.5px] ${quiet} opacity-80`}>Key from platform.comfy.org → API Keys · kept only in this browser</span>
    </div>
  );
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
        {segments}
        {statusLine}
        {compact && trailing}
      </div>
      {panel}
      {hint && <span className={`text-[11px] ${hint.bad ? "text-[#ff453a]" : quiet}`} role={hint.bad ? "alert" : "status"}>{hint.text}</span>}
      {demo && mode === "remote" && <span className={`text-[11.5px] ${quiet}`}>{serverLabel()}</span>}
      {!compact && trailing}
    </div>
  );
}

/**
 * The landing's server control: a dot top-right that opens the chooser. It
 * opens itself once when the server is truly unreachable (two missed pings).
 */
export function BackendDot() {
  const [url] = useServer();
  const status = useServerStatus(url);
  const [open, setOpen] = useState(false);
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    if (status.state !== "offline" || auto) return;
    let seen = false;
    try { seen = sessionStorage.getItem("eve-tools.backend-prompted") === "1"; sessionStorage.setItem("eve-tools.backend-prompted", "1"); } catch { /* per tab */ }
    setAuto(true);
    if (!seen) setOpen(true);
  }, [status.state, auto]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label={`ComfyUI: ${statusWord(status)}`} title={statusWord(status)}
        className="eve-press flex h-7 w-7 items-center justify-center rounded-full text-[var(--muted)] ring-1 ring-inset ring-[var(--hairline)] hover:text-[var(--foreground)]">
        <StatusDot status={status} />
      </button>
      {open && (
        <>
          <div aria-hidden className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="dialog" aria-label="Where ComfyUI runs" className="eve-hub-in absolute right-0 top-9 z-50 w-[min(440px,92vw)] rounded-2xl bg-[var(--surface)] p-4 shadow-2xl ring-1 ring-[var(--hairline)]">
            <BackendChooser onChosen={() => setOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}
