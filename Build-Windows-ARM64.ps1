$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

Write-Host "VulnLab Manager — Windows ARM64 build" -ForegroundColor Cyan

$Node = Get-Command node -ErrorAction SilentlyContinue
$Npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $Node -or -not $Npm) {
  throw "Node.js 22+ and npm are required. Install Node.js from https://nodejs.org/ and reopen PowerShell."
}
$Major = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($Major -lt 22) { throw "Node.js 22 or newer is required. Found $(& node --version)." }

Write-Host "Installing locked dependencies..." -ForegroundColor Yellow
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

Write-Host "Building the Windows ARM64 installer..." -ForegroundColor Yellow
npm run package:win:arm64
if ($LASTEXITCODE -ne 0) { throw "Windows ARM64 packaging failed with exit code $LASTEXITCODE." }

Write-Host "Build complete. Installer files are in: $ProjectRoot\release" -ForegroundColor Green
Start-Process explorer.exe -ArgumentList (Join-Path $ProjectRoot 'release')
