#!/usr/bin/env python3
"""Stream Compose database, Recall images and config directly into age encryption."""
import argparse
import hashlib
import json
import os
import io
import posixpath
import signal
from pathlib import Path
import shutil
import subprocess
import tarfile
import uuid
from datetime import datetime, timezone


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def encrypted_command(command, destination, age, recipient_file, cwd):
    """No plaintext temporary file; both producer and encryptor must succeed."""
    with destination.open('xb') as target:
        source = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
        encrypt = None
        try:
            encrypt = subprocess.Popen([age, '-R', str(recipient_file)], stdin=source.stdout, stdout=target)
            source.stdout.close()
            encrypted_status = encrypt.wait()
            source_status = source.wait()
            if encrypted_status or source_status:
                raise RuntimeError(f'Backup pipeline failed (source={source_status}, encryption={encrypted_status})')
            target.flush()
            os.fsync(target.fileno())
        finally:
            source.stdout.close()
            for proc in (encrypt, source):
                if proc is not None and proc.poll() is None:
                    proc.terminate()
                    proc.wait()


def backup(project, output, recipient_file, age, keyring=None, container_keyring=None):
    project, output = project.resolve(), output.resolve()
    recipient_file = recipient_file.resolve(strict=True)
    if not recipient_file.read_text().strip():
        raise ValueError('Recipient file is empty')
    if keyring and container_keyring:
        raise ValueError('Use only one keyring source')
    config = [project / 'docker-compose.yml', project / '.env']
    if keyring is not None:
        config.append(keyring.resolve(strict=True))
    if len({p.name for p in config}) != len(config):
        raise ValueError('Configuration file names must be distinct')
    for path in config:
        if not path.is_file() or path.is_symlink():
            raise ValueError('Configuration must consist of regular files')
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    if output.stat().st_mode & 0o077:
        raise ValueError('Backup destination must have permissions 0700')
    name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    stage = output / ('.partial-' + name)
    compose = ['docker', 'compose']
    container = subprocess.check_output(compose + ['ps', '-a', '-q', 'server'], cwd=project, text=True).strip()
    if not container or '\n' in container:
        raise ValueError('Expected exactly one server container')
    runtime_env = dict(v.split('=', 1) for v in json.loads(subprocess.check_output(
        ['docker', 'inspect', '--format', '{{json .Config.Env}}', container], text=True)) if '=' in v)
    workdir = subprocess.check_output(['docker', 'inspect', '--format', '{{.Config.WorkingDir}}', container], text=True).strip() or '/'

    def absolute(value):
        if not value or any(c in value for c in '\r\n\0'):
            raise ValueError('Invalid container storage path')
        return posixpath.normpath(posixpath.join(workdir, value))

    def container_file(path):
        data = subprocess.check_output(['docker', 'cp', container + ':' + absolute(path), '-'])
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            entries = archive.getmembers()
            if len(entries) != 1 or not entries[0].isfile():
                raise ValueError('Expected one regular container configuration file')
            return archive.extractfile(entries[0]).read()

    history = runtime_env.get('SCREEN_HISTORY_DIR')
    if history is None and runtime_env.get('SCREEN_HISTORY_DIR_FILE'):
        history = container_file(runtime_env['SCREEN_HISTORY_DIR_FILE']).decode().strip()
    history = absolute(history if history and history.strip() else './screen_history')
    configured_keyring = runtime_env.get('SCREEN_HISTORY_KEYRING_FILE')
    if configured_keyring:
        configured_keyring = absolute(configured_keyring)
        if container_keyring and absolute(container_keyring) != configured_keyring:
            raise ValueError('Explicit keyring differs from the running server configuration')
        if keyring and keyring.read_bytes() != container_file(configured_keyring):
            raise ValueError('Host keyring differs from the running server keyring')
        # Always include the server's actual key, even when an override was supplied.
        container_keyring = configured_keyring
    elif container_keyring:
        container_keyring = absolute(container_keyring)
    running = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', container], text=True).strip() == 'true'
    stage.mkdir(mode=0o700)
    stopped = False
    try:
        if running:
            # Always attempt restart even if Docker reports an interrupted stop.
            stopped = True
            run(compose + ['stop', 'server'], cwd=project, stdin=subprocess.DEVNULL)
        encrypted_command(compose + ['exec', '-T', 'db', 'sh', '-c',
            'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],
            stage / 'database.dump.age', age, recipient_file, project)
        encrypted_command(['docker', 'cp', container + ':' + history, '-'],
            stage / 'recall.tar.age', age, recipient_file, project)
        if container_keyring:
            encrypted_command(['docker', 'cp', container + ':' + container_keyring, '-'],
                stage / 'keyring.tar.age', age, recipient_file, project)
        # Tar config files to age through a pipe. Secrets never enter argv or logs.
        with (stage / 'config.tar.age').open('xb') as target:
            proc = subprocess.Popen([age, '-R', str(recipient_file)], stdin=subprocess.PIPE, stdout=target)
            try:
                with tarfile.open(fileobj=proc.stdin, mode='w|') as archive:
                    for path in config:
                        archive.add(path, arcname=path.name, recursive=False)
                proc.stdin.close()
                if proc.wait():
                    raise RuntimeError('Configuration encryption failed')
                target.flush()
                os.fsync(target.fileno())
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait()
        files = {}
        for path in stage.iterdir():
            path.chmod(0o600)
            with path.open('rb') as source:
                files[path.name] = hashlib.file_digest(source, 'sha256').hexdigest()
        with (stage / 'manifest.json').open('x') as manifest:
            manifest.write(json.dumps({'version': 1, 'files': files, 'encrypted_recall': bool(configured_keyring)}, indent=2) + '\n')
            manifest.flush()
            os.fsync(manifest.fileno())
        stage_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(stage_fd)
        finally:
            os.close(stage_fd)
        os.rename(stage, output / name)
        output_fd = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(output_fd)
        finally:
            os.close(output_fd)
        return output / name
    finally:
        try:
            if stopped:
                run(compose + ['start', 'server'], cwd=project, stdin=subprocess.DEVNULL)
        finally:
            if stage.exists():
                shutil.rmtree(stage)


def verify(directory, identity, age):
    """Authenticate every encrypted byte and check archive structure without extracting."""
    manifest = json.loads((directory / 'manifest.json').read_text())
    expected = {'database.dump.age', 'recall.tar.age', 'config.tar.age'}
    actual = set(manifest.get('files', {}))
    if manifest.get('version') != 1 or actual not in (expected, expected | {'keyring.tar.age'}):
        raise ValueError('Unsupported or incomplete backup manifest')
    if manifest.get('encrypted_recall') and 'keyring.tar.age' not in actual:
        raise ValueError('Encrypted Recall backup has no recovery keyring')
    results = {}
    for name in sorted(actual):
        path = directory / name
        with path.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != manifest['files'][name]:
                raise ValueError('Encrypted backup checksum mismatch')
        proc = subprocess.Popen([age, '-d', '-i', str(identity), str(path)], stdout=subprocess.PIPE)
        try:
            count = 0
            if name.endswith('.tar.age'):
                with tarfile.open(fileobj=proc.stdout, mode='r|') as archive:
                    for member in archive:
                        p = Path(member.name)
                        if p.is_absolute() or '..' in p.parts or not (member.isfile() or member.isdir()):
                            raise ValueError('Unsafe backup archive member')
                        if member.isfile():
                            stream = archive.extractfile(member)
                            while stream.read(1024 * 1024):
                                pass
                            count += 1
            elif proc.stdout.read(5) != b'PGDMP':
                raise ValueError('Invalid PostgreSQL custom dump')
            # Drain to EOF: age verifies its final chunk, even after tar end markers.
            while proc.stdout.read(1024 * 1024):
                pass
            if proc.wait():
                raise ValueError('Backup decryption/authentication failed')
            results[name] = {'authenticated': True, 'files': count} if count else {'authenticated': True}
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.terminate()
                proc.wait()
    return results


def main():
    os.umask(0o077)
    def terminate(signum, frame):
        raise KeyboardInterrupt('Backup interrupted; restarting server')
    signal.signal(signal.SIGTERM, terminate)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--age', default='age', help='Path to the age executable')
    sub = parser.add_subparsers(dest='command', required=True)
    create = sub.add_parser('create', help='Briefly stop server for a consistent encrypted backup')
    create.add_argument('--project-dir', type=Path, required=True)
    create.add_argument('--output', type=Path, required=True)
    create.add_argument('--recipient-file', type=Path, required=True)
    create.add_argument('--keyring', type=Path)
    create.add_argument('--keyring-container-path', help='Read a restricted keyring through Docker without exposing its bytes')
    check = sub.add_parser('verify', help='Authenticate/decrypt without writing plaintext files')
    check.add_argument('--backup', type=Path, required=True)
    check.add_argument('--identity', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'create':
        print(backup(args.project_dir, args.output, args.recipient_file, args.age, args.keyring, args.keyring_container_path))
    else:
        print(json.dumps(verify(args.backup, args.identity, args.age)))


if __name__ == '__main__':
    main()
