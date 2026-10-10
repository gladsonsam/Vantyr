"""Local-only actual-parser/HTTP tests; no agent or external endpoint."""
import contextlib
import http.server
import io
import json
import os
import socket
import threading
import time
import unittest
from unittest import mock

import media_benchmark as mb

JPEG = b'\xff\xd8private-fixture\x00--mjpegframe\r\n\xff\xd9'


def part(image=JPEG, boundary=b'mjpegframe'):
    return (b'--' + boundary + b'\r\nContent-Type: image/jpeg\r\nContent-Length: ' +
            str(len(image)).encode() + b'\r\n\r\n' + image + b'\r\n')


@contextlib.contextmanager
def local_server(mode):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if mode == 'header_oversize':
                self.connection.sendall(b'HTTP/1.1 200 OK\r\nX-Test: ' + b'x' * (mb.HEADER_LIMIT + 1) + b'\r\n\r\n')
                return
            if mode == 'header_stall':
                self.connection.sendall(b'HTTP/1.1 200 OK\r\nX-Test: ')
                while not self.server.done.wait(.01):
                    try:
                        self.connection.sendall(b'x')
                    except OSError:
                        break
                return
            self.send_response(200 if mode != 'status' else 403)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=mjpegframe')
            if mode == 'chunked_stall':
                self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            try:
                if mode == 'chunked_stall':
                    self.wfile.write(b'a')  # Incomplete chunk size, no newline.
                    self.wfile.flush()
                elif mode == 'corrupt':
                    self.wfile.write(part(b'not a jpeg'))
                    self.wfile.flush()
                    return
                elif mode == 'eof':
                    self.wfile.write(part())
                    self.wfile.flush()
                    return
                elif mode == 'frames':
                    while not self.server.done.is_set():
                        self.wfile.write(part())
                        self.wfile.flush()
                        self.server.done.wait(.015)
                else:
                    self.server.done.wait(2)
                if mode == 'chunked_stall':
                    self.server.done.wait(2)
            except (OSError, ConnectionError):
                pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    server.done = threading.Event()
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01})
    thread.start()
    try:
        yield 'http://127.0.0.1:%d/agents/private-id/mjpeg?session=secret&token=private-token' % server.server_port
    finally:
        server.done.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()


class ParserTests(unittest.TestCase):
    def test_generated_multipart_every_chunk_split_and_embedded_boundary(self):
        wire = part() * 3 + b'--mjpegframe--\r\n'
        for size in range(1, len(wire) + 1):
            parser = mb.MultipartParser(b'mjpegframe')
            frames = []
            for i in range(0, len(wire), size):
                frames.extend(parser.feed(wire[i:i + size]))
            parser.finish()
            self.assertEqual(frames, [len(JPEG)] * 3)
            self.assertTrue(parser.done)

    def test_content_type_boundary_quoted_and_validation(self):
        self.assertEqual(mb.boundary_from('multipart/x-mixed-replace; boundary="mjpegframe"'), b'mjpegframe')
        for value in ['image/jpeg', 'multipart/x-mixed-replace', 'multipart/x-mixed-replace; boundary="a b"', 'x' * 513]:
            with self.assertRaises(mb.ProtocolError):
                mb.boundary_from(value)

    def test_corruption_length_headers_oversize_and_truncation(self):
        invalid = [part(b'bad!'), part().replace(b'Content-Length:', b'Content-Length: -'),
                   part().replace(b'Content-Length:', b'Content-Length: 99999999\r\nBad:'),
                   part().replace(b'Content-Type: image/jpeg', b'Content-Type: image/jpeg\r\nContent-Type: image/jpeg'),
                   part().replace(b'Content-Length: ', b'Content-Length: 99999999'),
                   part().replace(b'--mjpegframe', b'--wrong'), part()[:-2] + b'xx',
                   b'--mjpegframe\r\n' + b'x' * (mb.HEADER_LIMIT + 1)]
        for wire in invalid:
            with self.assertRaises(mb.ProtocolError):
                list(mb.MultipartParser(b'mjpegframe').feed(wire))
        parser = mb.MultipartParser(b'mjpegframe', max_frame=4)
        with self.assertRaises(mb.ProtocolError):
            list(parser.feed(part()))
        parser = mb.MultipartParser(b'mjpegframe')
        list(parser.feed(part()[:-1]))
        with self.assertRaisesRegex(mb.ProtocolError, 'truncated'):
            parser.finish()
        with self.assertRaisesRegex(mb.ProtocolError, 'chunk_limit'):
            list(parser.feed(b'x' * (mb.CHUNK + 1)))


