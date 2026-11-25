#!/usr/bin/env python3
"""Stage a relocatable Apple Silicon QEMU runtime by walking actual dylib links."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import re
from collections import deque

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "runtime" / "qemu"
BIN = OUT / "bin"
LIB = OUT / "lib"
SHARE = OUT / "share"
EXPECTED = "11.1.3"
SYSTEM_PREFIXES = ("/System/Library/", "/usr/lib/")
SYSTEM_NAMES = ("libSystem.", "libobjc.", "libc++abi.")


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


def linked_libraries(binary: Path) -> list[str]:
    output = run(["otool", "-L", str(binary)])
    return [
        line.strip().split(" (", 1)[0]
        for line in output.splitlines()[1:]
        if line.strip()
    ]


def runtime_paths(binary: Path) -> list[str]:
    output = run(["otool", "-l", str(binary)])
    lines = output.splitlines()
    paths: list[str] = []
    for index, line in enumerate(lines):
        if line.strip() == "cmd LC_RPATH":
            for following in lines[index + 1:index + 5]:
                match = re.match(r"\s*path (.+) \(offset \d+\)", following)
                if match:
                    paths.append(match.group(1))
                    break
    return paths


def expand_loader_path(value: str, loader: Path) -> Path:
    if value.startswith("@loader_path/"):
        return loader.parent / value[len("@loader_path/"):]
    if value == "@loader_path":
        return loader.parent
    if value.startswith("@executable_path/"):
        return loader.parent / value[len("@executable_path/"):]
    if value == "@executable_path":
        return loader.parent
    return Path(value)


if sys.platform != "darwin" or platform.machine() != "arm64":
    raise SystemExit("QEMU bundling must run on a native Apple Silicon Mac.")
if shutil.which("brew") is None:
    raise SystemExit("Homebrew is required to prepare the QEMU runtime.")
if shutil.which("otool") is None or shutil.which("install_name_tool") is None:
    raise SystemExit("Xcode Command Line Tools (otool and install_name_tool) are required.")

# Install QEMU and insist on the exact stable version used by this release.
run(["brew", "install", "qemu"], check=False)
version_output = run(["qemu-system-x86_64", "--version"])
if EXPECTED not in version_output:
    run(["brew", "upgrade", "qemu"], check=False)
    version_output = run(["qemu-system-x86_64", "--version"])
if EXPECTED not in version_output:
    raise SystemExit(f"Expected QEMU {EXPECTED}; found: {version_output.splitlines()[0]}")

qemu_prefix = Path(run(["brew", "--prefix", "qemu"]))
brew_prefix = Path(run(["brew", "--prefix"]))
cellar = brew_prefix / "Cellar"
if not cellar.is_dir():
    raise SystemExit(f"Homebrew Cellar does not exist: {cellar}")

if OUT.exists():
    shutil.rmtree(OUT)
BIN.mkdir(parents=True)
LIB.mkdir(parents=True)
(SHARE / "qemu").mkdir(parents=True)

tool_sources: dict[str, Path] = {}
for tool in ("qemu-system-x86_64", "qemu-system-i386", "qemu-img"):
    source_text = shutil.which(tool)
    if not source_text:
        raise SystemExit(f"Homebrew did not provide required QEMU tool: {tool}")
    source = Path(source_text).resolve(strict=True)
    target = BIN / tool
    shutil.copy2(source, target)
    tool_sources[str(target)] = source

firmware_source = qemu_prefix / "share" / "qemu"
if not firmware_source.is_dir():
    raise SystemExit(f"QEMU firmware/data directory is missing: {firmware_source}")
shutil.copytree(firmware_source, SHARE / "qemu", dirs_exist_ok=True, symlinks=False)

module_source = qemu_prefix / "lib" / "qemu"
module_target = LIB / "qemu"
module_target.mkdir(parents=True)
module_entries: list[tuple[str, Path, Path]] = []
if module_source.is_dir():
    for source in module_source.rglob("*"):
        if source.is_file() and source.suffix in (".dylib", ".so"):
            resolved = source.resolve(strict=True)
            target = module_target / source.relative_to(module_source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(resolved, target)
            module_entries.append(("module", resolved, target))
(module_target / ".runtime-marker").write_text("QEMU 11.1.3\n", encoding="utf-8")

# Build an index of libraries actually installed in the Homebrew Cellar.
# Dependency collection follows otool links; it does not call brew deps.
dylib_index: dict[str, list[Path]] = {}
for candidate in cellar.rglob("*"):
    try:
        if candidate.is_file() and (candidate.suffix == ".dylib" or ".dylib." in candidate.name):
            resolved = candidate.resolve(strict=True)
            dylib_index.setdefault(candidate.name, []).append(resolved)
    except OSError:
        continue

# Active opt-prefix dylibs help choose the currently linked formula version.
active_dylibs: dict[str, list[Path]] = {}
opt_root = brew_prefix / "opt"
if opt_root.is_dir():
    for formula_dir in opt_root.iterdir():
        for lib_dir_name in ("lib", "libexec"):
            library_dir = formula_dir / lib_dir_name
            if not library_dir.is_dir():
                continue
            for candidate in library_dir.iterdir():
                try:
                    if candidate.is_file() and (candidate.suffix == ".dylib" or ".dylib." in candidate.name):
                        active_dylibs.setdefault(candidate.name, []).append(candidate.resolve(strict=True))
                except OSError:
                    continue


def resolve_dependency(dependency: str, loader: Path) -> Path | None:
    if dependency.startswith(SYSTEM_PREFIXES):
        return None
    name = Path(dependency).name
    if name.startswith(SYSTEM_NAMES):
        return None

    direct_candidates: list[Path] = []
    if dependency.startswith("@rpath/"):
        suffix = dependency[len("@rpath/"):]
        for rpath in runtime_paths(loader):
            direct_candidates.append(expand_loader_path(rpath, loader) / suffix)
        direct_candidates.append(brew_prefix / "lib" / suffix)
    elif dependency.startswith("@loader_path") or dependency.startswith("@executable_path"):
        direct_candidates.append(expand_loader_path(dependency, loader))
    elif dependency.startswith("/"):
        direct_candidates.append(Path(dependency))

    for candidate in direct_candidates:
        try:
            if candidate.is_file():
                resolved = candidate.resolve(strict=True)
                if str(resolved).startswith(SYSTEM_PREFIXES):
                    return None
                return resolved
        except OSError:
            pass

    candidates = list(dict.fromkeys(dylib_index.get(name, [])))
    active = list(dict.fromkeys(active_dylibs.get(name, [])))
    if len(active) == 1:
        return active[0]
    if len(candidates) == 1:
        return candidates[0]
    if len(active) > 1:
        raise RuntimeError(
            f"Ambiguous active Homebrew library {dependency}: "
            + ", ".join(str(item) for item in active)
        )
    if len(candidates) > 1:
        raise RuntimeError(
            f"Ambiguous Homebrew library {dependency}: "
            + ", ".join(str(item) for item in candidates[:8])
        )
    raise RuntimeError(f"Could not resolve non-system QEMU dependency {dependency} from {loader}")


# Each entry is (kind, original source path, staged target path).
entries: list[tuple[str, Path, Path]] = []
for target_text, source in tool_sources.items():
    entries.append(("executable", source, Path(target_text)))
entries.extend(module_entries)
library_map: dict[str, str] = {}
library_sources: dict[str, Path] = {}
license_roots: dict[str, Path] = {}
scanned: set[str] = set()
queue = deque(entries)


def register_library(source: Path) -> Path:
    source = source.resolve(strict=True)
    key = str(source)
    if key in library_sources:
        return LIB / library_map[key]
    name = source.name
    target_name = name
    target = LIB / target_name
    digest = sha256(source)
    if target.exists() and sha256(target) != digest:
        target_name = f"{source.stem}-{digest[:10]}{source.suffix}"
        target = LIB / target_name
    if not target.exists():
        shutil.copy2(source, target)
    library_sources[key] = source
    library_map[key] = target_name
    try:
        formula = source.relative_to(cellar).parts[0]
        license_dir = cellar / formula / "share" / "licenses"
        if license_dir.is_dir():
            license_roots[formula] = license_dir
    except ValueError:
        pass
    return target


while queue:
    kind, source, target = queue.popleft()
    source = source.resolve(strict=True)
    key = str(source)
    if key in scanned:
        continue
    scanned.add(key)
    for dependency in linked_libraries(source):
        resolved = resolve_dependency(dependency, source)
        if resolved is None:
            continue
        register_library(resolved)
        if str(resolved) not in scanned:
            queue.append(("library", resolved, LIB / library_map[str(resolved)]))

# Rewrite non-system LC_LOAD_DYLIB references to private staged paths.
all_targets: list[tuple[str, Path, Path]] = entries + [
    ("library", source, LIB / destination_name)
    for key, source in library_sources.items()
    for destination_name in [library_map[key]]
]
patched: set[str] = set()
for kind, source, target in all_targets:
    target_key = str(target)
    if target_key in patched:
        continue
    patched.add(target_key)
    for dependency in linked_libraries(source):
        resolved = resolve_dependency(dependency, source)
        if resolved is None:
            continue
        destination_name = library_map.get(str(resolved))
        if destination_name is None:
            raise RuntimeError(f"Dependency was resolved but not staged: {dependency}")
        if kind == "executable":
            replacement = f"@executable_path/../lib/{destination_name}"
        elif kind == "module":
            replacement = f"@loader_path/../{destination_name}"
        else:
            replacement = f"@loader_path/{destination_name}"
        run(["install_name_tool", "-change", dependency, replacement, str(target)])
    if kind == "library":
        run(["install_name_tool", "-id", f"@loader_path/{target.name}", str(target)])
    run(["codesign", "--remove-signature", str(target)], check=False)

# Include license files from formulae that contributed linked shared libraries.
licenses_out = OUT / "licenses"
for formula, license_dir in sorted(license_roots.items()):
    shutil.copytree(license_dir, licenses_out / formula, dirs_exist_ok=True, symlinks=False)

shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", OUT / "THIRD_PARTY_NOTICES.md")
manifest = {
    "qemuVersion": EXPECTED,
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
for tool in ("qemu-system-x86_64", "qemu-system-i386", "qemu-img"):
    output = run([str(BIN / tool), "--version"], env=runtime_env)
    if EXPECTED not in output:
        raise SystemExit(f"Bundled runtime smoke test failed for {tool}: {output}")

print(f"Bundled QEMU {EXPECTED} for macOS ARM64.")
print(f"Copied {len(library_map)} shared libraries and QEMU firmware data.")
print(f"Runtime size: {sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file()) / (1024**2):.1f} MiB")
