# Maintainer-only refresh for the vendored Windows x64 CPU ONNX Runtime.
# Builds, tests, packaging hooks, and CI must never invoke this script.
[CmdletBinding()]
param(
    [string]$DestinationRoot = (Join-Path $PSScriptRoot '..\third_party\onnxruntime')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Version = '1.24.2'
$Commit = '058787ceead760166e3c50a0a4cba8a833a6f53f'
$Url = "https://github.com/microsoft/onnxruntime/releases/download/v$Version/onnxruntime-win-x64-$Version.zip"
$ArchiveSha256 = '8e3e9c826375352e29cb2614fe44f3d7a4b0ff7b8028ad7a456af9d949a7e8b0'
$RuntimeSha256 = '114947d633e6844ce3c4b51ef6678f776628571d08a5763859c61642c8dcca9c'

function Assert-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) {
        throw "SHA-256 mismatch for '$Path' (got $actual, expected $Expected)"
    }
}

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [System.Runtime.InteropServices.OSPlatform]::Windows)) {
    throw 'This acquisition script supports Windows only.'
}

$DestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot)
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'hgripe-onnxruntime-' + [System.Guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $tempRoot "onnxruntime-win-x64-$Version.zip"
$extractRoot = Join-Path $tempRoot 'extract'

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null

    Write-Host "Downloading the official ONNX Runtime $Version Windows x64 archive..."
    Invoke-WebRequest -Uri $Url -OutFile $archivePath
    Assert-Sha256 -Path $archivePath -Expected $ArchiveSha256

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
    $packageRoot = Join-Path $extractRoot "onnxruntime-win-x64-$Version"
    $runtimeSource = Join-Path $packageRoot 'lib\onnxruntime.dll'
    $metadataNames = @(
        'LICENSE',
        'ThirdPartyNotices.txt',
        'VERSION_NUMBER',
        'GIT_COMMIT_ID'
    )

    if (-not (Test-Path -LiteralPath $runtimeSource -PathType Leaf)) {
        throw "Official archive is missing '$runtimeSource'."
    }
    Assert-Sha256 -Path $runtimeSource -Expected $RuntimeSha256

    foreach ($name in $metadataNames) {
        $source = Join-Path $packageRoot $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Official archive is missing '$name'."
        }
    }

    $actualVersion = (Get-Content -LiteralPath (
            Join-Path $packageRoot 'VERSION_NUMBER') -Raw).Trim()
    if ($actualVersion -ne $Version) {
        throw "VERSION_NUMBER is '$actualVersion', expected '$Version'."
    }

    $actualCommit = (Get-Content -LiteralPath (
            Join-Path $packageRoot 'GIT_COMMIT_ID') -Raw).Trim()
    if ($actualCommit -ne $Commit) {
        throw "GIT_COMMIT_ID is '$actualCommit', expected '$Commit'."
    }

    $runtimeDestinationDir = Join-Path $DestinationRoot 'win-x64\bin'
    New-Item -ItemType Directory -Force -Path $runtimeDestinationDir | Out-Null
    Copy-Item -LiteralPath $runtimeSource -Destination (
        Join-Path $runtimeDestinationDir 'onnxruntime.dll') -Force

    # The CPU payload has an exact DLL allowlist. Remove every stale provider or
    # dependency DLL from older snapshots so this directory cannot imply GPU
    # capability without the corresponding locked runtime flavor.
    Get-ChildItem -LiteralPath $runtimeDestinationDir -File -Filter '*.dll' |
        Where-Object { $_.Name -ne 'onnxruntime.dll' } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

    $runtimeDlls = @(Get-ChildItem -LiteralPath $runtimeDestinationDir -File -Filter '*.dll' |
            Select-Object -ExpandProperty Name)
    if ($runtimeDlls.Count -ne 1 -or $runtimeDlls[0] -ne 'onnxruntime.dll') {
        throw "CPU runtime DLL allowlist mismatch: $($runtimeDlls -join ', ')"
    }

    foreach ($name in $metadataNames) {
        Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination (
            Join-Path $DestinationRoot $name) -Force
    }

    Assert-Sha256 -Path (Join-Path $runtimeDestinationDir 'onnxruntime.dll') `
        -Expected $RuntimeSha256
    Write-Host "Vendored ONNX Runtime $Version into '$DestinationRoot'."
    Write-Host 'Only onnxruntime.dll and the locked upstream metadata were selected.'
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
