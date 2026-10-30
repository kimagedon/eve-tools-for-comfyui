
import { useState } from "react";
import { Popover } from "@base-ui/react/popover";

function hsv(hex: string) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = rgb, v = Math.max(...rgb), d = v - Math.min(...rgb);
  const h = !d ? 0 : v === r ? ((g - b) / d + 6) % 6 : v === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: v ? d / v : 0, v };
}
function hex(h: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

/** A local HSV wheel: no WebView-dependent native colour dialog. */
export function LightColourPicker({ value, onChange }: { value: string; onChange: (colour: string) => void }) {
  const [lastHue, setLastHue] = useState(hsv(value).h);
  const [lastSaturation, setLastSaturation] = useState(hsv(value).s);
  const colour = hsv(value);
  if (colour.v === 0) colour.s = lastSaturation;
  const hue = colour.s > 0 ? colour.h : lastHue;
  const change = (h: number, s: number, v: number) => { setLastHue(h); setLastSaturation(s); onChange(hex(h, s, v)); };
  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * 2 - 1, y = (e.clientY - r.top) / r.height * 2 - 1;
    change((Math.atan2(x, -y) * 180 / Math.PI + 360) % 360, Math.min(1, Math.hypot(x, y)), colour.v || 1);
  };
  return <Popover.Root>
    <Popover.Trigger aria-label="Gel colour wheel" title="Gel — custom colour" className="ml-1 size-6 shrink-0 cursor-pointer rounded-full ring-1 ring-white/40 focus-visible:outline-2 focus-visible:outline-white"
      style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }} />
    <Popover.Portal>
      <Popover.Positioner side="top" sideOffset={12} className="z-[10100]">
        <Popover.Popup className="w-60 rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl outline-none">
          <div className="mb-3 flex items-center justify-between">
            <Popover.Title className="text-xs font-medium">Light colour</Popover.Title>
            <Popover.Close aria-label="Close colour wheel" className="size-6 rounded-full hover:bg-muted">×</Popover.Close>
          </div>
          <div role="slider" aria-label="Hue and saturation" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hue)}
            aria-valuetext={`${Math.round(hue)} degrees, ${Math.round(colour.s * 100)}% saturation`} tabIndex={0}
            className="relative mx-auto size-48 touch-none rounded-full cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ background: "radial-gradient(circle, white 0%, transparent 70.7%), conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); point(e); }}
            onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) point(e); }}
            onKeyDown={(e) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
              e.preventDefault();
              change((hue + (e.key === "ArrowRight" ? 2 : e.key === "ArrowLeft" ? -2 : 0) + 360) % 360,
                Math.max(0, Math.min(1, colour.s + (e.key === "ArrowUp" ? 0.02 : e.key === "ArrowDown" ? -0.02 : 0))), colour.v);
            }}>
            <span className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white ring-1 ring-black/70"
              style={{ left: `${50 + Math.sin(hue * Math.PI / 180) * colour.s * 50}%`, top: `${50 - Math.cos(hue * Math.PI / 180) * colour.s * 50}%`, background: value }} />
          </div>
          <label className="mt-4 flex items-center gap-2 text-xs">Brightness
            <input aria-label="Colour brightness" type="range" min={0} max={100} value={Math.round(colour.v * 100)}
              onChange={(e) => change(hue, colour.s, Number(e.target.value) / 100)} className="min-w-0 flex-1 accent-current" />
          </label>
          <label className="mt-3 flex items-center gap-2 text-xs">
            <span className="size-6 rounded-full border border-border" style={{ background: value }} />HEX
            <input aria-label="Light colour HEX" key={value} defaultValue={value.toUpperCase()} maxLength={7}
              onBlur={(e) => { const v = e.target.value.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v); else e.target.value = value.toUpperCase(); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs" />
          </label>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
