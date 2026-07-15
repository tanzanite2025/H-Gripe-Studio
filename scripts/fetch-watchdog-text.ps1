# Fetch the PP-OCRv3 English text detector (Apache-2.0, about 2.4 MB) for
# Detail Watchdog's native onnx_defect engine. The model remains a local
# runtime asset; point HGRIPE_WATCHDOG_MODEL at another compatible weight when
# developing a hands/logo detector.
$ErrorActionPreference = 'Stop'

$Url = 'https://huggingface.co/deepghs/paddleocr/resolve/main/det/en_PP-OCRv3_det/model.onnx'
$Want = '69d10a2f151e0561e7e6c948ff0207a5fb84789fa6a4591d1d08138e3d82f1f9'
$DestDir = Join-Path $PSScriptRoot '..\apps\desktop-tauri\src-tauri\resources\models'
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
$Dest = Join-Path $DestDir 'watchdog_defect.onnx'
$Sidecar = "$Dest.labels.json"
$SidecarJson = '{"labels":{"0":"text"},"normalize":"imagenet"}'

function Write-LabelSidecar {
    $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Sidecar, $SidecarJson, $Utf8NoBom)
}

if (Test-Path -LiteralPath $Dest) {
    $Have = (Get-FileHash -Algorithm SHA256 -LiteralPath $Dest).Hash.ToLowerInvariant()
    if ($Have -eq $Want) {
        Write-LabelSidecar
        Write-Host 'watchdog_defect.onnx already present and verified.'
        return
    }
}

Write-Host 'Downloading watchdog_defect.onnx (PP-OCRv3 text detector) ...'
Invoke-WebRequest -Uri $Url -OutFile $Dest
$Got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Dest).Hash.ToLowerInvariant()
if ($Got -ne $Want) {
    Remove-Item -LiteralPath $Dest -Force
    throw "sha256 mismatch for watchdog_defect.onnx (got $Got, want $Want)"
}

Write-LabelSidecar
Write-Host "Fetched $Dest"
