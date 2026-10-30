/**
 * The lighting units as objects on the set, and the translate gizmo on the
 * selected one — screen only. A unit is drawn as the gaffer would see it:
 * a dark-metal head on a thin stand, its face glowing in the light's own
 * colour, aimed where the light goes. The gizmo moves it along three axes:
 * left/right, up/down, and its throw (out from / back to what it lights).
 *
 * Nothing here may reach a guide: depth-scene hides `root` for every snapshot.
 */
import * as THREE from "three";
import type { Fixture, SceneLight } from "./depth-scene";

export type GizmoAxis = "x" | "y" | "throw" | "pan" | "tilt";
export type GizmoMode = "move" | "rotate";
const AXES = ["x", "y", "throw"] as const;
type MoveAxis = (typeof AXES)[number];
/** Rotate: pan round the vertical, tilt round the horizontal across the beam. */
const RINGS = ["pan", "tilt"] as const;
type RingAxis = (typeof RINGS)[number];
const RING_R = 7.5;
/** Restrained axis colours: Blender's convention, desaturated. */
const AXIS_COLOUR: Record<GizmoAxis, number> = { x: 0xd8645c, y: 0x84b867, throw: 0x5f97d8, pan: 0x84b867, tilt: 0xd8645c };
/** Gizmo arrow span in marker units (the handle disc is 2.6). */
const ARROW_FROM = 3.2, ARROW_TO = 12;
const HIT_PX = 8;
const LENGTH: Record<MoveAxis, number> = { x: 1, y: 1, throw: 0.85 };

/** A unit's size, as a share of the scene's height. */
/** The unit as built: a recognisable low-poly body per family. */
type MeshKind = "fresnel" | "openface" | "par" | "hmi" | "panel" | "tube" | "mat" | "fluoro" | "lantern" | "balloon" | "frame"
  | "softbox" | "octa" | "strip" | "dish" | "umbrella" | "ring" | "speedlight" | "bulb" | "lamp" | "candle" | "neon";
/** A unit's size (its head's diameter, about) as a share of the scene's height. */
const UNIT_SIZE: Record<MeshKind, number> = {
  fresnel: 0.06, openface: 0.06, par: 0.055, hmi: 0.09, panel: 0.07, tube: 0.1, mat: 0.1, fluoro: 0.1, lantern: 0.06, balloon: 0.09, frame: 0.09,
  softbox: 0.07, octa: 0.075, strip: 0.08, dish: 0.07, umbrella: 0.085, ring: 0.05, speedlight: 0.03, bulb: 0.025, lamp: 0.05, candle: 0.025, neon: 0.08,
};
/** Library unit (scene-rig LIBRARY id) → its body. */
const MESH_OF: Record<string, MeshKind> = {
  t650: "fresnel", t1k: "fresnel", t2k: "fresnel", t5k: "fresnel", t10k: "fresnel", o800: "openface", o2k: "openface", par1k: "par",
  h12: "hmi", h4: "hmi", h18: "hmi", hp18: "par", hp4: "par", hp18k: "hmi",
  lsoft: "panel", l1x1: "panel", lfres: "fresnel", ltube: "tube", lmat: "mat", f4b: "fluoro",
  lantern: "lantern", balloon: "balloon", book: "frame", frame12: "frame",
  mono: "dish", monosb: "softbox", octa: "octa", strip: "strip", dish: "dish", umbshoot: "umbrella", umbref: "umbrella", ring: "ring", speed: "speedlight",
  bulb: "bulb", lamp: "lamp", candle: "candle", neon: "neon", fire: "candle",
};
const FAMILY_MESH: Record<Fixture, MeshKind> = { fresnel: "fresnel", openface: "openface", led: "panel", softbox: "softbox", practical: "bulb", hmi: "hmi" };

export const fixtureOf = (l: SceneLight): Fixture => l.fixture ?? ((l.kind ?? "point") === "sun" ? "hmi" : l.kind === "spot" ? "fresnel" : "led");
const meshOf = (l: SceneLight): MeshKind => (l.model && MESH_OF[l.model]) || FAMILY_MESH[fixtureOf(l)];

type Unit = {
  fixture: MeshKind;
  /** At the light, turned round Y towards where it points; holds the yoke. */
  mount: THREE.Group;
  /** Tilts up/down inside the yoke; local +Z is the light's direction. */
  head: THREE.Group;
  stand: THREE.Group;
  pole: THREE.Mesh;
  /** The glowing parts, tinted with the light's colour. */
  faces: THREE.MeshBasicMaterial[];
  glow: THREE.Sprite | null;
  /** Where the stand meets the yoke, below the light, in unit sizes. */
  drop: number;
};

type Arrow = { group: THREE.Group; shaft: THREE.Mesh; tip: THREE.Mesh; material: THREE.MeshBasicMaterial; dir: THREE.Vector3 };

export interface RigLight { light: SceneLight; at: THREE.Vector3; anchor: THREE.Vector3; aim: THREE.Vector3 }

