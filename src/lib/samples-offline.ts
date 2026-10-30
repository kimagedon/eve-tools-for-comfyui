/**
 * No ComfyUI server (the static GitHub Pages build, or a pod that is down):
 * a run that cannot reach one ends in one calm line instead of a raw network
 * error, and the server pill in the title bar lights up to show where to
 * connect one.
 */
import { useEffect, useState } from "react";
import { ComfyError } from "@/comfy";

export const CONNECT_NOTE = "Connect a ComfyUI server to render your own setup";

const OFFLINE = /No connection to ComfyUI|is offline|Failed to fetch|Load failed|NetworkError|Connect a ComfyUI server/i;

/** True when a run failed only because no server answered (an Error, a ComfyError or its message). */
export function isOfflineError(error: unknown): boolean {
  if (error instanceof ComfyError) return error.kind === "offline";
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return OFFLINE.test(text);
}

const EVENT = "eve:server-attention";
/** How long the server pill stays highlighted after a run found no server. */
const ATTENTION_MS = 2600;

/** Point at the server pill: a run needed a server and found none. */
export function askForServer() {
  window.dispatchEvent(new Event(EVENT));
}

/** True for a moment after `askForServer()`: the server pill draws attention to itself. */
export function useServerAttention(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ping = () => {
      setOn(true);
      clearTimeout(timer);
      timer = setTimeout(() => setOn(false), ATTENTION_MS);
    };
    window.addEventListener(EVENT, ping);
    return () => { window.removeEventListener(EVENT, ping); clearTimeout(timer); };
  }, []);
  return on;
}
