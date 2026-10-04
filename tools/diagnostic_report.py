#!/usr/bin/env python3
"""Local, bounded, metadata-only Vantyr diagnostic report (standard library)."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import selectors
import signal
import time

TIMEOUT_SECONDS = 3
OUTPUT_LIMIT = 4096
ROOT = Path(__file__).resolve().parent.parent
TOOLS = {
    "git": (("git", "--version"), r"git version (\d+\.\d+(?:\.\d+)?)"),
    "node": (("node", "--version"), r"v(\d+\.\d+\.\d+)"),
    "docker": (("docker", "--version"), r"Docker version (\d+\.\d+\.\d+), build [0-9a-f]+"),
    "psql": (("psql", "--version"), r"psql \(PostgreSQL\) (\d+\.\d+(?:\.\d+)?)"),
}
ERRORS = {"unavailable", "timeout", "command_failed", "malformed_output", "output_limit", "storage_unavailable"}


def error(category):
    assert category in ERRORS
    return {"status": category}


def _stop_process(proc):
    """Kill our POSIX session group even if its leader has already exited."""
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            # No claim of descendant termination on Windows without a Job Object.
            proc.kill()
    except OSError:
        # ProcessLookupError is an expected race with normal command exit.
        pass
    try:
        proc.wait(timeout=0.5)
    except (subprocess.TimeoutExpired, OSError):
        pass


def _windows_pipe_chunk(pipe, maximum):
    """Poll a Windows anonymous pipe without a blocking reader thread."""
    import ctypes
    from ctypes import wintypes
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    peek = kernel.PeekNamedPipe
    peek.argtypes = (wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                     wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID)
    peek.restype = wintypes.BOOL
    available = wintypes.DWORD()
    handle = msvcrt.get_osfhandle(pipe.fileno())
    if not peek(handle, None, 0, None, ctypes.byref(available), None):
        if ctypes.get_last_error() == 109:  # ERROR_BROKEN_PIPE: all writers closed.
            return b""
        raise OSError("pipe_unavailable")
    if available.value:
        return os.read(pipe.fileno(), min(available.value, maximum))
    return None


def _read_stdout(proc, deadline):
    data = bytearray()
    selector = None
    try:
        if os.name == "posix":
            os.set_blocking(proc.stdout.fileno(), False)
            selector = selectors.DefaultSelector()
            selector.register(proc.stdout, selectors.EVENT_READ)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return b"", "timeout"
            maximum = OUTPUT_LIMIT + 1 - len(data)
            if selector is not None:
                if not selector.select(timeout=remaining):
                    return b"", "timeout"
                try:
                    chunk = os.read(proc.stdout.fileno(), maximum)
                except BlockingIOError:
                    continue
            else:
                chunk = _windows_pipe_chunk(proc.stdout, maximum)
                if chunk is None:
                    time.sleep(min(0.01, remaining))
                    continue
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > OUTPUT_LIMIT:
                return b"", "output_limit"
        try:
            proc.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            return b"", "timeout"
        return bytes(data), None
    except OSError:
        return b"", "command_failed"
    finally:
        if selector is not None:
            selector.close()


def command(args):
    """No shell, input, inherited tool options, stderr, or unbounded stdout buffer."""
    env = {"PATH": os.defpath, "LC_ALL": "C", "LANG": "C", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"}
    # Windows process startup may require SystemRoot; it is never serialized.
    if os.name == "nt" and "SystemRoot" in os.environ:
        env["SystemRoot"] = os.environ["SystemRoot"]
    try:
        proc = subprocess.Popen(args, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                bufsize=0, start_new_session=(os.name == "posix"))
    except FileNotFoundError:
        return None, b"", "unavailable"
    except OSError:
        return None, b"", "command_failed"
    try:
        data, failure = _read_stdout(proc, time.monotonic() + TIMEOUT_SECONDS)
        if failure:
            _stop_process(proc)
            return None, b"", failure
        return proc.returncode, data, None
    finally:
        proc.stdout.close()


def tool_version(name):
    args, pattern = TOOLS[name]
    code, data, failure = command(args)
    if failure:
        return error(failure)
    if code != 0:
        return error("command_failed")
    try:
        match = re.fullmatch(pattern, data.decode("ascii").strip())
    except UnicodeError:
        match = None
    return {"status": "ok", "version": match[1]} if match else error("malformed_output")


def git_metadata():
    prefix = ("git", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false")
    code, data, failure = command(prefix + ("rev-parse", "--verify", "HEAD"))
    if failure:
        return error(failure)
    if code != 0:
        return error("command_failed")
    try:
        commit = data.decode("ascii").strip()
    except UnicodeError:
        return error("malformed_output")
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", commit):
        return error("malformed_output")
    code, data, failure = command(prefix + ("diff", "--quiet", "--no-ext-diff",
                                          "--no-textconv", "--ignore-submodules", "HEAD", "--"))
    if failure:
        return {"status": "ok", "commit": commit, "tracked_changes": error(failure)}
    if code not in (0, 1):
        changes = error("command_failed")
    elif data:
        changes = error("malformed_output")
    else:
        changes = {"status": "ok", "dirty": code == 1}
    return {"status": "ok", "commit": commit, "tracked_changes": changes}


def storage_metadata(root):
    try:
        usage = shutil.disk_usage(root)
        if not (0 <= usage.free <= usage.total):
            return error("storage_unavailable")
        return {"status": "ok", "total_bytes": int(usage.total), "free_bytes": int(usage.free)}
    except (OSError, ValueError):
        return error("storage_unavailable")


def build_report(storage_root=None):
    families = {"Linux": "linux", "Windows": "windows", "Darwin": "macos",
                "FreeBSD": "freebsd", "OpenBSD": "openbsd", "NetBSD": "netbsd"}
    architectures = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "arm64",
                     "arm64": "arm64", "i386": "x86", "i686": "x86", "x86": "x86",
                     "armv7l": "arm", "armv6l": "arm", "riscv64": "riscv64"}
    return {
        "schema_version": 1,
        "system": {"os_family": families.get(platform.system(), "other"),
                   "architecture": architectures.get(platform.machine().lower(), "other")},
        "repository": git_metadata(),
        "tools": {"python": {"status": "ok", "version": ".".join(map(str, sys.version_info[:3]))},
                  **{name: tool_version(name) for name in TOOLS}},
        "storage": storage_metadata(storage_root) if storage_root is not None else {"status": "not_requested"},
    }


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default error may echo user-provided paths/arguments.
        self.exit(2, '{"error":"invalid_arguments"}\n')


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument("--storage-root", help="Explicit filesystem to sample capacity; no file traversal")
    parser.add_argument("--output", help="Explicit JSON output file (exclusive creation; never overwrite)")
    args = parser.parse_args(argv)
    payload = json.dumps(build_report(args.storage_root), sort_keys=True, indent=2) + "\n"
    if args.output is None:
        sys.stdout.write(payload)
        return 0
    try:
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(payload)
    except OSError:
        sys.stderr.write('{"error":"output_unavailable"}\n')
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
