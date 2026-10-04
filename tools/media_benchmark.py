#!/usr/bin/env python3
"""Bounded MJPEG receive benchmark. Never writes payloads or authentication."""
import argparse
import csv
import email.message
import http.client
import ipaddress
import json
import math
import os
import signal
import select
import socket
import ssl
import statistics
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass

CHUNK = 64 * 1024
HEADER_LIMIT = 16 * 1024
SAMPLE_LIMIT = 100_000


class ProtocolError(Exception):
    """A fixed, content-free protocol failure code."""


def boundary_from(content_type):
    if len(content_type) > 512:
        raise ProtocolError("content_type_limit")
    msg = email.message.Message()
    msg['content-type'] = content_type
    boundary = msg.get_param('boundary')
    if msg.get_content_type().lower() != 'multipart/x-mixed-replace' or not boundary:
        raise ProtocolError('not_mjpeg')
    try:
        encoded = boundary.encode('ascii')
    except UnicodeError:
        raise ProtocolError('invalid_boundary') from None
    if not 1 <= len(encoded) <= 70 or any(c < 33 or c > 126 for c in encoded):
        raise ProtocolError('invalid_boundary')
    return encoded


class MultipartParser:
    """Strict Content-Length parser; one bounded frame, no searching JPEG delimiters.

    Frame validity means JPEG SOI/EOI markers, not a full image decode.
    """
    def __init__(self, boundary, max_frame=16 * 1024 * 1024):
        self.marker = b'--' + boundary
        self.max_frame = max_frame
        self.buffer = bytearray()
        self.state = 'boundary'
        self.length = 0
        self.done = False

    def feed(self, data):
        if len(data) > CHUNK:
            raise ProtocolError('chunk_limit')
        self.buffer.extend(data)
        while True:
            if self.state == 'boundary':
                end = self.buffer.find(b'\r\n')
                if end < 0:
                    if len(self.buffer) > 74:
                        raise ProtocolError('boundary_limit')
                    return
                line = bytes(self.buffer[:end])
                del self.buffer[:end + 2]
                if line == self.marker + b'--':
                    self.done = True
                    if self.buffer:
                        raise ProtocolError('unexpected_epilogue')
                    return
                if line != self.marker:
                    raise ProtocolError('invalid_boundary_line')
                self.state = 'headers'
            elif self.state == 'headers':
                end = self.buffer.find(b'\r\n\r\n')
                if end < 0:
                    if len(self.buffer) > HEADER_LIMIT:
                        raise ProtocolError('part_header_limit')
                    return
                if end + 4 > HEADER_LIMIT:
                    raise ProtocolError('part_header_limit')
                headers = {}
                for line in bytes(self.buffer[:end]).split(b'\r\n'):
                    key, sep, value = line.partition(b':')
                    key = key.lower()
                    if not sep or key in headers or key not in (b'content-type', b'content-length'):
                        raise ProtocolError('invalid_part_header')
                    headers[key] = value.strip()
                raw = headers.get(b'content-length', b'')
                if headers.get(b'content-type', b'').lower() != b'image/jpeg' or not raw.isdigit() or len(raw) > 10:
                    raise ProtocolError('invalid_part_header')
                self.length = int(raw)
                if not 4 <= self.length <= self.max_frame:
                    raise ProtocolError('frame_size_limit')
                del self.buffer[:end + 4]
                self.state = 'frame'
            else:
                if len(self.buffer) < self.length + 2:
                    return
                if self.buffer[:2] != b'\xff\xd8' or self.buffer[self.length - 2:self.length] != b'\xff\xd9':
                    raise ProtocolError('invalid_jpeg_markers')
                if self.buffer[self.length:self.length + 2] != b'\r\n':
                    raise ProtocolError('invalid_part_terminator')
                del self.buffer[:self.length + 2]
                self.state = 'boundary'
                yield self.length
            if self.done:
                return

    def finish(self):
        if self.buffer or self.state != 'boundary':
            raise ProtocolError('truncated_multipart')


