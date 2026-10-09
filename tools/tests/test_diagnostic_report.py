"""Fixture tests: never connect to services or inspect production data."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import tempfile
import unittest
from unittest.mock import Mock, patch

import diagnostic_report as report


class DiagnosticTests(unittest.TestCase):
    def test_versions_are_normalized_and_private_suffixes_rejected(self):
        fixtures = {"git": b"git version 2.45.1\n", "node": b"v22.3.1\n",
                    "docker": b"Docker version 27.0.1, build abc123\n",
                    "psql": b"psql (PostgreSQL) 16.4\n"}
        for name, data in fixtures.items():
            with self.subTest(name=name), patch.object(report, "command", return_value=(0, data, None)):
                result = report.tool_version(name)
                self.assertEqual(result["status"], "ok")
                self.assertRegex(result["version"], r"^\d+\.\d+(\.\d+)?$")
            for malicious in (data + b"private /home/person TOKEN=secret", b"\xff", b"unexpected"):
                with patch.object(report, "command", return_value=(0, malicious, None)):
                    self.assertEqual(report.tool_version(name), {"status": "malformed_output"})

    def test_git_metadata_only_and_malformed_outputs(self):
        for code, dirty in ((0, False), (1, True)):
            with patch.object(report, "command", side_effect=[(0, b"a" * 40 + b"\n", None), (code, b"", None)]) as run:
                result = report.git_metadata()
                self.assertEqual(result["tracked_changes"], {"status": "ok", "dirty": dirty})
                commands = [call.args[0] for call in run.call_args_list]
                self.assertIn("--no-ext-diff", commands[1])
                self.assertNotIn("status", commands[1])
        for data in (b"private /home/person", b"a" * 39, b"\xff", b"a" * 40 + b"\nsecret"):
            with patch.object(report, "command", return_value=(0, data, None)):
                self.assertEqual(report.git_metadata(), {"status": "malformed_output"})
        with patch.object(report, "command", side_effect=[(0, b"a" * 64, None), (1, b"private-filename", None)]):
            self.assertEqual(report.git_metadata()["tracked_changes"], {"status": "malformed_output"})

    def test_failure_categories_never_include_output(self):
        for failure in ("unavailable", "timeout", "output_limit"):
            with patch.object(report, "command", return_value=(None, b"secret /private", failure)):
                self.assertEqual(report.tool_version("git"), {"status": failure})
        with patch.object(report, "command", return_value=(7, b"secret /private", None)):
            self.assertEqual(report.tool_version("git"), {"status": "command_failed"})

    def test_command_unavailable_and_launch_error(self):
        for exception, category in ((FileNotFoundError("private"), "unavailable"), (OSError("private"), "command_failed")):
            with patch.object(report.subprocess, "Popen", side_effect=exception):
                self.assertEqual(report.command(("git", "--version")), (None, b"", category))

    def local_command(self, source, timeout=0.4):
        """Only an explicit Python fixture; never external services or real data."""
        started = []
        real_popen = subprocess.Popen

        def launch(*args, **kwargs):
            proc = real_popen(*args, **kwargs)
            started.append((proc, kwargs))
            return proc

        before = time.monotonic()
        with patch.object(report, "TIMEOUT_SECONDS", timeout), \
             patch.object(report.subprocess, "Popen", side_effect=launch):
            result = report.command((sys.executable, "-c", source))
        self.assertLess(time.monotonic() - before, timeout + 1.0)
        self.assertTrue(started[0][0].stdout.closed)
        self.assertIsNotNone(started[0][0].poll())
        options = started[0][1]
        self.assertNotIn("shell", options)
        self.assertEqual(options["stderr"], subprocess.DEVNULL)
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertNotIn("NODE_OPTIONS", options["env"])
        self.assertEqual(options["start_new_session"], os.name == "posix")
        return result

    def test_actual_excessive_stdout_is_bounded(self):
        reads = []
        real_read = os.read

        def read(fd, maximum):
            chunk = real_read(fd, maximum)
            reads.append((maximum, len(chunk)))
            return chunk

        with patch.object(report.os, "read", side_effect=read):
            result = self.local_command("import os,time; os.write(1,b'x'*100000); time.sleep(10)")
        self.assertEqual(result, (None, b"", "output_limit"))
        self.assertTrue(reads)
        # Popen also reads an empty exec-error pipe. Total captured bytes across
        # every read must still remain bounded, not just individual requests.
        self.assertLessEqual(sum(length for _, length in reads), report.OUTPUT_LIMIT + 1)
        self.assertTrue(all(maximum <= report.OUTPUT_LIMIT + 1
                            for maximum, length in reads if length))

    def test_actual_trickling_stdout_uses_overall_deadline(self):
        result = self.local_command(
            "import os,time\nfor i in range(100):\n os.write(1,b'x'); time.sleep(.025)",
            timeout=0.2,
        )
        self.assertEqual(result, (None, b"", "timeout"))

    def test_actual_closed_stdout_but_hung_process_times_out(self):
        self.assertEqual(self.local_command("import os,time; os.close(1); time.sleep(10)"),
                         (None, b"", "timeout"))

    def test_actual_normal_output_and_exit(self):
        self.assertEqual(self.local_command("import os; os.write(1,b'v22.3.1\\n')"),
                         (0, b"v22.3.1\n", None))

    @unittest.skipUnless(os.name == "posix", "POSIX owned process-group cleanup")
    def test_actual_descendant_holding_pipe_is_killed(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = str(Path(directory) / "descendant-survived")
            child = "import time,pathlib; time.sleep(.8); pathlib.Path(%r).write_text('alive')" % marker
            source = "import subprocess,sys; subprocess.Popen([sys.executable,'-c',%r])" % child
            self.assertEqual(self.local_command(source, timeout=0.4), (None, b"", "timeout"))
            time.sleep(1.0)
            self.assertFalse(Path(marker).exists(), "descendant escaped process-group cleanup")

    def test_cleanup_tolerates_normal_exit_race(self):
        proc = Mock(pid=12345)
        with patch.object(report.os, "killpg", side_effect=ProcessLookupError("private")) if os.name == "posix" else \
             patch.object(proc, "kill", side_effect=ProcessLookupError("private")):
            report._stop_process(proc)
        proc.wait.assert_called_once_with(timeout=0.5)

    def test_schema_and_system_redaction(self):
        with patch.object(report, "git_metadata", return_value={"status": "unavailable"}), \
             patch.object(report, "tool_version", return_value={"status": "unavailable"}), \
             patch.object(report.platform, "system", return_value="private-host"), \
             patch.object(report.platform, "machine", return_value="private-user"), \
             patch.object(report.shutil, "disk_usage", side_effect=AssertionError("must not inspect storage")):
            result = report.build_report()
        self.assertEqual(set(result), {"schema_version", "system", "repository", "tools", "storage"})
        self.assertEqual(set(result["tools"]), {"python", "git", "node", "docker", "psql"})
        self.assertEqual(result["system"], {"os_family": "other", "architecture": "other"})
        self.assertEqual(result["storage"], {"status": "not_requested"})
        self.assertNotIn("private", json.dumps(result))

    def test_storage_only_aggregate_no_traversal_or_contents(self):
        usage = Mock(total=1000, free=250)
        with patch.object(report.shutil, "disk_usage", return_value=usage) as disk, \
             patch("builtins.open", side_effect=AssertionError("no content reads")), \
             patch.object(report.os, "walk", side_effect=AssertionError("no traversal")), \
             patch.object(report.os, "scandir", side_effect=AssertionError("no traversal")):
            result = report.storage_metadata("/private/storage")
            disk.assert_called_once_with("/private/storage")
        self.assertEqual(result, {"status": "ok", "total_bytes": 1000, "free_bytes": 250})
        self.assertNotIn("private", json.dumps(result))
        with patch.object(report.shutil, "disk_usage", side_effect=OSError("secret path")):
            self.assertEqual(report.storage_metadata("private"), {"status": "storage_unavailable"})

    def test_stdout_and_exclusive_output(self):
        fixture = {"schema_version": 1, "storage": {"status": "not_requested"}}
        with patch.object(report, "build_report", return_value=fixture), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(report.main([]), 0)
            self.assertEqual(json.loads(out.getvalue()), fixture)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            with patch.object(report, "build_report", return_value=fixture), contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(report.main(["--output", str(path)]), 0)
                self.assertEqual(out.getvalue(), "")
            self.assertEqual(json.loads(path.read_text()), fixture)
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with patch.object(report, "build_report", return_value=fixture), contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(report.main(["--output", str(path)]), 1)
                self.assertEqual(err.getvalue(), '{"error":"output_unavailable"}\n')
            self.assertEqual(json.loads(path.read_text()), fixture)

    def test_invalid_argument_does_not_echo_private_value(self):
        with contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as raised:
            report.main(["--secret=/private/token"])
        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(err.getvalue(), '{"error":"invalid_arguments"}\n')


if __name__ == "__main__":
    unittest.main()
