import contextlib
import io
import json
import pathlib
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch

CODE = pathlib.Path(__file__).resolve().parents[1] / 'application/deployment/remote'


def module():
    result = types.ModuleType('deployment_fixture')
    for name in ('common.py', 'inspection.py', 'backup.py', 'candidate.py', 'transaction.py', 'runner.py'):
        exec(compile((CODE / name).read_text(), str(CODE / name), 'exec'), result.__dict__)
    result.emit = lambda *a, **k: None
    return result


class DeploymentTests(unittest.TestCase):
    def test_backup_is_verified_and_corruption_refuses_switch(self):
        m = module()
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'server/storage').mkdir(parents=True)
            (root / '.runtime').mkdir()
            (root / 'server/.env').write_text('A_PRIVATE_VALUE=not-in-output')
            (root / '.runtime/nginx.conf').write_text('nginx')
            db = root / 'novel.db'
            with sqlite3.connect(db) as connection:
                connection.execute('CREATE TABLE Novel(title text)')
                connection.execute("INSERT INTO Novel VALUES ('preserve me')")
            info = dict(root=root, db=db, assets=[root / 'server/storage'], old='old')
            snapshot = m.backup_snapshot(info, root / 'backup')
            m.verify_snapshot(snapshot)
            self.assertEqual((snapshot / 'database.sqlite').stat().st_mode & 0o777, 0o600)
            with sqlite3.connect(snapshot / 'database.sqlite') as connection:
                self.assertEqual(connection.execute('SELECT title FROM Novel').fetchone()[0], 'preserve me')
            (snapshot / 'database.sqlite').write_bytes(b'corrupted')
            with self.assertRaises(m.Refused):
                m.verify_snapshot(snapshot)

    def test_maintenance_preserves_exact_health_and_restricts_probe(self):
        m = module()
        original = (CODE.parents[3] / 'infra/server/nginx.conf.template').read_text()
        value = m.maintenance_config(original, dict(remoteWebPort=18080, maintenanceProbePort=18081))
        self.assertEqual(value.count('listen 127.0.0.1:18080;'), 1)
        self.assertEqual(value.count('listen 127.0.0.1:18081;'), 1)
        self.assertIn('location = /api/health', value)
        self.assertIn('location ^~ /api/', value)
        self.assertIn('Retry-After 30 always', value)
        self.assertIn('if ($request_method !~ ^(GET|HEAD)$)', value)

    def test_every_artifact_rename_failure_restores_code_and_all_dependencies(self):
        for fail_at in range(1, 15):
            with self.subTest(fail_at=fail_at), tempfile.TemporaryDirectory() as temporary:
                m = module()
                root = pathlib.Path(temporary)
                batch = root / '.runtime/deploy-test'
                candidate = batch / 'candidate'
                candidate.mkdir(parents=True)
                (root / 'infra/server').mkdir(parents=True)
                original = 'worker_processes auto;\nhttp {\n    server {\n        listen 127.0.0.1:18080;\n        server_name localhost;\n        location /api/ {\n            proxy_pass http://127.0.0.1:13000;\n        }\n        location / { try_files $uri /index.html; }\n    }\n}\n'
                (root / 'infra/server/nginx.conf.template').write_text(original)
                (root / '.runtime/nginx.conf').write_text(original)
                for name in m.ARTIFACTS:
                    for parent, value in ((root, 'old'), (candidate, 'new')):
                        location = parent / name
                        location.mkdir(parents=True)
                        (location / 'identity').write_text(value)
                (root / 'data').mkdir()
                (root / 'data/novel.db').write_bytes(b'unchanged production database')
                info = dict(root=root, old='old-sha', sha='new-sha', branch='ai', states={'ai-novel-api':'active', 'ai-novel-web':'active'})
                config = dict(remoteWebPort=18080, maintenanceProbePort=18081)
                git_calls = []
                m.git = lambda root, *args: git_calls.append(args)
                m.command = lambda *a, **k: types.SimpleNamespace(stdout='', returncode=0)
                m.check_quiescence = lambda *a: None
                m.check_connections = lambda: None
                m.backup_snapshot = lambda info, location: location
                m.verify_snapshot = lambda *a: None
                m.validate_nginx = lambda *a: None
                m.start_and_check = lambda *a: None
                m.health = lambda *a: None
                m.set_nginx = lambda root, text, **k: (root / '.runtime/nginx.conf').write_text(text)
                original_rename = m.os.rename
                count = 0

                def fail_once(source, target):
                    nonlocal count
                    count += 1
                    if count == fail_at:
                        raise OSError('injected artifact switch failure')
                    return original_rename(source, target)

                with patch.object(m.os, 'rename', fail_once), patch.object(m.time, 'sleep', lambda *_: None):
                    code = m.switch_transaction(dict(config=config), info, batch, candidate, dict(fingerprint='test'))
                self.assertEqual(code, 7)
                for name in m.ARTIFACTS:
                    self.assertEqual((root / name / 'identity').read_text(), 'old')
                self.assertIn(('switch', '--detach', 'old-sha'), git_calls)
                self.assertEqual((root / '.runtime/nginx.conf').read_text(), original)
                self.assertEqual((root / 'data/novel.db').read_bytes(), b'unchanged production database')

    def test_dry_run_never_enters_locks_or_mutation_adapters(self):
        m = module()
        info = dict(old='old', sha='candidate', differences=['client/page'], checks=['not yet validated'], db=pathlib.Path('/db'), assets=[])
        m.inspect_deployment = lambda payload: info
        m.check_quiescence = lambda *a: None
        m.remote_lock = lambda *_: self.fail('dry-run acquired remote lock')
        m.build_candidate = lambda *_: self.fail('dry-run built artifacts')
        m.backup_snapshot = lambda *_: self.fail('dry-run wrote a backup')
        self.assertEqual(m.run_remote(dict(dryRun=True)), 0)


if __name__ == '__main__':
    unittest.main()
