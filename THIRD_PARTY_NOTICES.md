# QEMU and bundled runtime notices

The planned VulnLab Manager v0.5.0 runtime stages QEMU **11.1.3** for macOS Apple Silicon and Windows ARM64. The QEMU host binaries are native to their host platform; x86/i386 guest CPUs are run using QEMU TCG software emulation. Confirm the native bundle builds and the release artifacts before distributing the runtime.

## QEMU source and licensing

- Upstream project: https://www.qemu.org/
- Upstream source for QEMU 11.1.3: https://download.qemu.org/qemu-11.1.3.tar.xz
- Upstream detached signature: https://download.qemu.org/qemu-11.1.3.tar.xz.sig
- QEMU license files are included in the upstream source archive (including COPYING and LICENSES).
- Homebrew's QEMU formula metadata identifies the formula as GPL-2.0-only: https://formulae.brew.sh/formula/qemu
- The MSYS2 CLANGARM64 QEMU package metadata lists GPL-2.0-or-later, LGPL-2.1-or-later, BSD-2-Clause, BSD-3-Clause and MIT components: https://packages.msys2.org/packages/mingw-w64-clang-aarch64-qemu

The v0.5.0 release workflow attaches the upstream QEMU source archive and signature.

## Windows ARM64 package sources

The Windows runtime is staged from the native MSYS2 CLANGARM64 package set:

- QEMU: `mingw-w64-clang-aarch64-qemu 11.1.3-2`
- Shared data / firmware: `mingw-w64-clang-aarch64-qemu-common 11.1.3-2`
- Disk utility: `mingw-w64-clang-aarch64-qemu-image-util 11.1.3-2`

Package metadata, dependency details, package file list, and license declarations:
https://packages.msys2.org/packages/mingw-w64-clang-aarch64-qemu

Corresponding MSYS2 source package / build recipe:
https://mirror.msys2.org/mingw/sources/mingw-w64-qemu-11.1.3-2.src.tar.zst

The release workflow attaches this source package archive alongside the installers.

## Runtime libraries and notices

QEMU uses dynamically linked runtime libraries from the corresponding Homebrew or MSYS2 dependency set. These components remain subject to their own copyrights and license terms.

- The macOS staging script copies shared dylibs from the installed recursive Homebrew dependency set and includes license directories when supplied by the formula.
- The Windows staging script copies the transitive imported DLL dependencies from the MSYS2 CLANGARM64 runtime and includes the CLANGARM64 license directory when supplied by installed packages.
- Compiler toolchains, development headers, and unrelated package content are not bundled.

Upstream package and dependency metadata:
- https://formulae.brew.sh/
- https://packages.msys2.org/

Review the `licenses/` directory inside the installed app's bundled QEMU resources for the license material shipped by the platform package sources.