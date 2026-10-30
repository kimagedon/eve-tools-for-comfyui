/**
 * The house marks: EVE's lens (the sphere from the teasers, clipped to its
 * glass, with an optional anamorphic streak) and the viewfinder drawn over
 * every frame — corner brackets, mono labels in the corners, a centre cross.
 */
import { useEffect, useRef, useState } from "react";
import type { Rect } from "@/components/tools/studio";
import { getServer, isDemo, serverLabel } from "@/comfy";

/** An error as shown on screen: in recording mode the server's address never appears. */
export function scrub(message: string): string {
  if (!isDemo()) return message;
  const url = getServer();
  let host = url;
  try { host = new URL(url).host; } catch { /* not a URL */ }
  return message.split(url).join(serverLabel()).split(host).join(serverLabel()).replace(/https?:\/\/[^\s)"']+/g, serverLabel());
}

export function LensMark({ size = 16, streak = false, className = "" }: { size?: number; streak?: boolean; className?: string }) {
  return (
    <span aria-hidden className={`eve-lens ${className}`} data-streak={streak || undefined} style={{ "--lens": `${size}px` } as React.CSSProperties}>
      <img src={`${import.meta.env.BASE_URL}lens.jpg`} alt="" draggable={false} />
    </span>
  );
}

/** One render of the sphere, AVIF → WebP → JPEG. */
function Render({ name, className }: { name: string; className: string }) {
  const base = `${import.meta.env.BASE_URL}lens/${name}`;
  return (
    <picture className={className}>
      <source srcSet={`${base}.avif`} type="image/avif" />
      <source srcSet={`${base}.webp`} type="image/webp" />
      <img src={`${base}.jpg`} alt="" draggable={false} decoding="async" />
    </picture>
  );
}

/**
 * The hero: EVE's glass sphere, two renders of it (warm and blue) breathing
 * and slowly trading places, with a thin anamorphic streak through its
 * highlight. `size` is the sphere's diameter (any CSS length).
 */
export function LensHero({ size }: { size: string }) {
  return (
    <span aria-hidden className="lens-hero" style={{ "--d": size } as React.CSSProperties}>
      <span className="lens-hero-disc" />
      <span className="lens-hero-breathe">
        <Render name="sphere-warm" className="lens-hero-warm" />
        <Render name="sphere-blue" className="lens-hero-blue" />
        <span className="lens-hero-streak" />
      </span>
    </span>
  );
}

/**
 * The hero, moving: a seamless 6 s loop of the sphere (2.39:1 on black) when
 * public/lens/hero-loop.* exists, screened onto the page; the static sphere
 * until the loop is playing, under reduced motion, and in the light theme.
 */
export function HeroLoop({ sphere }: { sphere: string }) {
  const [files, setFiles] = useState<{ webm: boolean; mp4: boolean; poster: boolean } | null>(null);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  // The light theme hides the loop (display: none pauses it); back in dark it must run again.
  useEffect(() => {
    const kick = () => { const v = video.current; if (v && v.paused) void v.play().catch(() => {}); };
    const mo = new MutationObserver(kick);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    document.addEventListener("visibilitychange", kick);
    return () => { mo.disconnect(); document.removeEventListener("visibilitychange", kick); };
  }, []);
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const base = `${import.meta.env.BASE_URL}lens/`;
  useEffect(() => {
    if (reduced) return;
    let alive = true;
    const has = (f: string, type: string) => fetch(base + f, { method: "HEAD" }).then((r) => r.ok && (r.headers.get("content-type") ?? "").startsWith(type)).catch(() => false);
    void Promise.all([has("hero-loop.webm", "video/"), has("hero-loop-1280.mp4", "video/"), has("hero-poster.jpg", "image/")])
      .then(([webm, mp4, poster]) => { if (alive && (webm || mp4)) setFiles({ webm, mp4, poster }); });
    return () => { alive = false; };
  }, [base, reduced]);
  return (
    <span className="hero-loop" style={{ "--d": sphere } as React.CSSProperties}>
      <span className={`hero-static transition-opacity duration-700 ease-out ${playing ? "opacity-0" : "opacity-100"}`}><LensHero size={sphere} /></span>
      {files && (
        <video ref={video} className={`hero-video transition-opacity duration-700 ease-out ${playing ? "opacity-100" : "opacity-0"}`} autoPlay muted loop playsInline preload="auto"
          poster={files.poster ? `${base}hero-poster.jpg` : undefined} onPlaying={() => setPlaying(true)} aria-hidden>
          {files.webm && <source src={`${base}hero-loop.webm`} type="video/webm" />}
          {files.mp4 && <source src={`${base}hero-loop-1280.mp4`} type="video/mp4" />}
        </video>
      )}
    </span>
  );
}

/** The landing's atmosphere: a macro of the sphere's glass, blurred and very dark, full-bleed. */
export function LensBackdrop() {
  return (
    <div aria-hidden className="lens-backdrop">
      <Render name="macro" className="lens-backdrop-img" />
    </div>
  );
}

export function Viewfinder({ rect, hidden = false }: { rect: Rect; hidden?: boolean }) {
  return (
    <div aria-hidden className="vf transition-opacity duration-300 ease-out" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, opacity: hidden ? 0 : 1 }}>
      <span className="vf-c tl" /><span className="vf-c tr" /><span className="vf-c bl" /><span className="vf-c br" />
    </div>
  );
}

/**
 * The wait: the glass sphere loop (6 s, seamless, pure black) screened onto the
 * frame. On the studio's black it needs no other treatment; elsewhere it sits
 * in a small dark disc.
 */
export function LensLoader({ size, disc = false }: { size: number; disc?: boolean }) {
  const base = `${import.meta.env.BASE_URL}lens/`;
  return (
    <span aria-hidden className={`lens-loader ${disc ? "lens-loader-disc" : ""}`} style={{ width: size, height: size }}>
      <video autoPlay muted loop playsInline preload="auto" poster={`${base}loader-160.webp`}>
        <source src={`${base}loader-320.webm`} type="video/webm" />
        <source src={`${base}loader-320.mp4`} type="video/mp4" />
      </video>
    </span>
  );
}

/** Seconds as SMPTE timecode at 24 fps. */
export function timecode(seconds: number, fps = 24) {
  const f = Math.floor(seconds * fps);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(Math.floor(f / fps / 3600))}:${p(Math.floor(f / fps / 60) % 60)}:${p(Math.floor(f / fps) % 60)}:${p(f % fps)}`;
}
