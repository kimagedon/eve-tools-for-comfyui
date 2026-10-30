/**
 * Where the work runs: Local (ComfyUI on this machine), Remote (any ComfyUI
 * URL — a RunPod pod, a studio box) or Comfy Cloud (through this app's /cloud
 * proxy, with the visitor's key or the app server's). One quiet segmented control, a live
 * status dot, the choice remembered. Status is calm: one missed ping shows
 * "Reconnecting", only two in a row mean offline.
 */
import { useEffect, useState } from "react";
import { cloudHeaders, getCloudKey, getServer, isDemo, ping, serverLabel, setCloudKey, setServer } from "@/comfy";

export type Backend = "local" | "remote" | "cloud";
export const LOCAL_URL = "http://127.0.0.1:8188";
const REMOTE_KEY = "eve-tools.remote";
const SERVER_EVENT = "eve-tools-server";

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
    if (!clean) return;
    if (backendOf(clean) === "remote") { try { localStorage.setItem(REMOTE_KEY, clean); } catch { /* per session */ } }
    setServer(clean);
    window.dispatchEvent(new Event(SERVER_EVENT));
  };
  return [url, choose];
}

export type Status = { state: "checking" | "online" | "reconnecting" | "offline"; gpu?: string };

/** Ping every 10 s; a single miss retries in 3 s and stays calm. */
export function useServerStatus(url: string): Status {
  const [status, setStatus] = useState<Status>({ state: "checking" });
  useEffect(() => {
    let alive = true, misses = 0, timer = 0;
    setStatus({ state: "checking" });
    const check = () => {
      // A public https page does not touch the visitor's machine until they pick Local themselves.
      let chosen = true;
      try { chosen = localStorage.getItem("eve-tools.server") != null; } catch { /* keep */ }
      if (!chosen && location.protocol === "https:" && backendOf(getServer()) === "local") {
        setStatus({ state: "offline" });
        timer = window.setTimeout(check, 3_000);
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

/** Comfy Cloud needs this app's /cloud proxy (dev or preview); a static build has none. */
type CloudProxy = { proxy: boolean; serverKey: boolean };
let cloudProbe: Promise<CloudProxy> | null = null;
function probeCloud(): Promise<CloudProxy> {
  cloudProbe ??= fetch("/cloud/__status").then(async (r) => {
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return { proxy: false, serverKey: false };
    const j = await r.json();
    return { proxy: !!j.proxy, serverKey: !!j.serverKey };
  }).catch(() => ({ proxy: false, serverKey: false }));
  return cloudProbe;
}

type CloudCheck = "checking" | "connected" | "plan" | "invalid" | "nokey" | "error";
/** A real call with the key: only a 200 from /cloud/user means connected. */
async function checkCloud(key: string): Promise<CloudCheck> {
  try {
    const r = await fetch("/cloud/user", { headers: cloudHeaders(key) });
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
  checking: "Checking…", connected: "Connected", plan: "Needs an active subscription", invalid: "Invalid key", nokey: "Add an API key", error: "Comfy Cloud is not answering",
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
  const c = status.state === "online" ? "bg-[#30d158] shadow-[0_0_6px_#30d158]" : status.state === "offline" ? "bg-[#ff453a]" : "animate-pulse bg-white/35";
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${c}`} />;
}

export const statusWord = (s: Status) => (s.state === "online" ? "Connected" : s.state === "offline" ? "Not reachable" : s.state === "reconnecting" ? "Reconnecting…" : "Checking…");

/**
 * The chooser: three tabs, and the selected one is the server in use. Local switches at once
 * (and says plainly when nothing runs there); Remote takes an address; Comfy Cloud takes an
 * API key kept in this browser. `tone` "page" uses the theme's tokens, "studio" the black chrome.
 */
export function BackendChooser({ tone = "page", onChosen, compact = false, trailing }: { tone?: "page" | "studio"; onChosen?: () => void; compact?: boolean; trailing?: React.ReactNode }) {
  const [url, choose] = useServer();
  const status = useServerStatus(url);
  const mode = backendOf(url);
  const demo = isDemo();
  const [cloud, setCloud] = useState<CloudProxy | null>(null);
  useEffect(() => { void probeCloud().then(setCloud); }, []);
  // The tab whose panel is open: the server in use, unless another tab is being set up.
  const [open, setOpen] = useState<Backend>(mode);
  useEffect(() => setOpen(mode), [mode]);
  const [local, setLocal] = useState(() => (mode === "local" ? url : LOCAL_URL));
  const [remote, setRemote] = useState(() => (mode === "remote" ? url : lastRemote()));
  const [key, setKey] = useState(getCloudKey);
  const [cloudState, setCloudState] = useState<CloudCheck | null>(null);
  const [hint, setHint] = useState<string | null>(null);
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
  const ghost = `h-7 shrink-0 rounded-full px-3 text-[12px] font-medium ring-1 ring-inset ${page ? "ring-[var(--hairline)] text-[var(--muted)] hover:text-[var(--foreground)]" : "ring-white/15 text-white/65 hover:text-white"}`;
  const cloudOff = cloud != null && !cloud.proxy;

  const useUrl = (next: string) => { setHint(null); choose(next); onChosen?.(); };
  const pick = (b: Backend) => {
    setHint(null);
    setOpen(b);
    // Local switches at once; its status says whether ComfyUI runs here.
    if (b === "local") { setLocal(LOCAL_URL); if (mode !== "local") choose(LOCAL_URL); }
    // Remote switches to the last address it knew; a new one goes through Connect.
    if (b === "remote") { const t = mode === "remote" ? url : lastRemote(); setRemote(t); if (t && mode !== "remote") choose(t); }
  };
  const connectRemote = async () => {
    const t = remote.trim();
    if (!t) return;
    setHint("Checking…");
    if (await reachable(t)) useUrl(t);
    else setHint("Not reachable — check the address, and that ComfyUI allows this site (CORS)");
  };
  const connectCloud = async () => {
    const k = key.trim();
    setCloudState("checking");
    const r = await checkCloud(k);
    setCloudState(r);
    if (r === "connected" || r === "plan") { setCloudKey(k || null); useUrl("cloud"); }
  };
  const disconnect = () => { setCloudKey(null); setKey(""); setCloudState(null); setOpen("local"); useUrl(LOCAL_URL); };

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
  const statusLine = open === "local"
    ? (mode !== "local" ? null : status.state === "online" ? dot("online", "Connected") : status.state === "offline" ? dot("offline", 'Not running — start ComfyUI with --enable-cors-header "*"', true) : dot("checking", statusWord(status)))
    : open === "remote"
    ? (mode !== "remote" ? null : dot(status.state, statusWord(status), status.state === "offline"))
    : cloudOff ? <span className={`text-[11.5px] ${quiet}`}>Needs the local app server</span>
    : cloudState ? dot(cloudState === "connected" ? "online" : cloudState === "checking" ? "checking" : "offline", CLOUD_WORD[cloudState], cloudState !== "connected" && cloudState !== "checking") : null;

  const input = `h-7 min-w-0 flex-1 rounded-full px-3 font-mono text-[11px] outline-none ring-1 ring-inset focus-visible:ring-2 ${field}`;
  const panel = demo ? null : open === "local" ? (
    <form className="flex w-full max-w-[420px] items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (local.trim()) useUrl(local.trim()); }}>
      <input value={local} onChange={(e) => setLocal(e.target.value)} aria-label="Local ComfyUI address" className={input} />
      <button type="submit" className={`h-7 shrink-0 rounded-full px-3 text-[12px] font-medium ${on}`}>Connect</button>
    </form>
  ) : open === "remote" ? (
    <form className="flex w-full max-w-[420px] items-center gap-2" onSubmit={(e) => { e.preventDefault(); void connectRemote(); }}>
      <input value={remote} onChange={(e) => setRemote(e.target.value)} aria-label="Remote ComfyUI address" placeholder="https://<pod>-8188.proxy.runpod.net" className={input} />
      <button type="submit" className={`h-7 shrink-0 rounded-full px-3 text-[12px] font-medium ${on}`}>Connect</button>
    </form>
  ) : cloudOff ? null : (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-1.5">
      {cloud?.serverKey && !getCloudKey() && !key ? (
        <div className="flex w-full items-center justify-center gap-2">
          <span className={`text-[11.5px] ${quiet}`}>Using the key from the app server</span>
          {mode !== "cloud" && <button type="button" onClick={() => void connectCloud()} className={`h-7 shrink-0 rounded-full px-3 text-[12px] font-medium ${on}`}>Connect</button>}
          {mode === "cloud" && <button type="button" onClick={disconnect} className={ghost}>Disconnect</button>}
        </div>
      ) : (
        <form className="flex w-full items-center gap-2" onSubmit={(e) => { e.preventDefault(); void connectCloud(); }}>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Comfy Cloud API key" placeholder="comfyui-…" autoComplete="off" spellCheck={false} className={input} />
          <button type="submit" disabled={!key.trim()} className={`h-7 shrink-0 rounded-full px-3 text-[12px] font-medium disabled:opacity-40 ${on}`}>Connect</button>
          {(mode === "cloud" || getCloudKey()) && <button type="button" onClick={disconnect} className={ghost}>Disconnect</button>}
        </form>
      )}
      {!(cloud?.serverKey && !getCloudKey() && !key) && <span className={`text-[10.5px] ${quiet} opacity-80`}>Key from platform.comfy.org → API Keys · kept only in this browser</span>}
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
      {hint && <span className={`text-[11px] ${quiet}`} role="status">{hint}</span>}
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
