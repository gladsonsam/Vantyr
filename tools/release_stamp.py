#!/usr/bin/env python3
"""Synchronize release metadata without resolving/upgrading dependencies."""
import argparse
import json
from pathlib import Path
import re
import tomllib

SEMVER = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
)


def version_from_tag(tag, stable=False):
    version = tag.removeprefix("v")
    match = SEMVER.fullmatch(version)
    if not tag.startswith("v") or not match:
        raise ValueError(f"Invalid SemVer tag: {tag!r}; expected v1.2.3")
    if stable:
        if match[4] or match[5]:
            raise ValueError("This stable release workflow rejects prerelease/build metadata")
        if any(int(match[i]) > maximum for i, maximum in enumerate((255, 255, 65535), 1)):
            raise ValueError("Version exceeds Windows MSI limits (255.255.65535)")
    return version


def replace_toml_version(text, package, lock=False, version=""):
    parsed = tomllib.loads(text)
    entries = parsed["package"] if lock else [parsed["package"]]
    if sum(entry.get("name") == package for entry in entries) != 1:
        raise ValueError(f"Expected exactly one package named {package}")
    header = r"\[\[package\]\]" if lock else r"\[package\]"
    blocks = re.compile(r"(?ms)^" + header + r"[^\n]*\n(?:(?!^\[).)*")
    count = 0

    def replace(block):
        nonlocal count
        value = block.group()
        if re.search(r'^name\s*=\s*"' + re.escape(package) + r'"\s*$', value, re.M):
            value, changes = re.subn(r'^(version\s*=\s*")[^"]+("[^\n]*)$',
                                     lambda m: m[1] + version + m[2], value, flags=re.M)
            if changes != 1:
                raise ValueError(f"Expected one version for {package}")
            count += 1
        return value

    result = blocks.sub(replace, text)
    if count != 1:
        raise ValueError(f"Cannot locate version for {package}")
    return result


def stamp(root, tag, check=False, stable=False):
    version = version_from_tag(tag, stable)
    updates = {}
    for filename, package, lock in (
        ("agent/Cargo.toml", "vantyr-agent", False),
        ("agent/Cargo.lock", "vantyr-agent", True),
        ("server/Cargo.toml", "vantyr-server", False),
        ("Cargo.lock", "vantyr-server", True),
    ):
        path = root / filename
        text = path.read_text(encoding="utf-8")
        updates[path] = replace_toml_version(text, package, lock, version)
    for filename in ("agent/tauri.conf.json", "agent/ui-src/package.json",
                     "frontend/package.json", "package-lock.json"):
        path = root / filename
        value = json.loads(path.read_text(encoding="utf-8"))
        if filename == "package-lock.json":
            # One npm-workspaces lockfile: stamp the versioned workspace entries it records.
            for workspace in ("agent/ui-src", "frontend"):
                value["packages"][workspace]["version"] = version
        else:
            value["version"] = version
        updates[path] = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    # Validate every input before writing any file. Repeated stamping is a no-op.
    mismatches = []
    for path, text in updates.items():
        current = path.read_text(encoding="utf-8")
        # --check compares metadata, not JSON whitespace.
        equal = (json.loads(current) == json.loads(text)) if path.suffix == ".json" else current == text
        if not equal:
            mismatches.append(str(path.relative_to(root)))
            if not check:
                path.write_text(text, encoding="utf-8", newline="\n")
    if check and mismatches:
        raise ValueError("Release versions do not match tag: " + ", ".join(mismatches))
    return mismatches


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--stable", action="store_true")
    args = parser.parse_args()
    try:
        changes = stamp(args.root, args.tag, args.check, args.stable)
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, f"{error}\n")
    print("Versions match" if args.check else f"Stamped {args.tag}: {len(changes)} files changed")


if __name__ == "__main__":
    main()
