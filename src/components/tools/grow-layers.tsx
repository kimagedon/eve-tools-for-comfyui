import { useId } from "react";

/**
 * The room around the photo, drawn as the photo growing into it. Two CSS-
 * blurred layers (full resolution, GPU): mirrored copies of the picture
 * tiled round it, dimmed; and a halo of the photo around its own edges at
 * full brightness, into which the photo's feathered border melts.
 *
 * Built for a smooth drag: both layers are rastered once at the photo's
 * size and only ever moved or scaled with transforms (their own compositor
 * layers), so pulling the frame repaints nothing. How hard the frame is
 * pulled lifts a black veil's opacity instead of changing a filter. The
 * ragged, drifting edge (SVG turbulence) runs only while the model works.
 */
export function GrowLayers({ url, photo, running, energy }: {
  url: string;
  /** The photo's rect inside the frame, in CSS px. */
  photo: { x: number; y: number; w: number; h: number };
  running: boolean;
  /** 0–1: how hard the frame is being pulled right now (drag speed, smoothed). */
  energy: number;
}) {
  const HALO = 1.22;
  const id = `eve-ragged-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  // Apple-like settle: quick to answer the pointer, long soft tail on release.
  const ease = "cubic-bezier(.22,1,.36,1)";
  const ms = running ? 2500 : energy > 0 ? 350 : 900;
  // The room's brightness (0.42 at rest → 0.82 pulled hard, 0.55 while running), as a veil over a 0.82 layer.
  const lit = running ? 0.55 : 0.42 + 0.4 * energy;
  const { w, h } = photo;
  return (
    <>
      {running && (
        <svg aria-hidden width="0" height="0" className="absolute">
          <filter id={id} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="2" seed="7" result="noise">
              <animate attributeName="baseFrequency" dur="5s" values="0.009;0.016;0.011;0.009" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale={64} xChannelSelector="R" yChannelSelector="G">
              <animate attributeName="scale" dur="3.2s" values="45;64;51;45" repeatCount="indefinite" />
            </feDisplacementMap>
          </filter>
        </svg>
      )}
      {/* The far room: mirrored copies tiled round the photo and blurred — colours meet
          at every seam and nothing is blown up. Anchored to the photo by a transform. */}
      <div className="pointer-events-none absolute left-0 top-0" style={{ transform: `translate3d(${photo.x}px, ${photo.y}px, 0)`, willChange: "transform" }}>
        <div className="absolute" style={{ left: -2 * w, top: -2 * h, width: 5 * w, height: 5 * h, filter: "blur(44px) saturate(1.1) brightness(0.82)" }}>
          {[-2, -1, 0, 1, 2].flatMap((i) => [-2, -1, 0, 1, 2].map((j) => (
            <img key={`${i}:${j}`} src={url} alt="" draggable={false} aria-hidden className="absolute max-w-none"
              style={{ left: (i + 2) * w, top: (j + 2) * h, width: w, height: h, transform: `scale(${i % 2 ? -1 : 1}, ${j % 2 ? -1 : 1})` }} />
          )))}
        </div>
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-black"
        style={{ opacity: 1 - lit / 0.82, transition: `opacity ${ms}ms ${ease}`, willChange: "opacity" }} />
      {/* The halo round the photo's edge; it breathes and swells with the pull — transforms only. */}
      <div className="pointer-events-none absolute left-0 top-0"
        style={{
          width: w * HALO, height: h * HALO, willChange: "transform",
          transform: `translate3d(${photo.x + w / 2 - (w * HALO) / 2}px, ${photo.y + h / 2 - (h * HALO) / 2}px, 0) scale(${running ? 1.03 : 1 + 0.08 * energy})`,
          transition: `transform ${running ? 2500 : energy > 0 ? 0 : 300}ms ${ease}`,
        }}>
        <img src={url} alt="" draggable={false} aria-hidden className="eve-grow-breathe h-full w-full max-w-none"
          style={{ filter: running ? `blur(14px) saturate(1.08) url(#${id})` : "blur(14px) saturate(1.08)" }} />
      </div>
    </>
  );
}
