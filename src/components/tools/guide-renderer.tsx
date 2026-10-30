/**
 * The 3D guide, rendered without the studio — for batch shooting, several
 * cameras at once. The page mounts one host; each request
 * mounts the studio's own DepthScene off screen, takes the same snapshot
 * the studio takes on Run, and lets it go. One at a time: every scene
 * holds a WebGL context of its own.
 */
import { useEffect, useRef, useState } from "react";
import type { DepthSurface } from "@/lib/depth-mesh";
import { DepthScene, type DepthSceneHandle, type SceneCamera, type SceneFocus, type SceneLight } from "./depth-scene";

export interface GuideRequest {
  image: Blob;
  surface: DepthSurface;
  width: number;
  height: number;
  camera: SceneCamera;
  lit: boolean;
  /** What shows where the scene has no surface; "photo" = the photo itself (front view only). */
  background: string;
  lights?: SceneLight[];
  /** Ambient share 0..1. */
  ambient?: number;
  focus?: SceneFocus | null;
}

type Job = GuideRequest & { resolve: (blob: Blob) => void; reject: (error: Error) => void };

let enqueue: ((job: Job) => void) | null = null;

export function renderGuide(request: GuideRequest): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!enqueue) { reject(new Error("The 3D renderer is not ready yet")); return; }
    enqueue({ ...request, resolve, reject });
  });
}

const LIMITS = { azimuth: 180, elevation: 75 };

export function GuideRendererHost() {
  const queue = useRef<Job[]>([]);
  const busy = useRef(false);
  const scene = useRef<DepthSceneHandle>(null);
  const [current, setCurrent] = useState<{ job: Job; img: HTMLImageElement; url: string } | null>(null);

  // Takes the next request when idle; a ref, so the finished one can call it again.
  const pump = useRef(() => {});
  useEffect(() => {
    pump.current = () => {
      if (busy.current) return;
      const job = queue.current.shift();
      if (!job) return;
      busy.current = true;
      const url = URL.createObjectURL(job.image);
      const img = new Image();
      img.src = url;
      img.decode().then(() => setCurrent({ job, img, url })).catch(() => {
        URL.revokeObjectURL(url);
        job.reject(new Error("Could not read the image for the 3D guide"));
        busy.current = false;
        pump.current();
      });
    };
    const waiting = queue.current;
    enqueue = (job) => { waiting.push(job); pump.current(); };
    return () => {
      enqueue = null;
      for (const job of waiting.splice(0)) job.reject(new Error("EVE closed the 3D renderer"));
    };
  }, []);

  // Runs after the scene's own effects have given it the surface and the photo.
  useEffect(() => {
    if (!current) return;
    const { job, url } = current;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      // The scene stays mounted for the next guide: one WebGL context for all of them.
      busy.current = false;
      pump.current();
    };
    const handle = scene.current;
    if (!handle) { job.reject(new Error("The 3D scene did not start")); done(); return; }
    handle.snapshot({ width: job.width, height: job.height, camera: job.camera, lit: job.lit, background: job.background })
      .then(job.resolve, (error) => job.reject(error instanceof Error ? error : new Error(String(error))))
      .finally(done);
  }, [current]);

  if (!current) return null;
  const { job, img } = current;
  return (
    <div aria-hidden className="pointer-events-none fixed -left-[10000px] top-0 h-16 w-16 opacity-0">
      <DepthScene ref={scene} image={img} surface={job.surface} width={64} height={64} lit={job.lit} camera={job.camera}
        limits={LIMITS} lights={job.lights} ambient={job.ambient} focus={job.focus ?? null} interactive={false} />
    </div>
  );
}
