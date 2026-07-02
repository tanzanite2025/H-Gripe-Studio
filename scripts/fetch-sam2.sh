#!/usr/bin/env bash
# Fetch the SAM 2 interactive point-prompt weights (Apache-2.0) into the Tauri
# resources dir. Usage: fetch-sam2.sh [tiny|small|base_plus|large|all ...]
# (default: tiny). These are a *downloadable big tier* (tiny encoder ~134 MB up
# to large ~889 MB; decoder ~20 MB each): not bundled in the release by
# default. Run this to bundle them for a release, or point
# HGRIPE_SAM2_ENCODER / HGRIPE_SAM2_DECODER at local copies for dev. Fetching
# more than one variant lets the Subject Mask node's `sam2_variant` selector
# compare them side by side. The weights are not committed to git.
set -euo pipefail

BASE="https://huggingface.co/vietanhdev/segment-anything-2-onnx-models/resolve/main"

# variant -> "<upstream stem> <encoder sha256> <decoder sha256>"
spec_for() {
  case "$1" in
    tiny) echo "sam2_hiera_tiny 4cc015ee18520e93f8c7ddfeaca7436039daaaaf19721b4b96a8810a805e82f7 f5a4bd656c143899fb7f52d64ed81e6f6aeb37d477a0b6da50146ac7cf2187bf" ;;
    small) echo "sam2_hiera_small f6a7c74dee5b2e71cce3f0475b778f0f28fa3e6c3646c79027302123d2197f40 e07f799d2afe8640ef21f47096ad154d9289bb53041191499ebbea8933ef047b" ;;
    base_plus) echo "sam2_hiera_base_plus 53b79cec15f2078b3c7410f00f00950a09ef02007dccf238859fec156e42cc8d 666f00ce2664de31211a71068b6b74c3fc5aeee089ebeb2fc9c37834b9ce03b4" ;;
    large) echo "sam2_hiera_large cb252d7b59fdeb2567f7134ed9f23d712e4f24584628913bbcb0ea72ba72b617 2b5a3d40a017e61d2cb4fac7147ebf899d24b082753fb5049be3810d2318ca07" ;;
    *) echo "ERROR: unknown SAM 2 variant '$1' (tiny|small|base_plus|large|all)" >&2; exit 1 ;;
  esac
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest_dir="$script_dir/../apps/desktop-tauri/src-tauri/resources/models"
mkdir -p "$dest_dir"

fetch() {
  local url="$1" name="$2" want="$3" dest="$dest_dir/$2"
  if [ -f "$dest" ] && command -v sha256sum >/dev/null 2>&1 \
    && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$want" ]; then
    echo "$name already present and verified."
    return 0
  fi
  echo "Downloading $name ..."
  curl -sSL -o "$dest" "$url"
  if command -v sha256sum >/dev/null 2>&1; then
    local got
    got="$(sha256sum "$dest" | cut -d' ' -f1)"
    if [ "$got" != "$want" ]; then
      echo "ERROR: sha256 mismatch for $name (got $got, want $want)" >&2
      rm -f "$dest"
      exit 1
    fi
  fi
  echo "Fetched $dest"
}

fetch_variant() {
  local variant="$1" stem enc_sha dec_sha
  read -r stem enc_sha dec_sha <<<"$(spec_for "$variant")"
  fetch "$BASE/$stem.encoder.onnx" "sam2_$variant.encoder.onnx" "$enc_sha"
  fetch "$BASE/$stem.decoder.onnx" "sam2_$variant.decoder.onnx" "$dec_sha"
}

variants=("${@:-tiny}")
for v in "${variants[@]}"; do
  if [ "$v" = "all" ]; then
    for each in tiny small base_plus large; do fetch_variant "$each"; done
  else
    fetch_variant "$v"
  fi
done
