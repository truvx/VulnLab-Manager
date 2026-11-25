# Project Status — 0.4.0

## Implemented

- General-purpose local machine library and QEMU target lifecycle.
- ZIP/OVA/TAR, OVF/VBox folder, and direct virtual disk import paths.
- Safe archive path checks and rejection of archive symlinks.
- Per-run QCOW2 write overlays to protect imported base disks.
- macOS Apple Silicon DMG/ZIP packaging configuration.
- Windows ARM64 NSIS `.exe` packaging configuration.
- Platform-aware QEMU executable resolution and display backend selection.
- GitHub Actions CI and ARM64 release automation.
- Generic optional Linux network helper for manual guest-side use.

## Current constraints

- One QEMU target at a time.
- Default guest hardware profile is BIOS/IDE/E1000 and may not boot every imported image.
- QEMU must be installed separately and discoverable on PATH.
- Attacker VMs are never started, stopped, or reconfigured by this application.
- The optional UDP tunnel requires the user to configure the attacker VM or its hypervisor manually.
- Releases are unsigned and macOS notarization is not configured.
- Windows ARM64 packaging is configured to build on a native ARM64 runner; actual installer smoke testing remains a release verification step.
- No project license has been selected yet.

## Verification

Source-level changes have been made for cross-platform paths and QEMU display handling. Run `npm ci` and `npm run build` before merging. The GitHub release workflow builds actual installers on native macOS ARM64 and Windows ARM64 runners.
