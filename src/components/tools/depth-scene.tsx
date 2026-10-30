
/**
 * The photo as a 3D scene (lib/depth-mesh) drawn with three.js, exactly in
 * the photo's place on the stage. From the original camera it is the photo,
 * pixel for pixel; drag to look round it.
 *
 * Relight hangs point lights off its surfaces and shades it live (no shadow
 * maps: one photo's depth is too noisy to cast clean shadows — the model
 * draws those). Reframe moves the camera and changes the lens: optical zoom with a fixed camera position, barrel
 * distortion under 24 mm, and depth of field from the depth buffer.
 *
 * The scene renders into a target; a final pass adds the lens, the focus
 * blur and clean edges. The preview keeps photographic seam bridges;
 * snapshots mark unsupported surfaces grey for the model to reconstruct.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { lens } from "@/lib/camera-lens";
export { lens } from "@/lib/camera-lens";
import { SceneContinuation } from "./scene-continuation";
import { LightRig3D, type GizmoAxis, type GizmoMode } from "./light-rig3d";
import { orbitLimits, type DepthSurface } from "@/lib/depth-mesh";

export interface SceneCamera {
  azimuth: number;
  elevation: number;
  /** 35 mm-equivalent focal length; null = the lens the photo was shot with. */
  focal: number | null;
  /** Camera distance as a share of the lens's own (1): < 1 flies in, > 1 pulls back. */
  dolly?: number;
  /** The subject the camera aims at (scene point); the set's middle when absent. */
  target?: Vec3;
}
export type Vec3 = [number, number, number];
export interface SceneLight {
  id: string;
  /** Where on the surface it was put, and that surface's normal. */
  anchor: Vec3;
  normal: Vec3;
  /** Distance out from the surface, in scene widths (0.03 – 0.8). */
  offset: number;
  colour: string;
  strength: number;
  /** Point: a bare bulb. Spot: a cone aimed at the anchor. Sun: parallel light along the same line. */
  kind?: LightKind;
  /** Spot: the cone's full angle, degrees. */
  beam?: number;
  /** Spot / Sun: the point it is aimed at (default: its anchor). */
  aim?: Vec3;
  /** On the lighting plot and in the prompt: the unit, its job and its colour temperature. */
  fixture?: Fixture;
  role?: LightRole;
  /** Colour temperature; absent when a gel colour was picked. */
  kelvin?: number;
  /** Green (−) / magenta (+), −100..100. */
  tint?: number;
  /** Hung freely (gizmo, Back role): the unit direction out from `anchor`; absent = between the surface's normal and the camera. */
  dir?: Vec3;
  /** Hung from the overhead grid (no stand). */
  hung?: boolean;
  /** The fixture library unit (scene-rig LIBRARY id). */
  model?: string;
}
export type Fixture = "fresnel" | "openface" | "led" | "softbox" | "practical" | "hmi";
export type LightRole = "key" | "fill" | "back" | "practical";
export type LightKind = "point" | "spot" | "sun";
/** Depth of field: the point in focus and the aperture. */
export interface SceneFocus { point: Vec3; fstop: number }
export interface SceneSnapshot {
  width: number;
  height: number;
  camera: SceneCamera;
  lit: boolean;
  /** What shows where the scene has no surface. "photo" = the photo itself (front view only). */
  background: string | "photo";
}
export interface DepthSceneHandle {
  snapshot(options: SceneSnapshot): Promise<Blob>;
  /** Mean relative luminance of a region (0..1 of the view: x, y, w, h) of the next drawn frame — for text over it. */
  luma(region: [number, number, number, number]): Promise<number | null>;
}

const DEG = Math.PI / 180;
const INTRO_MS = 2600;
/** The fly-around (push in, arc left → right, crane, back) and the first-frame reveal. */
const FLY_MS = 8000;
const REVEAL_MS = 2600;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number) => 1 - (1 - x) ** 3;

// The plate's shape on the GPU (`relief` / `reveal`): every vertex lies on its
// pixel's camera ray, so it is rescaled along that ray — from the photo's own
// camera the plate stays the photo, pixel for pixel, whatever the relief.
type U = { value: number };
interface Shape { on: U; center: U; relief: U; flat: U; sweep: U; sweepAmount: U; border: U }
const SHAPE_VERT_HEAD = "uniform float uShapeOn, uCenter, uRelief, uFlat;\nvarying float vDepthLog;";
const SHAPE_VERT = /* glsl */ `
{
  float zr = max(1e-4, -transformed.z);
  float lr = log(zr / uCenter);
  vDepthLog = lr;
  if (uShapeOn > 0.5) {
    // lib/depth-mesh's bounded log profile; at full relief the depth as measured.
    float soft = uCenter * exp(0.5 * tanh(lr * uRelief / 0.5));
    float z = mix(soft, zr, smoothstep(0.6, 1.0, uRelief));
    z = mix(uCenter, z, uFlat);
    transformed *= z / zr;
  }
}`;
const SHAPE_FRAG_HEAD = "uniform float uSweep, uSweepAmount, uBorder;\nvarying float vDepthLog;";
const SHAPE_FRAG = /* glsl */ `
{
  // One faint contour travelling from near to far: depth, read at a glance.
  // A hairline whatever the surface's slant: its width is set in pixels, not depth.
  float fw = clamp(fwidth(vDepthLog), 1e-5, 0.015);
  diffuseColor.rgb += vec3(0.85, 0.92, 1.0) * uSweepAmount * (1.0 - smoothstep(0.4 * fw, 1.4 * fw, abs(vDepthLog - uSweep)));
#ifdef USE_MAP
  // Turned, the plate's border melts into the black stage instead of ending in a line.
  vec2 bu = min(vMapUv, 1.0 - vMapUv);
  diffuseColor.rgb *= mix(1.0, smoothstep(0.0, 0.035, bu.x) * smoothstep(0.0, 0.05, bu.y), uBorder);
#endif
}`;
type ShaderSource = { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string };
function shaped(shader: ShaderSource, s: Shape) {
  Object.assign(shader.uniforms, { uShapeOn: s.on, uCenter: s.center, uRelief: s.relief, uFlat: s.flat, uSweep: s.sweep, uSweepAmount: s.sweepAmount, uBorder: s.border });
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${SHAPE_VERT_HEAD}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${SHAPE_VERT}`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${SHAPE_FRAG_HEAD}`)
    .replace("#include <map_fragment>", `#include <map_fragment>\n${SHAPE_FRAG}`);
}

/**
 * Mean relative luminance (0..1, linear) of a region of a drawn scene canvas — `region` in 0..1 of
 * its size (x, y, w, h) — so text over the picture can pick dark or light ink. Null if it can't be read.
 */
export function canvasLuma(canvas: HTMLCanvasElement | null, region: [number, number, number, number]): number | null {
  if (!canvas || !canvas.width) return null;
  try {
    const k = document.createElement("canvas");
    k.width = 48; k.height = 24;
    const g = k.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    const [x, y, w, h] = region;
    g.drawImage(canvas, x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height, 0, 0, 48, 24);
    const d = g.getImageData(0, 0, 48, 24).data;
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; sum += a * (0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2])); n++; }
    return n ? sum / n : null;
  } catch { return null; }
}

export const FRONT: SceneCamera = { azimuth: 0, elevation: 0, focal: null };
export const DOLLY: [number, number] = [0.02, 12];

