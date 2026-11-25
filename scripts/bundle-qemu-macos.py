#!/usr/bin/env python3
"""Stage a relocatable Apple Silicon QEMU runtime from Homebrew."""
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
EXPECTED = "11.1.3"


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
    raise SystemExit("Homebrew is required to prepare the QEMU runtime.")

# Install QEMU and insist on the exact stable version used by this release.
run(["brew", "install", "qemu"], check=False)
version_output = run(["qemu-system-x86_64", "--version"])
if EXPECTED not in version_output:
    run(["brew", "upgrade", "qemu"], check=False)
    version_output = run(["qemu-system-x86_64", "--version"])
if EXPECTED not in version_output:
    raise SystemExit(f"Expected QEMU {EXPECTED}; found: {version_output.splitlines()[0]}")

qemu_prefix = Path(run(["brew", "--prefix", "qemu"]))

if OUT.exists():
    shutil.rmtree(OUT)
BIN.mkdir(parents=True)
LIB.mkdir(parents=True)
(SHARE / "qemu").mkdir(parents=True)

for tool in ("qemu-system-x86_64", "qemu-system-i386", "qemu-img"):
    source_text = shutil.which(tool)
    if not source_text:
        raise SystemExit(f"Homebrew did not provide required QEMU tool: {tool}")
    shutil.copy2(Path(source_text).resolve(strict=True), BIN / tool)

firmware_source = qemu_prefix / "share" / "qemu"
if not firmware_source.is_dir():
    raise SystemExit(f"QEMU firmware/data directory is missing: {firmware_source}")
shutil.copytree(firmware_source, SHARE / "qemu", dirs_exist_ok=True, symlinks=False)

module_source = qemu_prefix / "lib" / "qemu"
module_target = LIB / "qemu"
if module_source.is_dir():
    shutil.copytree(module_source, module_target, dirs_exist_ok=True, symlinks=False)
else:
    module_target.mkdir(parents=True)
(module_target / ".runtime-marker").write_text("QEMU 11.1.3\n", encoding="utf-8")

# Query Homebrew's recursive dependency graph, then keep only formula prefixes
# that are installed on this build runner. Avoid the newer --installed filter.
formulae = ["qemu"] + run(["brew", "deps", "--recursive", "qemu"]).splitlines()
formulae = sorted(set(formulae))
library_hashes: dict[str, str] = {}
copied_libraries: list[str] = []
license_roots: list[tuple[str, Path]] = []

for formula in formulae:
    prefix_result = subprocess.run(
        ["brew", "--prefix", formula],
        text=True,
        capture_output=True,
    )
    if prefix_result.returncode != 0:
        print(f"Skipping unavailable dependency prefix: {formula}", file=sys.stderr)
        continue
    prefix = Path(prefix_result.stdout.strip())
    if not prefix.is_dir():
        print(f"Skipping dependency not installed on runner: {formula}", file=sys.stderr)
        continue

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

licenses_out = OUT / "licenses"
for formula, license_dir in license_roots:
    destination = licenses_out / formula
    if destination.exists():
        continue
    shutil.copytree(license_dir, destination, dirs_exist_ok=True, symlinks=False)

shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", OUT / "THIRD_PARTY_NOTICES.md")
formula_versions = run(["brew", "list", "--versions", *formulae], check=False).splitlines()
manifest = {
    "qemuVersion": EXPECTED,
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
for tool in ("qemu-system-x86_64", "qemu-system-i386", "qemu-img"):
    output = run([str(BIN / tool), "--version"], env=runtime_env)
    if EXPECTED not in output:
        raise SystemExit(f"Bundled runtime smoke test failed for {tool}: {output}")

print(f"Bundled QEMU {EXPECTED} for macOS ARM64.")
print(f"Copied {len(copied_libraries)} shared libraries and QEMU firmware data.")
print(f"Runtime size: {sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file()) / (1024**2):.1f} MiB")