@dataclass
class Config:
    duration: float = 10
    warmup: float = 1
    timeout: float = 1
    max_reconnects: int = 0
    reconnect_delay: float = .25
    gap_ms: float = 1000
    max_frame: int = 16 * 1024 * 1024
    connect_ip: str | None = None

    def validate(self):
        for value, low, high in [(self.duration, .01, 3600), (self.warmup, 0, 300),
                                 (self.timeout, .01, 10), (self.reconnect_delay, 0, 10),
                                 (self.gap_ms, 1, 3_600_000)]:
            if not math.isfinite(value) or not low <= value <= high:
                raise ValueError('invalid configuration bounds')
        if not 0 <= self.max_reconnects <= 10 or not 4 <= self.max_frame <= 32 * 1024 * 1024:
            raise ValueError('invalid configuration bounds')


class Deadline:
    """One joined watchdog; closes current socket on cancellation/absolute deadline.

    This bounds trickling HTTP/chunk headers too, where per-read timeouts alone
    could be restarted indefinitely. No reader thread, queue or abandoned worker.
    """
    def __init__(self, end, cancel):
        self.end, self.cancel = end, cancel
        self.lock = threading.Lock()
        self.sock = None
        self.finish = threading.Event()
        self.thread = threading.Thread(target=self.watch, name='media-deadline', daemon=True)
        self.thread.start()

    def watch(self):
        while not self.finish.wait(.02):
            if self.cancel.is_set() or time.monotonic() >= self.end:
                with self.lock:
                    if self.sock:
                        try:
                            self.sock.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                        self.sock.close()
                return

    def attach(self, sock):
        with self.lock:
            self.sock = sock
            if self.cancel.is_set() or time.monotonic() >= self.end:
                sock.close()
                raise TimeoutError()

    def close(self):
        self.finish.set()
        self.thread.join()


def endpoint(url, connect_ip):
    if len(url) > 8192 or any(ord(c) < 32 or ord(c) == 127 for c in url):
        raise ValueError('invalid URL')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError('use HTTP(S) URL without userinfo or fragment')
    # Avoid uncancellable OS DNS lookups; TLS/Host still use original hostname.
    ip = ipaddress.ip_address(connect_ip or parsed.hostname)
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    if not 1 <= port <= 65535:
        raise ValueError('invalid port')
    target = urllib.parse.urlunsplit(('', '', parsed.path or '/', parsed.query, ''))
    return parsed, ip, port, target


def authorization(kind, secret):
    if kind not in ('bearer', 'cookie') or len(secret) > 4096 or not secret or any(ord(c) < 32 or ord(c) > 126 for c in secret):
        raise ValueError('invalid authentication input')
    return {'Authorization': 'Bearer ' + secret} if kind == 'bearer' else {'Cookie': secret}


class BoundedResponse(http.client.HTTPResponse):
    def begin(self):
        raw = self.fp

        class HeaderReader:
            remaining = HEADER_LIMIT

            def readline(self, limit=-1):
                line = raw.readline(min(limit if limit >= 0 else self.remaining + 1, self.remaining + 1))
                self.remaining -= len(line)
                if self.remaining < 0:
                    raise ProtocolError('response_header_limit')
                return line

            def __getattr__(self, name):
                return getattr(raw, name)

        reader = HeaderReader()
        self.fp = reader
        try:
            super().begin()
        finally:
            if self.fp is reader:
                self.fp = raw


