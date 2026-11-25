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

if ($env:PROCESSOR_ARCHITECTURE -ne 'ARM64') {
  throw "The bundled QEMU runtime must be prepared on a native Windows ARM64 host."
}
$MsysRoot = if ($env:MSYS2_LOCATION) { $env:MSYS2_LOCATION } else { 'C:\msys64' }
$RequiredRuntimeFiles = @(
  (Join-Path $MsysRoot 'clangarm64\bin\qemu-system-x86_64.exe'),
  (Join-Path $MsysRoot 'clangarm64\bin\qemu-system-i386.exe'),
  (Join-Path $MsysRoot 'clangarm64\bin\qemu-img.exe'),
  (Join-Path $MsysRoot 'usr\bin\objdump.exe')
)
$MissingRuntimeFiles = $RequiredRuntimeFiles | Where-Object { -not (Test-Path $_) }
if ($MissingRuntimeFiles) {
  throw "MSYS2 CLANGARM64 QEMU packages are missing. Install MSYS2 on Windows ARM64, then run: pacman -Syu; pacman -S --needed binutils mingw-w64-clang-aarch64-qemu mingw-w64-clang-aarch64-qemu-image-util"
}

Write-Host "Installing locked dependencies..." -ForegroundColor Yellow
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

Write-Host "Staging bundled QEMU and building the Windows ARM64 installer..." -ForegroundColor Yellow
npm run package:win:arm64
if ($LASTEXITCODE -ne 0) { throw "Windows ARM64 packaging failed with exit code $LASTEXITCODE." }

Write-Host "Build complete. Installer files are in: $ProjectRoot\release" -ForegroundColor Green
Start-Process explorer.exe -ArgumentList (Join-Path $ProjectRoot 'release')