export class LightRig3D {
  readonly root = new THREE.Group();
  private units = new Map<string, Unit>();
  // Unlit bodies: a unit's own light sits inside its head — lit materials there sparkle into grain.
  // Depth-tested against the set (props in front hide them); a small offset keeps a foot on the floor from z-fighting.
  private metal = new THREE.MeshBasicMaterial({ color: 0x2c2c31, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  private dark = new THREE.MeshBasicMaterial({ color: 0x17171a, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  /** A fine light edge on the dark bodies: the unit's shape reads against a dark set. */
  private edge = new THREE.LineBasicMaterial({ color: 0x9a9aa2, transparent: true, opacity: 0.4 });
  private gizmo = new THREE.Group();
  private arrows: Record<MoveAxis, Arrow>;
  private rings: Record<RingAxis, { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; axis: THREE.Vector3 }>;
  private mode: GizmoMode = "move";
  private hover: GizmoAxis | null = null;
  private active: GizmoAxis | null = null;
  /**
   * The back lights' rim: an additive pass over the surface (sharing its
   * geometry) that lights the silhouette edges facing a light behind the
   * subject. Part of the light's effect, so it stays in the guide: not under `root`.
   */
  readonly rim: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private rimSpare = new THREE.BufferGeometry();
  private rimU = {
    uCount: { value: 0 },
    uColour: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
    uLight: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
    uCentre: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
    uRadius: { value: [1, 1, 1, 1] },
  };
  /** The gizmo as last drawn: its origin, marker size and the light it is on. */
  private shown: { id: string; at: THREE.Vector3; size: number } | null = null;

  constructor(private glowMap: THREE.Texture) {
    this.root.name = "light-rig3d";
    const shaftGeo = new THREE.CylinderGeometry(0.16, 0.16, 1, 8, 1, true).translate(0, 0.5, 0);
    const tipGeo = new THREE.ConeGeometry(0.5, 1.5, 14).translate(0, 0.75, 0);
    this.arrows = Object.fromEntries(AXES.map((axis) => {
      const material = new THREE.MeshBasicMaterial({ color: AXIS_COLOUR[axis], transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
      const shaft = new THREE.Mesh(shaftGeo, material), tip = new THREE.Mesh(tipGeo, material);
      shaft.position.y = ARROW_FROM;
      shaft.scale.y = ARROW_TO - ARROW_FROM - 1.3;
      tip.position.y = ARROW_TO - 1.5;
      const group = new THREE.Group();
      group.add(shaft, tip);
      shaft.renderOrder = tip.renderOrder = 40;
      this.gizmo.add(group);
      return [axis, { group, shaft, tip, material, dir: new THREE.Vector3() }];
    })) as unknown as Record<MoveAxis, Arrow>;
    const ringGeo = new THREE.TorusGeometry(RING_R, 0.13, 6, 96);
    this.rings = Object.fromEntries(RINGS.map((axis) => {
      const material = new THREE.MeshBasicMaterial({ color: AXIS_COLOUR[axis], transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(ringGeo, material);
      mesh.renderOrder = 40;
      this.gizmo.add(mesh);
      return [axis, { mesh, material, axis: new THREE.Vector3() }];
    })) as unknown as Record<RingAxis, { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; axis: THREE.Vector3 }>;
    this.gizmo.visible = false;
    this.root.add(this.gizmo);
    this.rim = new THREE.Mesh(this.rimSpare, new THREE.ShaderMaterial({
      uniforms: this.rimU, vertexShader: RIM_VERT, fragmentShader: RIM_FRAG, side: THREE.DoubleSide,
      transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      // Adds light, leaves coverage (alpha) as it is.
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    this.rim.name = "back-light-rim";
    this.rim.renderOrder = 2;
    this.rim.frustumCulled = false;
    this.rim.visible = false;
  }

  /** Bring the units and the gizmo in line with the lights. */
  update(o: { orient?: "global" | "local"; truss?: { y: number; z: [number, number]; x: [number, number] } | null; mode?: GizmoMode; geometry: THREE.BufferGeometry; scale: number; floor: number; floorAt?: (at: THREE.Vector3) => number | null; camera: THREE.PerspectiveCamera; lights: RigLight[]; selected: string | null; fixtures: boolean; gizmo: boolean; marker: (at: THREE.Vector3) => number }) {
    // Back lights rim the subject they are aimed at.
    const backs = o.lights.filter((r) => r.light.role === "back").slice(0, 4);
    this.rim.visible = backs.length > 0;
    this.rim.geometry = backs.length ? o.geometry : this.rimSpare;
    this.rimU.uCount.value = backs.length;
    backs.forEach((r, i) => {
      const c = new THREE.Color(r.light.colour);
      this.rimU.uColour.value[i].set(c.r, c.g, c.b).multiplyScalar(1.25 * r.light.strength);
      this.rimU.uLight.value[i].copy(r.at);
      this.rimU.uCentre.value[i].copy((r.light.kind ?? "point") === "point" ? r.anchor : r.aim);
      this.rimU.uRadius.value[i] = 0.25 * o.scale;
    });
    this.updateTruss(o.fixtures ? o.truss ?? null : null, o.scale);
    for (const [id, u] of this.units) if (!o.lights.some((r) => r.light.id === id)) { this.drop(u); this.units.delete(id); }
    for (const r of o.lights) {
      const l = r.light, fixture = meshOf(l);
      let u = this.units.get(l.id);
      if (u && u.fixture !== fixture) { this.drop(u); u = undefined; }
      if (!u) { u = this.build(fixture); this.units.set(l.id, u); }
      u.mount.visible = u.stand.visible = o.fixtures;
      if (!o.fixtures) continue;
      const size = UNIT_SIZE[fixture] * o.scale;
      u.mount.position.copy(r.at);
      u.mount.scale.setScalar(size);
      // Points where the light goes: a spot or the sun at its aim, a soft source at what it lights.
      // Points where it is aimed (a soft source with no aim: at what it lights — its aim defaults to its anchor).
      const dir = r.aim.clone().sub(r.at);
      if (dir.lengthSq() < 1e-10) dir.set(0, 0, -1);
      dir.normalize();
      u.mount.rotation.set(0, Math.atan2(dir.x, dir.z), 0);
      u.head.rotation.set(-Math.asin(Math.max(-1, Math.min(1, dir.y))), 0, 0);
      const tint = new THREE.Color(l.colour);
      const face = new THREE.Color(1, 1, 1).lerp(tint, 0.7);
      for (const m of u.faces) m.color.copy(face);
      if (u.glow) {
        (u.glow.material as THREE.SpriteMaterial).color.copy(tint);
        u.glow.scale.setScalar((4 + 3 * l.strength) * ((u.glow.userData.k as number | undefined) ?? 1));
      }
      // A stand down to the floor right under the unit (what is straight below it), else the set's lowest point.
      const top = r.at.y - u.drop * size, ground = o.floorAt?.(new THREE.Vector3(r.at.x, top, r.at.z)) ?? o.floor, len = top - ground;
      // Hung from the grid: a pipe clamp, no stand.
      u.stand.visible = !l.hung && u.drop > 0 && len > size * 0.5;
      if (u.stand.visible) {
        u.stand.position.set(r.at.x, ground, r.at.z);
        u.pole.scale.set(o.scale, len, o.scale);
        // A tripod: three legs from a collar on the pole (0.35 of its height) splaying down to feet on the floor.
        const collar = Math.min(len * 0.35, 0.12 * o.scale), legLen = collar / 0.8, spread = 0.6 * legLen;
        for (const c of u.stand.children) {
          if (c === u.pole || c.userData.leg === undefined) continue;
          const a = (c.userData.leg as number) * 2 * Math.PI / 3;
          const foot = new THREE.Vector3(Math.cos(a) * spread, 0, Math.sin(a) * spread), top = new THREE.Vector3(0, collar, 0);
          c.position.copy(foot).add(top).multiplyScalar(0.5);
          c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(foot).normalize());
          c.scale.set(o.scale, legLen, o.scale);
        }
      }
    }
    // The gizmo: on the selected unit, constant size on screen.
    const sel = o.gizmo ? o.lights.find((r) => r.light.id === o.selected) : undefined;
    this.gizmo.visible = !!sel;
    this.mode = o.mode ?? "move";
    this.shown = null;
    if (!sel) return;
    const size = o.marker(sel.at);
    this.shown = { id: sel.light.id, at: sel.at.clone(), size };
    this.gizmo.position.copy(sel.at);
    this.gizmo.scale.setScalar(size);
    // Blue: the unit's own forward axis — along where it points (its aim), like a local Z.
    const throwDir = sel.aim.clone().sub(sel.at);
    if (throwDir.lengthSq() < 1e-12) throwDir.set(0, 0, -1);
    throwDir.normalize();
    this.arrows.x.dir.set(1, 0, 0);
    this.arrows.y.dir.set(0, 1, 0);
    // Blue: towards what the unit lights (the real direction), shorter than X / Y.
    // Drawn in the screen's plane along the beam as it lies on screen (always a full-length arrow, never foreshortened).
    const e = o.camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]).normalize(), upV = new THREE.Vector3(e[4], e[5], e[6]).normalize(), back = new THREE.Vector3(e[8], e[9], e[10]).normalize();
    // Global: blue is the set's depth (away from the photo's camera, -Z); Local: along the beam.
    if (o.orient !== "local") throwDir.set(0, 0, -1);
    const pa = sel.at.clone().project(o.camera), pb = (o.orient !== "local" ? sel.at.clone().add(new THREE.Vector3(0, 0, -0.05 * o.scale)) : sel.aim.clone()).project(o.camera);
    let vx = (pb.x - pa.x) * o.camera.aspect, vy = pb.y - pa.y;
    if (pb.z > 1 || Math.hypot(vx, vy) < 1e-5) { vx = throwDir.dot(right); vy = throwDir.dot(upV); }
    if (Math.hypot(vx, vy) < 1e-6) { vx = 0; vy = 1; }
    this.arrows.throw.dir.copy(right.clone().multiplyScalar(vx).addScaledVector(upV, vy).normalize());
    // Depth cue: towards the camera thicker and brighter, away thinner.
    const toward = throwDir.dot(back);
    const up = new THREE.Vector3(0, 1, 0);
    const rotating = this.mode === "rotate";
    const beam = sel.aim.clone().sub(sel.at).setY(0);
    const across = beam.lengthSq() > 1e-10 ? beam.normalize().cross(up).normalize() : new THREE.Vector3(1, 0, 0);
    this.rings.pan.axis.set(0, 1, 0);
    this.rings.tilt.axis.copy(across);
    for (const axis of RINGS) {
      const g = this.rings[axis];
      g.mesh.visible = rotating;
      g.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), g.axis);
      const lit = this.active ? this.active === axis : this.hover === axis;
      g.material.color.set(AXIS_COLOUR[axis]);
      if (lit) g.material.color.lerp(new THREE.Color(0xffffff), 0.45);
      g.material.opacity = (this.active ?? this.hover) && !lit ? 0.3 : lit ? 1 : 0.8;
    }
    for (const axis of AXES) {
      const a = this.arrows[axis];
      a.group.visible = !rotating;
      a.group.quaternion.setFromUnitVectors(up, a.dir);
      a.group.scale.setScalar(LENGTH[axis]);
      const lit = this.active ? this.active === axis : this.hover === axis;
      const dim = !!(this.active ?? this.hover) && !lit;
      a.material.color.set(AXIS_COLOUR[axis]);
      if (lit) a.material.color.lerp(new THREE.Color(0xffffff), 0.45);
      a.material.opacity = dim ? 0.35 : lit ? 1 : 0.85;
      const cue = axis === "throw" ? 1 + 0.45 * toward : 1;
      a.shaft.scale.x = a.shaft.scale.z = (lit ? 1.35 : 1) * cue;
      a.tip.scale.setScalar(axis === "throw" ? 0.85 + 0.25 * toward : 1);
      if (axis === "throw" && !lit && !dim) a.material.opacity = 0.7 + 0.25 * Math.max(0, toward);
    }
  }

  /** The gizmo axis under the pointer (`ndc`: the pointer in normalised device coordinates). */
  hit(ndc: THREE.Vector2, camera: THREE.PerspectiveCamera, px: { w: number; h: number }): GizmoAxis | null {
    if (!this.shown || !this.gizmo.visible) return null;
    let best: GizmoAxis | null = null, bestD = HIT_PX;
    const p = new THREE.Vector2((ndc.x * px.w) / 2, (ndc.y * px.h) / 2);
    const near = (a: THREE.Vector2, b: THREE.Vector2) => {
      const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(1e-6, ab.lengthSq())));
      return p.distanceTo(a.clone().addScaledVector(ab, t));
    };
    if (this.mode === "rotate") {
      // Rings are thin: catch them within a wider band.
      bestD = 13;
      for (const axis of RINGS) {
        const pts = this.ring(axis, camera, px);
        for (let i = 0; i < pts.length; i++) { const d = near(pts[i], pts[(i + 1) % pts.length]); if (d < bestD) { bestD = d; best = axis; } }
      }
      return best;
    }
    for (const axis of AXES) {
      const [a, b] = this.segment(axis, camera, px);
      const d = near(a, b);
      if (d < bestD) { bestD = d; best = axis; }
    }
    return best;
  }

  /** How a drag along `axis` maps to the scene: the arrow's direction on screen (px, unit) and px per scene unit. */
  dragMap(axis: MoveAxis, camera: THREE.PerspectiveCamera, px: { w: number; h: number }) {
    if (!this.shown) return null;
    const [a, b] = this.segment(axis, camera, px);
    const along = b.clone().sub(a);
    const span = (ARROW_TO - ARROW_FROM) * this.shown.size;
    const len = along.length();
    if (len < 3) return null;
    return { screen: along.divideScalar(len), perUnit: len / span, id: this.shown.id };
  }

  /** The overhead grid: a rectangle of triangular box truss above the set (screen only, like the units). */
  private truss = new THREE.Group();
  private trussKey = "";
  private beams: [THREE.Vector3, THREE.Vector3][] = [];
  private updateTruss(t: { y: number; z: [number, number]; x: [number, number] } | null, scale: number) {
    if (!this.truss.parent) this.root.add(this.truss);
    this.truss.visible = !!t;
    if (!t) return;
    const key = JSON.stringify(t) + scale;
    if (key === this.trussKey) return;
    this.trussKey = key;
    this.truss.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose(); });
    this.truss.clear();
    const [x0, x1] = t.x, [z0, z1] = t.z, y = t.y;
    const c = [new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0), new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y, z1)];
    this.beams = [[c[0], c[1]], [c[3], c[2]], [c[0], c[3]], [c[1], c[2]]];
    const w = 0.045 * scale, r = 0.0035 * scale;
    const lace: number[] = [];
    for (const [a, b] of this.beams) {
      const along = b.clone().sub(a), len = along.length(), dir = along.clone().normalize();
      const side = dir.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
      // Three chords: two below, one on top — a triangular truss.
      const chords = [side.clone().multiplyScalar(w / 2), side.clone().multiplyScalar(-w / 2), new THREE.Vector3(0, w * 0.85, 0)];
      for (const off of chords) {
        const g = new THREE.CylinderGeometry(r, r, len, 6, 1, true);
        const m = new THREE.Mesh(g, this.metal);
        m.position.copy(a).add(b).multiplyScalar(0.5).add(off);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        this.truss.add(m);
      }
      // Zig-zag lacing between the chords.
      const n = Math.max(2, Math.round(len / (w * 1.2)));
      for (let i = 0; i < n; i++) {
        const p0 = a.clone().addScaledVector(dir, (len * i) / n), p1 = a.clone().addScaledVector(dir, (len * (i + 1)) / n);
        for (let k = 0; k < 3; k++) {
          const q0 = p0.clone().add(chords[k]), q1 = p1.clone().add(chords[(k + 1) % 3]);
          lace.push(q0.x, q0.y, q0.z, q1.x, q1.y, q1.z);
        }
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lace, 3));
    this.truss.add(new THREE.LineSegments(lg, this.edge));
  }
  /** The point on the grid under the pointer (`ndc`), if any: where a unit can be hung. */
  trussHit(ndc: THREE.Vector2, camera: THREE.PerspectiveCamera, px: { w: number; h: number }): THREE.Vector3 | null {
    if (!this.truss.visible || !this.beams.length) return null;
    let best: THREE.Vector3 | null = null, bestD = 12;
    const p = new THREE.Vector2((ndc.x * px.w) / 2, (ndc.y * px.h) / 2);
    for (const [a, b] of this.beams) for (let i = 0; i <= 80; i++) {
      const q = a.clone().lerp(b, i / 80), v = q.clone().project(camera);
      if (v.z > 1) continue;
      const d = p.distanceTo(new THREE.Vector2((v.x * px.w) / 2, (v.y * px.h) / 2));
      if (d < bestD) { bestD = d; best = q; }
    }
    return best;
  }

