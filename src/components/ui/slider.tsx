import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  showTicks,
  ...props
}: SliderPrimitive.Root.Props & { showTicks?: boolean }) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max]
  )

  const step = (props.step as number) ?? 1
  const tickCount = showTicks ? Math.floor((max - min) / step) + 1 : 0

  // "Click-jump" detection: pointerdown without subsequent movement is a
  // discrete jump to that position, and the fill bar + thumb should glide
  // there. Once the user moves more than a few px the interaction becomes a
  // real drag and transitions are killed so the thumb stays glued 1:1.
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const downXRef = React.useRef<number | null>(null)
  const clearTimerRef = React.useRef<number | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current)
      clearTimerRef.current = null
    }
    downXRef.current = e.clientX
    wrapperRef.current?.setAttribute("data-click-jump", "1")
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (downXRef.current === null) return
    if (Math.abs(e.clientX - downXRef.current) > 3) {
      wrapperRef.current?.removeAttribute("data-click-jump")
      downXRef.current = null
    }
  }

  const onPointerUp = () => {
    if (downXRef.current !== null && wrapperRef.current?.hasAttribute("data-click-jump")) {
      clearTimerRef.current = window.setTimeout(() => {
        wrapperRef.current?.removeAttribute("data-click-jump")
        clearTimerRef.current = null
      }, 320)
    }
    downXRef.current = null
  }

  React.useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current)
    }
  }, [])

  return (
    <div
      ref={wrapperRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="group/slider flex h-[18px] items-center px-[7px]"
    >
      <SliderPrimitive.Root
        className={cn("relative w-full", className)}
        data-slot="slider"
        defaultValue={defaultValue}
        value={value}
        min={min}
        max={max}
        {...props}
      >
        <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50">
          <SliderPrimitive.Track
            data-slot="slider-track"
            className="relative h-[3px] w-full grow rounded-full select-none before:absolute before:-inset-y-3 before:-inset-x-[7px] before:content-['']"
            style={{ background: "var(--slider-track)" }}
          >
            {showTicks && tickCount > 2 && (
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-between pointer-events-none">
                {Array.from({ length: tickCount }, (_, i) => (
                  <div
                    key={i}
                    className={cn(
                      "h-1.5 w-px",
                      i === 0 || i === tickCount - 1
                        ? "opacity-0"
                        : "bg-gray-400/40 dark:bg-white/15"
                    )}
                  />
                ))}
              </div>
            )}
            {/* Filled portion (Indicator). The transition is short
                (90ms) so the bar still feels glued to the thumb during
                a drag, but smooths discrete keyboard/programmatic
                changes instead of snapping. The fill color uses the
                slider's own thumb gradient for cohesion with the rest
                of the theme. */}
            <SliderPrimitive.Indicator
              data-slot="slider-range"
              className="slider-range h-full select-none rounded-full"
              style={{ background: "var(--slider-fill)" }}
            />
          </SliderPrimitive.Track>
          {Array.from({ length: _values.length }, (_, index) => (
            <SliderPrimitive.Thumb
              data-slot="slider-thumb"
              key={index}
              className={cn(
                "slider-thumb relative block h-[13px] w-[13px] shrink-0 rounded-full select-none after:absolute after:-inset-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--slider-fill)] disabled:pointer-events-none disabled:opacity-50",
              )}
              style={{ background: "var(--slider-thumb)" }}
            />
          ))}
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>
    </div>
  )
}

export { Slider }
