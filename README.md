# VulnLab Manager

**A cross-platform local lab manager for vulnerable virtual machines.**

VulnLab Manager helps security learners and researchers organize local practice machines, inspect compatible VM images, and launch isolated QEMU targets from a desktop interface. It is designed to work with machines from multiple sources rather than a single training platform.

> **Current status:** The repository bootstrap currently contains only this README. The v0.4.0 source bundle and its build pipeline have not yet been committed or published here. Installers are not available yet.

## Goals

- Import locally supplied VM archives, descriptors, and virtual disks.
- Inspect machine metadata before launching.
- Launch and stop QEMU targets from the manager.
- Keep attacker VMs independent: start Kali, Parrot, or another VM manually in the hypervisor of your choice.
- Provide generic, manually operated Linux lab-network setup guidance.
- Preserve separation between the isolated practice network and the host's normal network.

## Planned platform packages

| Platform | Target architecture | Installer |
|---|---|---|
| macOS | Apple Silicon (arm64) | DMG |
| Windows | ARM64 | EXE (NSIS) |

Installers will be attached to GitHub Releases after successful native builds. They are not published yet.

## Supported input formats

The importer aims to handle compatible locally supplied formats including ZIP, OVA, TAR/TAR.GZ, OVF/VBOX descriptors, and virtual disks such as VMDK, QCOW2, VDI, VHD/VHDX, IMG and RAW. Actual boot compatibility depends on guest architecture, firmware, disk controller, and QEMU device support.

The project does not provide downloads from third-party training platforms. Users must supply images they are authorized to use.

## Architecture

- **Desktop shell:** Electron
- **UI:** React + TypeScript
- **Virtualization:** QEMU for targets
- **Optional host integration:** VirtualBox for manually managed attacker VMs
- **Networking:** local UDP tunnel design with a manually configured attacker-side interface

The manager is intended to start and stop its selected QEMU target only. It must not automatically start Kali, Parrot, or any other attacker VM.

## Development

The source code and reproducible build instructions will be added in the next project commit. Native packaging should be performed on the matching host architecture:

- macOS Apple Silicon runner for the DMG build.
- Windows ARM64 runner for the NSIS installer.

Do not treat a cross-platform packaging configuration as proof that a release binary has been tested. Releases will be marked available only after native CI jobs complete successfully.

## Security notes

- Imported VM images are untrusted. Inspect their origin and keep lab networking isolated.
- Do not bridge intentionally vulnerable targets to a production or public network.
- Network setup helpers are manual tools. Review them before running with elevated privileges.
- No attacker VM is started automatically.

## Contributing

Bug reports and focused pull requests are welcome. Include host OS/architecture, QEMU version, import format, relevant logs, and steps to reproduce. Never attach proprietary or unauthorized machine images.

## License

No license has been selected yet. Until one is added, all rights are reserved by the copyright holder; do not assume that the source can be redistributed or modified under an open-source license.
