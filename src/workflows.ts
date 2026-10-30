import { lookWords, monochrome } from './lib/monochrome.ts';
// ComfyUI API-format graphs. Mirrors the official Comfy-Org templates
// (image_qwen_image_edit_2511, video_ltx2_5_flf2v, video_ltx2_5_i2v) with the
// subgraphs flattened and the inputs the app drives exposed as parameters.

export type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } };
export type ApiGraph = Record<string, ApiNode>;

export const MODELS = {
  qwenUnet: 'qwen_image_edit_2511_fp8mixed.safetensors',
  qwenClip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  qwenVae: 'qwen_image_vae.safetensors',
  qwenLightning: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors',
  ltxUnet: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
  ltxClip: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
  ltxVae: 'ltx-2.5-video-vae-bf16.safetensors',
  ltxAudioVae: 'ltx-2.5-audio-vae-bf16.safetensors',
  ltxUpscaler: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
  /** Small vision LM that looks at the first frame and writes the scene description. */
  ltxDescriber: 'gemma4_e2b_it_int8_convrot.safetensors',
} as const;

/**
 * Black & white (lib/monochrome): the prompt says so and the picture is
 * desaturated in the graph with core nodes only (the green channel — a
 * panchromatic-like luminance — as a grey image), so any server can run it.
 */
function mono(g: ApiGraph, from: [string, number]): [string, number] {
  if (!monochrome()) return from;
  g.monoMask = { class_type: 'ImageToMask', inputs: { image: from, channel: 'green' }, _meta: { title: 'B&W' } };
  g.monoImage = { class_type: 'MaskToImage', inputs: { mask: ['monoMask', 0] } };
  return ['monoImage', 0];
}
const monoPrompt = (prompt: string) => `${prompt} ${lookWords()}`;

const n = (class_type: string, inputs: Record<string, unknown>, title?: string): ApiNode =>
  title ? { class_type, inputs, _meta: { title } } : { class_type, inputs };

export type EditParams = {
  /** Uploaded file names (ComfyUI input folder). image1 drives the output size. */
  image1: string;
  image2?: string;
  prompt: string;
  seed: number;
  /** Lightning LoRA: 4 steps, cfg 1. Off: 40 steps, cfg 3. */
  fast?: boolean;
};

