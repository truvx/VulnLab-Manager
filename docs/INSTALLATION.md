# Installation

VulnLab Manager v0.5.0 installers include a platform-native QEMU 11.1.3 runtime, its required shared libraries, and QEMU firmware/data files. A separate QEMU installation is not required for the published installers.

## macOS — Apple Silicon

1. Download `VulnLab-Manager-0.5.0-arm64.dmg` from [GitHub Releases](https://github.com/truvx/VulnLab-Manager/releases).
2. Open the DMG and drag VulnLab Manager to Applications.
3. On first launch, use Control-click → Open if Gatekeeper blocks the unsigned build.
4. Open VulnLab Manager. The system checks should show the bundled QEMU tools as Ready.

## Windows 11 — ARM64

1. Download `VulnLab-Manager-0.5.0-arm64.exe` from [GitHub Releases](https://github.com/truvx/VulnLab-Manager/releases).
2. Run the per-user installer. Administrator privileges are not required by default.
3. If Microsoft SmartScreen warns that the publisher is unknown, verify the release checksum and continue only if you trust the release.
4. Open VulnLab Manager. The system checks should show the bundled QEMU tools as Ready.

## QEMU runtime behavior

- The application prefers its private QEMU runtime inside the installation.
- A compatible QEMU installation on `PATH` can be used as a fallback for development or advanced troubleshooting.
- The app displays the detected QEMU version and whether it is using the bundled runtime.
- x86 and x86_64 guests run through QEMU TCG software emulation on ARM64 hosts. This avoids a separate QEMU setup but is not the same performance as native x86 virtualization.

## Compatibility

The bundled runtime includes BIOS and firmware/data files, but the current default guest profile remains BIOS, IDE disk, and E1000 networking. A VM image that requires UEFI, VirtIO/SCSI, a special CPU model, or another NIC may need a future per-machine hardware profile. Importing a disk format does not guarantee that every guest image will boot.

## Unsigned builds

The default release pipeline does not sign the macOS app or Windows installer. This may produce first-run security prompts. Do not disable platform security protections globally. Verify downloaded assets using `SHA256SUMS.txt`.

## Building from source

See the platform-specific steps in [BUILDING.md](BUILDING.md).