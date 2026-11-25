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

# Install the stable Homebrew bottle. The exact version check prevents a later
# formula update from silently changing the release runtime.
run(["brew", "install", "qemu"], check=False)
version_output = run(["qemu-system-x86_64", "--version"])
if EXPECTED_VERSION not in version_output:
    run(["brew", "upgrade", "qemu"], check=False)
    version_output = run(["qemu-system-x86_64", "--version"])
if EXPECTED_VERSION not in version_output:
    raise SystemExit(f"Expected QEMU {EXPECTED_VERSION}; found: {version_output.splitlines()[0]}")

qemu_prefix = Path(run(["brew", "--prefix", "qemu"]))
brew_prefix = Path(run(["brew", "--prefix"]))
cellar = brew_prefix / "Cellar"

if OUT.exists():
    shutil.rmtree(OUT)
BIN.mkdir(parents=True)
LIB.mkdir(parents=True)
(SHARE / "qemu").mkdir(parents=True)

tool_names = ("qemu-system-x86_64", "qemu-system-i386", "qemu-img")
tool_sources: dict[str, Path] = {}
for name in tool_names:
    source_text = shutil.which(name)
    if not source_text:
        raise SystemExit(f"Homebrew did not provide required QEMU tool: {name}")
    source = Path(source_text).resolve(strict=True)
    target = BIN / name
    shutil.copy2(source, target)
    tool_sources[str(target)] = source

firmware_source = qemu_prefix / "share" / "qemu"
if not firmware_source.is_dir():
    raise SystemExit(f"QEMU firmware/data directory is missing: {firmware_source}")
shutil.copytree(firmware_source, SHARE / "qemu", dirs_exist_ok=True, symlinks=False)

# Preserve QEMU loadable modules and create the module path expected by QEMU.
module_source = qemu_prefix / "lib" / "qemu"
module_target = LIB / "qemu"
if module_source.is_dir():
    shutil.copytree(module_source, module_target, dirs_exist_ok=True, symlinks=False)
else:
    module_target.mkdir(parents=True)
(module_target / ".runtime-marker").write_text("QEMU 11.1.3\n", encoding="utf-8")

# Build a basename index of installed Homebrew dylibs. This deliberately avoids
# brew deps --installed, which can return a failing status on newer Homebrew
# even though the QEMU bottle and its actual runtime dependencies are installed.
dylib_index: dict[str, list[Path]] = {}
if not cellar.is_dir():
    raise SystemExit(f"Homebrew Cellar not found: {cellar}")
for candidate in cellar.rglob("*.dylib"):
    try:
        if candidate.is_file():
            dylib_index.setdefault(candidate.name, []).append(candidate.resolve(strict=True))
    except OSError:
        continue

system_prefixes = ("/System/Library/", "/usr/lib/")
system_names = ("libSystem.", "libobjc.", "libc++abi.")

def resolve_dependency(dependency: str) -> Path | None:
    if dependency.startswith(system_prefixes):
        return None
    name = Path(dependency).name
    direct = Path(dependency)
    if direct.is_absolute() and direct.is_file():
        resolved = direct.resolve(strict=True)
        if str(resolved).startswith(system_prefixes):
            return None
        return resolved
    if name.startswith(system_names):
        return None
    candidates = dylib_index.get(name, [])
    if not candidates:
        raise RuntimeError(f"Could not resolve QEMU runtime dependency: {dependency}")
    # Prefer the active Homebrew opt-prefix target when multiple kegs have
    # the same dylib name; otherwise use the only candidate.
    opt_candidates = []
    for candidate in candidates:
        formula_relative = candidate.relative_to(cellar)
        formula_name = formula_relative.parts[0]
        active = brew_prefix / "opt" / formula_name / "lib" / name
        if active.exists() and active.resolve(strict=True) == candidate:
            opt_candidates.append(candidate)
    if len(opt_candidates) == 1:
        return opt_candidates[0]
    unique = list(dict.fromkeys(candidates))
    if len(unique) == 1:
        return unique[0]
    raise RuntimeError(
        f"Ambiguous Homebrew dylib dependency {dependency}: "
        + ", ".join(str(item) for item in unique[:5])
    )


def linked_libraries(source: Path) -> list[str]:
    output = run(["otool", "-L", str(source)])
    result: list[str] = []
    for line in output.splitlines()[1:]:
        dependency = line.strip().split(" (", 1)[0]
        if dependency:
            result.append(dependency)
    return result


