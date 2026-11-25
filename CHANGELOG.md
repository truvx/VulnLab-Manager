# Changelog

## 0.4.0 — Cross-platform ARM64 packaging

- Added Windows ARM64 NSIS `.exe` installer configuration.
- Added macOS Apple Silicon DMG/ZIP release build workflow.
- Added Windows ARM64 release build workflow.
- Added CI validation and automatic GitHub Release asset publishing.
- Added Windows QEMU executable discovery and host-specific display backend selection.
- Replaced macOS-only `/usr/bin/tar` assumptions with cross-platform `tar` discovery.
- Made host platform and architecture labels dynamic in the UI.
- Added Windows ARM64 build script and installation/build/security/architecture documentation.

## 0.3.0 — General-purpose machine manager

- Rebranded the application as VulnLab Manager.
- Generalized machine import and network setup guidance.
- Kept attacker VM lifecycle manual and outside app control.
- Added legacy machine folder/database migration logic.
