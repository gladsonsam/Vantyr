#!/usr/bin/env python3
"""Check downloaded draft assets and write deterministic SHA256SUMS."""
import argparse
import base64
import subprocess
import tempfile
import hashlib
import json
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from release_stamp import version_from_tag


def verify_signature(asset, signature, public_key, minisign="minisign"):
    """Tauri wraps minisign keys/signatures in base64; verify the payload bytes."""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "public.key").write_bytes(base64.b64decode(public_key.strip(), validate=True))
        (root / "payload.sig").write_bytes(base64.b64decode(signature.strip(), validate=True))
        result = subprocess.run([
            minisign, "-Vm", str(asset.resolve()), "-x", str(root / "payload.sig"),
            "-p", str(root / "public.key"),
        ], capture_output=True, text=True)
        if result.returncode:
            raise ValueError(f"Updater signature verification failed: {asset.name}")


def pin_updater_urls(root, tag, repository, release):
    """Translate Tauri action v1 API asset URLs using this exact release's assets.

    Preserve version-pinned public download URLs for installed updaters. Never
    follow an arbitrary API URL or accept an asset from another release.
    """
    version_from_tag(tag, stable=True)
    if release.get("tag_name") != tag:
        raise ValueError("Asset manifest does not match release tag")
    path = root / "latest.json"
    metadata = json.loads(path.read_text(encoding="utf-8"))
    prefix = f"https://github.com/{repository}/releases/download/{tag}/"
    api_prefix = f"https://api.github.com/repos/{repository}/releases/assets/"
    changed = False
    for entry in metadata.get("platforms", {}).values():
        url = entry["url"]
        if url.startswith(prefix):
            continue  # Already pinned; the normal verifier checks name and signature.
        if not url.startswith(api_prefix) or not url[len(api_prefix):].isdigit():
            raise ValueError("Updater API URL is not an asset in this repository")
        matches = [asset for asset in release.get("assets", []) if asset.get("url") == url]
        if len(matches) != 1:
            raise ValueError("Updater asset does not belong to the requested release")
        asset = matches[0]
        target = asset.get("browser_download_url", "")
        # GitHub keeps drafts under a temporary untagged URL until publication.
        # Match this exact authenticated draft's URL before constructing the
        # final tag URL; never ship the temporary URL to installed updaters.
        draft_prefix = f"https://github.com/{repository}/releases/tag/untagged-"
        draft_url = release.get("html_url", "")
        if release.get("draft") is True and draft_url.startswith(draft_prefix):
            temporary_tag = draft_url[len(draft_prefix):]
            temporary_prefix = f"https://github.com/{repository}/releases/download/untagged-{temporary_tag}/"
            name = asset.get("name", "")
            if (temporary_tag and all(c in "0123456789abcdef" for c in temporary_tag)
                    and name and "/" not in name and "\\" not in name
                    and target.startswith(temporary_prefix)
                    and unquote(target[len(temporary_prefix):]) == name):
                target = prefix + quote(name, safe="")
        if not target.startswith(prefix) or unquote(target[len(prefix):]) != asset.get("name"):
            raise ValueError("Asset download URL is not pinned to this release")
        entry["url"] = target
        changed = True
    if changed:
        path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8", newline="\n")


def verify(root, tag, repository, public_key=None, minisign="minisign"):
    version = version_from_tag(tag, stable=True)
    assets = [path for path in sorted(root.iterdir()) if path.is_file()
              and path.name not in ("SHA256SUMS", "RELEASE_READY.json")]
    by_name = {path.name: path for path in assets}
    for name in ("latest.json", "vantyr-agent-linux-x86_64.tar.gz"):
        if name not in by_name or not by_name[name].stat().st_size:
            raise ValueError(f"Missing or empty asset: {name}")
    # Exactly one installer, built for this tag (tauri: `<product>_<version>_x64_<lang>.msi`).
    installers = [path for path in assets if path.suffix == ".msi"]
    if len(installers) != 1 or not installers[0].stat().st_size:
        raise ValueError(f"Expected exactly one Windows MSI installer, found {len(installers)}")
    if f"_{version}_" not in installers[0].name:
        raise ValueError(f"Windows MSI installer does not match version {version}: {installers[0].name}")
    metadata = json.loads(by_name["latest.json"].read_text())
    if metadata.get("version", "").removeprefix("v") != version:
        raise ValueError("Updater version does not match tag")
    platforms = metadata.get("platforms", {})
    if "windows-x86_64" not in platforms:
        raise ValueError("Missing windows-x86_64 updater target")
    for platform, entry in platforms.items():
        url = urlparse(entry["url"])
        prefix = f"/{repository}/releases/download/{tag}/"
        if url.scheme != "https" or url.netloc != "github.com" or not unquote(url.path).startswith(prefix):
            raise ValueError(f"Updater URL is not pinned to this release: {platform}")
        name = unquote(url.path)[len(prefix):]
        asset = by_name.get(name)
        signature = by_name.get(name + ".sig")
        if not asset or not asset.stat().st_size or not signature:
            raise ValueError(f"Missing updater payload/signature: {name}")
        if not entry.get("signature") or signature.read_text().strip() != entry["signature"].strip():
            raise ValueError(f"Updater signature differs from asset: {name}")
        if public_key:
            verify_signature(asset, entry["signature"], public_key, minisign)
    checksums = ""
    for path in assets:
        with path.open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        checksums += f"{digest}  {path.name}\n"
    (root / "SHA256SUMS").write_text(checksums, encoding="utf-8", newline="\n")
    return checksums


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("tag")
    parser.add_argument("repository")
    parser.add_argument("--tauri-config", type=Path, required=True,
                        help="Config containing the deployed updater public key")
    parser.add_argument("--release-metadata", type=Path,
                        help="GitHub release API JSON, used to pin Tauri v1 asset URLs")
    args = parser.parse_args()
    try:
        public_key = json.loads(args.tauri_config.read_text())["plugins"]["updater"]["pubkey"]
        if not public_key:
            raise ValueError("Missing updater public key")
        if args.release_metadata:
            pin_updater_urls(args.directory, args.tag, args.repository,
                             json.loads(args.release_metadata.read_text(encoding="utf-8")))
        verify(args.directory, args.tag, args.repository, public_key)
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, f"{error}\n")
    print("Draft updater signatures verified against public key; installers and version checked; SHA256SUMS written")


if __name__ == "__main__":
    main()