  setHover(axis: GizmoAxis | null) { const changed = this.hover !== axis; this.hover = axis; return changed; }
  setActive(axis: GizmoAxis | null) { const changed = this.active !== axis; this.active = axis; return changed; }

  dispose() {
    for (const u of this.units.values()) this.drop(u);
    this.units.clear();
    this.metal.dispose();
    this.dark.dispose();
    this.edge.dispose();
    const a = this.arrows.x;
    a.shaft.geometry.dispose();
    a.tip.geometry.dispose();
    for (const axis of AXES) this.arrows[axis].material.dispose();
    this.root.removeFromParent();
    this.rim.removeFromParent();
    this.rim.material.dispose();
    this.rimSpare.dispose();
  }

  /** An arrow's ends on screen, in px from the middle (y up). */
  /** A rotation ring on screen, as a polyline (px from the middle, y up). */
  private ring(axis: RingAxis, camera: THREE.PerspectiveCamera, px: { w: number; h: number }) {
    const s = this.shown!, n = this.rings[axis].axis;
    const u = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const a = u.clone().cross(n).normalize(), b = n.clone().cross(a).normalize();
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      const v = s.at.clone().addScaledVector(a, Math.cos(t) * RING_R * s.size).addScaledVector(b, Math.sin(t) * RING_R * s.size).project(camera);
      out.push(new THREE.Vector2((v.x * px.w) / 2, (v.y * px.h) / 2));
    }
    return out;
  }

  private segment(axis: MoveAxis, camera: THREE.PerspectiveCamera, px: { w: number; h: number }): [THREE.Vector2, THREE.Vector2] {
    const s = this.shown!, d = this.arrows[axis].dir;
    const end = (k: number) => {
      const v = s.at.clone().addScaledVector(d, k * LENGTH[axis] * s.size).project(camera);
      return new THREE.Vector2((v.x * px.w) / 2, (v.y * px.h) / 2);
    };
    return [end(ARROW_FROM), end(ARROW_TO)];
  }

  private drop(u: Unit) {
    this.root.remove(u.mount, u.stand);
    const seen = new Set<THREE.BufferGeometry>();
    for (const g of [u.mount, u.stand]) g.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) seen.add(o.geometry); });
    seen.forEach((g) => g.dispose());
    u.faces.forEach((m) => m.dispose());
    if (u.glow) (u.glow.material as THREE.Material).dispose();
  }

  private build(fixture: MeshKind): Unit {
    const mount = new THREE.Group(), head = new THREE.Group(), stand = new THREE.Group();
    mount.add(head);
    const faces: THREE.MeshBasicMaterial[] = [];
    // Emissive faces sit just in front of their housing; polygon offset keeps them from fighting it.
    const glowing = () => { const m = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); faces.push(m); return m; };
    const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material) => { const mesh = new THREE.Mesh(g, m); parent.add(mesh); return mesh; };
    const alongZ = (g: THREE.BufferGeometry) => g.rotateX(Math.PI / 2);
    const cyl = (r0: number, r1: number, len: number, z: number, seg = 18, open = false) => alongZ(new THREE.CylinderGeometry(r0, r1, len, seg, 1, open)).translate(0, 0, z);
    let glow: THREE.Sprite | null = null;
    const halo = (scale = 1) => { glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowMap, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, opacity: 0.7 })); glow.userData.k = scale; head.add(glow); };
    let drop = 0.95;
    /** A U-shaped yoke round the head, from its sides down to the stand. */
    const yoke = (half: number, depth: number) => {
      const arm = new THREE.BoxGeometry(0.06, depth, 0.1);
      add(mount, arm.clone().translate(-half, -depth / 2, 0), this.metal);
      add(mount, arm.translate(half, -depth / 2, 0), this.metal);
      add(mount, new THREE.BoxGeometry(half * 2 + 0.06, 0.06, 0.1).translate(0, -depth, 0), this.metal);
      add(mount, new THREE.CylinderGeometry(0.05, 0.05, 0.25, 8).translate(0, -depth - 0.12, 0), this.metal);
      drop = depth + 0.25;
    };
    /** A short spigot under a head that has no yoke. */
    const spigot = (len = 0.5) => { add(mount, new THREE.CylinderGeometry(0.045, 0.045, len, 8).translate(0, -len / 2 - 0.3, 0), this.metal); drop = len + 0.3; };
    const barnDoors = (r: number) => {
      const leaf = (w: number, h: number) => new THREE.BoxGeometry(w, 0.02, h).translate(0, 0, h / 2);
      for (const [rot, w, h] of [[0, 2 * r, r], [Math.PI, 2 * r, r], [Math.PI / 2, 1.6 * r, 0.85 * r], [-Math.PI / 2, 1.6 * r, 0.85 * r]] as const) {
        const hinge = new THREE.Group();
        hinge.rotation.z = rot;
        const door = add(hinge, leaf(w, h), this.dark);
        door.position.y = r + 0.02;
        door.rotation.x = -0.45;
        head.add(hinge);
      }
    };
    /** A monolight body behind a modifier (z < 0), facing +Z. */
    const monolight = (z: number) => {
      add(head, cyl(0.2, 0.2, 0.75, z - 0.375, 14), this.metal);
      add(head, new THREE.BoxGeometry(0.06, 0.18, 0.3).translate(0, 0.24, z - 0.5), this.metal);
      spigot(0.45);
    };
    switch (fixture) {
      case "fresnel":
      case "hmi": {
        const big = fixture === "hmi";
        add(head, cyl(0.5, 0.5, 0.95, -0.5, 20, true), this.metal);
        add(head, cyl(0.42, 0.5, 0.28, -1.1), this.metal);
        // Cooling fins on the back of the can.
        for (const z of [-0.85, -0.7]) add(head, cyl(0.53, 0.53, 0.04, z), this.dark);
        add(head, new THREE.RingGeometry(0.4, 0.53, 28), this.metal).position.z = 0.01;
        add(head, new THREE.CircleGeometry(0.4, 28), glowing()).position.z = -0.03;
        // The Fresnel lens's stepped rings.
        for (const r of [0.14, 0.24, 0.33]) add(head, new THREE.RingGeometry(r, r + 0.022, 28), this.dark).position.z = -0.01;
        barnDoors(0.52);
        if (big) add(mount, new THREE.BoxGeometry(0.8, 0.36, 0.6).translate(0, -1.7, -0.1), this.metal);
        yoke(0.6, big ? 1.25 : 0.85);
        if (big) drop = 2.1;
        break;
      }
      case "openface": {
        add(head, cyl(0.6, 0.3, 0.55, -0.28, 20, true), this.metal);
        add(head, cyl(0.3, 0.3, 0.4, -0.75, 14), this.metal);
        add(head, new THREE.CircleGeometry(0.52, 24), glowing()).position.z = -0.4;
        add(head, new THREE.SphereGeometry(0.13, 12, 8), glowing()).position.z = -0.2;
        barnDoors(0.6);
        yoke(0.66, 0.85);
        break;
      }
      case "par": {
        // A deep can with a lamp at the back.
        add(head, cyl(0.45, 0.45, 1.3, -0.65, 20, true), this.metal);
        add(head, new THREE.CircleGeometry(0.45, 20), this.metal).position.z = -1.3;
        add(head, new THREE.CircleGeometry(0.4, 24), glowing()).position.z = -0.06;
        add(head, new THREE.RingGeometry(0.4, 0.47, 24), this.dark).position.z = 0.01;
        yoke(0.52, 0.8);
        break;
      }
      case "panel": {
        add(head, new THREE.BoxGeometry(1.2, 1.2, 0.1).translate(0, 0, -0.06), this.metal);
        add(head, new THREE.PlaneGeometry(1.08, 1.08), glowing()).position.z = 0.01;
        yoke(0.68, 0.8);
        break;
      }
      case "tube": {
        // An LED tube as gaffers stand it: vertical, ~1.2 m × 3 cm (here 4 × 0.1 head units), glowing along its whole
        // length, short matte black end caps, a black clamp at its middle on the stand; it pans with the unit and stays upright.
        const z = 0.18;
        add(mount, new THREE.CylinderGeometry(0.05, 0.05, 3.8, 16).translate(0, 0, z), glowing());
        // Soft bloom: a wider, faint, additive sleeve in the same colour.
        const bloom = glowing();
        bloom.transparent = true; bloom.opacity = 0.18; bloom.depthWrite = false; bloom.blending = THREE.AdditiveBlending;
        add(mount, new THREE.CylinderGeometry(0.16, 0.16, 3.9, 16, 1, true).translate(0, 0, z), bloom);
        for (const y of [-1.96, 1.96]) add(mount, new THREE.CylinderGeometry(0.062, 0.062, 0.14, 12).translate(0, y, z), this.dark);
        add(mount, new THREE.BoxGeometry(0.16, 0.22, 0.2).translate(0, 0, z - 0.1), this.dark);
        add(mount, new THREE.CylinderGeometry(0.035, 0.035, 0.2, 8).rotateX(Math.PI / 2).translate(0, 0, 0.0), this.metal);
        drop = 0.01;
        break;
      }
      case "mat": {
        // A flexible thin mat, gently bowed, in a light frame.
        const g = new THREE.PlaneGeometry(1.6, 1.0, 8, 1);
        const pos = g.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setZ(i, -0.12 * (pos.getX(i) / 0.8) ** 2);
        g.computeVertexNormals();
        add(head, g, glowing());
        const back = g.clone().translate(0, 0, -0.03);
        add(head, back, this.dark);
        spigot(0.6);
        break;
      }
      case "fluoro": {
        // A frame with four tubes and a reflector.
        add(head, new THREE.BoxGeometry(1.5, 0.95, 0.12).translate(0, 0, -0.1), this.metal);
        for (const y of [-0.33, -0.11, 0.11, 0.33]) add(head, new THREE.CylinderGeometry(0.06, 0.06, 1.36, 10).rotateZ(Math.PI / 2).translate(0, y, 0.02), glowing());
        barnDoors(0.5);
        yoke(0.8, 0.8);
        break;
      }
      case "lantern":
      case "balloon": {
        add(head, new THREE.SphereGeometry(0.5, 18, 12), glowing());
        if (fixture === "lantern") for (const y of [-0.25, 0, 0.25]) add(head, new THREE.TorusGeometry(Math.sqrt(0.25 - y * y) + 0.005, 0.012, 4, 24).rotateX(Math.PI / 2).translate(0, y, 0), this.dark);
        add(mount, new THREE.CylinderGeometry(0.01, 0.01, 1.4, 4).translate(0, 1.2, 0), this.dark);
        halo(1);
        drop = 0;
        break;
      }
      case "frame": {
        // A square frame with fabric: the fabric glows (it is the source).
        const t = 0.05;
        for (const [w, h, x, y] of [[2, t, 0, 1], [2, t, 0, -1], [t, 2, 1, 0], [t, 2, -1, 0]] as const) add(head, new THREE.BoxGeometry(w + t, h + t, t).translate(x, y, 0), this.metal);
        add(head, new THREE.PlaneGeometry(1.96, 1.96), glowing()).position.z = 0.005;
        add(mount, new THREE.BoxGeometry(t, 1.2, t).translate(0, -1.6, 0), this.metal);
        drop = 2.2;
        break;
      }
      case "softbox":
      case "strip": {
        const strip = fixture === "strip";
        const box = alongZ(new THREE.CylinderGeometry(0.71, 0.14, 0.7, 4, 1, true)).rotateZ(Math.PI / 4).scale(strip ? 0.45 : 1.3, strip ? 2 : 1, 1).translate(0, 0, -0.35);
        add(head, box, this.dark);
        add(head, new THREE.PlaneGeometry(strip ? 0.45 : 1.3, strip ? 2 : 1), glowing()).position.z = 0.005;
        monolight(-0.7);
        break;
      }
      case "octa": {
        add(head, alongZ(new THREE.CylinderGeometry(0.75, 0.14, 0.7, 8, 1, true)).rotateZ(Math.PI / 8).translate(0, 0, -0.35), this.dark);
        add(head, new THREE.CircleGeometry(0.72, 8).rotateZ(Math.PI / 8), glowing()).position.z = 0.005;
        monolight(-0.7);
        break;
      }
      case "dish": {
        add(head, cyl(0.6, 0.18, 0.35, -0.18, 24, true), this.metal);
        add(head, new THREE.CircleGeometry(0.17, 16), glowing()).position.z = -0.32;
        add(head, new THREE.CircleGeometry(0.12, 16), this.metal).position.z = 0.05;
        add(head, new THREE.RingGeometry(0.25, 0.58, 24), glowing()).position.z = -0.2;
        monolight(-0.35);
        break;
      }
      case "umbrella": {
        // An umbrella opening towards the light's direction, with its shaft.
        const g = new THREE.SphereGeometry(0.8, 16, 6, 0, Math.PI * 2, 0, Math.PI / 3).rotateX(Math.PI / 2).translate(0, 0, -0.4);
        add(head, g, glowing());
        add(head, g.clone().scale(1.01, 1.01, 1.01).translate(0, 0, -0.01), this.dark);
        add(head, alongZ(new THREE.CylinderGeometry(0.015, 0.015, 1.4, 4)).translate(0, 0, -0.5), this.metal);
        monolight(-0.6);
        break;
      }
      case "ring": {
        add(head, new THREE.TorusGeometry(0.42, 0.12, 8, 32), this.metal);
        add(head, new THREE.RingGeometry(0.33, 0.51, 32), glowing()).position.z = 0.13;
        spigot(0.5);
        break;
      }
      case "speedlight": {
        add(head, new THREE.BoxGeometry(0.9, 0.5, 0.6).translate(0, 0, -0.3), this.metal);
        add(head, new THREE.PlaneGeometry(0.8, 0.4), glowing()).position.z = 0.01;
        add(mount, new THREE.BoxGeometry(0.75, 1.1, 0.5).translate(0, -0.85, -0.35), this.metal);
        drop = 1.4;
        break;
      }
      case "bulb": {
        add(head, new THREE.SphereGeometry(0.42, 16, 10), glowing());
        add(head, new THREE.CylinderGeometry(0.17, 0.2, 0.35, 10).translate(0, 0.5, 0), this.metal);
        add(mount, new THREE.CylinderGeometry(0.01, 0.01, 1.2, 4).translate(0, 1.27, 0), this.dark);
        halo(1);
        drop = 0;
        break;
      }
      case "lamp": {
        // A table lamp: a glowing drum shade on a stem and base.
        add(head, new THREE.CylinderGeometry(0.32, 0.5, 0.55, 20, 1, true), glowing());
        add(head, new THREE.SphereGeometry(0.12, 10, 8).translate(0, -0.05, 0), glowing());
        add(head, new THREE.CylinderGeometry(0.03, 0.03, 0.8, 6).translate(0, -0.6, 0), this.metal);
        add(head, new THREE.CylinderGeometry(0.25, 0.3, 0.08, 16).translate(0, -1.0, 0), this.metal);
        halo(0.8);
        drop = 0;
        break;
      }
      case "candle": {
        add(head, new THREE.CylinderGeometry(0.22, 0.22, 1.1, 14).translate(0, -0.75, 0), this.dark);
        add(head, new THREE.ConeGeometry(0.1, 0.38, 10).translate(0, 0, 0), glowing());
        add(head, new THREE.SphereGeometry(0.1, 10, 8).translate(0, -0.15, 0), glowing());
        halo(1.2);
        drop = 0;
        break;
      }
      case "neon": {
        // A bent neon line on a thin back plate.
        const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-1, -0.3, 0), new THREE.Vector3(-0.5, 0.3, 0), new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0.5, 0.3, 0), new THREE.Vector3(1, -0.1, 0)]);
        add(head, new THREE.TubeGeometry(curve, 48, 0.05, 8), glowing());
        add(head, new THREE.PlaneGeometry(2.3, 0.9).translate(0, 0, -0.08), this.dark);
        halo(1);
        drop = 0;
        break;
      }
    }
    // Outline the bodies (not the glowing faces) where their facets turn sharply.
    const bodies: THREE.Mesh[] = [];
    mount.traverse((o) => { if (o instanceof THREE.Mesh && (o.material === this.metal || o.material === this.dark)) bodies.push(o); });
    for (const b of bodies) b.add(new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry, 35), this.edge));
    // A thin stand: pole (unit height, scaled to the floor) and three short legs.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0032, 1, 6).translate(0, 0.5, 0), this.metal);
    stand.add(pole);
    for (let i = 0; i < 3; i++) {
      // Unit height, centred: placed each update from the collar down to its foot.
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.0026, 0.0026, 1, 5), this.metal);
      leg.userData.leg = i;
      stand.add(leg);
    }
    this.root.add(mount, stand);
    return { fixture, mount, head, stand, pole, faces, glow, drop };
  }
}