/** `over`: the canvas shows this much more than the frame on every side (the frame stays the lens's view). */
function pose(camera: THREE.PerspectiveCamera, s: DepthSurface, c: SceneCamera, over = 1, aspect = s.aspect) {
  const az = c.azimuth * DEG, el = c.elevation * DEG;
  const { fovY: frameFov, r } = lens(s, c);
  const fovY = (2 * Math.atan(Math.tan((frameFov / 2) * DEG) * over)) / DEG;
  camera.position.set(r * Math.sin(az) * Math.cos(el), r * Math.sin(el), -s.pivot + r * Math.cos(az) * Math.cos(el));
  camera.up.set(0, 1, 0);
  if (c.target) camera.lookAt(c.target[0], c.target[1], c.target[2]); else camera.lookAt(0, 0, -s.pivot);
  camera.fov = fovY;
  camera.aspect = aspect;
  camera.zoom = 1;
  camera.near = 0.001;
  camera.far = Math.max(60, r + s.pivot + Math.hypot(...s.bounds.min) + Math.hypot(...s.bounds.max));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/** Where a light hangs: out from its anchor, between the surface's normal and
 * the photo's camera — so from the front it sits over the spot it was put on. */
export function lightPoint(s: DepthSurface, l: SceneLight): Vec3 {
  const a = new THREE.Vector3(...l.anchor);
  const dir = l.dir ? new THREE.Vector3(...l.dir).normalize()
    : new THREE.Vector3(...l.normal).normalize().multiplyScalar(0.3).add(a.clone().negate().normalize().multiplyScalar(0.7)).normalize();
  let len = l.offset * s.scale;
  // Never past (or onto) the camera: a unit hung towards the lens stops at 15 % of the set's depth
  // in front of it — otherwise it flipped behind the camera and jittered wildly near it.
  const minZ = 0.15 * s.pivot;
  if (dir.z > 1e-6 && -(a.z + dir.z * len) < minZ) len = Math.max(0, (-a.z - minZ) / dir.z);
  return a.addScaledVector(dir, len).toArray() as Vec3;
}

/** Ambient share 0..1 → light intensity. three's lights are physical: π gives the albedo back. */
const ambientIntensity = (a: number) => Math.PI * a;
/** A light's intensity so it adds about `strength` of the albedo where it was put, wherever it hangs. */
const pointIntensity = (s: DepthSurface, l: SceneLight) => Math.PI * 2.4 * l.strength * (l.offset * s.scale) ** 2;

function glowTexture() {
  const c = document.createElement("canvas");
  // 256 px, a smooth (Gaussian-like) falloff: magnified, it never shows steps or grain.
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (let i = 0; i <= 16; i++) { const t = i / 16; grad.addColorStop(t, `rgba(255,255,255,${(Math.exp(-t * t * 5) - Math.exp(-5)) / (1 - Math.exp(-5))})`); }
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ── The final pass: lens, focus, holes ───────────────────────────────

const POST_VERT = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// The target holds premultiplied colour (everything is blended over a clear,
// transparent black), and it is mipmapped: the focus blur reads the level
// that matches each pixel's blur, plus a soft ring of taps — creamy bokeh
// with no rings or streaks at any size.
const POST_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNearest;
uniform vec2 uRes;
uniform float uAspect, uBarrel, uNear, uFar, uOver;
uniform float uDof, uFocus, uCoc;
uniform float uFeather, uContinuation;
uniform vec4 uHole; // rgb (sRGB) + 1 = paint holes opaque (snapshot)
in vec2 vUv;
layout(location = 0) out vec4 outColor;

float linearDepth(vec2 uv) {
  float z = texture(tDepth, uv).x * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
vec2 lensUv(vec2 uv) {
  // In the frame's own units: the barrel is the frame's lens, the overscan just shows more.
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0) * uOver;
  float r2 = dot(c, c);
  float edge = 0.25 * uAspect * uAspect + 0.25;
  c *= (1.0 + uBarrel * r2) / (1.0 + uBarrel * edge);
  return c / (vec2(uAspect, 1.0) * uOver) + 0.5;
}
float coc(float z) { return clamp(uCoc * abs(1.0 - uFocus / z), 0.0, 48.0); }
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = lensUv(vUv);
  vec4 col = texture(tColor, uv);
  float z = linearDepth(uv);
  float r0 = uDof > 0.5 ? coc(z) : 0.0;
  if (r0 > 0.5) {
    float lod = log2(max(r0 * 0.45, 1.0));
    vec4 acc = textureLod(tColor, uv, lod);
    float wsum = 1.0;
    for (int i = 0; i < 20; i++) {
      float fi = float(i);
      float rr = sqrt((fi + 0.5) / 20.0) * r0;
      float th = fi * 2.39996323;
      vec2 o = vec2(cos(th), sin(th)) * rr / uRes;
      float zs = linearDepth(uv + o);
      // Something sharp in front must not smear over what is behind it.
      float w = zs >= z * 0.97 ? 1.0 : smoothstep(rr * 0.5, rr + 1.0, coc(zs));
      acc += textureLod(tColor, uv + o, max(0.0, lod - 1.0)) * w;
      wsum += w;
    }
    col = acc / wsum;
  }
  if (uFeather > 0.0) {
    // In focus only: where depth steps (a silhouette over the layer behind),
    // blend across the step so the mesh grid never shows as a staircase.
    vec2 px = 1.0 / uRes;
    float zmin = z, zmax = z;
    for (int i = 0; i < 4; i++) {
      float th = float(i) * 1.5707963 + 0.785398;
      float zz = linearDepth(uv + vec2(cos(th), sin(th)) * px * 1.5);
      zmin = min(zmin, zz); zmax = max(zmax, zz);
    }
    float edge = smoothstep(1.01, 1.05, zmax / zmin) * (1.0 - smoothstep(0.5, 2.0, r0));
    vec4 soft = col;
    for (int i = 0; i < 8; i++) {
      float th = float(i) * 0.785398;
      soft += texture(tColor, uv + vec2(cos(th), sin(th)) * px * uFeather);
    }
    col = mix(col, soft / 9.0, edge);
  }
  // Smooth edge-derived colour field, computed at low resolution on the GPU.
  if (uContinuation > 0.5 && col.a < 0.999) {
    vec4 room = texture(tNearest, uv);
    vec3 backdrop = mix(vec3(0.012), room.rgb, room.a);
    col = vec4(col.rgb + backdrop * (1.0 - col.a), 1.0);
  }
  vec3 rgb = col.a > 0.0 ? col.rgb / col.a : vec3(0.0);
  if (uHole.a > 0.5) outColor = vec4(mix(uHole.rgb, toSrgb(rgb), col.a), 1.0);
  else outColor = vec4(toSrgb(rgb) * col.a, col.a);
}`;

interface Post {
  continuation?: SceneContinuation;
  target: THREE.WebGLRenderTarget;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  material: THREE.ShaderMaterial;
}

function makePost(w: number, h: number): Post {
  const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  target.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: POST_VERT, fragmentShader: POST_FRAG, depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.NoBlending,
    uniforms: {
      tNearest: { value: null }, tColor: { value: target.texture }, tDepth: { value: target.depthTexture },
      uRes: { value: new THREE.Vector2(w, h) }, uAspect: { value: w / h }, uBarrel: { value: 0 },
      uNear: { value: 0.02 }, uFar: { value: 60 }, uOver: { value: 1 }, uDof: { value: 0 }, uFocus: { value: 1 }, uCoc: { value: 0 },
      uContinuation: { value: 0 }, uFeather: { value: 0 }, uHole: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return { target, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material };
}
function disposePost(p: Post) {
  p.continuation?.dispose();
  p.target.depthTexture?.dispose();
  p.target.dispose();
  p.material.dispose();
  (p.scene.children[0] as THREE.Mesh).geometry.dispose();
}
const srgb = (hex: string) => {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255] as const;
};

/** Render `scene` from `camera` through the final pass to the canvas. */
function composite(renderer: THREE.WebGLRenderer, post: Post, scene: THREE.Scene, camera: THREE.PerspectiveCamera, o: {
  surface: DepthSurface; view: SceneCamera; focus: SceneFocus | null; feather: number; hole: string | null; rerender: boolean; over?: number; continuation?: boolean;
}) {
  if (o.rerender) {
    renderer.setRenderTarget(post.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  }
  const u = post.material.uniforms;
  if (o.continuation && o.rerender) {
    post.continuation ??= new SceneContinuation(post.target.width, post.target.height);
    u.tNearest.value = post.continuation.render(renderer, post.target.texture);
  }
  const { barrel, f } = lens(o.surface, o.view);
  u.uBarrel.value = barrel;
  u.uOver.value = o.over ?? 1;
  u.uNear.value = camera.near;
  u.uFar.value = camera.far;
  u.uFeather.value = o.feather;
  u.uContinuation.value = o.continuation ? 1 : 0;
  if (o.focus) {
    const p = new THREE.Vector3(...o.focus.point).applyMatrix4(camera.matrixWorldInverse);
    u.uDof.value = 1;
    u.uFocus.value = Math.max(0.05, -p.z);
    // Blur in px at the frame's height: wider open and longer lens = softer.
    u.uCoc.value = (post.target.height / (o.over ?? 1)) * 0.034 * (1.4 / o.focus.fstop) * Math.min(3, Math.max(0.5, f / 35));
  } else u.uDof.value = 0;
  if (o.hole) { const [r, g, b] = srgb(o.hole); u.uHole.value.set(r, g, b, 1); } else u.uHole.value.set(0, 0, 0, 0);
  renderer.setClearColor(0x000000, 0);
  renderer.render(post.scene, post.camera);
}

/** `handle`: the dark backing disc (also the hit target); `core` the light's colour; `rim` white; `ring` marks the selected one. */
/** Spot / Sun also get `aimHandle` + `aimRing` (where it points, draggable) and `beam`, the line to it. */
type LightRig = { kind: LightKind | "hemi"; light: THREE.PointLight | THREE.SpotLight | THREE.DirectionalLight; handle: THREE.Mesh; core: THREE.Mesh; rim: THREE.Mesh; halo: THREE.Sprite; ring: THREE.Mesh; plate: THREE.Mesh; beam: THREE.Line; aimHandle: THREE.Mesh; aimRing: THREE.Mesh };

interface World {
  renderer: THREE.WebGLRenderer;
  post: Post | null;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mesh: THREE.Mesh;
  /** The silhouette sheet: the photo from the front, a hole from anywhere else. */
  seam: THREE.Mesh;
  seamBasic: THREE.MeshBasicMaterial;
  seamStandard: THREE.MeshStandardMaterial;
  /** `cut`: drop the sheet (the model's grey holes); `texel`: photo texels per screen pixel, unstretched; `size`: the texture's size. */
  hole: { cut: { value: number }; texel: { value: number }; size: { value: THREE.Vector2 }; away: { value: number } };
  /** What lies behind the photo and past its edges (lib/depth-layers): on screen only. */
  /** A coarse copy of the surface for picking: a full-resolution raycast per pointer move stalls. */
  proxy: THREE.Mesh;
  texture: THREE.Texture | null;
  basic: THREE.MeshBasicMaterial;
  standard: THREE.MeshStandardMaterial;
  ambient: THREE.AmbientLight;
  rigs: Map<string, LightRig>;
  /** The units as fixtures on the set and the gizmo (light-rig3d): screen only. */
  rig3d: LightRig3D;
  /** Near-field softening of point/spot falloff (d0², scene units). */
  near2: { value: number };
  /** Where the far background (sky) begins and is fully reached, in set depth: it receives no unit's light. */
  farRange: { value: THREE.Vector2 };
  reticle: THREE.Mesh;
  glow: THREE.Texture;
  surface: DepthSurface | null;
  /** GPU relief, the reveal and the border fade (see SHAPE_VERT). */
  shape: Shape;
}

// One snapshot renderer for every scene, kept: a new WebGL context per guide recompiled every shader
// and re-uploaded the surface (≈60 ms stalls per guide in Cameras).
let snapRenderer: THREE.WebGLRenderer | null = null;
/** A surface's GPU geometry, built once and shared by every scene that shows it (left to GC, never disposed). */
const bySurface = new WeakMap<DepthSurface, { mesh: THREE.BufferGeometry; seam: THREE.BufferGeometry; proxy: THREE.BufferGeometry }>();
const cached = new WeakSet<THREE.BufferGeometry>();
function surfaceGeometry(s: DepthSurface) {
  let geo = bySurface.get(s);
  if (geo) return geo;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(s.positions, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(s.uvs, 2));
  g.setAttribute("normal", new THREE.BufferAttribute(s.normals, 3));
  g.setAttribute("edge", new THREE.BufferAttribute(s.edge, 1));
  g.setIndex(new THREE.BufferAttribute(s.index, 1));
  g.computeBoundingSphere();
  // Keep photographic UVs across seams; generation guides can cut unsupported bridges.
  const sg = new THREE.BufferGeometry();
  sg.setAttribute("position", g.getAttribute("position"));
  sg.setAttribute("uv", g.getAttribute("uv"));
  sg.setAttribute("normal", g.getAttribute("normal"));
  sg.setIndex(new THREE.BufferAttribute(s.seams, 1));
  sg.computeBoundingSphere();
  geo = { mesh: g, seam: sg, proxy: proxyGeometry(s) };
  for (const x of Object.values(geo)) cached.add(x);
  bySurface.set(s, geo);
  return geo;
}

function proxyGeometry(s: DepthSurface, step = 4) {
  const cols = Math.ceil(s.cols / step), rows = Math.ceil(s.rows / step);
  const pos = new Float32Array((cols + 1) * (rows + 1) * 3);
  const uv = new Float32Array((cols + 1) * (rows + 1) * 2);
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const si = Math.min(s.cols, i * step), sj = Math.min(s.rows, j * step);
    const k = sj * (s.cols + 1) + si, d = j * (cols + 1) + i;
    pos.set(s.positions.subarray(k * 3, k * 3 + 3), d * 3);
    uv.set(s.uvs.subarray(k * 2, k * 2 + 2), d * 2);
  }
  const index: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
    index.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

export const DepthScene = forwardRef<DepthSceneHandle, {
  image: HTMLImageElement;
  surface: DepthSurface;
  width: number;
  height: number;
  /** Shade with the lights (Relight) or show the photo as it is (Reframe). */
  lit: boolean;
  camera: SceneCamera;
  onCamera?: (c: SceneCamera) => void;
  limits: { azimuth: number; elevation: number; focal?: [number, number]; dolly?: [number, number] };
  lights?: SceneLight[];
  ambient?: number;
  selected?: string | null;
  onSelect?: (id: string) => void;
  onLightMove?: (id: string, anchor: Vec3, normal: Vec3) => void;
  /** The focus reticle dragged over the set: only the focus point moves (no orbit). */
  onFocus?: (point: Vec3) => void;
  /** A click (not a drag) on the surface. */
  onPlace?: (anchor: Vec3, normal: Vec3) => void;
  /** The wheel over a light: nearer (< 0) or farther from its surface. */
  onLightWheel?: (id: string, delta: number) => void;
  /** A spot's or sun's aim handle dragged onto the surface. */
  onLightAim?: (id: string, aim: Vec3) => void;
  /** The selected unit moved with the gizmo: along X / Y (`anchor` + a fixed `dir`) or its throw (`offset`). Absent = no gizmo. */
  onLightNudge?: (id: string, patch: Pick<SceneLight, "anchor" | "dir"> | Pick<SceneLight, "offset">) => void;
  /** Show the units as fixtures on the set (screen only — never in a snapshot). */
  fixtures?: boolean;
  /** The gizmo: move arrows or rotate (re-aim) rings. */
  gizmoMode?: GizmoMode;
  /** Move axes: Global (X, up, the set's depth) or Local (blue along the beam). */
  gizmoOrient?: "global" | "local";
  /** The overhead grid's height as a share of the frame's top at the set's middle; null = no grid. */
  grid?: number | null;
  /** A click on the grid: hang the selected unit there. */
  onHang?: (at: Vec3) => void;
  /** Show this much more than the frame on every side (Reframe): the frame is the middle 1/over. */
  overscan?: number;
  /** The view never turns past this, whatever `camera` asks (a free camera can go where the photo never saw). */
  /** Allow repeated full turns without a hard stop at the rear. */
  freeOrbit?: boolean;
  clampView?: { azimuth: number; elevation: number };
  focus?: SceneFocus | null;
  interactive: boolean;
  /** Drift slowly, as if breathing (while the model works). */
  drift?: boolean;
  /** Play a camera move as a seamless loop: from → to → from, `seconds` each way (ease in-out). */
  /** A move on repeat. "cut": start → end, hold, cut back to start (a shot); "pingpong" (default): there and back (idle motion). */
  play?: { from: SceneCamera; to: SceneCamera; fromFocus?: SceneFocus | null; toFocus?: SceneFocus | null; seconds: number; loop?: "cut" | "pingpong" } | null;
  /** Once the scene is up, swing round it once — so it reads as 3D at a glance. */
  intro?: boolean;
  /** Preview-only blurred continuation from the current rendered scene. */
  continuation?: boolean;
  /** Screen only: stand this much farther back than `camera` (a free orbit sees the scene whole). */
  viewBack?: number;
  /** Unlit too, keep the photo's seam bridges when the camera turns (the stretched relief of a set) instead of cutting holes; the plate's border fades to black. */
  bridges?: boolean;
  /** Fly a slow move round the set: push in, arc left → right with a slight crane, and back. `onFlyEnd` once it lands or a pointer cuts it short. */
  fly?: boolean;
  onFlyEnd?: () => void;
  /** The showcase stage: the view leans after the hovering pointer, and a thrown orbit glides out. */
  showcase?: boolean;
  /** Relief 0..1 applied on the GPU to a surface built at relief 1: a change glides instead of rebuilding. (Picking keeps the built surface.) */
  relief?: number;
  /** First frame: the plate starts flat and its relief eases in while the camera drifts and one faint depth contour sweeps through. */
  reveal?: boolean;
  /** Past the still's reach (orbitLimits, in reach units: [start, end]) the set flattens into a picture card seen from the angle. Off by default. */
  flattenBeyond?: [number, number];
  /** Told once the first frame is on screen. */
  onReady?: () => void;
  className?: string;
  style?: React.CSSProperties;
}>(function DepthScene(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const world = useRef<World | null>(null);
  const latest = useRef(props);
  // Kept for the pointer handlers and the render loop, which outlive renders.
  useEffect(() => { latest.current = props; });
  const frame = useRef(0);
  const dirty = useRef(true);
  const ready = useRef(false);

  // What is on screen eases towards what was asked for — camera, lens, focus,
  // aperture — on a critically damped spring, and leans a little after the
  // pointer (Apple's spatial-photo parallax). The model is always sent the
  // exact values, never the in-between.
  const shown = useRef<{ az: number; el: number; logF: number; logD: number; focus: THREE.Vector3 | null; fstop: number; px: number; py: number } | null>(null);
  // The intro swing: when it starts (ms), -1 once done or cut short by the pointer.
  const introAt = useRef(0);
  // Lights glide to where they are put, rather than jumping cell to cell.
  const shownLights = useRef(new Map<string, { at: THREE.Vector3; anchor: THREE.Vector3; aim: THREE.Vector3 }>());
  const lastT = useRef(0);
  const lumaAsk = useRef<{ region: [number, number, number, number]; resolve: (l: number | null) => void }[]>([]);
  // A lens change reframes with an eased zoom (350 ms, cubic in-out on log focal) rather than a spring or a jump.
  const zoom = useRef<{ from: number; to: number; at: number } | null>(null);
  // Flown paths on top of the asked-for camera (degrees, log dolly): the reveal and the fly-around.
  const revealOff = useRef({ az: 0, el: 0, logD: 0 });
  const flyOff = useRef({ az: 0, el: 0, logD: 0 });
  // A camera move on repeat: as a shot (start → end, hold, cut) or as a seamless ping-pong; eased in and out.
  const playOff = useRef({ az: 0, el: 0, logD: 0, logF: 0, k: 0 });
  const playAt = useRef(0);
  // When the reveal / fly started (ms); 0 = not yet, -1 = done.
  const revealAt = useRef(0);
  const flyAt = useRef(0);
  // The relief on screen: a critically damped spring towards `relief`.
  const reliefNow = useRef<{ x: number; v: number } | null>(null);
  // The camera spring's rate (1/s): tighter while dragging, slow while a thrown orbit glides out.
  const rate = useRef(11);
  // The hovering pointer, -1..1 across the stage (showcase parallax).
  const hover = useRef<{ x: number; y: number } | null>(null);
  const view = (): SceneCamera => {
    const v = shown.current, r = revealOff.current, f = flyOff.current, q = playOff.current, pl = latest.current.play;
    const target = pl?.to.target && pl.from.target ? pl.from.target.map((x, i) => x + (pl.to.target![i] - x) * q.k) as Vec3 : latest.current.camera.target;
    return v ? { azimuth: v.az + v.px + r.az + f.az + q.az, elevation: v.el + v.py + r.el + f.el + q.el, focal: latest.current.camera.focal == null ? null : Math.exp(v.logF + q.logF), dolly: Math.exp(v.logD + r.logD + f.logD + q.logD), target } : latest.current.camera;
  };
  /** Hand a fly cut short over to the asked-for camera without a jump; the pose it lands on. */
  const bakeFly = (): SceneCamera | null => {
    if (flyAt.current <= 0) return null;
    flyAt.current = 0;
    const v = shown.current, f = flyOff.current, p = latest.current;
    if (!v) return null;
    v.az += f.az; v.el += f.el; v.logD += f.logD;
    f.az = f.el = f.logD = 0;
    const cam = { ...p.camera, azimuth: v.az, elevation: v.el, dolly: Math.exp(v.logD) / (p.viewBack ?? 1) };
    p.onCamera?.(cam);
    return cam;
  };
  const shownFocus = (): SceneFocus | null => {
    const pl = latest.current.play, k = playOff.current.k;
    // A rack: focus travels with the move.
    if (pl?.fromFocus && pl.toFocus) return { point: pl.fromFocus.point.map((x, i) => x + (pl.toFocus!.point[i] - x) * k) as Vec3, fstop: pl.fromFocus.fstop + (pl.toFocus.fstop - pl.fromFocus.fstop) * k };
    const v = shown.current, f = latest.current.focus;
    return f && v?.focus ? { point: v.focus.toArray() as Vec3, fstop: v.fstop } : f ?? null;
  };
  /** Advance the springs by `dt` seconds; true while anything still moves. */
  const step = (dt: number) => {
    const p = latest.current, c = p.camera, cv = p.clampView;
    const t = cv ? { ...c, azimuth: Math.max(-cv.azimuth, Math.min(cv.azimuth, c.azimuth)), elevation: Math.max(-cv.elevation, Math.min(cv.elevation, c.elevation)) } : c;
    const tf = Math.log(t.focal ?? world.current?.surface?.baseFocal ?? 31);
    let td = Math.log((t.dolly ?? 1) * (p.viewBack ?? 1));
    const v = shown.current ??= { az: t.azimuth, el: t.elevation, logF: tf, logD: td, focus: null, fstop: 16, px: 0, py: 0 };
    const k = 1 - Math.exp(-dt * rate.current), kp = 1 - Math.exp(-dt * 4.5);
    let hx = 0, hy = 0;
    if (p.drift) { const s = performance.now() / 1000; hx = Math.sin(s * 0.55) * 2.4; hy = Math.sin(s * 0.41 + 1) * 1.4; }
    // Showcase: lean a little after the hovering pointer, as if the viewer moved.
    if (p.showcase && hover.current && !drag.current && flyAt.current <= 0) { hx += hover.current.x * 2.2; hy -= hover.current.y * 1.3; }
    const now = performance.now(), lim = p.limits, w = world.current, surface = w?.surface;
    let pathRunning = false;
    // The reveal: flat plate → relief while the camera drifts left, up and in, and settles back.
    const ro = revealOff.current;
    if (p.reveal && revealAt.current === 0 && surface) revealAt.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? -1 : now;
    if (revealAt.current > 0 && w && surface) {
      const u = (now - revealAt.current) / REVEAL_MS;
      if (u >= 1) { revealAt.current = -1; ro.az = ro.el = ro.logD = 0; w.shape.flat.value = 1; w.shape.sweepAmount.value = 0; }
      else {
        const env = Math.sin(Math.PI * u) ** 2;
        ro.az = -Math.min(9, lim.azimuth * 0.4) * env;
        ro.el = Math.min(3.5, lim.elevation * 0.3) * env;
        ro.logD = Math.log(1 - 0.06 * env);
        w.shape.flat.value = easeOut(Math.min(1, u / 0.45));
        // The contour runs from the nearest surface to the far wall, once.
        const su = Math.min(1, u / 0.62), c = surface.pivot;
        const near = Math.log(Math.max(1e-3, -surface.bounds.max[2]) / c), far = Math.min(1.1, Math.log(Math.max(1e-3, -surface.bounds.min[2]) / c));
        w.shape.sweep.value = near + (far - near) * easeInOut(su);
        w.shape.sweepAmount.value = 0.45 * Math.sin(Math.PI * su) ** 1.5;
        pathRunning = true;
      }
    }
    // The fly-around: push in, arc left → right with a slight crane, and back to where it began.
    const fo = flyOff.current;
    if (flyAt.current > 0) {
      const u = (now - flyAt.current) / FLY_MS;
      if (u >= 1) { flyAt.current = 0; fo.az = fo.el = fo.logD = 0; p.onFlyEnd?.(); }
      else {
        const e = easeInOut(Math.max(0, u)), s2 = Math.sin(Math.PI * e) ** 2;
        fo.az = -lim.azimuth * Math.sin(2 * Math.PI * e);
        fo.el = lim.elevation * 0.45 * s2;
        fo.logD = Math.log(1 - 0.2 * s2);
        pathRunning = true;
      }
    }
    // The selected camera's move, looped: offsets from the start pose (the `camera` prop) to the end pose.
    const q = playOff.current, pl = p.play;
    if (pl && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (!playAt.current) playAt.current = now;
      const len = Math.max(0.5, pl.seconds), t = (now - playAt.current) / 1000;
      // A shot holds on its end frame for 0.4 s, then cuts straight back to the start.
      const ph = pl.loop === "cut" ? (t % (len + 0.4)) / len : (t / len) % 2;
      const k = easeInOut(pl.loop === "cut" ? Math.min(1, ph) : ph < 1 ? ph : 2 - ph);
      q.k = k;
      q.az = (pl.to.azimuth - pl.from.azimuth) * k;
      q.el = (pl.to.elevation - pl.from.elevation) * k;
      q.logD = Math.log((pl.to.dolly ?? 1) / (pl.from.dolly ?? 1)) * k;
      q.logF = pl.to.focal && pl.from.focal ? Math.log(pl.to.focal / pl.from.focal) * k : 0;
      pathRunning = true;
    } else if (playAt.current || Math.abs(q.az) + Math.abs(q.el) + Math.abs(q.logD) + Math.abs(q.logF) > 1e-4) {
      // Stopped (Light pauses its idle motion while a unit is handled): ease back, never snap.
      playAt.current = 0;
      const d = Math.exp(-dt * 5);
      q.az *= d; q.el *= d; q.logD *= d; q.logF *= d; q.k *= d;
      if (Math.abs(q.az) + Math.abs(q.el) + Math.abs(q.logD) + Math.abs(q.logF) < 1e-4) q.az = q.el = q.logD = q.logF = q.k = 0;
      else pathRunning = true;
    }
    // Relief glides to a new strength (GPU): no rebuild, no flash.
    let reliefMoving = false;
    if (w && surface) {
      const target = p.relief ?? 1, rs = reliefNow.current ??= { x: target, v: 0 };
      const omega = 9;
      rs.v += (omega * omega * (target - rs.x) - 2 * omega * rs.v) * dt;
      rs.x += rs.v * dt;
      reliefMoving = Math.abs(target - rs.x) > 1e-3 || Math.abs(rs.v) > 1e-3;
      if (!reliefMoving) { rs.x = target; rs.v = 0; }
      w.shape.on.value = p.relief != null || revealAt.current > 0 ? 1 : 0;
      w.shape.relief.value = Math.max(0, Math.min(1, rs.x));
      w.shape.center.value = surface.pivot;
    }
    // Past what the still can show the set flattens into a picture card seen from the angle,
    // instead of tearing: relief fades over the last of the reach and is gone well beyond it.
    if (w && surface && p.flattenBeyond) {
      const [f0, f1] = p.flattenBeyond;
      const reach = p.freeOrbit ? orbitLimits(surface) : lim;
      const az = Math.abs(((v.az + v.px + 540) % 360) - 180), el = Math.abs(v.el + v.py);
      const x = Math.max(az / Math.max(1, reach.azimuth), el / Math.max(1, reach.elevation));
      const t = Math.min(1, Math.max(0, (x - f0) / Math.max(1e-3, f1 - f0))), card = t * t * (3 - 2 * t);
      if (card > 0) {
        w.shape.flat.value = (revealAt.current > 0 ? w.shape.flat.value : 1) * (1 - card);
        w.shape.on.value = 1;
      } else if (revealAt.current <= 0) w.shape.flat.value = 1;
    }
    let introRunning = false;
    if (p.intro && introAt.current > 0) {
      // One slow loop round the middle, easing in and out: left, up, right, back.
      const u = (performance.now() - introAt.current) / INTRO_MS;
      if (u >= 1) introAt.current = -1;
      else if (u > 0) {
        const env = Math.sin(Math.PI * u) ** 2, a = 2 * Math.PI * u;
        hx += Math.sin(a) * 12 * env;
        hy += (1 - Math.cos(a)) * 3 * env;
        td += Math.log(1 + 0.12 * env);
        introRunning = true;
      } else introRunning = true;
    }
    let lightsMoving = false;
    const surf = world.current?.surface;
    // A unit being dragged stays under the hand (fast follow); otherwise it glides.
    const kl = 1 - Math.exp(-dt * (drag.current ? 45 : 18));
    for (const l of p.lights ?? []) {
      if (!surf) break;
      const at = new THREE.Vector3(...lightPoint(surf, l)), anchor = new THREE.Vector3(...l.anchor), aim = new THREE.Vector3(...(l.aim ?? l.anchor));
      const cur = shownLights.current.get(l.id);
      if (!cur) { shownLights.current.set(l.id, { at, anchor, aim }); continue; }
      cur.at.lerp(at, kl);
      cur.anchor.lerp(anchor, kl);
      cur.aim.lerp(aim, kl);
      if (cur.at.distanceTo(at) > 1e-4 || cur.anchor.distanceTo(anchor) > 1e-4 || cur.aim.distanceTo(aim) > 1e-4) lightsMoving = true;
    }
    const azDelta = p.freeOrbit ? ((t.azimuth - v.az + 180) % 360 + 360) % 360 - 180 : t.azimuth - v.az;
    v.az += azDelta * k;
    v.el += (t.elevation - v.el) * k;
    {
      const z = zoom.current, t0 = performance.now();
      if (!z || Math.abs(tf - z.to) > 0.02) zoom.current = { from: v.logF, to: tf, at: t0 };
      else z.to = tf; // small steady changes (a zoom move playing) are followed, not restarted
      const zz = zoom.current!, u = Math.min(1, (t0 - zz.at) / 350);
      v.logF = zz.from + (zz.to - zz.from) * easeInOut(u);
    }
    v.logD += (td - v.logD) * k;
    v.px += (hx - v.px) * kp;
    v.py += (hy - v.py) * kp;
    let focusMoving = false;
    if (p.focus) {
      const fp = new THREE.Vector3(...p.focus.point);
      // Focus comes in from sharp (f/16) and racks over to a new point.
      if (!v.focus) { v.focus = fp.clone(); v.fstop = 16; }
      v.focus.lerp(fp, k * 0.7);
      v.fstop += (p.focus.fstop - v.fstop) * k * 0.7;
      focusMoving = v.focus.distanceTo(fp) > 1e-4 || Math.abs(p.focus.fstop - v.fstop) > 0.01;
    } else v.focus = null;
    return !!p.drift || introRunning || pathRunning || reliefMoving || Math.abs(td - v.logD) > 1e-4 || focusMoving || lightsMoving || Math.abs(azDelta) > 0.01 || Math.abs(t.elevation - v.el) > 0.01
      || Math.abs(tf - v.logF) > 1e-4 || Math.abs(hx - v.px) > 0.01 || Math.abs(hy - v.py) > 0.01;
  };

  const draw = () => {
    const w = world.current;
    const p = latest.current;
    if (!w || !w.surface || !w.post) return;
    const cam = view(), focus = shownFocus(), over = p.overscan ?? 1;
    // From the front the plate is the photo, edge to edge; turned, its border fades into the stage.
    w.shape.border.value = p.bridges ? Math.min(1, Math.hypot(cam.azimuth, cam.elevation) / 4) : 0;
    pose(w.camera, w.surface, cam, over, p.width / p.height);
    sync(w, { ...p, focus }, true, cam, (l) => shownLights.current.get(l.id));
    w.hole.texel.value = w.hole.size.value.x / w.post.target.width;
    composite(w.renderer, w.post, w.scene, w.camera, {
      surface: w.surface, view: cam, focus, hole: null, rerender: dirty.current, over,
      feather: w.renderer.getPixelRatio() * 1.2, continuation: p.continuation,
    });
    dirty.current = false;
    // Read right after drawing, while the frame is still in the drawing buffer.
    if (lumaAsk.current.length) for (const a of lumaAsk.current.splice(0)) a.resolve(canvasLuma(canvasRef.current, a.region));
    if (import.meta.env.DEV && canvasRef.current) {
      // Dev only: where each unit is on screen (client px), for scripted drag profiling.
      const r = canvasRef.current.getBoundingClientRect(), out: Record<string, [number, number]> = {};
      for (const [id, l] of shownLights.current) { const q = l.at.clone().project(w.camera); out[id] = [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height]; }
      (window as unknown as { __eveLights?: unknown }).__eveLights = out;
      { const q = w.reticle.position.clone().project(w.camera); (window as unknown as { __eveFocus?: unknown }).__eveFocus = w.reticle.visible ? [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height] : null; }
      const sl = p.selected ? shownLights.current.get(p.selected) : undefined;
      if (sl) {
        // Dev only: points on the selected unit's rotate rings (pan, tilt), client px.
        const size = markerSize(w, sl.at), up = new THREE.Vector3(0, 1, 0), beam = sl.aim.clone().sub(sl.at).setY(0);
        const across = beam.lengthSq() > 1e-10 ? beam.normalize().cross(up).normalize() : new THREE.Vector3(1, 0, 0);
        const ring = (axis: THREE.Vector3) => {
          const u = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), b = axis.clone().cross(u).normalize(), c = axis.clone().cross(b);
          return Array.from({ length: 16 }, (_, i) => { const t = i / 16 * Math.PI * 2, q = sl.at.clone().addScaledVector(b, Math.cos(t) * 7.5 * size).addScaledVector(c, Math.sin(t) * 7.5 * size).project(w.camera); return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height]; });
        };
        (window as unknown as { __eveRings?: unknown }).__eveRings = { pan: ring(up), tilt: ring(across) };
      }
    }
    if (!ready.current) {
      ready.current = true;
      p.onReady?.();
      // After the photo has handed over to the scene.
      if (p.intro && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) { introAt.current = performance.now() + 900; schedule(); }
    }
  };
  const tick = (t: number) => {
    frame.current = 0;
    const dt = lastT.current ? Math.min(0.05, (t - lastT.current) / 1000) : 1 / 60;
    lastT.current = t;
    // Dev only: `window.__eveScenePerf = []` collects each frame's CPU + GPU time (ms).
    const perf = import.meta.env.DEV ? (window as unknown as { __eveScenePerf?: number[] }).__eveScenePerf : undefined;
    const t0 = perf ? performance.now() : 0;
    const moving = step(dt);
    dirty.current = true;
    draw();
    if (perf && world.current) {
      const gl = world.current.renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      perf.push(performance.now() - t0);
    }
    if (moving) frame.current = requestAnimationFrame(tick);
    else { lastT.current = 0; rate.current = 11; }
  };
  const schedule = () => {
    dirty.current = true;
    if (frame.current) return;
    frame.current = requestAnimationFrame(tick);
  };

  // The renderer, once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.02, 60);
    // Once the camera leaves the photo's viewpoint (`away` 0 → 1), the photo's
    // own surface feathers out over the last cells before a silhouette, so
    // edges melt into the layer behind instead of ending in a torn line.
    const away = { value: 0 };
    const shape: Shape = { on: { value: 0 }, center: { value: 1 }, relief: { value: 1 }, flat: { value: 1 }, sweep: { value: 0 }, sweepAmount: { value: 0 }, border: { value: 0 } };
    const feathered = <M extends THREE.Material>(m: M): M => {
      m.transparent = false;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uAway = away;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nattribute float edge;\nvarying float vEdge;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvEdge = edge;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vEdge;\nuniform float uAway;")
          .replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.a *= 1.0 - uAway * 0.85 * smoothstep(0.0, 1.0, vEdge);");
        shaped(shader, shape);
      };
      return m;
    };
    const basic = feathered(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const standard = feathered(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide }));
    // Near-field softening: a unit right against a wall must not multiply the photo's albedo
    // without bound (that reveals its JPEG chroma noise as coloured speckle). Falloff 1/(d² + d0²).
    const near2 = { value: 0 };
    // Set depths where the far background (sky) starts and is fully reached: [start, end], 0,0 = off.
    const farRange = { value: new THREE.Vector2(0, 0) };
    const softNear = (m: THREE.Material) => {
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = (shader, r) => {
        prev.call(m, shader, r);
        shader.uniforms.uNear2 = near2;
        shader.uniforms.uFarRange = farRange;
        // The set depth of each fragment (the mesh lives in the photo camera's space).
        shader.vertexShader = "varying float vSetDepth;\n" + shader.vertexShader.replace("#include <project_vertex>", "vSetDepth = -transformed.z;\n#include <project_vertex>");
        shader.fragmentShader = "uniform float uNear2;\nuniform vec2 uFarRange;\nvarying float vSetDepth;\n" + shader.fragmentShader.replace("#include <lights_pars_begin>",
          THREE.ShaderChunk.lights_pars_begin.replace("1.0 / max( pow( lightDistance, decayExponent ), 0.01 )", "1.0 / ( pow( lightDistance, decayExponent ) + uNear2 )"))
          // Sky and the far background keep the photo's own light: a unit on the set never paints a pool
          // (which the model reads as a softbox or a lamp) onto them. Direct light also never adds more
          // than about the surface's own albedo again: no blown, fixture-shaped hotspots.
          .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
{
  float farK = uFarRange.y > uFarRange.x ? 1.0 - 0.92 * smoothstep(uFarRange.x, uFarRange.y, vSetDepth) : 1.0;
  reflectedLight.directDiffuse = min(reflectedLight.directDiffuse * farK, diffuseColor.rgb * 1.6 + 0.04);
  reflectedLight.directSpecular *= farK;
}`)
          // Highlights roll off as one colour instead of clipping channel by channel (which turns photo noise into coloured speckle).
          .replace("#include <opaque_fragment>", "{ float m = max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b); if (m > 0.75) outgoingLight *= (0.75 + 0.25 * (1.0 - exp(-(m - 0.75) / 0.25))) / m; }\n#include <opaque_fragment>");
      };
    };
    softNear(standard);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), basic);
    // Original UVs close front-view seams without inventing shaded side walls.
    const hole = { cut: { value: 0 }, texel: { value: 1 }, size: { value: new THREE.Vector2(1, 1) }, away };
    const seamify = <M extends THREE.Material>(m: M): M => {
      m.transparent = false;
      m.depthWrite = true;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uCut = hole.cut;
        shader.uniforms.uTexel = hole.texel;
        shader.uniforms.uMapSize = hole.size;
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nuniform float uCut;\nuniform float uTexel;\nuniform vec2 uMapSize;")
          .replace("#include <map_fragment>", "#include <map_fragment>\nif (uCut > 0.5) discard;")
          ;
        shaped(shader, shape);
      };
      return m;
    };
    const seamBasic = seamify(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const seamStandard = seamify(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide }));
    softNear(seamStandard);
    const seam = new THREE.Mesh(new THREE.BufferGeometry(), seamBasic);
    seam.renderOrder = 1;
    const proxy = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const reticle = flat(new THREE.RingGeometry(1.6, 1.85, 4, 1, Math.PI / 4), 0xffd60a);
    reticle.renderOrder = 20;
    scene.add(mesh, seam, reticle);
    const ambient = new THREE.AmbientLight(0xffffff, Math.PI);
    scene.add(ambient);
    const glow = glowTexture();
    const rig3d = new LightRig3D(glow);
    // The rim follows the plate's GPU shape (relief / reveal / flattening past the reach) like the surface it lies on.
    rig3d.rim.material.onBeforeCompile = (shader) => shaped(shader, shape);
    scene.add(rig3d.root, rig3d.rim);
    world.current = { renderer, post: null, scene, camera, mesh, seam, seamBasic, seamStandard, hole, proxy, texture: null, basic, standard, ambient, rigs: new Map(), rig3d, near2, farRange, reticle, glow, surface: null, shape };
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      const w = world.current;
      world.current = null;
      if (!w) return;
      w.rigs.forEach((r) => disposeRig(w, r));
      w.rig3d.dispose();
      if (w.post) disposePost(w.post);
      for (const m of [w.mesh, w.seam, w.proxy, w.reticle]) if (!cached.has(m.geometry)) m.geometry.dispose();
      (w.proxy.material as THREE.Material).dispose();
      (w.reticle.material as THREE.Material).dispose();
      w.texture?.dispose();
      w.basic.dispose();
      w.seamBasic.dispose();
      w.seamStandard.dispose();
      w.standard.dispose();
      w.glow.dispose();
      w.renderer.dispose();
    };
  }, []);

  // The surface and its texture.
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    const s = props.surface;
    const geo = surfaceGeometry(s), old = [w.mesh.geometry, w.seam.geometry, w.proxy.geometry];
    w.mesh.geometry = geo.mesh;
    w.seam.geometry = geo.seam;
    w.proxy.geometry = geo.proxy;
    // Shared per surface (guides remount the scene per shot): only the empty start-up geometry is freed here.
    for (const g of old) if (!cached.has(g)) g.dispose();
    w.surface = s;
    schedule();
  }, [props.surface]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const w = world.current;
    if (!w) return;
    const t = new THREE.Texture(props.image);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = w.renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    w.texture?.dispose();
    w.texture = t;
    w.basic.map = t;
    w.standard.map = t;
    w.seamBasic.map = w.seamStandard.map = t;
    w.hole.size.value.set(props.image.naturalWidth || props.image.width, props.image.naturalHeight || props.image.height);
    w.basic.needsUpdate = w.standard.needsUpdate = w.seamBasic.needsUpdate = w.seamStandard.needsUpdate = true;
    schedule();
  }, [props.image]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const w = world.current;
    if (!w || props.width < 2 || props.height < 2) return;
    // Retina, but never more than ~3.7 M pixels through the 4× MSAA target: a big window stays at 60 fps.
    w.renderer.setPixelRatio(Math.max(1, Math.min(2, window.devicePixelRatio || 1, Math.sqrt(3.7e6 / (props.width * props.height)))));
    w.renderer.setSize(Math.round(props.width), Math.round(props.height), false);
    const size = w.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (w.post) disposePost(w.post);
    w.post = makePost(size.x, size.y);
    schedule();
  }, [props.width, props.height]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everything else just redraws.
  useEffect(() => { schedule(); });

  // The fly-around starts on `fly`; switched off mid-flight, it lands where it is.
  useEffect(() => {
    if (!props.fly) { bakeFly(); return; }
    if (flyAt.current > 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { props.onFlyEnd?.(); return; }
    flyAt.current = performance.now();
    schedule();
  }, [props.fly]); // eslint-disable-line react-hooks/exhaustive-deps


  useImperativeHandle(ref, () => ({
    luma: (region) => new Promise((resolve) => { lumaAsk.current.push({ region, resolve }); schedule(); }),
    snapshot: async (o) => {
      const w = world.current;
      if (!w || !w.surface) throw new Error("The 3D scene is not ready");
      // One snapshot renderer per scene, reused: a new WebGL context per guide recompiled every shader (stalls).
      const r = snapRenderer ??= new THREE.WebGLRenderer({ canvas: document.createElement("canvas"), antialias: false, alpha: true, preserveDrawingBuffer: true });
      const canvas = r.domElement;
      const post = makePost(o.width, o.height);
      // Guides get the measured surface as built: no screen-only relief, flattening, contour or border fade.
      const sh = w.shape, saved = [sh.on.value, sh.flat.value, sh.sweepAmount.value, sh.border.value];
      sh.on.value = 0; sh.sweepAmount.value = 0; sh.border.value = 0;
      try {
        r.outputColorSpace = THREE.SRGBColorSpace;
        r.setPixelRatio(1);
        r.setSize(o.width, o.height, false);
        const cam = w.camera.clone();
        pose(cam, w.surface, o.camera, 1, o.width / o.height);
        const photo = o.background === "photo";
        sync(w, { ...latest.current, lit: o.lit, bridges: false }, false, o.camera);
        // Fixtures, stands and the gizmo are for the person at the screen: never in what the model is sent.
        w.rig3d.root.visible = false;
        w.scene.background = photo ? w.texture : null;
        w.hole.texel.value = w.hole.size.value.x / post.target.width;
        composite(r, post, w.scene, cam, {
          surface: w.surface, view: o.camera, focus: latest.current.focus ?? null, feather: 0,
          hole: photo ? "#000000" : o.background, rerender: true,
        });
        w.scene.background = null;
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("Could not render the 3D view");
        return blob;
      } finally {
        w.rig3d.root.visible = true;
        [sh.on.value, sh.flat.value, sh.sweepAmount.value, sh.border.value] = saved;
        disposePost(post);
        schedule();
      }
    },
  }));

  // ── Pointer: drag a light, drag to orbit, click to place, wheel for the lens ──
  const ray = useRef(new THREE.Raycaster());
  const lastOrbit = useRef<SceneCamera | null>(null);
  // A dragged unit's camera-facing plane, fixed when it is picked up.
  const lightPlane = useRef<THREE.Plane | null>(null);
  // A ring drag: the pointer's last angle round the unit and the turn so far (radians).
  const ringDrag = useRef<{ last: number; sum: number } | null>(null);
  const drag = useRef<null | { kind: "focus" } | { kind: "light"; id: string } | { kind: "aim"; id: string } | { kind: "orbit"; x: number; y: number; from: SceneCamera; moved: boolean; trail: { t: number; az: number; el: number }[] }
    | { kind: "axis"; id: string; axis: GizmoAxis; x: number; y: number; screen: THREE.Vector2; perUnit: number; anchor: Vec3; dir: Vec3; offset: number; aim0: Vec3 }>(null);
  // The pointer in device coordinates (barrel undone), as of the last cast.
  const ndc = useRef(new THREE.Vector2());
  // Moves are handled once per frame, with the last position.
  const pending = useRef<{ clientX: number; clientY: number } | null>(null);
  const moveFrame = useRef(0);
  const cast = (event: { clientX: number; clientY: number }) => {
    const w = world.current, canvas = canvasRef.current;
    if (!w || !canvas || !w.surface) return null;
    const r = canvas.getBoundingClientRect();
    // Undo the barrel: the pointer is on the distorted frame.
    const cam = view();
    const { barrel } = lens(w.surface, cam);
    const over = latest.current.overscan ?? 1;
    let x = (event.clientX - r.left) / r.width - 0.5, y = (event.clientY - r.top) / r.height - 0.5;
    if (barrel) {
      const a = r.width / r.height, cx = x * a * over, cy = y * over, r2 = cx * cx + cy * cy, edge = 0.25 * a * a + 0.25;
      const k = (1 + barrel * r2) / (1 + barrel * edge);
      x *= k; y *= k;
    }
    pose(w.camera, w.surface, cam, over, latest.current.width / latest.current.height);
    ndc.current.set(x * 2, -y * 2);
    ray.current.setFromCamera(ndc.current, w.camera);
    return w;
  };
  /** The selected unit's gizmo arrow under the pointer. */
  const gizmoHit = (event: { clientX: number; clientY: number }): GizmoAxis | null => {
    const p = latest.current;
    if (!p.onLightNudge || !p.selected || !p.lit) return null;
    const w = cast(event), canvas = canvasRef.current;
    if (!w || !canvas) return null;
    const r = canvas.getBoundingClientRect();
    return w.rig3d.hit(ndc.current, w.camera, { w: r.width, h: r.height });
  };
  const surfaceHit = (event: { clientX: number; clientY: number }): { anchor: Vec3; normal: Vec3 } | null => {
    const w = cast(event);
    if (!w || !w.surface) return null;
    const hit = ray.current.intersectObject(w.proxy, false)[0];
    if (!hit?.uv) return null;
    // The proxy finds where; the full surface (and its smoothed normals) says exactly what is there.
    // Bilinear between the four vertices around the hit: smooth as the pointer moves.
    const s = w.surface;
    const fx = Math.min(s.cols, Math.max(0, hit.uv.x * s.cols)), fy = Math.min(s.rows, Math.max(0, (1 - hit.uv.y) * s.rows));
    const i0 = Math.min(s.cols - 1, Math.floor(fx)), j0 = Math.min(s.rows - 1, Math.floor(fy)), tx = fx - i0, ty = fy - j0;
    const at = new THREE.Vector3(), n = new THREE.Vector3();
    for (const [di, dj, wgt] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
      const k = ((j0 + dj) * (s.cols + 1) + i0 + di) * 3;
      at.x += s.positions[k] * wgt; at.y += s.positions[k + 1] * wgt; at.z += s.positions[k + 2] * wgt;
      n.x += s.normals[k] * wgt; n.y += s.normals[k + 1] * wgt; n.z += s.normals[k + 2] * wgt;
    }
    n.normalize();
    if (n.dot(w.camera.position.clone().sub(at)) < 0) n.negate();
    return { anchor: at.toArray() as Vec3, normal: n.toArray() as Vec3 };
  };
  /** The light (or, with `aim`, the aim handle) under the pointer. */
  const handleHit = (event: { clientX: number; clientY: number }): { id: string; aim: boolean } | null => {
    const w = cast(event);
    if (!w) return null;
    const handles = [...w.rigs.entries()].flatMap(([id, r]) => [
      { id, aim: false, o: r.handle as THREE.Object3D },
      ...(r.aimHandle.visible ? [{ id, aim: true, o: r.aimHandle as THREE.Object3D }] : []),
    ]);
    const hit = ray.current.intersectObjects(handles.map((h) => h.o), false)[0];
    const h = hit ? handles.find((x) => x.o === hit.object) : undefined;
    return h ? { id: h.id, aim: h.aim } : null;
  };

  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const p = latest.current;
    if (!p.interactive || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (introAt.current > 0) introAt.current = -1;
    // A fly in progress lands where it is (and says so).
    const landed = bakeFly();
    if (landed) p.onFlyEnd?.();
    rate.current = 11;
    // The focus reticle claims the pointer: dragging it moves only the focus point.
    const wf = world.current, cf = canvasRef.current;
    if (p.onFocus && p.focus && wf?.surface && cf && wf.reticle.visible) {
      const r = cf.getBoundingClientRect(), at = wf.reticle.position.clone(), q = at.clone().project(wf.camera);
      const cx = r.left + (q.x + 1) / 2 * r.width, cy = r.top + (1 - q.y) / 2 * r.height;
      const rim = at.clone().addScaledVector(new THREE.Vector3().setFromMatrixColumn(wf.camera.matrixWorld, 0), wf.reticle.scale.x * 1.85).project(wf.camera);
      const px = Math.abs(rim.x - q.x) / 2 * r.width;
      if (Math.hypot(event.clientX - cx, event.clientY - cy) < px * 1.4 + 8) {
        drag.current = { kind: "focus" };
        event.currentTarget.style.cursor = "grabbing";
        return;
      }
    }
    // The gizmo first: its arrows lie over the light's own handle.
    const axis = gizmoHit(event), w0 = world.current, sel = p.lights?.find((l) => l.id === p.selected), canvas = event.currentTarget.getBoundingClientRect();
    // Throw needs no on-screen direction: it follows the pointer's vertical travel.
    const map = axis === "pan" || axis === "tilt" ? { screen: new THREE.Vector2(0, 1), perUnit: 1 } : axis && w0 && sel ? w0.rig3d.dragMap(axis, w0.camera, { w: canvas.width, h: canvas.height }) : null;
    if (axis && w0?.surface && sel && map) {
      const at = new THREE.Vector3(...lightPoint(w0.surface, sel)), anchor = new THREE.Vector3(...sel.anchor);
      const dir = at.clone().sub(anchor).normalize().toArray() as Vec3;
      ringDrag.current = null;
      drag.current = { kind: "axis", id: sel.id, axis, x: event.clientX, y: event.clientY, screen: map.screen, perUnit: map.perUnit, anchor: sel.anchor, dir, offset: sel.offset, aim0: sel.aim ?? sel.anchor };
      w0.rig3d.setActive(axis);
      schedule();
      event.currentTarget.style.cursor = axis === "tilt" ? "ns-resize" : axis === "pan" ? "ew-resize" : "grabbing";
      return;
    }
    const h = p.lights?.length ? handleHit(event) : null;
    if (h) { lightPlane.current = null; drag.current = { kind: h.aim ? "aim" : "light", id: h.id }; p.onSelect?.(h.id); event.currentTarget.style.cursor = "grabbing"; return; }
    // Showcase: an orbit still gliding is caught where it is, not where it was heading.
    let from = landed ?? p.camera;
    const v = shown.current;
    if (!landed && p.showcase && v && Math.hypot(p.camera.azimuth - v.az, p.camera.elevation - v.el) > 0.05) { from = { ...p.camera, azimuth: v.az, elevation: v.el }; p.onCamera?.(from); }
    drag.current = { kind: "orbit", x: event.clientX, y: event.clientY, from, moved: false, trail: [] };
  };
  /** Showcase: a thrown orbit keeps its speed and glides out — one camera update, the spring does the rest. */
  const glide = (d: { from: SceneCamera; trail: { t: number; az: number; el: number }[] }): boolean => {
    const p = latest.current, v = shown.current, last = d.trail[d.trail.length - 1];
    if (!v || !last || performance.now() - last.t > 70) return false;
    const first = d.trail.find((s) => last.t - s.t <= 100) ?? last, span = (last.t - first.t) / 1000;
    if (span < 0.016) return false;
    const vaz = (last.az - first.az) / span, vel = (last.el - first.el) / span;
    if (Math.hypot(vaz, vel) < 6) return false;
    // At rate r the spring leaves at (target − shown)·r: exactly the hand's speed, then eases out.
    const r = 4, clamp = (x: number, m: number) => Math.max(-m, Math.min(m, x));
    rate.current = r;
    p.onCamera?.({ ...d.from, azimuth: clamp(v.az + vaz / r, p.limits.azimuth), elevation: clamp(v.el + vel / r, p.limits.elevation) });
    return true;
  };
  const handleMove = (event: { clientX: number; clientY: number }, el: HTMLCanvasElement) => {
    const p = latest.current;
    const d = drag.current;
    if (!d) {
      if (!p.interactive) return;
      if (p.showcase) {
        const r = el.getBoundingClientRect();
        hover.current = { x: ((event.clientX - r.left) / r.width) * 2 - 1, y: ((event.clientY - r.top) / r.height) * 2 - 1 };
        schedule();
      }
      const axis = gizmoHit(event);
      if (world.current?.rig3d.setHover(axis)) schedule();
      el.style.cursor = axis === "tilt" ? "ns-resize" : axis === "pan" ? "ew-resize" : axis ? "grab" : p.lights?.length && handleHit(event) ? "grab" : p.onPlace ? "crosshair" : "grab";
      if (introAt.current > 0) introAt.current = -1;
      return;
    }
    if (d.kind === "axis") {
      // Along the arrow as it lies on screen: px → scene units.
      const s = world.current?.surface;
      if (!s) return;
      const t = ((event.clientX - d.x) * d.screen.x - (event.clientY - d.y) * d.screen.y) / d.perUnit;
      // Up = farther from what it lights, down = closer; relative to where the drag began (no jump), log gain, clamped.
      if (d.axis === "pan" || d.axis === "tilt") {
        // Re-aim: the beam turns round the unit — pan with the pointer's sideways travel, tilt with its vertical travel.
        const l = p.lights?.find((x) => x.id === d.id);
        if (!l) return;
        const at = new THREE.Vector3(...lightPoint(s, l)), start = new THREE.Vector3(...d.aim0).sub(at);
        const up = new THREE.Vector3(0, 1, 0), w = world.current, canvas = canvasRef.current;
        if (!w || !canvas) return;
        const axisW = d.axis === "pan" ? up : start.clone().setY(0).cross(up);
        if (axisW.lengthSq() < 1e-10) return;
        axisW.normalize();
        // The ring follows the hand round the unit's centre on screen (a true circular drag), measured
        // from where it was grabbed; a ring seen almost edge-on falls back to travel along its line.
        const r = canvas.getBoundingClientRect(), q = at.clone().project(w.camera);
        const cx = r.left + (q.x + 1) / 2 * r.width, cy = r.top + (1 - q.y) / 2 * r.height;
        const view = w.camera.getWorldDirection(new THREE.Vector3()), facing = -axisW.dot(view);
        const rd = ringDrag.current ??= { last: Math.atan2(-(d.y - cy), d.x - cx), sum: 0 };
        let turn: number;
        if (Math.abs(facing) > 0.3 && Math.hypot(event.clientX - cx, event.clientY - cy) > 8) {
          const a = Math.atan2(-(event.clientY - cy), event.clientX - cx);
          let da = a - rd.last;
          if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
          rd.last = a; rd.sum += da;
          turn = rd.sum * Math.sign(facing);
        } else {
          rd.last = Math.atan2(-(event.clientY - cy), event.clientX - cx);
          turn = d.axis === "pan" ? -(event.clientX - d.x) * 0.008 : -(event.clientY - d.y) * 0.008;
          rd.sum = turn * Math.sign(facing || 1);
        }
        const turned = start.clone().applyAxisAngle(axisW, turn);
        // Never past straight up or down.
        if (d.axis === "tilt" && Math.abs(turned.clone().normalize().y) > 0.995) return;
        p.onLightAim?.(d.id, at.add(turned).toArray() as Vec3);
        return;
      }
      if (d.axis === "throw" && p.gizmoOrient !== "local") {
        // Global depth: the whole unit moves into / out of the set (fixed hang); it keeps pointing at its aim.
        const anchor = [...d.anchor] as Vec3;
        anchor[2] -= t;
        p.onLightNudge?.(d.id, { anchor, dir: d.dir });
      }
      else if (d.axis === "throw") {
        // Forward / back along where the unit points: the whole unit dollies (anchor + fixed hang), its aim stays put.
        const l = p.lights?.find((x) => x.id === d.id);
        if (!l) return;
        const from = new THREE.Vector3(...d.anchor).addScaledVector(new THREE.Vector3(...d.dir), d.offset * s.scale);
        const fwd = new THREE.Vector3(...d.aim0).sub(from);
        const reach = fwd.length();
        if (reach < 1e-6) return;
        fwd.divideScalar(reach);
        // Never through what it is aimed at.
        const go = Math.min(t, reach - 0.05 * s.scale);
        p.onLightNudge?.(d.id, { anchor: new THREE.Vector3(...d.anchor).addScaledVector(fwd, go).toArray() as Vec3, dir: d.dir });
      }
      else {
        const anchor = [...d.anchor] as Vec3;
        anchor[d.axis === "x" ? 0 : 1] += t;
        p.onLightNudge?.(d.id, { anchor, dir: d.dir });
      }
      return;
    }
    if (d.kind === "focus") {
      const hit = surfaceHit(event);
      if (hit) p.onFocus?.(hit.anchor);
      return;
    }
    if (d.kind === "light" && p.onLightNudge) {
      // The unit moves on a camera-facing plane through where it was picked up: stable at any
      // distance (a surface pick jumped between near and far layers and jittered near the lens);
      // it hangs off the surface under the pointer, which it faces.
      const w = cast(event), s = w?.surface, l = p.lights?.find((x) => x.id === d.id);
      if (!w || !s || !l) return;
      const n = w.camera.getWorldDirection(new THREE.Vector3());
      const plane = lightPlane.current ??= new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...lightPoint(s, l)));
      if (Math.abs(ray.current.ray.direction.dot(plane.normal)) < 0.05) return;
      const at = ray.current.ray.intersectPlane(plane, new THREE.Vector3());
      if (!at) return;
      const hit = surfaceHit(event);
      const anchor = new THREE.Vector3(...(hit?.anchor ?? l.anchor)), off = at.clone().sub(anchor), len = off.length();
      if (len < 1e-5) return;
      p.onLightNudge(d.id, { anchor: anchor.toArray() as Vec3, dir: off.divideScalar(len).toArray() as Vec3, offset: Math.min(0.8, Math.max(0.03, len / s.scale)) } as Pick<SceneLight, "anchor" | "dir">);
      return;
    }
    if (d.kind === "light" || d.kind === "aim") {
      const hit = surfaceHit(event);
      if (hit && d.kind === "light") p.onLightMove?.(d.id, hit.anchor, hit.normal);
      if (hit && d.kind === "aim") p.onLightAim?.(d.id, hit.anchor);
      return;
    }
    const dx = event.clientX - d.x, dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    el.style.cursor = "grabbing";
    // Drag right turns the scene right: the camera swings left.
    // Past a limit the view keeps following the hand with rising resistance (rubber band), never a dead stop.
    const clamp = (v: number, m: number) => { const a = Math.abs(v); if (a <= m) return v; const r = Math.max(6, m * 0.5); return Math.sign(v) * (m + r * (1 - 1 / ((a - m) / r + 1))); };
    const next = { ...d.from, azimuth: p.freeOrbit ? ((d.from.azimuth - dx * 0.14 + 180) % 360 + 360) % 360 - 180 : clamp(d.from.azimuth - dx * 0.14, p.limits.azimuth), elevation: clamp(d.from.elevation + dy * 0.14, p.limits.elevation) };
    lastOrbit.current = next;
    if (p.showcase) {
      // Held tight to the hand; the last moves give the throw.
      rate.current = 22;
      d.trail.push({ t: performance.now(), az: next.azimuth, el: next.elevation });
      if (d.trail.length > 8) d.trail.shift();
    }
    p.onCamera?.(next);
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pending.current = { clientX: event.clientX, clientY: event.clientY };
    const el = event.currentTarget;
    if (moveFrame.current) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      const e = pending.current;
      pending.current = null;
      if (e) handleMove(e, el);
    });
  };
  const up = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // The last move first, so a light lands exactly where it was let go.
    if (moveFrame.current) { cancelAnimationFrame(moveFrame.current); moveFrame.current = 0; }
    if (pending.current) { handleMove(pending.current, event.currentTarget); pending.current = null; }
    const d = drag.current;
    drag.current = null;
    event.currentTarget.style.cursor = "";
    if (d?.kind === "axis" && world.current?.rig3d.setActive(null)) schedule();
    if (d?.kind === "orbit" && d.moved && !(latest.current.showcase && glide(d))) {
      // Let go past a limit: spring back inside it.
      const p = latest.current, c = lastOrbit.current ?? p.camera, hard = (x: number, m: number) => Math.max(-m, Math.min(m, x));
      const az = p.freeOrbit ? c.azimuth : hard(c.azimuth, p.limits.azimuth), el = hard(c.elevation, p.limits.elevation);
      if (az !== c.azimuth || el !== c.elevation) p.onCamera?.({ ...c, azimuth: az, elevation: el });
    }
    lastOrbit.current = null;
    if (d?.kind === "orbit" && !d.moved && latest.current.onHang && latest.current.grid != null) {
      const w = cast(event), canvas = canvasRef.current;
      const r = canvas?.getBoundingClientRect();
      const at = w && r ? w.rig3d.trussHit(ndc.current, w.camera, { w: r.width, h: r.height }) : null;
      if (at) { latest.current.onHang(at.toArray() as Vec3); return; }
    }
    if (d?.kind === "orbit" && !d.moved && latest.current.onPlace) {
      const hit = surfaceHit(event);
      if (hit) latest.current.onPlace(hit.anchor, hit.normal);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      const p = latest.current;
      if (!p.interactive) return;
      const over = p.lights?.length && p.onLightWheel ? handleHit(event) : null;
      if (over && !over.aim) { event.preventDefault(); p.onLightWheel?.(over.id, event.deltaY); return; }
      // Over the selected unit's gizmo, the wheel is its throw too.
      if (p.selected && p.onLightWheel && gizmoHit(event)) { event.preventDefault(); p.onLightWheel(p.selected, event.deltaY); return; }
      // Pinch: the lens (when it is on). Wheel / two-finger scroll: fly in and out.
      if (event.ctrlKey && p.limits.focal && p.camera.focal != null) {
        event.preventDefault();
        const [lo, hi] = p.limits.focal;
        p.onCamera?.({ ...p.camera, focal: Math.max(lo, Math.min(hi, p.camera.focal * Math.exp(event.deltaY * 0.004))) });
        return;
      }
      if (!p.limits.dolly) return;
      event.preventDefault();
      const [lo, hi] = p.limits.dolly;
      p.onCamera?.({ ...p.camera, dolly: Math.max(lo, Math.min(hi, (p.camera.dolly ?? 1) * Math.exp(event.deltaY * 0.0012))) });
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <canvas ref={canvasRef} className={props.className}
      style={{ ...props.style, width: props.width, height: props.height, touchAction: "none" }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onPointerLeave={() => { if (hover.current) { hover.current = null; schedule(); } }}
      onDoubleClick={() => { const p = latest.current; if (p.interactive) p.onCamera?.({ ...p.camera, azimuth: 0, elevation: 0 }); }} />
  );
});

