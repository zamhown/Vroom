#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
skip_model=false
for arg in "$@"; do
  case "$arg" in
    --skip-model) skip_model=true ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

missing=()
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then missing+=(ffmpeg); fi
if ! command -v mpv >/dev/null; then missing+=(mpv); fi
if ! command -v HandBrakeCLI >/dev/null; then missing+=(handbrake); fi
if [ "${#missing[@]}" -gt 0 ]; then
  if command -v brew >/dev/null; then
    brew install "${missing[@]}"
  elif [ "$(uname -s)" = Linux ] && command -v apt-get >/dev/null; then
    packages=()
    for package in "${missing[@]}"; do
      if [ "$package" = handbrake ]; then packages+=(handbrake-cli); else packages+=("$package"); fi
    done
    privilege=()
    if [ "$(id -u)" -ne 0 ]; then
      if ! command -v sudo >/dev/null || ! sudo -n true; then
        printf 'Installing media tools needs apt permissions. Install ffmpeg mpv handbrake-cli, then retry npm run setup.\n' >&2
        exit 1
      fi
      privilege=(sudo -n)
    fi
    "${privilege[@]}" apt-get update
    "${privilege[@]}" apt-get install -y "${packages[@]}"
  else
    printf 'Install Homebrew on macOS (https://brew.sh), or install ffmpeg, ffprobe, mpv and HandBrakeCLI with your Linux package manager; then retry npm run setup.\n' >&2
    exit 1
  fi
fi
for executable in ffmpeg ffprobe mpv HandBrakeCLI; do
  command -v "$executable" >/dev/null || { printf 'Missing tool after installation: %s\n' "$executable" >&2; exit 1; }
done

mkdir -p "$root/runtime/models" "$root/runtime/ffmpeg" "$root/runtime/mpv" "$root/runtime/handbrake"
ln -sfn "$(command -v ffmpeg)" "$root/runtime/ffmpeg/ffmpeg"
ln -sfn "$(command -v ffprobe)" "$root/runtime/ffmpeg/ffprobe"
ln -sfn "$(command -v mpv)" "$root/runtime/mpv/mpv"
ln -sfn "$(command -v HandBrakeCLI)" "$root/runtime/handbrake/HandBrakeCLI"
ffmpeg -version >/dev/null
ffprobe -version >/dev/null
mpv --version >/dev/null
HandBrakeCLI --version

if [ "$skip_model" = false ]; then
  model="$root/runtime/models/qwen2.5-0.5b-instruct-q4_k_m.gguf"
  expected='74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db'
  verify_model() {
    if command -v sha256sum >/dev/null; then
      printf '%s  %s\n' "$expected" "$1" | sha256sum -c -
    else
      printf '%s  %s\n' "$expected" "$1" | shasum -a 256 -c -
    fi
  }
  if [ ! -f "$model" ] || ! verify_model "$model"; then
    curl --fail --location --retry 3 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_k_m.gguf' -o "$model.partial"
    verify_model "$model.partial"
    mv "$model.partial" "$model"
  fi
  if [ ! -f "$root/runtime/models/LICENSE" ]; then
    curl --fail --location --retry 3 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/raw/9217f5db79a29953eb74d5343926648285ec7e67/LICENSE' -o "$root/runtime/models/LICENSE"
  fi
fi
printf 'Runtime ready: %s/runtime\n' "$root"
