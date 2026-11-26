"""Real age round trips with synthetic data and a disposable Docker command fixture."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import hashlib

from secure_backup import backup, verify

AGE = os.environ.get('VANTYR_TEST_AGE', shutil.which('age'))


@unittest.skipUnless(AGE, 'age executable required for encryption integration tests')
class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()
        (self.project / '.env').write_text('SYNTHETIC_SECRET=private-fixture\n')
        (self.project / 'docker-compose.yml').write_text('services: {}\n')
        self.keyring = self.project / 'recall-keyring.json'
        self.keyring.write_text('{"synthetic": "encryption-key-fixture"}')
        self.identity = self.root / 'identity'
        keygen = str(Path(AGE).with_name('age-keygen'))
        subprocess.run([keygen, '-o', str(self.identity)], check=True, capture_output=True)
        self.recipient = self.root / 'recipient'
        self.recipient.write_bytes(subprocess.check_output([keygen, '-y', str(self.identity)]))
        docker = self.root / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import io, os, sys, tarfile, json
from pathlib import Path
args=sys.argv[1:]
if args[:3]==['compose','ps','-a']: print('fixture-server')
elif args[0]=='inspect':
 if args[2]=='{{json .Config.Env}}':
  env=['SCREEN_HISTORY_KEYRING_FILE=/run/secrets/keyring.json'] if os.environ.get('FAKE_KEYRING') else []
  if os.environ.get('FAKE_HISTORY'): env.append('SCREEN_HISTORY_DIR='+os.environ['FAKE_HISTORY'])
  print(json.dumps(env))
 elif args[2]=='{{.Config.WorkingDir}}': print('/app')
 else: print('true')
elif args[:2] in (['compose','stop'], ['compose','start']):
 with open(os.environ['DOCKER_EVENTS'],'a') as out: out.write(args[1]+'\\n')
 if args[1]=='start' and os.environ.get('FAIL_START'): sys.exit(3)
elif args[:2]==['compose','exec']:
 if os.environ.get('FAIL_DUMP'): sys.exit(1)
 sys.stdout.buffer.write(b'PGDMP'+b'synthetic-private-database'*10000)
elif args[0]=='cp':
 with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as tar:
  if args[1].endswith('/keyring.json'):
   payload=b'synthetic-runtime-keyring'; name='keyring.json'
  else:
   if os.environ.get('FAKE_HISTORY'): assert args[1]=='fixture-server:'+os.environ['FAKE_HISTORY']
   payload=b'synthetic-private-jpeg'; name='screen_history/agent/day/frame.jpg'
  info=tarfile.TarInfo(name); info.size=len(payload)
  tar.addfile(info,io.BytesIO(payload))
else: sys.exit(2)
''')
        docker.chmod(0o700)
        self.events = self.root / 'events'
        self.env = patch.dict(os.environ, {'PATH': str(self.root) + ':' + os.environ['PATH'],
                                          'DOCKER_EVENTS': str(self.events)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.output = self.root / 'backups'

    def create(self):
        return backup(self.project, self.output, self.recipient, AGE, self.keyring)

    def test_encrypted_roundtrip_contains_images_database_and_key_recovery(self):
        path = self.create()
        results = verify(path, self.identity, AGE)
        self.assertEqual(len(results), 3)
        self.assertEqual(results['config.tar.age']['files'], 3)
        self.assertEqual(results['recall.tar.age']['files'], 1)
        self.assertEqual(self.events.read_text(), 'stop\nstart\n')
        for p in path.glob('*.age'):
            self.assertNotIn(b'synthetic-private', p.read_bytes())
            self.assertNotIn(b'encryption-key-fixture', p.read_bytes())
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
        clear = subprocess.check_output([AGE, '-d', '-i', str(self.identity), str(path/'config.tar.age')])
        with tarfile.open(fileobj=io.BytesIO(clear)) as tar:
            self.assertEqual(tar.extractfile('recall-keyring.json').read(), self.keyring.read_bytes())
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)

    def test_failed_database_dump_never_publishes_and_restarts_server(self):
        with patch.dict(os.environ, {'FAIL_DUMP':'1'}), self.assertRaises(RuntimeError): self.create()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertEqual(self.events.read_text(), 'stop\nstart\n')

    def test_tampering_fails_even_with_recomputed_manifest(self):
        path = self.create()
        target = path/'database.dump.age'
        data=bytearray(target.read_bytes()); data[-1] ^= 1; target.write_bytes(data)
        manifest=json.loads((path/'manifest.json').read_text())
        manifest['files'][target.name]=hashlib.sha256(data).hexdigest()
        (path/'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(ValueError): verify(path,self.identity,AGE)

    def test_wrong_identity_is_rejected(self):
        path = self.create()
        wrong=self.root/'wrong'
        subprocess.run([str(Path(AGE).with_name('age-keygen')), '-o',str(wrong)],check=True,capture_output=True)
        with self.assertRaises((ValueError,tarfile.ReadError)): verify(path,wrong,AGE)

    def test_unsafe_output_permissions_rejected_before_downtime(self):
        self.output.mkdir(mode=0o755)
        self.output.chmod(0o755)
        with self.assertRaises(ValueError): self.create()
        self.assertFalse(self.events.exists())

    def test_configured_runtime_keyring_is_automatically_backed_up(self):
        with patch.dict(os.environ, {'FAKE_KEYRING':'1'}): path=self.create_without_keyring()
        self.assertIn('keyring.tar.age', verify(path, self.identity, AGE))
        clear=subprocess.check_output([AGE, '-d', '-i',str(self.identity),str(path/'keyring.tar.age')])
        with tarfile.open(fileobj=io.BytesIO(clear)) as tar:
            self.assertEqual(tar.extractfile('keyring.json').read(), b'synthetic-runtime-keyring')

    def create_without_keyring(self):
        return backup(self.project, self.output, self.recipient, AGE)

    def test_custom_runtime_image_directory_is_backed_up(self):
        with patch.dict(os.environ, {'FAKE_HISTORY':'/private/actual-captures'}): path=self.create()
        self.assertTrue(verify(path,self.identity,AGE)['recall.tar.age']['authenticated'])

    def test_wrong_keyring_override_is_rejected_before_downtime(self):
        with patch.dict(os.environ, {'FAKE_KEYRING':'1'}), self.assertRaises(ValueError):
            self.create()
        self.assertFalse(self.events.exists())
        self.assertEqual(list(self.output.iterdir()), [])

    def test_restart_failure_still_cleans_incomplete_backup(self):
        with patch.dict(os.environ, {'FAIL_DUMP':'1','FAIL_START':'1'}), self.assertRaises(subprocess.CalledProcessError):
            self.create()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertEqual(self.events.read_text(), 'stop\nstart\n')

    def test_wrong_container_keyring_path_is_rejected(self):
        with patch.dict(os.environ, {'FAKE_KEYRING':'1'}), self.assertRaises(ValueError):
            backup(self.project,self.output,self.recipient,AGE,container_keyring='/wrong-keyring.json')
        self.assertFalse(self.events.exists())
