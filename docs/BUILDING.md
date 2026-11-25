# Building from source

## General toolchain

- Node.js 22 or newer (CI uses Node 24)
- npm
- Native packaging host for the target: Apple Silicon macOS or Windows 11 ARM64

The normal development build (`npm run build`) does not require QEMU. The application can use a locally installed QEMU during development, but release installers stage a private QEMU runtime.

## QEMU version

Both platform release runtimes are pinned to QEMU **11.1.3**:

- macOS Apple Silicon: Homebrew `qemu` formula and its installed shared-library dependencies.
- Windows ARM64: MSYS2 CLANGARM64 packages `mingw-w64-clang-aarch64-qemu 11.1.3-2` and `mingw-w64-clang-aarch64-qemu-image-util 11.1.3-2`.

The Windows runtime uses native ARM64 binaries, not x64 binaries running under Windows emulation. MSYS2 documents CLANGARM64 as its AArch64 environment; QEMU documents that Windows ARM64 builds should use CLANGARM64. See [MSYS2 ARM64 support](https://www.msys2.org/docs/arm64/) and [QEMU build environment](https://www.qemu.org/docs/master/devel/build-environment.html).

## macOS Apple Silicon

Requirements: Homebrew and Python 3.

```bash
npm ci
npm run package:mac:arm64
```

The runtime staging script installs Homebrew QEMU, verifies version 11.1.3, copies the QEMU executables, firmware/data, loadable modules, shared dylibs, and available license files into `runtime/qemu`, then smoke-tests all three tools. The output contains a DMG installer and ZIP archive under `release/`.

You can also run `Build-Mac-App.command`.

## Windows 11 ARM64

Requirements: a native Windows ARM64 host and MSYS2 CLANGARM64 with these packages:

- `binutils`
- `mingw-w64-clang-aarch64-qemu`
- `mingw-w64-clang-aarch64-qemu-image-util`

```powershell
npm ci
npm run package:win:arm64
```

The PowerShell staging script copies the QEMU system emulators, `qemu-img`, firmware/data, modules and the transitive runtime DLL dependencies into `runtime/qemu`. It checks the architecture and QEMU version and smoke-tests all three bundled tools before packaging. The output is an NSIS `.exe` installer under `release/`.

You can also run `Build-Windows-ARM64.ps1` from PowerShell.

## CI and releases

`.github/workflows/ci.yml` runs source validation. `.github/workflows/release.yml`:

1. Builds the macOS runtime and installer on an Apple Silicon runner.
2. Installs the native MSYS2 CLANGARM64 QEMU packages and builds the Windows ARM64 runtime and installer on a Windows ARM64 runner.
3. Downloads the corresponding QEMU source archives, generates SHA-256 checksums, and publishes the installers, source archives, and notices to a GitHub Release.

Run the release workflow manually from Actions and supply a version such as `0.5.0`. No manual tag operation is needed.

## Signing and notarization

Signing is intentionally not configured by default. A maintainer can add Apple Developer ID signing/notarization credentials and a Windows code-signing certificate using repository secrets, then configure electron-builder's signing options. Never commit certificates, private keys, or signing passwords.