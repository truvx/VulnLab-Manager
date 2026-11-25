# QEMU and bundled runtime notices

VulnLab Manager v0.5.0 bundles QEMU **11.1.3** for macOS Apple Silicon and Windows ARM64. The QEMU host binaries are native to their host platform; x86/i386 guest CPUs are run using QEMU TCG software emulation.

## QEMU source and licensing

- Upstream project: https://www.qemu.org/
- Upstream source for QEMU 11.1.3: https://download.qemu.org/qemu-11.1.3.tar.xz
- QEMU license files are included in the upstream source archive (including COPYING and LICENSES).
- Homebrew's QEMU formula metadata identifies its QEMU package as GPL-2.0-only: https://formulae.brew.sh/formula/qemu
- The MSYS2 CLANGARM64 QEMU package metadata lists GPL-2.0-or-later, LGPL-2.1-or-later, BSD-2-Clause, BSD-3-Clause and MIT components: https://packages.msys2.org/packages/mingw-w64-clang-aarch64-qemu

## Windows ARM64 build sources

The Windows runtime is taken from the native MSYS2 CLANGARM64 package set:

- QEMU: `mingw-w64-clang-aarch64-qemu 11.1.3-2`
- Shared data / firmware: `mingw-w64-clang-aarch64-qemu-common 11.1.3-2`
- Disk utility: `mingw-w64-clang-aarch64-qemu-image-util 11.1.3-2`

Package metadata and package-specific license declarations:
https://packages.msys2.org/packages/mingw-w64-clang-aarch64-qemu

MSYS2 source package and build recipe:
https://mirror.msys2.org/mingw/sources/mingw-w64-qemu-11.1.3-2.src.tar.zst

## Additional libraries

QEMU uses dynamically linked runtime libraries from the relevant Homebrew or MSYS2 dependency set. Those libraries retain their own copyrights and licenses. The platform bundling scripts collect the runtime DLL/dylib dependencies required by the QEMU executables; compiler toolchains and development headers are not included.

- Homebrew formula and dependency metadata: https://formulae.brew.sh/
- MSYS2 package and dependency metadata: https://packages.msys2.org/

## Corresponding source

The v0.5.0 GitHub Release is intended to include the upstream QEMU 11.1.3 source archive and MSYS2's matching QEMU source package archive alongside the installers. The MSYS2 archive contains the package recipe and patches used to prepare its native Windows ARM64 package.
