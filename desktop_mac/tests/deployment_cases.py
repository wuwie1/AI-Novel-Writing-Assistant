import contextlib
import io
import json
import pathlib
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

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
        info = dict(old='old', sha='candidate', known=False, differences=['client/page'], checks=['not yet validated'], db=pathlib.Path('/db'), assets=[])
        m.inspect_deployment = lambda payload: info
        m.check_quiescence = lambda *a: None
        m.remote_lock = lambda *_: self.fail('dry-run acquired remote lock')
        m.build_candidate = lambda *_: self.fail('dry-run built artifacts')
        m.backup_snapshot = lambda *_: self.fail('dry-run wrote a backup')
        self.assertEqual(m.run_remote(dict(dryRun=True)), 0)

    def test_candidate_requires_pinned_local_commit_without_remote_lookup(self):
        m = module()
        m.git = Mock()
        root = pathlib.Path('.')
        for sha in (None, 'origin/ai', 'abc123'):
            with self.subTest(sha=sha), self.assertRaisesRegex(m.Refused, '完整的 Git 提交 SHA'):
                m.candidate_commit(root, sha)
        sha = 'a' * 40
        self.assertEqual(m.candidate_commit(root, sha), sha)
        m.git.assert_not_called()

    def test_update_requires_matching_preview_before_importing_candidate(self):
        m = module()
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            m.candidate_commit = Mock()
            for baseline in ({}, {'serverBase': 'b' * 40}):
                m.git = Mock(side_effect=[str(root), 'https://github.com/wuwie1/AI-Novel-Writing-Assistant.git', 'a' * 40])
                payload = dict(config=dict(serverDir=str(root)), dryRun=False, **baseline)
                with self.subTest(baseline=baseline), self.assertRaisesRegex(m.Refused, '预演基线不符'):
                    m.inspect_deployment(payload, import_bundle=True)
            m.candidate_commit.assert_not_called()

    def test_explicit_current_version_update_restarts_both_units_and_leaves_them_serving(self):
        for initial in ('active', 'inactive'):
            with self.subTest(initial=initial), tempfile.TemporaryDirectory() as temporary:
                m = module()
                root = pathlib.Path(temporary)
                (root / '.runtime').mkdir()
                template = pathlib.Path('infra/server/nginx.conf.template')
                (root / template.parent).mkdir(parents=True)
                original = (CODE.parents[3] / template).read_text()
                (root / template).write_text(original)
                (root / '.runtime/nginx.conf').write_text(original.replace('@ROOT@', str(root)))
                sha = 'a' * 40
                info = dict(root=root, old=sha, sha=sha, branch='ai',
                            known=True, differences=[], checks=[], db=root / 'test.db', assets=[],
                            states=dict.fromkeys(('ai-novel-api', 'ai-novel-web'), initial))
                m.inspect_deployment = Mock(return_value=info)
                m.check_quiescence = Mock()
                m.check_connections = Mock()
                m.backup_snapshot = Mock(side_effect=lambda info, location, **kwargs: location)
                m.verify_snapshot = Mock()
                m.validate_nginx = Mock()
                m.set_nginx = Mock()
                m.command = Mock(return_value=types.SimpleNamespace(stdout='active'))
                m.git = Mock(return_value=sha)
                m.health = Mock()

                def build(info, batch):
                    candidate = batch / 'candidate'
                    for slot in m.ARTIFACTS:
                        (root / slot).parent.mkdir(parents=True, exist_ok=True)
                        (candidate / slot).mkdir(parents=True)
                    return candidate, {'fingerprint': 'verified-test-build'}

                m.build_candidate = Mock(side_effect=build)
                payload = dict(config=dict(remoteWebPort=18080, maintenanceProbePort=18081),
                               dryRun=False, currentSha=sha, serverBase=sha, withBundle=False)
                with patch.object(m.time, 'sleep'):
                    self.assertEqual(m.run_remote(payload), 0)
                units = [c.args[0] for c in m.command.call_args_list]
                self.assertEqual(units, [['systemctl', 'stop', 'ai-novel-web', 'ai-novel-api'],
                                         ['systemctl', 'start', 'ai-novel-api', 'ai-novel-web'],
                                         ['systemctl', 'is-active', 'ai-novel-api'],
                                         ['systemctl', 'is-active', 'ai-novel-web']])
                self.assertEqual([c.args[0] for c in m.health.call_args_list], [18081, 18080])
                self.assertEqual(m.backup_snapshot.call_count, 2)
                self.assertEqual(m.verify_snapshot.call_count, 2)
                self.assertEqual(m.check_connections.call_count, 2)
                record = json.loads((root / '.runtime/deployment.json').read_text())['desktopMacDeployment']
                self.assertEqual(record['sha'], sha)
                self.assertEqual(record['result'], 'success')


if __name__ == '__main__':
    unittest.main()
