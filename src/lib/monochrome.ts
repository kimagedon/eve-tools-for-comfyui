/**
 * Black & white: a scene-level choice made in Light that every later step
 * honours — the Light preview turns monochrome, and every ComfyUI graph
 * (Relight, stills, shots) is told so and desaturates its own output.
 * Kept in localStorage, so it survives a reload and reaches Shoot / Result.
 */
const KEY = "eve-set-monochrome";
const listeners = new Set<(on: boolean) => void>();

export function monochrome(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function setMonochrome(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private window: this session only */ }
  listeners.forEach((f) => f(on));
}
export function onMonochrome(f: (on: boolean) => void) { listeners.add(f); return () => { listeners.delete(f); }; }

/** What every prompt says when the set is black & white. */
export const MONOCHROME_WORDS = "Black-and-white photograph, rich monochrome tonality, no colour.";

/** Digital (clean sensor) or Film (photochemical): the same scene-level choice, kept the same way. */
const FILM = "eve-set-film";
export function film(): boolean {
  try { return localStorage.getItem(FILM) === "1"; } catch { return false; }
}
export function setFilm(on: boolean) {
  try { localStorage.setItem(FILM, on ? "1" : "0"); } catch { /* this session only */ }
  listeners.forEach((f) => f(monochrome()));
}
export const FILM_WORDS = "Shot on 35mm film: fine organic grain, gentle halation around highlights, soft highlight roll-off, slightly lifted blacks.";
export const DIGITAL_WORDS = "Clean digital cinema image.";
/** The look in words for every prompt. */
export const lookWords = () => [monochrome() ? MONOCHROME_WORDS : "", film() ? FILM_WORDS : DIGITAL_WORDS].filter(Boolean).join(" ");