def stdin_secret(stream, timeout, cancel):
    # select on pipes/terminal file descriptors is POSIX-only. Windows uses env
    # instead of leaving a blocked stdin reader thread behind on cancellation.
    if os.name != 'posix':
        raise ValueError('stdin authentication requires POSIX; use environment')
    fd = stream.fileno()
    end = time.monotonic() + timeout
    value = bytearray()
    while time.monotonic() < end:
        if cancel.is_set():
            raise KeyboardInterrupt()
        ready, _, _ = select.select([fd], [], [], min(.02, max(0, end - time.monotonic())))
        if ready:
            chunk = os.read(fd, 4098 - len(value))
            value.extend(chunk)
            if len(value) > 4096:
                raise ValueError('authentication input limit')
            if not chunk or b'\n' in value:
                return bytes(value).split(b'\n', 1)[0].rstrip(b'\r').decode('ascii')
    raise TimeoutError()


def benchmark(url, config, auth=None, cancel=None):
    config.validate()
    parsed, ip, port, target = endpoint(url, config.connect_ip)
    cancel = cancel or threading.Event()
    start = time.monotonic()
    measurement_start = start + config.warmup
    end = measurement_start + config.duration
    deadline = Deadline(end, cancel)
    arrivals, errors = [], []
    received = frames = attempts = reconnects = 0
    termination = 'duration'
    try:
        while time.monotonic() < end and not cancel.is_set():
            attempts += 1
            connection = http.client.HTTPConnection(parsed.hostname, port)
            connection.response_class = BoundedResponse
            response = None
            try:
                family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
                sock = socket.socket(family, socket.SOCK_STREAM)
                sock.settimeout(min(config.timeout, max(.001, end - time.monotonic())))
                deadline.attach(sock)
                sock.connect((str(ip), port))
                if parsed.scheme == 'https':
                    sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parsed.hostname, do_handshake_on_connect=False)
                    deadline.attach(sock)
                    sock.do_handshake()
                connection.sock = sock
                # No redirects, proxies or ambient cookie jar; never forward secrets.
                connection.request('GET', target, headers={'Accept': 'multipart/x-mixed-replace', **(auth or {})})
                response = connection.getresponse()
                # http.client additionally enforces 64KiB/line and 100 header lines.
                if sum(len(k) + len(v) + 4 for k, v in response.getheaders()) > HEADER_LIMIT:
                    raise ProtocolError('response_header_limit')
                if response.status != 200:
                    raise ProtocolError('http_status_' + str(response.status))
                parser = MultipartParser(boundary_from(response.getheader('Content-Type', '')), config.max_frame)
                while time.monotonic() < end and not cancel.is_set():
                    data = response.read1(CHUNK)
                    now = time.monotonic()
                    if now >= end or cancel.is_set():
                        break
                    if not data:
                        parser.finish()
                        raise ProtocolError('eof')
                    if now >= measurement_start:
                        received += len(data)
                    for _size in parser.feed(data):
                        if now >= measurement_start:
                            if len(arrivals) >= SAMPLE_LIMIT:
                                raise ProtocolError('sample_limit')
                            arrivals.append(now - measurement_start)
                            frames += 1
                    if parser.done:
                        raise ProtocolError('multipart_end')
            except (OSError, http.client.HTTPException, ProtocolError) as exc:
                if cancel.is_set():
                    termination = 'cancelled'
                    break
                if time.monotonic() >= end:
                    break
                code = str(exc) if isinstance(exc, ProtocolError) else ('timeout' if isinstance(exc, TimeoutError) else 'transport_error')
                errors.append(code)  # Never exception details, URL, headers or body.
                if code == 'sample_limit':
                    termination = code
                    break
                if reconnects >= config.max_reconnects:
                    termination = code
                    break
                reconnects += 1
                cancel.wait(min(config.reconnect_delay, max(0, end - time.monotonic())))
            finally:
                if response is not None:
                    response.close()
                connection.close()
                with deadline.lock:
                    if deadline.sock:
                        deadline.sock.close()
                    deadline.sock = None
        if cancel.is_set():
            termination = 'cancelled'
    finally:
        deadline.close()
    elapsed = max(0, min(time.monotonic(), end) - measurement_start)
    intervals = sorted((b - a) * 1000 for a, b in zip(arrivals, arrivals[1:]))
    p95 = intervals[max(0, math.ceil(len(intervals) * .95) - 1)] if intervals else None
    # Include leading/trailing silence and reconnect downtime in gap counts.
    silences = [b - a for a, b in zip([0] + arrivals, arrivals + [elapsed])]
    return {
        'schema_version': 1,
        # Deliberately no URL path/query/host/IP/session, even if supplied privately.
        'endpoint': {'scheme': parsed.scheme, 'protocol': 'mjpeg'},
        'config': {key: getattr(config, key) for key in ('duration', 'warmup', 'timeout', 'max_reconnects', 'reconnect_delay', 'gap_ms', 'max_frame')},
        'measurement': {'elapsed_seconds': elapsed, 'body_bytes': received, 'bytes_per_second': received / elapsed if elapsed else 0,
                        'marker_valid_frames': frames, 'frames_per_second': frames / elapsed if elapsed else 0,
                        'interval_median_ms': statistics.median(intervals) if intervals else None,
                        'interval_p95_ms': p95, 'max_silence_ms': max(silences, default=0) * 1000,
                        'gaps': sum(g * 1000 >= config.gap_ms for g in silences)},
        'connections': {'attempts': attempts, 'reconnects': reconnects, 'errors': errors, 'termination': termination},
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', help='non-secret stream URL; use --url-env for private query values')
    parser.add_argument('--url-env', help='environment variable containing the full stream URL')
    parser.add_argument('--connect-ip', help='numeric IP for DNS hosts; preserves HTTP Host/TLS identity')
    for name, default in [('duration', 10), ('warmup', 1), ('timeout', 1), ('gap-ms', 1000), ('reconnect-delay', .25)]:
        parser.add_argument('--' + name, type=float, default=default)
    parser.add_argument('--max-reconnects', type=int, default=0)
    parser.add_argument('--max-frame', type=int, default=16 * 1024 * 1024)
    parser.add_argument('--auth-kind', choices=['bearer', 'cookie'], default='cookie')
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument('--auth-env', help='environment variable containing auth secret')
    auth.add_argument('--auth-stdin', action='store_true', help='one bounded line from stdin')
    parser.add_argument('--format', choices=['json', 'csv'], default='json')
    args = parser.parse_args(argv)
    cancel = threading.Event()
    old = signal.signal(signal.SIGINT, lambda *_: cancel.set())
    try:
        if bool(args.url) == bool(args.url_env):
            raise ValueError('choose exactly one URL source')
        url = args.url or os.environ.get(args.url_env, '')
        # Credentials cannot appear in argv. Environment values never enter report.
        config = Config(**{key: getattr(args, key) for key in Config.__dataclass_fields__})
        config.validate()
        secret = os.environ.get(args.auth_env, '') if args.auth_env else (stdin_secret(sys.stdin, config.timeout, cancel) if args.auth_stdin else None)
        headers = authorization(args.auth_kind, secret) if secret is not None else None
        result = benchmark(url, config, headers, cancel)
        if args.format == 'json':
            print(json.dumps(result, sort_keys=True, allow_nan=False))
        else:
            flat = {group + '.' + key: json.dumps(value) if isinstance(value, (list, dict)) else value
                    for group, values in result.items() if isinstance(values, dict) for key, value in values.items()}
            writer = csv.DictWriter(sys.stdout, fieldnames=flat.keys())
            writer.writeheader()
            writer.writerow(flat)
        return 0 if result['connections']['termination'] == 'duration' else 1
    except KeyboardInterrupt:
        return 130
    except (ValueError, OSError):
        print('Invalid configuration or unavailable input; no request/report details logged.', file=sys.stderr)
        return 2
    finally:
        signal.signal(signal.SIGINT, old)


if __name__ == '__main__':
    sys.exit(main())
