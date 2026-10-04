#!/usr/bin/env python3
"""Check downloaded draft assets and write deterministic SHA256SUMS."""
import argparse
import base64
import subprocess
import tempfile
import hashlib
import json
from pathlib import Path
from urllib.parse import unquote, urlparse

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


def verify(root, tag, repository, public_key=None, minisign="minisign"):
    version = version_from_tag(tag, stable=True)
    assets = [path for path in sorted(root.iterdir()) if path.is_file()
              and path.name not in ("SHA256SUMS", "RELEASE_READY.json")]
    by_name = {path.name: path for path in assets}
    for name in ("latest.json", "vantyr-agent-linux-x86_64.tar.gz"):
        if name not in by_name or not by_name[name].stat().st_size:
            raise ValueError(f"Missing or empty asset: {name}")
    if not any(path.suffix == ".msi" and path.stat().st_size for path in assets):
        raise ValueError("Missing Windows MSI installer")
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
    args = parser.parse_args()
    try:
        public_key = json.loads(args.tauri_config.read_text())["plugins"]["updater"]["pubkey"]
        if not public_key:
            raise ValueError("Missing updater public key")
        verify(args.directory, args.tag, args.repository, public_key)
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, f"{error}\n")
    print("Draft updater signatures verified against public key; installers and version checked; SHA256SUMS written")


if __name__ == "__main__":
    main()
