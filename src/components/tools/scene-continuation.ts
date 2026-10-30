import * as THREE from "three";

const vertex = `in vec3 position; in vec2 uv; out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const fragment = `precision highp float;
uniform sampler2D source;
uniform sampler2D colourSource;
uniform vec2 resolution, fullResolution;
uniform float jump;
in vec2 vUv;
out vec4 outColor;
void main() {
  if (jump < -2.5) {
    vec2 direction = jump < -3.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
    vec4 colour = vec4(0.0);
    float total = 0.0;
    for (int i = -6; i <= 6; i++) {
      float weight = exp(-float(i * i) / 18.0);
      colour += texture(source, vUv + direction * float(i) * 2.5 / resolution) * weight;
      total += weight;
    }
    outColor = colour / total;
    return;
  }
  if (jump < -1.5) {
    vec2 nearest = texture(source, vUv).xy;
    if (nearest.x < 0.0) { outColor = vec4(vec3(0.012), 1.0); return; }
    float distance = length((nearest - vUv) * fullResolution);
    float lod = log2(10.0 + distance * 0.3);
    vec4 colour = textureLod(colourSource, nearest, lod);
    vec3 rgb = colour.rgb / max(colour.a, 0.00001);
    float luminance = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    // Unobserved space is a neutral editing backdrop, not stretched subject colour.
    float halo = exp(-distance / max(1.0, fullResolution.y * 0.06));
    rgb = vec3(0.012 + min(luminance, 0.5) * 0.08 * halo);
    outColor = vec4(rgb, 1.0);
    return;
  }
  if (jump < 0.0) {
    outColor = texture(source, vUv).a > 0.5 ? vec4(vUv, 0.0, 1.0) : vec4(-1.0);
    return;
  }
  vec2 best = vec2(-1.0);
  float distance2 = 1e20;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 sampleUv = vUv + vec2(float(x), float(y)) * jump / resolution;
    if (any(lessThan(sampleUv, vec2(0.0))) || any(greaterThan(sampleUv, vec2(1.0)))) continue;
    vec2 candidate = texture(source, sampleUv).xy;
    if (candidate.x < 0.0) continue;
    vec2 delta = (candidate - vUv) * resolution;
    float d = dot(delta, delta);
    if (d < distance2) { distance2 = d; best = candidate; }
  }
  outColor = vec4(best, 0.0, 1.0);
}`;

/** Low-resolution nearest silhouette coordinates. No readback or full-size blur. */
export class SceneContinuation {
  private targets: THREE.WebGLRenderTarget[];
  private material: THREE.RawShaderMaterial;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private geometry = new THREE.PlaneGeometry(2, 2);
  constructor(width: number, height: number) {
    const scale = Math.min(1, 384 / Math.max(width, height));
    const w = Math.max(2, Math.round(width * scale)), h = Math.max(2, Math.round(height * scale));
    this.targets = [0, 1].map(() => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false }));
    this.material = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vertex, fragmentShader: fragment, depthTest: false, depthWrite: false,
      uniforms: { colourSource: { value: null }, fullResolution: { value: new THREE.Vector2(width, height) }, source: { value: null }, resolution: { value: new THREE.Vector2(w, h) }, jump: { value: -1 } } });
    this.scene.add(new THREE.Mesh(this.geometry, this.material));
  }
  render(renderer: THREE.WebGLRenderer, source: THREE.Texture): THREE.Texture {
    let current = 0;
    const u = this.material.uniforms;
    u.source.value = source; u.jump.value = -1;
    renderer.setRenderTarget(this.targets[current]); renderer.render(this.scene, this.camera);
    const max = Math.max(this.targets[0].width, this.targets[0].height);
    for (let step = 2 ** (Math.ceil(Math.log2(max)) - 1); step >= 1; step /= 2) {
      u.source.value = this.targets[current].texture; u.jump.value = step;
      current = 1 - current;
      renderer.setRenderTarget(this.targets[current]); renderer.render(this.scene, this.camera);
    }
    u.colourSource.value = source;
    // Convert the coordinate field to colour, then smooth its Voronoi boundaries.
    for (const pass of [-2, -3, -4]) {
      u.source.value = this.targets[current].texture; u.jump.value = pass;
      current = 1 - current;
      renderer.setRenderTarget(this.targets[current]); renderer.render(this.scene, this.camera);
    }
    renderer.setRenderTarget(null);
    return this.targets[current].texture;
  }
  dispose() { this.targets.forEach((t) => t.dispose()); this.geometry.dispose(); this.material.dispose(); }
}