/** Qwen-Image-Edit-2511: one or two images + prompt -> image. */
export function editGraph(p: EditParams): ApiGraph {
  const fast = p.fast ?? true;
  const g: ApiGraph = {
    unet: n('UNETLoader', { unet_name: MODELS.qwenUnet, weight_dtype: 'default' }),
    clip: n('CLIPLoader', { clip_name: MODELS.qwenClip, type: 'qwen_image', device: 'default' }),
    vae: n('VAELoader', { vae_name: MODELS.qwenVae }),
    lora: n('LoraLoaderModelOnly', { model: ['unet', 0], lora_name: MODELS.qwenLightning, strength_model: 1 }),
    shift: n('ModelSamplingAuraFlow', { model: fast ? ['lora', 0] : ['unet', 0], shift: 3.1 }),
    norm: n('CFGNorm', { model: ['shift', 0], strength: 1 }),
    load1: n('LoadImage', { image: p.image1 }, 'Input image 1'),
    // Keeps the exact aspect (2.39:1 etc.) so the original can be composited back.
    scale1: n('ImageScaleToTotalPixels', { image: ['load1', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 }),
    pos: n('TextEncodeQwenImageEditPlus', { clip: ['clip', 0], vae: ['vae', 0], image1: ['scale1', 0], prompt: monoPrompt(p.prompt) }, 'Prompt'),
    neg: n('TextEncodeQwenImageEditPlus', { clip: ['clip', 0], vae: ['vae', 0], image1: ['scale1', 0], prompt: '' }),
    posRef: n('FluxKontextMultiReferenceLatentMethod', { conditioning: ['pos', 0], reference_latents_method: 'index_timestep_zero' }),
    negRef: n('FluxKontextMultiReferenceLatentMethod', { conditioning: ['neg', 0], reference_latents_method: 'index_timestep_zero' }),
    latent: n('VAEEncode', { pixels: ['scale1', 0], vae: ['vae', 0] }),
    sample: n('KSampler', {
      model: ['norm', 0], positive: ['posRef', 0], negative: ['negRef', 0], latent_image: ['latent', 0],
      seed: p.seed, steps: fast ? 4 : 40, cfg: fast ? 1 : 3, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
    }),
    decode: n('VAEDecode', { samples: ['sample', 0], vae: ['vae', 0] }),
    save: n('SaveImage', { images: ['decode', 0], filename_prefix: 'eve-tools/edit' }, 'Output'),
  };
  if (!fast) delete g.lora;
  g.save.inputs.images = mono(g, ['decode', 0]);
  if (p.image2) {
    g.load2 = n('LoadImage', { image: p.image2 }, 'Input image 2');
    g.scale2 = n('ImageScaleToTotalPixels', { image: ['load2', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 });
    g.pos.inputs.image2 = ['scale2', 0];
    g.neg.inputs.image2 = ['scale2', 0];
  }
  if (fast) {
    // At cfg 1 ComfyUI never evaluates the negative (cfg1 optimisation) and CFGNorm
    // is an identity, so skip a second vision+text encode (~2 s) and the norm hook.
    // Same pixels for the same seed.
    g.neg = n('ConditioningZeroOut', { conditioning: ['pos', 0] });
    g.sample.inputs.model = ['shift', 0];
    delete g.norm;
  }
  return g;
}

export type OutpaintParams = {
  /** Canvas at the target size (multiples of 16, ~1 MP); transparent where new world is to grow. */
  canvas: string;
  /** The untouched photo: the model's reference for what the world looks like. */
  original: string;
  prompt: string;
  seed: number;
  fast?: boolean;
};

/**
 * Extend: Qwen-Image-Edit copies whatever it is shown, so flat or blurred
 * borders survive a plain edit. Here the borders start from pure noise
 * (latent noise mask from the canvas alpha) and only the clean photo is the reference.
 */
export function outpaintGraph(p: OutpaintParams): ApiGraph {
  const g = editGraph({ image1: p.original, prompt: p.prompt, seed: p.seed, fast: p.fast });
  g.canvas = n('LoadImage', { image: p.canvas }, 'Canvas (alpha = grow)');
  // Soft seam: the mask reaches ~48 px into the photo and fades out, and
  // Differential Diffusion denoises that band gradually, so the new world is
  // stitched to the photo instead of meeting it at a hard edge.
  g.grow = n('GrowMask', { mask: ['canvas', 1], expand: 48, tapered_corners: true });
  g.maskImg = n('MaskToImage', { mask: ['grow', 0] });
  g.maskBlur = n('ImageBlur', { image: ['maskImg', 0], blur_radius: 31, sigma: 10 });
  g.softMask = n('ImageToMask', { image: ['maskBlur', 0], channel: 'red' });
  g.latent = n('VAEEncode', { pixels: ['canvas', 0], vae: ['vae', 0] });
  g.masked = n('SetLatentNoiseMask', { samples: ['latent', 0], mask: ['softMask', 0] });
  g.diffdiff = n('DifferentialDiffusion', { model: g.sample.inputs.model, strength: 1 });
  g.sample.inputs.model = ['diffdiff', 0];
  g.sample.inputs.latent_image = ['masked', 0];
  // A gradual seam needs more than the 4 Lightning steps to settle.
  if (p.fast ?? true) g.sample.inputs.steps = 8;
  return g;
}

export type ShotParams = {
  first: string;
  /** With a last frame LTX interpolates the move between two camera keys. */
  last?: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  seconds: number;
  fps?: number;
  /** Generated sound (ambience/foley) in the shot; false = silent clip. Default true. */
  audio?: boolean;
  /** Let Gemma 4 E2B describe the first frame (subject, colours, light, materials) into the prompt. Default on. */
  describe?: boolean;
};

const NEGATIVE =
  'blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, grainy texture, flickering, distorted geometry, warped architecture, text, watermark';
const SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
const REFINE_SIGMAS = '0.85, 0.7250, 0.4219, 0.0';

/**
 * The delivery frame: the exact aspect of the shot (the keyed stills), long
 * side `longSide`, even sides for H.264. This is what the saved mp4 is.
 */
export function deliverySize(width: number, height: number, longSide = 1280) {
  const s = longSide / Math.max(width, height);
  const e = (v: number) => Math.max(2, Math.round((v * s) / 2) * 2);
  return { width: e(width), height: e(height) };
}

/**
 * LTX dims: multiples of 64 (the VAE's 32-px grid, halved once more by the
 * two-stage i2v), frame count 8n+1. Each side is the grid size nearest the
 * delivery frame, so the picture is squeezed at most ~6 % on one axis; the
 * graph scales the decoded frames back to the exact delivery size, so the
 * saved clip has the exact aspect and the exact framing of the keyed stills
 * (no crop, no stretch in the result).
 */
export function ltxSize(width: number, height: number, longSide = 1280) {
  const d = deliverySize(width, height, longSide);
  const r = (v: number) => Math.max(256, Math.round(v / 64) * 64);
  return { width: r(d.width), height: r(d.height) };
}
const frames = (seconds: number, fps: number) => Math.round((seconds * fps) / 8) * 8 + 1;

function ltxBase(p: ShotParams, w: number, h: number) {
  const fps = p.fps ?? 24;
  const len = frames(p.seconds, fps);
  return {
    fps,
    len,
    nodes: {
      unet: n('UNETLoader', { unet_name: MODELS.ltxUnet, weight_dtype: 'default' }),
      clip: n('CLIPLoader', { clip_name: MODELS.ltxClip, type: 'ltxv', device: 'default' }),
      vae: n('VAELoader', { vae_name: MODELS.ltxVae }),
      avae: n('VAELoader', { vae_name: MODELS.ltxAudioVae }),
      pos: n('CLIPTextEncode', { clip: ['clip', 0], text: monoPrompt(p.prompt) }, 'Prompt'),
      neg: n('CLIPTextEncode', { clip: ['clip', 0], text: NEGATIVE }),
      cond: n('LTXVConditioning', { positive: ['pos', 0], negative: ['neg', 0], frame_rate: fps }),
      load1: n('LoadImage', { image: p.first }, 'First frame'),
      size1: n('ImageScale', { image: ['load1', 0], upscale_method: 'lanczos', width: w, height: h, crop: 'disabled' }),
      pre1: n('LTXVPreprocess', { image: ['size1', 0], img_compression: 18 }),
      alat: n('LTXVEmptyLatentAudio', { audio_vae: ['avae', 0], frames_number: len, frame_rate: fps, batch_size: 1 }),
      noise: n('RandomNoise', { noise_seed: p.seed }),
      sampler: n('KSamplerSelect', { sampler_name: 'euler_ancestral' }),
      sigmas: n('ManualSigmas', { sigmas: SIGMAS }),
    } as ApiGraph,
  };
}

/** On by default; needs VRAM headroom for Gemma 4 E2B next to LTX (run ComfyUI without --highvram). */
export const DESCRIBE_DEFAULT = true;

/**
 * The describer: Gemma 4 E2B looks at the first frame and expands the move
 * into a full LTX prompt (scene, colours, light, materials); the camera move
 * is kept verbatim in front so the description can never drop it.
 */
function describeFirstFrame(g: ApiGraph, prompt: string) {
  g.describer = n('CLIPLoader', { clip_name: MODELS.ltxDescriber, type: 'ltxv', device: 'default' });
  g.describe = n('TextGenerateLTX2Prompt', {
    clip: ['describer', 0], image: ['size1', 0], prompt, max_length: 320,
    sampling_mode: 'off', thinking: false, use_default_template: true, mtp: 'auto',
  }, 'Describe first frame');
  g.fullPrompt = n('StringConcatenate', { string_a: prompt, string_b: ['describe', 0], delimiter: ' ' });
  g.pos.inputs.text = ['fullPrompt', 0];
}

function ltxDecode(g: ApiGraph, av: [string, number], fps: number, audio: boolean, out: { width: number; height: number }) {
  g.split = n('LTXVSeparateAVLatent', { av_latent: av });
  g.decode = n('VAEDecodeTiled', { samples: ['split', 0], vae: ['vae', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 });
  // LTX-2.5 always samples picture and sound together; a silent shot just skips decoding the sound.
  if (audio) g.adecode = n('LTXVAudioVAEDecode', { samples: ['split', 1], audio_vae: ['avae', 0] });
  // Back from the LTX grid to the exact delivery frame (the inverse of the input squeeze).
  g.deliver = n('ImageScale', { image: ['decode', 0], upscale_method: 'lanczos', width: out.width, height: out.height, crop: 'disabled' }, 'Delivery size');
  const frames = mono(g, ['deliver', 0]);
  g.video = n('CreateVideo', audio ? { images: frames, audio: ['adecode', 0], fps } : { images: frames, fps });
  g.save = n('SaveVideo', { video: ['video', 0], filename_prefix: 'eve-tools/shot', format: 'mp4', codec: 'h264' }, 'Output');
}

/** LTX-2.5 first/last frame: the camera move between two keyed stills. */
export function shotFlfGraph(p: ShotParams): ApiGraph {
  if (!p.last) throw new Error('shotFlfGraph needs a last frame');
  const { width: w, height: h } = ltxSize(p.width, p.height);
  const { fps, len, nodes: g } = ltxBase(p, w, h);
  if (p.describe ?? DESCRIBE_DEFAULT) describeFirstFrame(g, monoPrompt(p.prompt));
  g.load2 = n('LoadImage', { image: p.last }, 'Last frame');
  g.size2 = n('ImageScale', { image: ['load2', 0], upscale_method: 'lanczos', width: w, height: h, crop: 'disabled' });
  g.pre2 = n('LTXVPreprocess', { image: ['size2', 0], img_compression: 18 });
  g.vlat = n('EmptyLTXVLatentVideo', { width: w, height: h, length: len, batch_size: 1 });
  g.guide1 = n('LTXVAddGuide', { positive: ['cond', 0], negative: ['cond', 1], vae: ['vae', 0], latent: ['vlat', 0], image: ['pre1', 0], frame_idx: 0, strength: 0.7 });
  g.guide2 = n('LTXVAddGuide', { positive: ['guide1', 0], negative: ['guide1', 1], vae: ['vae', 0], latent: ['guide1', 2], image: ['pre2', 0], frame_idx: -1, strength: 0.7 });
  g.av = n('LTXVConcatAVLatent', { video_latent: ['guide2', 2], audio_latent: ['alat', 0] });
  g.guider = n('LTXVDualCFGGuider', { model: ['unet', 0], positive: ['guide2', 0], negative: ['guide2', 1], video_cfg: 1, audio_cfg: 1 });
  g.sample = n('SamplerCustomAdvanced', { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['av', 0] });
  g.split0 = n('LTXVSeparateAVLatent', { av_latent: ['sample', 0] });
  g.crop = n('LTXVCropGuides', { positive: ['guide2', 0], negative: ['guide2', 1], latent: ['split0', 0] });
  g.av2 = n('LTXVConcatAVLatent', { video_latent: ['crop', 2], audio_latent: ['split0', 1] });
  ltxDecode(g, ['av2', 0], fps, p.audio ?? true, deliverySize(p.width, p.height));
  return g;
}

/** LTX-2.5 image-to-video, two stages: half-res pass, x2 latent upscale, refine. */
export function shotI2vGraph(p: ShotParams): ApiGraph {
  const { width: w, height: h } = ltxSize(p.width, p.height);
  const { fps, len, nodes: g } = ltxBase(p, w, h);
  if (p.describe ?? DESCRIBE_DEFAULT) describeFirstFrame(g, monoPrompt(p.prompt));
  g.vlat = n('EmptyLTXVLatentVideo', { width: w / 2, height: h / 2, length: len, batch_size: 1 });
  g.i2v = n('LTXVImgToVideoInplace', { vae: ['vae', 0], image: ['pre1', 0], latent: ['vlat', 0], strength: 0.7, bypass: false });
  g.av = n('LTXVConcatAVLatent', { video_latent: ['i2v', 0], audio_latent: ['alat', 0] });
  g.guider = n('LTXVDualCFGGuider', { model: ['unet', 0], positive: ['cond', 0], negative: ['cond', 1], video_cfg: 1, audio_cfg: 1 });
  g.sample = n('SamplerCustomAdvanced', { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['av', 0] });
  g.split0 = n('LTXVSeparateAVLatent', { av_latent: ['sample', 0] });
  g.upmodel = n('LatentUpscaleModelLoader', { model_name: MODELS.ltxUpscaler });
  g.up = n('LTXVLatentUpsampler', { samples: ['split0', 0], upscale_model: ['upmodel', 0], vae: ['vae', 0] });
  g.i2v2 = n('LTXVImgToVideoInplace', { vae: ['vae', 0], image: ['pre1', 0], latent: ['up', 0], strength: 1, bypass: false });
  g.av2 = n('LTXVConcatAVLatent', { video_latent: ['i2v2', 0], audio_latent: ['split0', 1] });
  g.noise2 = n('RandomNoise', { noise_seed: 42 });
  g.sigmas2 = n('ManualSigmas', { sigmas: REFINE_SIGMAS });
  g.sample2 = n('SamplerCustomAdvanced', { noise: ['noise2', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas2', 0], latent_image: ['av2', 0] });
  ltxDecode(g, ['sample2', 0], fps, p.audio ?? true, deliverySize(p.width, p.height));
  return g;
}
