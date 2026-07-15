# Fetch the unofficial PCT-Net ONNX conversion used by the native
# onnx_harmonize engine. This artifact comes from the MIT-licensed conversion
# repository pccaza/harmonizer-onnx at commit
# 046a31654875432fe303d5342aa036782270c520. Our PCT-Net upstream review
# reference is rakutentech/PCT-Net-Image-Harmonization commit
# 1572176ed1a72217dad7395391615329b98d30c7 under MPL-2.0. The converter did
# not identify its exact upstream revision/checkpoint, so lineage is unverified.
#
# This is not an official Rakuten ONNX export, is not release-ready by default,
# and is not bundled unless a maintainer explicitly fetches it before packaging.
$ErrorActionPreference = 'Stop'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'fetch-color-harmonize.ps1 supports Windows only'
}

$ConversionCommit = '046a31654875432fe303d5342aa036782270c520'
$Url = "https://raw.githubusercontent.com/pccaza/harmonizer-onnx/$ConversionCommit/pct_net.onnx"
$WantBytes = 24819882
$WantSha256 = '5ac3c8f59ad3a58a55baae79f3886e06826e7acb932179aaed034b61d62f5997'
$DestDir = Join-Path $PSScriptRoot '..\apps\desktop-tauri\src-tauri\resources\models'
$Dest = Join-Path $DestDir 'color_harmonize.onnx'
$Download = "$Dest.download"

New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

if (Test-Path -LiteralPath $Dest) {
    $HaveBytes = (Get-Item -LiteralPath $Dest).Length
    $HaveSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Dest).Hash.ToLowerInvariant()
    if ($HaveBytes -eq $WantBytes -and $HaveSha256 -eq $WantSha256) {
        Write-Host 'color_harmonize.onnx already present and verified.'
        return
    }
}

try {
    Write-Host 'Downloading color_harmonize.onnx (unofficial PCT-Net ONNX conversion) ...'
    Invoke-WebRequest -Uri $Url -OutFile $Download

    $GotBytes = (Get-Item -LiteralPath $Download).Length
    if ($GotBytes -ne $WantBytes) {
        throw "byte-length mismatch for color_harmonize.onnx (got $GotBytes, want $WantBytes)"
    }

    $GotSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Download).Hash.ToLowerInvariant()
    if ($GotSha256 -ne $WantSha256) {
        throw "sha256 mismatch for color_harmonize.onnx (got $GotSha256, want $WantSha256)"
    }

    Move-Item -LiteralPath $Download -Destination $Dest -Force
    Write-Host "Fetched and verified $Dest"
} finally {
    if (Test-Path -LiteralPath $Download) {
        Remove-Item -LiteralPath $Download -Force
    }
}
