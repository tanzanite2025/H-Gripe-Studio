# Fetch the SAM 2 interactive point-prompt weights (Apache-2.0) into the Tauri
# resources dir. Usage: fetch-sam2.ps1 [tiny|small|base_plus|large|all ...]
# (default: tiny). These are a *downloadable big tier* (tiny encoder ~134 MB up
# to large ~889 MB; decoder ~20 MB each): not bundled in the release by
# default. Run this to bundle them for a release, or point
# HGRIPE_SAM2_ENCODER / HGRIPE_SAM2_DECODER at local copies for dev. Fetching
# more than one variant lets the Subject Mask node's `sam2_variant` selector
# compare them side by side. The weights are not committed to git.
param([string[]]$Variants = @('tiny'))
$ErrorActionPreference = 'Stop'

$Base = 'https://huggingface.co/vietanhdev/segment-anything-2-onnx-models/resolve/main'
$destDir = Join-Path $PSScriptRoot '..\apps\desktop-tauri\src-tauri\resources\models'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null

$Specs = @{
    tiny      = @{ Stem = 'sam2_hiera_tiny';      Encoder = '4cc015ee18520e93f8c7ddfeaca7436039daaaaf19721b4b96a8810a805e82f7'; Decoder = 'f5a4bd656c143899fb7f52d64ed81e6f6aeb37d477a0b6da50146ac7cf2187bf' }
    small     = @{ Stem = 'sam2_hiera_small';     Encoder = 'f6a7c74dee5b2e71cce3f0475b778f0f28fa3e6c3646c79027302123d2197f40'; Decoder = 'e07f799d2afe8640ef21f47096ad154d9289bb53041191499ebbea8933ef047b' }
    base_plus = @{ Stem = 'sam2_hiera_base_plus'; Encoder = '53b79cec15f2078b3c7410f00f00950a09ef02007dccf238859fec156e42cc8d'; Decoder = '666f00ce2664de31211a71068b6b74c3fc5aeee089ebeb2fc9c37834b9ce03b4' }
    large     = @{ Stem = 'sam2_hiera_large';     Encoder = 'cb252d7b59fdeb2567f7134ed9f23d712e4f24584628913bbcb0ea72ba72b617'; Decoder = '2b5a3d40a017e61d2cb4fac7147ebf899d24b082753fb5049be3810d2318ca07' }
}

function Fetch-Weight($Url, $Name, $Want) {
    $dest = Join-Path $destDir $Name
    if (Test-Path $dest) {
        $have = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLower()
        if ($have -eq $Want) {
            Write-Host "$Name already present and verified."
            return
        }
    }
    Write-Host "Downloading $Name ..."
    Invoke-WebRequest -Uri $Url -OutFile $dest
    $got = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLower()
    if ($got -ne $Want) {
        Remove-Item $dest -Force
        throw "sha256 mismatch for $Name (got $got, want $Want)"
    }
    Write-Host "Fetched $dest"
}

function Fetch-Variant($Variant) {
    if (-not $Specs.ContainsKey($Variant)) {
        throw "unknown SAM 2 variant '$Variant' (tiny|small|base_plus|large|all)"
    }
    $spec = $Specs[$Variant]
    Fetch-Weight "$Base/$($spec.Stem).encoder.onnx" "sam2_$Variant.encoder.onnx" $spec.Encoder
    Fetch-Weight "$Base/$($spec.Stem).decoder.onnx" "sam2_$Variant.decoder.onnx" $spec.Decoder
}

foreach ($v in $Variants) {
    if ($v -eq 'all') {
        foreach ($each in 'tiny', 'small', 'base_plus', 'large') { Fetch-Variant $each }
    } else {
        Fetch-Variant $v
    }
}
