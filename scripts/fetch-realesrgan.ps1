# Manually fetch the Real-ESRGAN general x4v3 ONNX artifact used by the native
# `realesrgan` engine. The fixed artifact is a third-party re-host whose model
# card points to xinntao/Real-ESRGAN; it does not document a reproducible export
# procedure or exact source checkpoint. It is for local Windows verification
# only and must not be bundled in a release without the review described in
# resources/models/REALESRGAN_NOTICE.md. This is not a build or packaging hook.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [System.Runtime.InteropServices.OSPlatform]::Windows)) {
    throw 'fetch-realesrgan.ps1 supports Windows only.'
}

$Revision = '488e5dda07333179f229a6205d92135eea4c25e9'
$SourceName = 'realesr-general-x4v3.onnx'
$Url = "https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/$Revision/$SourceName"
$WantBytes = 4871181
$WantSha256 = '09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4'
$DestDir = Join-Path $PSScriptRoot '..\apps\desktop-tauri\src-tauri\resources\models'
$Dest = Join-Path $DestDir 'realesrgan_x4v3.onnx'
$Download = "$Dest.download"

New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

if (Test-Path -LiteralPath $Dest -PathType Leaf) {
    $HaveBytes = (Get-Item -LiteralPath $Dest).Length
    $HaveSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Dest).Hash.ToLowerInvariant()
    if ($HaveBytes -eq $WantBytes -and $HaveSha256 -eq $WantSha256) {
        Write-Host 'realesrgan_x4v3.onnx already present and verified.'
        return
    }
}

try {
    Write-Host 'Downloading realesrgan_x4v3.onnx (third-party Real-ESRGAN ONNX re-host) ...'
    Invoke-WebRequest -Uri $Url -OutFile $Download

    $GotBytes = (Get-Item -LiteralPath $Download).Length
    if ($GotBytes -ne $WantBytes) {
        throw "byte-length mismatch for realesrgan_x4v3.onnx (got $GotBytes, want $WantBytes)"
    }

    $GotSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Download).Hash.ToLowerInvariant()
    if ($GotSha256 -ne $WantSha256) {
        throw "sha256 mismatch for realesrgan_x4v3.onnx (got $GotSha256, want $WantSha256)"
    }

    Move-Item -LiteralPath $Download -Destination $Dest -Force
    Write-Host "Fetched and verified $Dest"
} finally {
    if (Test-Path -LiteralPath $Download) {
        Remove-Item -LiteralPath $Download -Force
    }
}
