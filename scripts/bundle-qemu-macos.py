#!/usr/bin/env python3
"""Create a relocatable Apple Silicon QEMU runtime from pinned Homebrew QEMU."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "runtime" / "qemu"
BIN = OUT / "bin"
LIB = OUT / "lib"
SHARE = OUT / "share"
EXPECTED_VERSION = "11.1.3"


def run(args: list[str], *, check: bool = True, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        args,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    return result.stdout.strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if sys.platform != "darwin" or platform.machine() != "arm64":
    raise SystemExit("QEMU bundling must run on a native Apple Silicon Mac.")
if shutil.which("brew") is None:
    raise SystemExit("Homebrew is required to prepare the bundled QEMU runtime.")
if shutil.which("python3") is None:
    raise SystemExit("Python 3 is required to prepare the bundled QEMU runtime.")

# Install the stable Homebrew bottle. The exact version check prevents a later
# Homebrew formula update from silently changing a reproducible release build.
run(["brew", "install", "qemu"], check=False)
version_output = run(["qemu-system-x86_64", "--version"])
if EXPECTED_VERSION not in version_output:
    # Refresh an older installed formula before refusing the non-pinned runtime.
    run(["brew", "upgrade", "qemu"], check=False)
    version_output = run(["qemu-system-x86_64", "--version"])
if EXPECTED_VERSION not in version_output:
    raise SystemExit(f"Expected QEMU {EXPECTED_VERSION}; found: {version_output.splitlines()[0]}")
qemu_prefix = Path(run(["brew", "--prefix", "qemu"]))

if OUT.exists():
    shutil.rmtree(OUT)
BIN.mkdir(parents=True)
LIB.mkdir(parents=True)
(SHARE / "qemu").mkdir(parents=True)

tool_names = ("qemu-system-x86_64", "qemu-system-i386", "qemu-img")
for name in tool_names:
    source_text = shutil.which(name)
    if not source_text:
        raise SystemExit(f"Homebrew did not provide required QEMU tool: {name}")
    source = Path(source_text).resolve(strict=True)
    shutil.copy2(source, BIN / name)

firmware_source = qemu_prefix / "share" / "qemu"
if not firmware_source.is_dir():
    raise SystemExit(f"QEMU firmware/data directory is missing: {firmware_source}")
shutil.copytree(firmware_source, SHARE / "qemu", dirs_exist_ok=True, symlinks=False)

# Preserve QEMU's optional loadable modules. QEMU_MODULE_DIR is set by the app
# when this directory is present.
module_source = qemu_prefix / "lib" / "qemu"
module_target = LIB / "qemu"
if module_source.is_dir():
    shutil.copytree(module_source, module_target, dirs_exist_ok=True, symlinks=True)
else:
    module_target.mkdir(parents=True)
(module_target / ".runtime-marker").write_text("QEMU 11.1.3\n", encoding="utf-8")

# Collect shared libraries from QEMU and its installed recursive Homebrew
# dependencies. DYLD_LIBRARY_PATH points the bundled QEMU processes at this
# private directory, so the target machine never depends on Homebrew paths.
formulae = ["qemu"] + run(["brew", "deps", "--installed", "--recursive", "qemu"]).splitlines()
formulae = sorted(set(formulae))
library_hashes: dict[str, str] = {}
copied_libraries: list[str] = []
license_roots: list[tuple[str, Path]] = []
for formula in formulae:
    prefix_result = subprocess.run(["brew", "--prefix", formula], text=True, capture_output=True)
    if prefix_result.returncode != 0:
        raise SystemExit(f"Could not resolve installed Homebrew dependency prefix: {formula}")
    prefix = Path(prefix_result.stdout.strip())
    license_dir = prefix / "share" / "licenses"
    if license_dir.is_dir():
        license_roots.append((formula, license_dir))
    for library_root in (prefix / "lib", prefix / "libexec"):
        if not library_root.is_dir():
            continue
        for candidate in library_root.rglob("*.dylib"):
            if not candidate.is_file():
                continue
            digest = sha256(candidate)
            name = candidate.name
            existing_digest = library_hashes.get(name)
            if existing_digest and existing_digest != digest:
                raise SystemExit(
                    f"Conflicting Homebrew dylibs named {name}; refusing an ambiguous runtime bundle."
                )
            if existing_digest:
                continue
            shutil.copy2(candidate, LIB / name)
            library_hashes[name] = digest
            copied_libraries.append(name)

if not copied_libraries:
    raise SystemExit("No Homebrew QEMU dependency dylibs were copied; refusing an incomplete runtime.")

# Retain any license texts provided by the installed formulas. Keep their
# directory names to make the origin of each notice clear.
licenses_out = OUT / "licenses"
for formula, license_dir in license_roots:
    destination = licenses_out / formula
    if destination.exists():
        continue
    shutil.copytree(license_dir, destination, dirs_exist_ok=True, symlinks=False)

notice = ROOT / "THIRD_PARTY_NOTICES.md"
shutil.copy2(notice, OUT / notice.name)

formula_versions = run(["brew", "list", "--versions", *formulae]).splitlines()
manifest = {
    "qemuVersion": EXPECTED_VERSION,
    "host": "macOS",
    "architecture": "arm64",
    "source": "Homebrew qemu formula",
    "sourceUrl": "https://formulae.brew.sh/formula/qemu",
    "formulaVersions": formula_versions,
    "runtimeLibraries": copied_libraries,
}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

runtime_env = dict(os.environ)
runtime_env["DYLD_LIBRARY_PATH"] = str(LIB)
runtime_env["QEMU_MODULE_DIR"] = str(module_target)
for name in tool_names:
    output = run([str(BIN / name), "--version"], env=runtime_env)
    if EXPECTED_VERSION not in output:
        raise SystemExit(f"Bundled runtime smoke test failed for {name}: {output}")

print(f"Bundled QEMU {EXPECTED_VERSION} for macOS ARM64.")
print(f"Copied {len(copied_libraries)} shared libraries and QEMU firmware data.")
print(f"Runtime size: {sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file()) / (1024**2):.1f} MiB")