function disposeRig(w: World, r: LightRig) {
  w.scene.remove(r.light, r.handle, r.core, r.rim, r.halo, r.ring, r.plate, r.beam, r.aimHandle, r.aimRing);
  if (r.light instanceof THREE.SpotLight || r.light instanceof THREE.DirectionalLight) w.scene.remove(r.light.target);
  r.light.dispose();
  for (const m of [r.handle, r.core, r.rim, r.ring, r.plate, r.aimHandle, r.aimRing]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
  (r.halo.material as THREE.Material).dispose();
  r.beam.geometry.dispose();
  (r.beam.material as THREE.Material).dispose();
}

function flat(geometry: THREE.BufferGeometry, colour: number, opacity = 1) {
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: colour, opacity, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide }));
}

/** On-screen size of a marker at `at`: constant whatever its distance. */
const markerSize = (w: World, at: THREE.Vector3) => at.distanceTo(w.camera.position) * Math.tan((w.camera.fov / 2) * DEG) * 0.016;

/** The surface straight below `at` (a coarse pick, cached per spot): where a stand's feet go. */
const down = new THREE.Raycaster(), floors = new WeakMap<THREE.BufferGeometry, Map<string, number | null>>();
function floorUnder(w: World, at: THREE.Vector3): number | null {
  const g = w.proxy.geometry, s = w.surface;
  if (!s) return null;
  const q = s.scale * 0.01, key = `${Math.round(at.x / q)},${Math.round(at.y / q)},${Math.round(at.z / q)}`;
  let cache = floors.get(g);
  if (!cache) { cache = new Map(); floors.set(g, cache); }
  if (cache.has(key)) return cache.get(key)!;
  down.set(at, new THREE.Vector3(0, -1, 0));
  const hit = down.intersectObject(w.proxy, false)[0];
  const y = hit ? hit.point.y : null;
  if (cache.size > 2000) cache.clear();
  cache.set(key, y);
  return y;
}

