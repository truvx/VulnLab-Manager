#!/usr/bin/env python3
"""Stage a relocatable Apple Silicon QEMU runtime from Homebrew."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "runtime" / "qemu"
BIN = OUT / "bin"
LIB = OUT / "lib"
SHARE = OUT / "share"
EXPECTED = "11.1.3"

def run(args: list[str], check: bool = True) -> str:
    result = subprocess.run(args, check=check, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.strip()

def real(path: Path) -> Path:
    return path.resolve(strict=True)

if sys.platform != "darwin" or os.uname().machine != "arm64":
    raise SystemExit("QEMU bundling must run on an Apple Silicon Mac.")
if shutil.which("brew") is None:
    raise SystemExit("Homebrew is required to prepare the QEMU runtime.")

run(["brew", "install", "qemu"], check=False)
qemu_prefix = Path(run(["brew", "--prefix", "qemu"]))
version_line = run(["qemu-system-x86_64", "--version"]).splitlines()[0]
if EXPECTED not in version_line:
    raise SystemExit(f"Expected QEMU {EXPECTED}; found {version_line}")

if OUT.exists():
    shutil.rmtree(OUT)
BIN.mkdir(parents=True)
LIB.mkdir(parents=True)
(SHARE / "qemu").parent.mkdir(parents=True, exist_ok=True)

tool_sources: dict[str, Path] = {}
for name in ("qemu-system-x86_64", "qemu-system-i386", "qemu-img"):
    source = real(Path(shutil.which(name) or ""))
    destination = BIN / name
    shutil.copy2(source, destination)
    tool_sources[str(destination)] = source

data_source = qemu_prefix / "share" / "qemu"
if not data_source.is_dir():
    raise SystemExit(f"Missing QEMU firmware/data directory: {data_source}")
shutil.copytree(data_source, SHARE / "qemu", symlinks=True)

module_source = qemu_prefix / "lib" / "qemu"
module_targets: list[tuple[Path, Path]] = []
if module_source.is_dir():
    module_target = LIB / "qemu"
    shutil.copytree(module_source, module_target, symlinks=True)
    for module in module_source.rglob("*.dylib"):
        if module.is_file():
            module_targets.append((module_target / module.relative_to(module_source), real(module)))

formulae = ["qemu"] + run(["brew", "deps", "--installed", "--recursive", "qemu"]).splitlines()
search_roots: list[Path] = [Path(run(["brew", "--prefix"])) / "Cellar"]
for formula in sorted(set(formulae)):
    prefix_text = subprocess.run(["brew", "--prefix", formula], text=True, capture_output=True)
    if prefix_text.returncode != 0:
        continue
    prefix = Path(prefix_text.stdout.strip())
    for folder in (prefix / "lib", prefix / "libexec"):
        if folder.is_dir():
            search_roots.append(folder)

def resolve_dependency(dep: str) -> Path | None:
    if dep.startswith("/System/Library/") or dep.startswith("/usr/lib/"):
        return None
    name = Path(dep).name
    direct = Path(dep)
    if direct.is_absolute() and direct.exists():
        return real(direct)
    # Homebrew libraries sometimes use @rpath install names; resolve by basename
    # only within the already-installed QEMU dependency prefixes.
    for root in search_roots:
        try:
            found = next(root.rglob(name))
            if found.is_file():
                return real(found)
        except StopIteration:
            pass
    if name.startswith(("libSystem.", "libobjc.", "libc++abi.")):
        return None
    raise RuntimeError(f"Could not resolve QEMU runtime dependency: {dep}")

mapping: dict[str, str] = {}
library_sources: list[Path] = []
for _target, source in module_targets:
    library_sources.append(source)

def register_library(source: Path) -> str:
    source = real(source)
    key = str(source)
    if key in mapping:
        return mapping[key]
    name = source.name
    destination = LIB / name
    if destination.exists() and hashlib.sha256(destination.read_bytes()).digest() != hashlib.sha256(source.read_bytes()).digest():
        suffix = hashlib.sha256(source.read_bytes()).hexdigest()[:10]
        destination = LIB / f"{source.stem}-{suffix}{source.suffix}"
    if not destination.exists():
        shutil.copy2(source, destination)
    mapping[key] = destination.name
    library_sources.append(source)
    return destination.name

# Traverse all linked libraries, including dependencies of dynamically loaded modules.
scanned: set[str] = set()
index = 0
while index < len(library_sources):
    source = library_sources[index]
    index += 1
    key = str(real(source))
    if key in scanned:
        continue
    scanned.add(key)
    output = run(["otool", "-L", str(source)])
    for line in output.splitlines()[1:]:
        dep = line.strip().split(" (", 1)[0]
        resolved = resolve_dependency(dep)
        if resolved is not None:
            register_library(resolved)

def dependencies(source: Path) -> list[str]:
    output = run(["otool", "-L", str(source)])
    return [line.strip().split(" (", 1)[0] for line in output.splitlines()[1:]]

# Patch app executables and dylibs so they load the copied libraries beside themselves.
for target_text, source in tool_sources.items():
    target = Path(target_text)
    run(["install_name_tool", "-add_rpath", "@executable_path/../lib", str(target)])
    for dep in dependencies(source):
        resolved = resolve_dependency(dep)
        if resolved is not None:
            dest_name = mapping[str(resolved)]
            run(["install_name_tool", "-change", dep, f"@executable_path/../lib/{dest_name}", str(target)], check=False)
    run(["codesign", "--remove-signature", str(target)], check=False)

for source in set(library_sources):
    source = real(source)
    dest_name = mapping[str(source)]
    target = LIB / dest_name
    for dep in dependencies(source):
        resolved = resolve_dependency(dep)
        if resolved is not None:
            dependency_name = mapping[str(resolved)]
            run(["install_name_tool", "-change", dep, f"@loader_path/{dependency_name}", str(target)], check=False)
    run(["install_name_tool", "-id", f"@loader_path/{dest_name}", str(target)], check=False)
    run(["codesign", "--remove-signature", str(target)], check=False)

notice = ROOT / "THIRD_PARTY_NOTICES.md"
shutil.copy2(notice, OUT / notice.name)
manifest = {
    "qemuVersion": EXPECTED,
    "host": "macOS",
    "architecture": "arm64",
    "source": "Homebrew qemu formula",
    "sourceUrl": "https://formulae.brew.sh/formula/qemu",
}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

for name in ("qemu-system-x86_64", "qemu-system-i386", "qemu-img"):
    output = run([str(BIN / name), "--version"])
    if EXPECTED not in output:
        raise SystemExit(f"Bundled runtime smoke test failed for {name}: {output}")
print(f"Bundled QEMU {EXPECTED} for macOS ARM64.")
print(f"Runtime size: {sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file()) / (1024**2):.1f} MiB")
