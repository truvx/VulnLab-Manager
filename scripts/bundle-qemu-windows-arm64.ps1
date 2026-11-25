$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MsysRoot = if ($env:MSYS2_LOCATION) { $env:MSYS2_LOCATION } else { 'C:\msys64' }
$MingwBin = Join-Path $MsysRoot 'clangarm64\bin'
$MingwShare = Join-Path $MsysRoot 'clangarm64\share\qemu'
$MingwLicenses = Join-Path $MsysRoot 'clangarm64\share\licenses'
$Objdump = Join-Path $MsysRoot 'clangarm64\bin\llvm-objdump.exe'
$Out = Join-Path $ProjectRoot 'runtime\qemu'
$OutBin = Join-Path $Out 'bin'
$OutShare = Join-Path $Out 'share'
$ExpectedVersion = '11.1.3'

Write-Host "Preparing bundled QEMU $ExpectedVersion for Windows ARM64..." -ForegroundColor Cyan
if ($env:PROCESSOR_ARCHITECTURE -ne 'ARM64') {
  throw "QEMU runtime must be packaged on a native Windows ARM64 runner."
}
foreach ($required in @($MingwBin, $MingwShare, $Objdump)) {
  if (-not (Test-Path $required)) { throw "Required MSYS2 CLANGARM64 path is missing: $required" }
}

$QemuExe = Join-Path $MingwBin 'qemu-system-x86_64.exe'
$QemuVersionText = (& $QemuExe --version 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $QemuVersionText -notmatch [regex]::Escape($ExpectedVersion)) {
  throw "Expected native QEMU $ExpectedVersion. Output: $QemuVersionText"
}

Remove-Item -Recurse -Force $Out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutBin, $OutShare | Out-Null
foreach ($tool in @('qemu-system-x86_64.exe', 'qemu-system-i386.exe', 'qemu-img.exe')) {
  $source = Join-Path $MingwBin $tool
  if (-not (Test-Path $source)) { throw "MSYS2 QEMU package is missing $tool." }
  Copy-Item $source (Join-Path $OutBin $tool) -Force
}
Copy-Item $MingwShare (Join-Path $OutShare 'qemu') -Recurse -Force
# QEMU's lib/qemu/plugins tree contains optional instrumentation and test plugins.
# The manager does not load plugins, so keep them out of the installer rather than
# treating optional examples (e.g. plugins/contrib/libbbv.dll) as runtime dependencies.
if (Test-Path $MingwLicenses) {
  Copy-Item $MingwLicenses (Join-Path $Out 'licenses') -Recurse -Force
}

# Collect the transitive PE/DLL dependency closure so the packaged executables are
# self-contained. System DLLs and Windows API-set forwarders remain OS-provided.
$SystemDir = [Environment]::SystemDirectory
$Queue = [System.Collections.Generic.Queue[string]]::new()
$Seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$Copied = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

function Get-ImportedDlls([string]$File) {
  $lines = & $Objdump -p $File 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect PE imports for $File" }
  foreach ($line in $lines) {
    if ($line -match 'DLL Name:\s*(.+)$') { $Matches[1].Trim() }
  }
}

function Resolve-RuntimeDll([string]$Name) {
  $candidate = Join-Path $MingwBin $Name
  if (Test-Path $candidate) { return $candidate }
  if (Test-Path (Join-Path $SystemDir $Name)) { return $null }
  $lower = $Name.ToLowerInvariant()
  if ($lower.StartsWith('api-ms-win-') -or $lower.StartsWith('ext-ms-win-')) { return $null }
  throw "Unresolved non-system QEMU DLL dependency: $Name"
}

foreach ($exe in @('qemu-system-x86_64.exe', 'qemu-system-i386.exe', 'qemu-img.exe')) {
  $Queue.Enqueue((Join-Path $OutBin $exe))
}
while ($Queue.Count -gt 0) {
  $file = $Queue.Dequeue()
  if (-not $Seen.Add($file)) { continue }
  foreach ($dll in (Get-ImportedDlls $file)) {
    $source = Resolve-RuntimeDll $dll
    if (-not $source) { continue }
    $destination = Join-Path $OutBin $dll
    if ($Copied.Add($dll)) {
      Copy-Item $source $destination -Force
      $Queue.Enqueue($destination)
    }
  }
}

$Manifest = @{
  qemuVersion = $ExpectedVersion
  host = 'Windows'
  architecture = 'arm64'
  source = 'MSYS2 CLANGARM64 QEMU package'
  qemuPackage = 'mingw-w64-clang-aarch64-qemu 11.1.3-2'
  sourceUrl = 'https://packages.msys2.org/packages/mingw-w64-clang-aarch64-qemu'
  imageUtilPackage = 'mingw-w64-clang-aarch64-qemu-image-util 11.1.3-2'
} | ConvertTo-Json -Depth 4
Set-Content -Path (Join-Path $Out 'manifest.json') -Value $Manifest -Encoding utf8
Copy-Item (Join-Path $ProjectRoot 'THIRD_PARTY_NOTICES.md') (Join-Path $Out 'THIRD_PARTY_NOTICES.md') -Force

foreach ($tool in @('qemu-system-x86_64.exe', 'qemu-system-i386.exe', 'qemu-img.exe')) {
  $path = Join-Path $OutBin $tool
  $result = (& $path --version 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $result -notmatch [regex]::Escape($ExpectedVersion)) {
    throw "Bundled runtime smoke test failed for $tool. Output: $result"
  }
}
Write-Host "Bundled QEMU $ExpectedVersion for Windows ARM64." -ForegroundColor Green
$size = (Get-ChildItem $Out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("Runtime size: {0:N1} MiB" -f ($size / 1MB))