/** Bring the three.js objects in line with the props. `handles`: draw the on-screen markers. */
function sync(w: World, p: { lit: boolean; lights?: SceneLight[]; ambient?: number; selected?: string | null; focus?: SceneFocus | null; fixtures?: boolean; interactive?: boolean; onLightNudge?: unknown; bridges?: boolean; gizmoMode?: GizmoMode; gizmoOrient?: "global" | "local"; grid?: number | null }, handles: boolean, view: SceneCamera,
  shown?: (l: SceneLight) => { at: THREE.Vector3; anchor: THREE.Vector3; aim: THREE.Vector3 } | undefined) {
  const s = w.surface;
  if (!s) return;
  w.mesh.material = p.lit ? w.standard : w.basic;
  // Lit (Relight) the sheet stays the photo; unlit (Reframe) it becomes a
  // hole as soon as the camera leaves the photo's own viewpoint.
  w.seam.material = p.lit ? w.seamStandard : w.seamBasic;
  // Turned, or come in / pulled back for another lens: the camera is no longer where the photo was taken.
  const away = Math.abs(lens(s, view).r - s.pivot) > s.pivot * 0.02;
  const turn = Math.hypot(Math.sin(view.azimuth * DEG), Math.sin(view.elevation * DEG));
  const rear = Math.cos(view.azimuth * DEG) < 0;
  w.hole.cut.value = !p.lit && !p.bridges && (away || rear || turn > 0.025) ? 1 : 0;
  // Keep measured surfaces opaque and crisp.
  w.hole.away.value = 0;
  w.ambient.intensity = ambientIntensity(p.ambient ?? 1);
  // d0 = a quarter of the closest unit's throw.
  const throws = (p.lit ? p.lights ?? [] : []).filter((l) => (l.kind ?? "point") !== "sun").map((l) => l.offset * s.scale * 0.25);
  // Never below a few percent of the set's height: a unit put right on the floor stays smooth too.
  w.near2.value = throws.length ? Math.max(Math.min(...throws), 0.04 * s.scale) ** 2 : 0;
  {
    // The far background: the last stretch of measured depth, where a depth model piles the sky and the
    // horizon. Only on open sets (the farthest point well past the middle); a room's back wall keeps its light.
    const far = -s.bounds.min[2];
    if (far > s.pivot * 1.3) w.farRange.value.set(far * 0.86, far * 0.96); else w.farRange.value.set(0, 0);
  }
  if (p.focus && handles) {
    const at = new THREE.Vector3(...p.focus.point);
    w.reticle.visible = true;
    w.reticle.position.copy(at);
    w.reticle.scale.setScalar(markerSize(w, at) * 1.4);
    w.reticle.quaternion.copy(w.camera.quaternion);
  } else w.reticle.visible = false;
  const lights = p.lit ? p.lights ?? [] : [];
  for (const [id, rig] of w.rigs) if (!lights.some((l) => l.id === id)) { disposeRig(w, rig); w.rigs.delete(id); }
  for (const l of lights) {
    const kind = l.kind ?? "point";
    // An off-camera bulb-type unit lights the set in front of it, not the surface it hangs off:
    // drawn as a hemisphere (a 180° spot with a cosine edge) facing out from its anchor towards the set's middle.
    // Omni, that surface got a bright disc right behind the unit, which the model drew as a softbox / lamp.
    // A practical stays omni: it glows where it is and lights its own wall.
    const emitter: LightKind | "hemi" = kind === "point" && l.role !== "practical" ? "hemi" : kind;
    let rig = w.rigs.get(l.id);
    if (rig && rig.kind !== emitter) { disposeRig(w, rig); w.rigs.delete(l.id); rig = undefined; }
    if (!rig) {
      const light = emitter === "hemi" ? new THREE.SpotLight(0xffffff, 1, 0, Math.PI / 2, 1, 2)
        : kind === "spot" ? new THREE.SpotLight(0xffffff, 1, 0, Math.PI / 6, 0.6, 2)
        : kind === "sun" ? new THREE.DirectionalLight(0xffffff, 1) : new THREE.PointLight(0xffffff, 1, 0, 2);
      if (light instanceof THREE.SpotLight || light instanceof THREE.DirectionalLight) w.scene.add(light.target);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: w.glow, depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, opacity: 0.6 }));
      const beam = new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false, dashSize: 1, gapSize: 1 });
      const beamLine = new THREE.Line(new THREE.BufferGeometry(), beam);
      // The hit disc is wider than what is drawn: easy to catch.
      const handle = flat(new THREE.CircleGeometry(2.6, 40), 0x000000, 0);
      const plate = flat(new THREE.CircleGeometry(1.75, 40), 0x000000, 0.55);
      const rim = flat(new THREE.RingGeometry(1.05, 1.4, 40), 0xffffff);
      const core = flat(new THREE.CircleGeometry(1.05, 40), 0xffffff);
      const ring = flat(new THREE.RingGeometry(2.05, 2.35, 48), 0xffffff, 0.95);
      const aimHandle = flat(new THREE.CircleGeometry(2.4, 32), 0x000000, 0.35);
      const aimRing = flat(new THREE.RingGeometry(1.1, 1.45, 32), 0xffffff, 0.95);
      [beamLine, halo, handle, plate, rim, core, ring, aimHandle, aimRing].forEach((o, i) => { o.renderOrder = 10 + i; });
      rig = { kind: emitter, light, handle, core, rim, halo, ring, plate, beam: beamLine, aimHandle, aimRing };
      w.scene.add(light, beamLine, halo, handle, plate, rim, core, ring, aimHandle, aimRing);
      w.rigs.set(l.id, rig);
    }
    const glide = shown?.(l);
    const at = glide?.at.clone() ?? new THREE.Vector3(...lightPoint(s, l));
    const aim = glide?.aim.clone() ?? new THREE.Vector3(...(l.aim ?? l.anchor));
    const colour = new THREE.Color(l.colour);
    rig.light.color = colour;
    // A spot is as bright where it is aimed as a bulb is on its own surface, however far that is.
    rig.light.intensity = kind === "sun" ? Math.PI * 1.3 * l.strength
      : kind === "spot" ? Math.PI * 2.4 * 1.6 * l.strength * Math.max(at.distanceTo(aim), l.offset * s.scale) ** 2
      : pointIntensity(s, l);
    rig.light.position.copy(at);
    if (emitter === "hemi" && rig.light instanceof THREE.SpotLight) {
      // Facing: out from where it hangs, turned towards the set's middle.
      const out = at.clone().sub(new THREE.Vector3(...l.anchor));
      if (out.lengthSq() < 1e-10) out.set(...l.normal);
      const facing = out.normalize().add(new THREE.Vector3(0, 0, -s.pivot).sub(at).normalize());
      if (facing.lengthSq() < 1e-8) facing.set(0, 0, -1);
      rig.light.angle = Math.PI / 2;
      rig.light.penumbra = 1;
      rig.light.target.position.copy(at).add(facing.normalize().multiplyScalar(s.scale));
      rig.light.target.updateMatrixWorld();
    } else if (rig.light instanceof THREE.SpotLight) {
      rig.light.angle = Math.min(80, Math.max(6, l.beam ?? 35)) * DEG / 2;
      rig.light.penumbra = 0.55;
    }
    if (rig.light instanceof THREE.SpotLight || rig.light instanceof THREE.DirectionalLight) {
      // Aimed at its aim point (by default, the spot it was put on).
      rig.light.target.position.copy(aim);
      rig.light.target.updateMatrixWorld();
    }
    const size = markerSize(w, at);
    for (const m of [rig.handle, rig.plate, rig.rim, rig.core, rig.ring]) {
      m.position.copy(at);
      m.scale.setScalar(size);
      m.quaternion.copy(w.camera.quaternion);
    }
    (rig.core.material as THREE.MeshBasicMaterial).color = colour;
    rig.halo.position.copy(at);
    rig.halo.scale.setScalar(size * (6 + 6 * l.strength));
    (rig.halo.material as THREE.SpriteMaterial).color = colour;
    for (const m of [rig.handle, rig.plate, rig.rim, rig.core, rig.halo]) m.visible = handles;
    // With the units on the set, a marker hides behind what stands in front of it; only the selected one stays on top.
    const onTop = !p.fixtures || p.selected === l.id;
    for (const m of [rig.plate, rig.rim, rig.core, rig.halo]) (m.material as THREE.Material).depthTest = onTop;
    rig.ring.visible = handles && p.selected === l.id;
    // Where a selected spot or sun points: a ring on the surface to drag, a dashed line from the light.
    const aiming = handles && p.selected === l.id && kind !== "point";
    rig.beam.visible = rig.aimHandle.visible = rig.aimRing.visible = aiming;
    if (aiming) {
      const aimSize = markerSize(w, aim);
      for (const m of [rig.aimHandle, rig.aimRing]) {
        m.position.copy(aim);
        m.scale.setScalar(aimSize);
        m.quaternion.copy(w.camera.quaternion);
      }
      rig.beam.geometry.setFromPoints([at, aim]);
      rig.beam.computeLineDistances();
      const m = rig.beam.material as THREE.LineDashedMaterial;
      m.dashSize = m.gapSize = aimSize * 1.6;
    }
  }
  // The units as objects on the set, and the gizmo on the selected one: on screen only.
  w.rig3d.root.visible = handles;
  w.rig3d.update({
    truss: p.grid != null ? (() => {
      // Just under the frame's top at the set's middle; across the set, from near the camera to the middle.
      const top = s.pivot * Math.tan((s.fovY * Math.PI) / 360) * p.grid;
      return { y: top, x: [s.bounds.min[0] * 0.8, s.bounds.max[0] * 0.8] as [number, number], z: [-s.pivot * 0.55, -s.pivot * 1.05] as [number, number] };
    })() : null,
    mode: p.gizmoMode, orient: p.gizmoOrient, geometry: w.mesh.geometry, scale: s.scale, floor: s.bounds.min[1], floorAt: (at) => floorUnder(w, at), camera: w.camera, selected: p.selected ?? null,
    fixtures: handles && p.fixtures !== false, gizmo: handles && !!p.onLightNudge && p.interactive !== false,
    marker: (at) => markerSize(w, at),
    lights: lights.map((l) => {
      const g = shown?.(l);
      return { light: l, at: g?.at ?? new THREE.Vector3(...lightPoint(s, l)), anchor: g?.anchor ?? new THREE.Vector3(...l.anchor), aim: g?.aim ?? new THREE.Vector3(...(l.aim ?? l.anchor)) };
    }),
  });
}
