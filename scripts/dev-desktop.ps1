param(
  [int]$Port = 5173,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$uiDir = Join-Path $repoRoot "apps\desktop-tauri\studio-ui"
$nodeModules = Join-Path $uiDir "node_modules"
$logDir = Join-Path $repoRoot "temp"
$viteOut = Join-Path $logDir "dev-vite.out.log"
$viteErr = Join-Path $logDir "dev-vite.err.log"

function Test-PortOpen {
  param([string]$HostName, [int]$PortNumber)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($HostName, $PortNumber)
    if (-not $task.Wait(500)) {
      return $false
    }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  try {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
      Stop-ProcessTree -ProcessId $child.ProcessId
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  } catch {
    # Best-effort cleanup only.
  }
}

Set-Location $repoRoot
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not $SkipInstall -and -not (Test-Path $nodeModules)) {
  Write-Host "[dev] studio-ui node_modules not found; running npm ci..."
  npm --prefix $uiDir ci
}

$startedVite = $false
$viteProcess = $null

if (Test-PortOpen -HostName "127.0.0.1" -PortNumber $Port) {
  Write-Host "[dev] Vite already appears to be listening on port $Port; reusing it."
} else {
  Write-Host "[dev] starting Vite on http://localhost:$Port ..."
  if (Test-Path $viteOut) { Remove-Item -LiteralPath $viteOut -Force }
  if (Test-Path $viteErr) { Remove-Item -LiteralPath $viteErr -Force }
  $viteProcess = Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList @("--prefix", $uiDir, "run", "dev", "--", "--host", "127.0.0.1") `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $viteOut `
    -RedirectStandardError $viteErr `
    -WindowStyle Hidden `
    -PassThru
  $startedVite = $true

  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    if ($viteProcess.HasExited) {
      Write-Host "[dev] Vite exited early. stdout:"
      if (Test-Path $viteOut) { Get-Content $viteOut -Tail 80 }
      Write-Host "[dev] Vite stderr:"
      if (Test-Path $viteErr) { Get-Content $viteErr -Tail 80 }
      throw "Vite dev server exited before port $Port became available."
    }
    if (Test-PortOpen -HostName "127.0.0.1" -PortNumber $Port) {
      break
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not (Test-PortOpen -HostName "127.0.0.1" -PortNumber $Port)) {
    Write-Host "[dev] Vite did not become ready. stdout:"
    if (Test-Path $viteOut) { Get-Content $viteOut -Tail 80 }
    Write-Host "[dev] Vite stderr:"
    if (Test-Path $viteErr) { Get-Content $viteErr -Tail 80 }
    throw "Timed out waiting for Vite on port $Port."
  }
}

try {
  Write-Host "[dev] starting H-Gripe Desktop..."
  cargo run -p hgripe-desktop
  exit $LASTEXITCODE
} finally {
  if ($startedVite -and $viteProcess -and -not $viteProcess.HasExited) {
    Write-Host "[dev] stopping Vite..."
    Stop-ProcessTree -ProcessId $viteProcess.Id
  }
}