const RIM_VERT = /* glsl */ `
attribute float edge;
varying float vEdge;
varying vec3 vW;
varying vec3 vN;
#include <common>
void main() {
  #include <begin_vertex>
  vEdge = edge;
  vW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}`;
// On screen, the edges whose outward side faces the light (both seen across
// the view), near the subject: silhouettes most, grazing surfaces a little.
const RIM_FRAG = /* glsl */ `
#include <common>
uniform int uCount;
uniform vec3 uColour[4];
uniform vec3 uLight[4];
uniform vec3 uCentre[4];
uniform float uRadius[4];
varying float vEdge;
varying vec3 vW;
varying vec3 vN;
void main() {
  vec3 v = normalize(cameraPosition - vW);
  vec3 n = normalize(vN);
  if (dot(n, v) < 0.0) n = -n;
  float nv = clamp(dot(n, v), 0.0, 1.0);
  vec3 np = n - v * nv;
  float g = 1.0 - nv;
  float mask = vEdge * vEdge * 0.55 + g * g * 0.45;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= uCount) break;
    vec3 l = uLight[i] - vW;
    vec3 lp = l - v * dot(l, v);
    float side = smoothstep(0.25, 0.9, dot(np, lp) / max(1e-5, length(np) * length(lp)));
    vec3 d = vW - uCentre[i];
    float near = exp(-dot(d, d) / (uRadius[i] * uRadius[i]));
    acc += uColour[i] * side * near * mask;
  }
  gl_FragColor = vec4(acc, 0.0);
}`;

