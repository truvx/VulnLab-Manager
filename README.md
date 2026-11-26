<div align="center">
  <img src="assets/app.png" alt="VulnLab Manager icon" width="112" />
  <h1>VulnLab Manager</h1>
  <p><strong>A local-first vulnerable machine library and QEMU target manager.</strong></p>
  <p>
    <img alt="Version" src="https://img.shields.io/badge/version-0.5.0-6477f5" />
    <a href="https://github.com/truvx/VulnLab-Manager/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/truvx/VulnLab-Manager/actions/workflows/ci.yml/badge.svg" /></a>
    <img alt="macOS" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?logo=apple" />
    <img alt="Windows" src="https://img.shields.io/badge/Windows-ARM64-0078D4?logo=windows" />
    <img alt="Electron" src="https://img.shields.io/badge/Electron-45-47848F?logo=electron" />
    <img alt="License" src="https://img.shields.io/badge/license-not%20set-lightgrey" />
  </p>
</div>

VulnLab Manager organizes local virtual machine images and launches **vulnerable target machines** with QEMU. It is source-independent: import compatible images from VulnHub, Metasploitable, OWASP training projects, custom labs, or other providers when you have a local copy and the right to use it.

The manager deliberately **does not manage attacker VMs**. Start Kali, Parrot, Ubuntu, or another attacker environment yourself in the hypervisor of your choice. VulnLab Manager starts and stops only its selected QEMU target.

## Downloads

