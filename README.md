<div align="center">
  <img src="assets/app.png" alt="VulnLab Manager icon" width="112" />
  <h1>VulnLab Manager</h1>
  <p><strong>A local-first vulnerable machine library and QEMU target manager.</strong></p>
  <p>
    <img alt="Version" src="https://img.shields.io/badge/version-0.4.0-6477f5" />
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
- **QEMU target execution** — x86_64 and i386 guest emulation using TCG.
- **Disposable write overlays** — QEMU writes to a per-run QCOW2 overlay so the imported base image remains unchanged.
- **Manual attacker workflow** — attacker VMs are intentionally outside the application's lifecycle control.
- **Isolated UDP networking option** — a QEMU datagram endpoint can be paired with a compatible hypervisor UDP tunnel.
- **Generic Linux network helper** — included for manual use inside a selected Linux attacker VM; it is never automatically copied or executed.
- **Cross-platform desktop packaging** — macOS Apple Silicon and Windows ARM64 installers.

## Compatibility and requirements

| Component | Supported in this release |
|---|---|
| Host OS | macOS 13+ (Apple Silicon); Windows 11 ARM64 |
| Host virtualization | QEMU is required; attacker VM hypervisor is user-managed |
| QEMU tools | `qemu-system-x86_64`, `qemu-system-i386`, `qemu-img` |
| Concurrent targets | One QEMU target at a time |
| Guest profile | x86_64 or i386, BIOS, IDE disk, E1000 network adapter |

The launch profile is intentionally conservative. Images requiring UEFI, VirtIO/SCSI controllers, other NIC models, GPU passthrough, or a different CPU model may need future per-machine hardware profiles. A file format being importable does not guarantee every guest will boot under the current default hardware profile.

### QEMU installation

Install a QEMU distribution compatible with your host architecture and add its executable directory to `PATH`.

- **macOS Apple Silicon:** `brew install qemu`
- **Windows ARM64:** install a Windows ARM64 QEMU build and ensure the directory containing `qemu-system-x86_64.exe`, `qemu-system-i386.exe`, and `qemu-img.exe` is in your user or system `PATH`.

The app checks for these tools at startup. QEMU is not bundled in the installer.

## Import formats

- **Archives:** `.zip`, `.ova`, `.tar`, `.tar.gz`, `.tgz`
- **VM descriptors/folders:** `.ovf`, `.vbox`, and folders containing these descriptors and their referenced disk files
- **Virtual disks:** `.vmdk`, `.qcow`, `.qcow2`, `.vdi`, `.vhd`, `.vhdx`, `.img`, `.raw`, `.vpc`

For OVF/VirtualBox descriptors, select the descriptor or containing folder. When an archive contains multiple candidate disks, the importer uses metadata where possible and refuses to guess if it cannot identify the boot disk. The app does not download machines directly from hosted platforms or bypass provider access restrictions.

## First run

1. Install QEMU and verify its executables are on `PATH`.
2. Install VulnLab Manager using the installer for your host architecture.
3. Open the app and import a local VM package, VM folder, or disk image.
4. Select a machine, choose guest architecture and memory, then select **Start target**.
5. Start your preferred attacker VM manually.
6. Optionally configure an isolated UDP tunnel as described in [Network setup](docs/NETWORKING.md). Keep the attacker VM's normal internet adapter separate from the lab adapter.
7. Use **Stop target** when finished.

See [Installation](docs/INSTALLATION.md), [Networking](docs/NETWORKING.md), and [Architecture](docs/ARCHITECTURE.md) for details.

## Build from source

Requirements: Node.js 22+ (Node 24 is used in CI), npm, and QEMU for running targets.

```bash
npm ci
npm run dev
```

### Build locally

**macOS Apple Silicon**

```bash
npm ci
npm run package:mac:arm64
```

Or double-click `Build-Mac-App.command`.

**Windows ARM64**

```powershell
npm ci
npm run package:win:arm64
```

Or right-click `Build-Windows-ARM64.ps1` and run it with PowerShell (or execute it from a PowerShell terminal).

Build artifacts are written to `release/`.

## Automated releases

- Pull requests and pushes to `main` run the TypeScript/renderer validation workflow.
- Push a tag such as `v0.4.0` to build the macOS ARM64 DMG/ZIP and Windows ARM64 EXE, then attach them to a GitHub Release.
- Alternatively, run **Build installers and publish release** from the Actions tab and supply a release tag.

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

This is an actively developed desktop utility. The source build and CI pipeline are provided, but compatibility still varies by guest firmware, storage controller, NIC, and host QEMU build. The installers should be treated as unsigned until signing/notarization is configured. See [CHANGELOG.md](CHANGELOG.md) and [PROJECT_STATUS.md](PROJECT_STATUS.md).

## License

No license has been selected for this repository yet. Until a license is added, the source is published for review and personal evaluation; no additional redistribution or modification permissions are granted.
