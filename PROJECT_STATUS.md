# Project Status — 0.6.0 development

## Implemented in source

- General-purpose local machine library and QEMU target lifecycle.
- ZIP/OVA/TAR, OVF/VBox folder, and direct virtual disk import paths.
- Safe archive path checks and rejection of archive symlinks.
- Per-run QCOW2 write overlays to protect imported base disks.
- Native macOS Apple Silicon and Windows ARM64 desktop packaging.
- Bundled QEMU 11.1.3 staging scripts for both host platforms.
- Bundled QEMU executable, firmware/data, module, and runtime-library discovery in the Electron main process.
- Runtime version detection and bundled-vs-system QEMU indication in the UI.
- Native MSYS2 CLANGARM64 QEMU package setup in the Windows ARM64 release workflow.
- Release workflow source archive attachments for QEMU and the MSYS2 Windows package recipe.
- Per-machine QEMU user-mode NAT with configurable TCP/UDP host-forward rules.
- Per-machine bridged network backend: socket_vmnet on macOS and TAP-Windows on Windows ARM64.
- Stable QEMU MAC addresses, NAT DHCP address display, best-effort bridged ARP discovery, and host IPv4 discovery.
- QEMU filter-dump NIC telemetry showing receive/transmit packet and byte counters, last activity, and observed peer IPs.
- Compact side-by-side import and Activity panels.
- Generic optional Linux network helper for manual guest-side use.
- Attacker VMs remain fully manual; the app starts/stops only its own QEMU target.

## Release validation still required

- The QEMU bundling scripts are committed but have not yet completed their native macOS/Windows ARM64 release workflow validation.
- The macOS packaging runner must successfully stage all Homebrew dylibs, then smoke-test QEMU system emulators and qemu-img.
- The Windows ARM64 runner must stage the CLANGARM64 executable/DLL closure, then smoke-test QEMU system emulators and qemu-img.
- Both installers must be tested after packaging to confirm the runtime is actually found under Electron's resources directory.
- Compatibility remains image-specific. The current default guest profile is BIOS/IDE/E1000 and will not boot every imported machine.
- One QEMU target at a time.
- Attacker VMs are never started, stopped, or reconfigured by this application.
- NAT provides attacker access only to explicitly forwarded services; it is not Layer-2 adjacency and cannot expose unforwarded ports to scans.
- Bridged TAP requires a host TAP driver/device and user-managed Layer-2 bridging to the attacker's isolated network. No kernel driver or host network bridge is installed automatically.
- macOS bridged mode requires the external socket_vmnet root LaunchDaemon for the selected enX interface; native bridged networking has not yet been tested on this Mac.
- Windows ARM64 bridged mode requires a signed TAP-Windows NDIS 6.30 driver and a user-configured Layer-2 bridge to the attacker VM.
- Releases are unsigned and macOS notarization is not configured.
- No project license has been selected yet.

## Runtime sources

- macOS ARM64: Homebrew QEMU 11.1.3.
- Windows ARM64: MSYS2 CLANGARM64 QEMU 11.1.3-2 plus the matching qemu-image-util and qemu-common packages.

## Verification

Run `npm ci` and `npm run build` for TypeScript/renderer validation. Run the native platform packaging scripts on Apple Silicon macOS and Windows 11 ARM64 to validate the QEMU runtime collectors. The release workflow is configured to run these checks on native ARM64 runners and publish installers plus corresponding QEMU source archives.