Installers are published on the [Releases](https://github.com/truvx/VulnLab-Manager/releases) page after a release build completes.

| Host platform | Installer | Architecture |
|---|---|---|
| macOS | `.dmg` (plus `.zip` archive) | Apple Silicon / ARM64 |
| Windows | `.exe` NSIS installer | Windows ARM64 |

Release assets include a `SHA256SUMS.txt` file. Compare the checksum before installing. These builds are currently unsigned: macOS may show a Gatekeeper warning, and Windows may show a SmartScreen publisher warning. A signed/notarized release requires the maintainer's Apple Developer and Windows code-signing credentials.

> The Windows ARM64 release workflow uses GitHub-hosted ARM64 runners. GitHub currently makes standard Windows ARM64 and macOS ARM64 hosted runners available for public repositories; private repositories need eligible larger or self-hosted runners. See [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Features

- **Local machine library** — import, inspect, organize, start, and stop target images locally.
- **Source-independent importing** — no hard dependency on VulnHub or another training provider.
- **Archive and disk inspection** — ZIP, OVA, TAR, OVF/VBox folders, and common virtual disk formats.
- **Bundled QEMU engine** — pinned QEMU 11.1.3 host runtimes for macOS Apple Silicon and Windows ARM64; no separate QEMU installation is required for release installers.
- **QEMU target execution** — x86_64 and i386 guest emulation using TCG software translation.
- **Disposable write overlays** — QEMU writes to a per-run QCOW2 overlay so the imported base image remains unchanged.
- **Manual attacker workflow** — attacker VMs are intentionally outside the application's lifecycle control.
- **Per-machine networking** — QEMU user-mode NAT with editable TCP/UDP host forwards, plus bridged TAP mode when a host TAP device is installed and connected to the attacker VM's isolated Layer-2 network.
- **Generic Linux network helper** — included for manual use inside a selected Linux attacker VM; it is never automatically copied or executed.
- **Cross-platform desktop packaging** — macOS Apple Silicon and Windows ARM64 installers.

## Compatibility and requirements

| Component | Supported in this release |
|---|---|
| Host OS | macOS 13+ (Apple Silicon); Windows 11 ARM64 |
| Host virtualization | Bundled QEMU 11.1.3; attacker VM hypervisor is user-managed |
| QEMU tools | Bundled `qemu-system-x86_64`, `qemu-system-i386`, and `qemu-img` |
| Concurrent targets | One QEMU target at a time |
| Guest profile | x86_64 or i386, BIOS, IDE disk, E1000 network adapter |

The launch profile is intentionally conservative. Images requiring UEFI, VirtIO/SCSI controllers, other NIC models, GPU passthrough, or a different CPU model may need future per-machine hardware profiles. A file format being importable does not guarantee every guest will boot under the current default hardware profile.

### Bundled QEMU engine

The v0.5.0 packaging pipeline is configured to include a host-native QEMU 11.1.3 runtime, firmware/data files, and the runtime libraries needed by the bundled tools. Native release builds are still being validated.

- **macOS Apple Silicon:** native ARM64 QEMU runtime staged from the Homebrew QEMU formula.
- **Windows 11 ARM64:** native ARM64 QEMU runtime staged from the MSYS2 CLANGARM64 packages.

When running a validated v0.5.0 installer, the application prefers its bundled runtime. It falls back to a compatible QEMU installation on `PATH` for development or advanced troubleshooting. It displays the detected QEMU version and whether the bundled runtime is active.

QEMU uses TCG software emulation to run x86/i386 guests on ARM64 hosts. This provides compatibility without a separate QEMU setup, but emulation can be slower than running the same guest on an x86_64 host. The release does not promise that every image will boot: guest firmware, disk controller, CPU model, and network-device requirements still matter.

## Import formats

- **Archives:** `.zip`, `.ova`, `.tar`, `.tar.gz`, `.tgz`
- **VM descriptors/folders:** `.ovf`, `.vbox`, and folders containing these descriptors and their referenced disk files
- **Virtual disks:** `.vmdk`, `.qcow`, `.qcow2`, `.vdi`, `.vhd`, `.vhdx`, `.img`, `.raw`, `.vpc`

For OVF/VirtualBox descriptors, select the descriptor or containing folder. When an archive contains multiple candidate disks, the importer uses metadata where possible and refuses to guess if it cannot identify the boot disk. The app does not download machines directly from hosted platforms or bypass provider access restrictions.

## First run

1. Install VulnLab Manager using the installer for your host architecture; QEMU is included.
2. Open the app and import a local VM package, VM folder, or disk image.
3. Select a machine, choose guest architecture and memory, then select **Start target**.
4. Start your preferred attacker VM manually.
5. Choose the target's network mode in Machine configuration. NAT is the cross-platform default; use the displayed host IPv4 and forwarded host ports from Kali/Parrot. Bridged TAP provides Layer-2 access when a host TAP driver/interface is installed and connected to the same isolated segment as your attacker VM.
6. Use **Stop target** when finished.

See [Installation](docs/INSTALLATION.md), [Bundled QEMU runtime](docs/QEMU_RUNTIME.md), [Networking](docs/NETWORKING.md), and [Architecture](docs/ARCHITECTURE.md) for details.

## Build from source

Requirements: Node.js 22+ (Node 24 is used in CI) and npm. Platform-native QEMU staging tools are required only when making packaged installers.

```bash
npm ci
npm run dev
```

### Build locally

**macOS Apple Silicon**

Requirements: Homebrew and Python 3. The build script installs the pinned Homebrew QEMU formula, stages QEMU 11.1.3 plus its dylib dependencies and firmware, smoke-tests the tools, then builds the DMG/ZIP.

```bash
npm ci
npm run package:mac:arm64
```

Or double-click `Build-Mac-App.command`.

**Windows 11 ARM64**

Requirements: a native Windows ARM64 host and MSYS2 CLANGARM64 with `mingw-w64-clang-aarch64-llvm-tools`, `mingw-w64-clang-aarch64-qemu`, and `mingw-w64-clang-aarch64-qemu-image-util`. The release workflow prepares these packages automatically; a local package build requires the same toolchain. The script stages the required ARM64 executables, DLL dependencies, and firmware before building the EXE.

```powershell
npm ci
npm run package:win:arm64
```

Or run `Build-Windows-ARM64.ps1` in PowerShell.

Build artifacts are written to `release/`.

## Automated releases

- Pull requests and pushes to `main` run the TypeScript/renderer validation workflow.
- Run **Build installers and publish GitHub Release** from the Actions tab and enter the release version (for example `0.5.0`). The workflow builds both native runtimes, packages them into the installers, attaches the corresponding QEMU source archives, and publishes the GitHub Release.

The release pipeline uses native ARM64 GitHub-hosted runners on macOS and Windows. See `.github/workflows/release.yml`.

## Data locations

- Machine library: `~/VulnLab/machines`
- Machine index and application state: Electron's per-user application data directory
- Each start creates a new write overlay beneath that machine's `snapshots/` directory

The app preserves the existing Electron application identifier so an in-place update can retain the current user-data location. It also checks for the earlier `~/VulnHubLab` machine folder during migration.

## Security notes

Virtual machine images are untrusted code. Inspect their origin, keep targets on an isolated network, and avoid bridging intentionally vulnerable guests to trusted home, work, or public networks. The application does not elevate privileges to configure host networking. The included helper is for a Linux guest and requires the user to copy and run it manually.

Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Project status

This is an actively developed desktop utility. The bundled QEMU runtime is pinned for reproducible builds. Compatibility still varies by guest firmware, storage controller, NIC, and target-image requirements. The installers should be treated as unsigned until signing/notarization is configured. See [CHANGELOG.md](CHANGELOG.md) and [PROJECT_STATUS.md](PROJECT_STATUS.md).

## License

No license has been selected for this repository yet. Until a license is added, the source is published for review and personal evaluation; no additional redistribution or modification permissions are granted.