class ReceiveTests(unittest.TestCase):
    def test_warmup_frames_metrics_and_report_contains_no_private_content(self):
        with local_server('frames') as url:
            report = mb.benchmark(url, mb.Config(duration=.16, warmup=.04, timeout=1), mb.authorization('cookie', 'secret-cookie'))
        m = report['measurement']
        self.assertGreater(m['marker_valid_frames'], 2)
        self.assertGreater(m['bytes_per_second'], 0)
        self.assertGreater(m['interval_median_ms'], 0)
        self.assertGreaterEqual(m['interval_p95_ms'], m['interval_median_ms'])
        self.assertEqual(report['connections']['termination'], 'duration')
        self.assertLessEqual(m['elapsed_seconds'], .161)
        rendered = json.dumps(report)
        for secret in ['private-fixture', 'private-id', 'private-token', 'secret-cookie', 'session=', '127.0.0.1']:
            self.assertNotIn(secret, rendered)

    def test_absolute_duration_bounds_stalled_body_and_trickling_headers(self):
        for mode in ['stall', 'chunked_stall', 'header_stall']:
            with local_server(mode) as url:
                started = time.monotonic()
                report = mb.benchmark(url, mb.Config(duration=.08, warmup=0, timeout=1, gap_ms=20))
                self.assertLess(time.monotonic() - started, .5)
                self.assertEqual(report['connections']['termination'], 'duration')
                self.assertEqual(report['measurement']['marker_valid_frames'], 0)
                self.assertEqual(report['measurement']['gaps'], 1)

    def test_cancellation_closes_stalled_read_and_joins_watchdog(self):
        with local_server('stall') as url:
            cancel = threading.Event()
            timer = threading.Timer(.05, cancel.set)
            timer.start()
            report = mb.benchmark(url, mb.Config(duration=2, warmup=0, timeout=1), cancel=cancel)
            timer.join()
        self.assertEqual(report['connections']['termination'], 'cancelled')
        self.assertLess(report['measurement']['elapsed_seconds'], .5)
        self.assertFalse(any(t.name == 'media-deadline' and t.is_alive() for t in threading.enumerate()))

    def test_timeouts_reconnections_and_fixed_error_codes(self):
        for mode, code in [('stall', 'timeout'), ('eof', 'eof'), ('corrupt', 'invalid_jpeg_markers'), ('status', 'http_status_403'), ('header_oversize', 'response_header_limit')]:
            with local_server(mode) as url:
                report = mb.benchmark(url, mb.Config(duration=1, warmup=0, timeout=.02, max_reconnects=2, reconnect_delay=.01))
            self.assertEqual(report['connections']['attempts'], 3)
            self.assertEqual(report['connections']['reconnects'], 2)
            self.assertEqual(report['connections']['errors'], [code] * 3)
            self.assertEqual(report['connections']['termination'], code)

    @unittest.skipUnless(os.name == 'posix', 'Windows environment auth only')
    def test_stdin_auth_timeout_cancellation_and_size_limit(self):
        read_fd, write_fd = os.pipe()
        try:
            with os.fdopen(read_fd) as stream:
                with self.assertRaises(TimeoutError):
                    mb.stdin_secret(stream, .02, threading.Event())
                cancel = threading.Event()
                cancel.set()
                with self.assertRaises(KeyboardInterrupt):
                    mb.stdin_secret(stream, .2, cancel)
                os.write(write_fd, b'x' * 4097)
                with self.assertRaises(ValueError):
                    mb.stdin_secret(stream, .2, threading.Event())
        finally:
            os.close(write_fd)

    def test_invalid_url_config_and_auth_without_request(self):
        for url in ['http://user:password@127.0.0.1/x', 'https://example.com/x', 'file:///tmp/a', 'http://127.0.0.1/\r\nx']:
            with self.assertRaises(ValueError):
                mb.benchmark(url, mb.Config())
        for config in [mb.Config(duration=float('nan')), mb.Config(duration=0), mb.Config(max_reconnects=11)]:
            with self.assertRaises(ValueError):
                config.validate()
        for secret in ['', 'abc\r\nX: secret', 'x' * 4097]:
            with self.assertRaises(ValueError):
                mb.authorization('cookie', secret)
        parsed, ip, _, _ = mb.endpoint('https://example.com/stream', '127.0.0.1')
        self.assertEqual(parsed.hostname, 'example.com')
        self.assertEqual(str(ip), '127.0.0.1')

    def test_cli_json_csv_env_and_stdin_no_auth_in_output(self):
        with local_server('frames') as url:
            for fmt, auth in [('json', ['--auth-env', 'TEST_AUTH']), ('csv', ['--auth-stdin'])]:
                out = io.StringIO()
                read_fd, write_fd = os.pipe()
                os.write(write_fd, b'sensitive-cookie\n')
                os.close(write_fd)
                with os.fdopen(read_fd) as stdin, mock.patch.dict(os.environ, {'TEST_URL': url, 'TEST_AUTH': 'sensitive-cookie'}), mock.patch('sys.stdin', stdin), contextlib.redirect_stdout(out):
                    code = mb.main(['--url-env', 'TEST_URL', '--format', fmt, '--duration', '.04', '--warmup', '0'] + auth)
                self.assertEqual(code, 0)
                self.assertNotIn('sensitive', out.getvalue())
                self.assertNotIn('private', out.getvalue())
                self.assertIn('marker_valid_frames', out.getvalue())


if __name__ == '__main__':
    unittest.main()
