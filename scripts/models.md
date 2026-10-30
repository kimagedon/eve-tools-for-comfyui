# Models

All open weights. `scripts/setup_pod.sh` downloads every file below into a ComfyUI install
(ComfyUI **≥ 0.32**, core nodes only — no custom node packs; tested on 0.43.2 with frontend 1.57.4).
Total ≈ 75 GB.

| Role | File | ComfyUI folder | Source | License |
|---|---|---|---|---|
| Image edit (Set, Light, Shoot stills) | `qwen_image_edit_2511_fp8mixed.safetensors` | `models/diffusion_models` | [Comfy-Org/Qwen-Image-Edit](https://huggingface.co/Comfy-Org/Qwen-Image-Edit/tree/main/split_files/diffusion_models) | Apache-2.0 |
| Text encoder | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `models/text_encoders` | [Comfy-Org/Qwen-Image](https://huggingface.co/Comfy-Org/Qwen-Image/tree/main/split_files/text_encoders) | Apache-2.0 |
| VAE | `qwen_image_vae.safetensors` | `models/vae` | [Comfy-Org/Qwen-Image](https://huggingface.co/Comfy-Org/Qwen-Image/tree/main/split_files/vae) | Apache-2.0 |
| 4-step LoRA | `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | `models/loras` | [lightx2v/Qwen-Image-Edit-2511-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning) | Apache-2.0 |
| Video (Shoot) | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` | `models/diffusion_models` | [Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) (gated: accept the license, use an HF read token) | LTX-2 Community License |
| Text encoder | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | `models/text_encoders` | Lightricks/LTX-2.5 | LTX-2 Community License |
| Frame describer (Shoot) | `gemma4_e2b_it_int8_convrot.safetensors` | `models/text_encoders` | [Comfy-Org/gemma-4](https://huggingface.co/Comfy-Org/gemma-4/tree/main/text_encoders) | Apache-2.0 |
| Video VAE | `ltx-2.5-video-vae-bf16.safetensors` | `models/vae` | Lightricks/LTX-2.5 | LTX-2 Community License |
| Audio VAE | `ltx-2.5-audio-vae-bf16.safetensors` | `models/vae` | Lightricks/LTX-2.5 | LTX-2 Community License |
| Latent upscaler (i2v graph) | `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | `models/latent_upscale_models` | Lightricks/LTX-2.5 | LTX-2 Community License |

In the browser (downloaded on first use, cached): MoGe-2 (WebGPU) or Depth Anything V2 Small (WASM fallback) for the 3D set.

Comfy Cloud already hosts every file above — nothing to download there.

## VRAM
- Qwen-Image-Edit fp8 + encoder: ~30 GB. LTX-2.5 int8 stack: ~23 GB sampling (encoder offloaded).
- Tested on an A100 80 GB. 48 GB cards (L40S, RTX 6000 Ada) work with ComfyUI's automatic offloading.
