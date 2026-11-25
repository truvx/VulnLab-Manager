# Installation

## macOS — Apple Silicon

1. Download `VulnLab-Manager-0.4.0-arm64.dmg` from GitHub Releases.
2. Open the DMG and drag VulnLab Manager to Applications.
3. On first launch, use Control-click → Open if Gatekeeper blocks the unsigned build.
4. Install QEMU with Homebrew: `brew install qemu`.
5. Open VulnLab Manager and confirm the QEMU checks show Ready.

## Windows 11 — ARM64

1. Download `VulnLab-Manager-0.4.0-arm64.exe` from GitHub Releases.
2. Run the per-user installer. Administrator privileges are not required by default.
3. If Microsoft SmartScreen warns that the publisher is unknown, verify the release checksum and choose the Windows option to continue only if you trust the downloaded release.
4. Install a compatible Windows ARM64 QEMU build.
5. Add the folder containing `qemu-system-x86_64.exe`, `qemu-system-i386.exe`, and `qemu-img.exe` to PATH, then restart VulnLab Manager.
6. Confirm the QEMU checks show Ready.

## Unsigned builds

The default release pipeline does not sign the macOS app or Windows installer. This keeps the project buildable without maintainer signing secrets but may produce first-run security prompts. Do not disable platform security protections globally. Verify downloaded assets using `SHA256SUMS.txt`.

## Building from source

See the platform-specific steps in [BUILDING.md](BUILDING.md).
