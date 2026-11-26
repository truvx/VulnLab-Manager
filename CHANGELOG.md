# Changelog

## 0.6.0 — Per-machine NAT and bridged networking (development)

- Added per-machine QEMU network modes: user-mode NAT and platform-native bridged networking (socket_vmnet on macOS, TAP-Windows on Windows ARM64).
- Added editable TCP/UDP host-to-guest port forwarding for NAT targets.
- Added stable per-machine virtual MAC addresses and guest IP display (DHCP address for NAT; best-effort ARP lookup for bridged mode).
- Added host IPv4 address discovery to show how attacker VMs can reach NAT-forwarded services.
- Added socket_vmnet/LaunchDaemon and TAP-Windows driver/interface prerequisites plus isolation warnings for bridged mode.
- Replaced the previous localhost UDP tunnel as the default QEMU network backend.
- Added per-target QEMU NIC traffic telemetry (packet/byte counters and observed peer IPs) using short packet-prefix captures that are deleted when the target stops.
- Moved the Activity panel beside the compact import drop zone.
- Updated network setup documentation for Kali, Parrot, and other manually managed attacker VMs.

## 0.5.0 — Bundled QEMU runtime (in validation)

- Added pinned QEMU 11.1.3 runtime staging for macOS Apple Silicon and Windows ARM64.
- Added QEMU firmware/data files, dynamically linked libraries, and module packaging.
- Added bundled-runtime detection and version display in the desktop app.
- Made the application prefer the private bundled runtime while retaining a system-QEMU fallback for development.
- Added native MSYS2 CLANGARM64 package setup to the Windows ARM64 release workflow.
- Added QEMU upstream source and MSYS2 package source archives to release assets for corresponding-source access.
- Updated platform installation/build guides and third-party notices.
- Native runtime smoke tests and installer validation are still required before declaring this release ready.

## 0.4.0 — Cross-platform ARM64 packaging

- Added Windows ARM64 NSIS `.exe` installer configuration.
- Added macOS Apple Silicon DMG/ZIP release build workflow.
- Added Windows ARM64 release build workflow.
- Added CI validation and GitHub Release asset publishing.
- Added Windows QEMU executable discovery and host-specific display backend selection.
- Replaced macOS-only `/usr/bin/tar` assumptions with cross-platform `tar` discovery.
- Made host platform and architecture labels dynamic in the UI.
- Added Windows ARM64 build script and installation/build/security/architecture documentation.

## 0.3.0 — General-purpose machine manager

- Rebranded the application as VulnLab Manager.
- Generalized machine import and network setup guidance.
- Kept attacker VM lifecycle manual and outside app control.
- Added legacy machine folder/database migration logic.