library_map: dict[str, str] = {}
library_sources: list[Path] = []
license_roots: dict[str, Path] = {}
scanned: set[str] = set()


def register_library(source: Path) -> str:
    source = source.resolve(strict=True)
    key = str(source)
    if key in library_map:
        return library_map[key]
    name = source.name
    destination_name = name
    destination = LIB / destination_name
    digest = sha256(source)
    if destination.exists() and sha256(destination) != digest:
        destination_name = f"{source.stem}-{digest[:10]}{source.suffix}"
        destination = LIB / destination_name
    if not destination.exists():
        shutil.copy2(source, destination)
    library_map[key] = destination_name
    library_sources.append(source)
    formula = source.relative_to(cellar).parts[0]
    formula_prefix = cellar / formula
    license_dir = formula_prefix / "share" / "licenses"
    if license_dir.is_dir():
        license_roots[formula] = license_dir
    return destination_name


# Walk the actual linked dependency graph from the three QEMU tools and modules.
queue: list[tuple[str, Path, Path]] = []
for target_text, source in tool_sources.items():
    queue.append(("executable", source, Path(target_text)))
if module_source.is_dir():
    for source in module_source.rglob("*"):
        if source.is_file() and source.suffix in (".dylib", ".so"):
            relative = source.relative_to(module_source)
            target = module_target / relative
            queue.append(("module", source.resolve(strict=True), target))

while queue:
    kind, source, target = queue.pop()
    source_key = str(source.resolve(strict=True))
    if source_key in scanned:
        continue
    scanned.add(source_key)
    for dependency in linked_libraries(source):
        resolved = resolve_dependency(dependency)
        if resolved is None:
            continue
        register_library(resolved)
        if str(resolved) not in scanned:
            queue.append(("library", resolved, LIB / library_map[str(resolved)]))

# Rewrite Homebrew install names to private relative paths inside the app.
patched_targets: set[str] = set()
for kind, source, target in queue + [
    (kind, source, target)
    for target_text, source in tool_sources.items()
    for kind, target in [("executable", Path(target_text))]
]:
    # Queue may be empty after traversal; binary targets are added explicitly.
    key = str(target)
    if key in patched_targets or not target.is_file():
        continue
    patched_targets.add(key)
    for dependency in linked_libraries(source):
        resolved = resolve_dependency(dependency)
        if resolved is None:
            continue
        destination_name = library_map[str(resolved)]
        if kind == "executable":
            new_name = f"@executable_path/../lib/{destination_name}"
        elif kind == "module":
            new_name = f"@loader_path/../{destination_name}"
        else:
            new_name = f"@loader_path/{destination_name}"
        run(["install_name_tool", "-change", dependency, new_name, str(target)])
    if kind == "library":
        run(["install_name_tool", "-id", f"@loader_path/{target.name}", str(target)], check=False)
    run(["codesign", "--remove-signature", str(target)], check=False)

# Add library targets which have been copied into the private lib folder.
for source_key, destination_name in library_map.items():
    source = Path(source_key)
    target = LIB / destination_name
    if str(target) in patched_targets:
        continue
    for dependency in linked_libraries(source):
        resolved = resolve_dependency(dependency)
        if resolved is None:
            continue
        run([
            "install_name_tool", "-change", dependency,
            f"@loader_path/{library_map[str(resolved)]}", str(target)
        ], check=False)
    run(["install_name_tool", "-id", f"@loader_path/{target.name}", str(target)], check=False)
    run(["codesign", "--remove-signature", str(target)], check=False)

licenses_out = OUT / "licenses"
for formula, license_dir in sorted(license_roots.items()):
    destination = licenses_out / formula
    shutil.copytree(license_dir, destination, dirs_exist_ok=True, symlinks=False)

shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", OUT / "THIRD_PARTY_NOTICES.md")
manifest = {
    "qemuVersion": EXPECTED_VERSION,
    "host": "macOS",
    "architecture": "arm64",
    "source": "Homebrew qemu formula",
    "sourceUrl": "https://formulae.brew.sh/formula/qemu",
    "runtimeLibraries": sorted(set(library_map.values())),
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
print(f"Copied {len(library_map)} shared libraries and QEMU firmware data.")
print(f"Runtime size: {sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file()) / (1024**2):.1f} MiB")
