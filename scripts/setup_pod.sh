#!/usr/bin/env bash
# Idempotent ComfyUI setup for EVE Tools for ComfyUI (RunPod "ComfyUI" template or any Linux box).
# Usage on the pod:  HF_TOKEN=... bash setup_pod.sh
# Elsewhere:         COMFY=/path/to/ComfyUI WS=$HOME HF_TOKEN=... bash setup_pod.sh
# HF_TOKEN must belong to an account that accepted the LTX-2.5 license on huggingface.co/Lightricks/LTX-2.5.
set -u

COMFY=${COMFY:-/workspace/runpod-slim/ComfyUI}
[ -d "$COMFY" ] || COMFY=$(dirname "$(find / -maxdepth 4 -name main.py -path '*ComfyUI*' 2>/dev/null | head -1)")
VENV=$(ls -d "$COMFY"/.venv* 2>/dev/null | head -1)
PY=${VENV:+$VENV/bin/python}; PY=${PY:-python3}
MD=$COMFY/models
WS=${WS:-/workspace}   # logs go here
LOG=$WS/setup.log
mkdir -p "$MD"/{diffusion_models,text_encoders,vae,loras,latent_upscale_models} "$WS"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
dl() {
  local dest="$1" url="$2" auth=()
  [[ "$url" == *Lightricks* ]] && auth=(-H "Authorization: Bearer ${HF_TOKEN:?HF_TOKEN required for LTX}")
  if [ -s "$dest" ] && [ ! -e "$dest.part" ]; then log "skip $(basename "$dest")"; return; fi
  log "get  $(basename "$dest")"
  touch "$dest.part"
  if curl -L --fail --retry 5 --retry-delay 5 -C - "${auth[@]}" -o "$dest" "$url" 2>>"$LOG"; then rm -f "$dest.part"; log "done $(basename "$dest")"
  else log "FAIL $(basename "$dest")"; fi
}

log "ComfyUI at $COMFY, python $PY"
# LTX-2.5 needs ComfyUI >= 0.32.0. The RunPod template's checkout has no upstream branch, so
# `git pull` fails there: check out the newest release tag instead (tested: v0.43.2).
if [ -d "$COMFY/.git" ]; then
  git -C "$COMFY" fetch --tags -q origin && T=$(git -C "$COMFY" tag -l 'v0.*' --sort=-v:refname | head -1) \
    && git -C "$COMFY" checkout -q "$T" && log "ComfyUI $T"
  "$PY" -m pip install -q -r "$COMFY/requirements.txt" 2>&1 | tail -2 | tee -a "$LOG"
fi

Q=https://huggingface.co/Comfy-Org/Qwen-Image-Edit/resolve/main/split_files
QI=https://huggingface.co/Comfy-Org/Qwen-Image/resolve/main/split_files
L=https://huggingface.co/Lightricks/LTX-2.5/resolve/main

# Qwen first: the image steps are usable before the video models land.
dl "$MD/vae/qwen_image_vae.safetensors"                        "$QI/vae/qwen_image_vae.safetensors" &
dl "$MD/loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors" \
   https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors &
dl "$MD/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"   "$QI/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" &
dl "$MD/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors" "$Q/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors" &
wait
dl "$MD/vae/ltx-2.5-video-vae-bf16.safetensors"               "$L/vae/ltx-2.5-video-vae-bf16.safetensors" &
dl "$MD/vae/ltx-2.5-audio-vae-bf16.safetensors"               "$L/vae/ltx-2.5-audio-vae-bf16.safetensors" &
dl "$MD/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" \
   "$L/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" &
dl "$MD/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
   "$L/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" &
# Gemma 4 E2B describes each shot's first frame into the LTX prompt (TextGenerateLTX2Prompt).
dl "$MD/text_encoders/gemma4_e2b_it_int8_convrot.safetensors" \
   https://huggingface.co/Comfy-Org/gemma-4/resolve/main/text_encoders/gemma4_e2b_it_int8_convrot.safetensors &
dl "$MD/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" \
   "$L/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" &
wait

du -sh "$MD"/* | tee -a "$LOG"; df -h "$WS" | tee -a "$LOG"

# Restart with CORS so the browser app can call the API directly.
# --cache-ram keeps recently used models in system RAM, so switching Qwen <-> LTX costs seconds, not a disk reload.
# (--highvram would pin everything in VRAM and leaves no room for the frame describer.)
pkill -f 'main.py' ; sleep 3
cd "$COMFY" && nohup "$PY" main.py --listen 0.0.0.0 --port 8188 --enable-cors-header '*' --cache-ram 10 24 > "$WS/comfyui.log" 2>&1 &
log "ComfyUI restarted; tail $WS/comfyui.log"
