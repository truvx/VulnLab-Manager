# Bundled QEMU runtime

VulnLab Manager v0.5.0 is being prepared to package a private QEMU runtime with each supported ARM64 installer. The host-side QEMU executable is native to the host; its x86/i386 guest emulator is QEMU TCG. The native packaging jobs must pass before this runtime can be considered released.

## Runtime layout

The Electron installer copies the staged runtime into the app's resources directory:

```text
resources/
└── qemu/
    ├── bin/
    │   ├── qemu-system-x86_64[.exe]
    │   ├── qemu-system-i386[.exe]
    │   └── qemu-img[.exe]
    ├── lib/
    │   └── qemu/              # QEMU loadable modules, when supplied
    ├── share/
    │   └── qemu/              # BIOS, ROMs, UEFI firmware and data
    ├── licenses/
    ├── manifest.json
    └── THIRD_PARTY_NOTICES.md
```

The macOS runtime also contains the non-system dylibs found by walking the QEMU executables' and modules' actual dynamic-link dependencies with Apple's otool tools. The Windows runtime contains the imported DLL dependency closure from MSYS2 CLANGARM64. Optional QEMU instrumentation and test plugins under `lib/qemu/plugins/` are excluded because VulnLab Manager does not load QEMU plugins.

## Pinned sources

| Host | Runtime package source | Pinned version |
|---|---|---|
| macOS Apple Silicon | Homebrew `qemu` formula | QEMU 11.1.3 |
| Windows 11 ARM64 | MSYS2 CLANGARM64 `mingw-w64-clang-aarch64-qemu` | QEMU 11.1.3-2 |
| Windows `qemu-img` | MSYS2 CLANGARM64 `mingw-w64-clang-aarch64-qemu-image-util` | QEMU 11.1.3-2 |

- Homebrew formula: https://formulae.brew.sh/formula/qemu
- MSYS2 QEMU package: https://packages.msys2.org/packages/mingw-w64-clang-aarch64-qemu
- MSYS2 image utility package: https://packages.msys2.org/packages/mingw-w64-clang-aarch64-qemu-image-util
- QEMU upstream source: https://download.qemu.org/qemu-11.1.3.tar.xz

## Runtime resolution

At startup, VulnLab Manager checks for the bundled QEMU tools first. If a bundled runtime is not present (for example, during development), it can fall back to a QEMU installation found on the user's `PATH` or known platform locations.

When launching a target, the application:

1. uses the selected bundled or system `qemu-system-x86_64` / `qemu-system-i386` executable;
2. uses the matching `qemu-img` tool to create a disposable QCOW2 overlay;
3. points QEMU at the bundled firmware/data directory when present;
4. sets platform runtime library and module search paths for the bundled runtime.

The **System** checks in the application show the detected QEMU version and whether the bundled runtime is active.

## Building the runtime

### macOS Apple Silicon

`scripts/bundle-qemu-macos.py` installs the Homebrew QEMU formula, checks the expected version, copies the system emulators, `qemu-img`, QEMU firmware/data and modules, resolves the transitive dylib links with `otool`, rewrites library install names for the private runtime, copies available license files, and smoke-tests all three tools with the staged library path.

### Windows 11 ARM64

`scripts/bundle-qemu-windows-arm64.ps1` expects a native ARM64 Windows host with MSYS2 CLANGARM64 packages installed. It copies the two system emulators, `qemu-img` and firmware/data, recursively resolves their required runtime DLLs with the native CLANGARM64 `llvm-objdump`, excludes optional QEMU instrumentation/test plugins, then smoke-tests all three tools.

The GitHub release workflow installs the MSYS2 packages automatically on the native Windows ARM64 runner and runs an additional smoke test against the packaged Electron resources.

## Updates and performance

The QEMU version is pinned to make installer builds reproducible. Updating it requires changing both platform sources, verifying that the required package versions exist, refreshing the notices/source archives, and passing both native runtime smoke tests.

TCG is software CPU emulation. Bundling QEMU removes a separate installation step; it does not make x86 emulation run at native x86 speed on ARM hardware. Guest compatibility and performance still depend on the virtual hardware profile and the VM image.

## Licensing and source

The release includes `THIRD_PARTY_NOTICES.md`, the upstream QEMU source archive and signature, and the MSYS2 QEMU source package archive. The installed runtime also includes license directories provided by the platform package sources. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).