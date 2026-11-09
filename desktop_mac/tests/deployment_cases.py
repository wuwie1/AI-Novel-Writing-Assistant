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
    for name in ('common.py', 'inspection.py', 'artifacts.py', 'backup.py', 'candidate.py', 'transaction.py', 'runner.py'):
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

    def test_public_health_waits_for_nginx_reload_but_persistent_failure_times_out(self):
        m = module()
        with patch.object(m.time, 'sleep') as sleep:
            m.health = Mock(side_effect=[m.Refused('HTTP 503'), None])
            m.wait_for_health(18080, 30)
            self.assertEqual([call.args for call in m.health.call_args_list], [(18080,), (18080,)])
            sleep.assert_called_once_with(2)
            m.health = Mock(side_effect=m.Refused('HTTP 503'))
            with patch.object(m.time, 'monotonic', side_effect=[20, 21, 50]):
                with self.assertRaisesRegex(m.Refused, '18080.*HTTP 503'):
                    m.wait_for_health(18080, 30)

    def test_retry_requires_matching_rollback_manifest_branch_and_ancestry(self):
        m = module()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            m.git(root, 'init', '-b', 'ai')
            m.git(root, 'config', 'user.name', 'Deploy Test')
            m.git(root, 'config', 'user.email', 'test@example.invalid')
            m.git(root, 'config', 'commit.gpgsign', 'false')
            m.git(root, 'remote', 'add', 'origin', 'https://github.com/wuwie1/AI-Novel-Writing-Assistant.git')
            def commit(message):
                m.git(root, 'commit', '--allow-empty', '-m', message)
                return m.git(root, 'rev-parse', 'HEAD')
            old = commit('deployed')
            tip = commit('previous candidate')
            self.assertEqual(m.deployment_branch_tip(root, 'ai', tip), tip)
            with self.assertRaisesRegex(m.Refused, '其他分支'):
                m.deployment_branch_tip(root, 'main', tip)
            m.git(root, 'switch', '--detach', old)
            divergent = commit('divergent candidate')
            m.git(root, 'switch', '--detach', old)
            manifest = root / '.runtime/deployment.json'
            journal = root / '.runtime/desktop_mac-deploy/20260101/transaction.json'
            journal.parent.mkdir(parents=True)
            with self.assertRaisesRegex(m.Refused, 'detached HEAD'):
                m.deployment_branch_tip(root, 'ai', old)
            m.write_json(manifest, dict(commit=old, branch='ai'))
            rollback = dict(phase='rolled_back', branch='ai', old=old, sha=tip)
            for invalid in (dict(rollback, phase='verifying'), dict(rollback, old=tip),
                            dict(rollback, sha=divergent), dict(rollback, branch='other')):
                m.write_json(journal, invalid)
                with self.subTest(record=invalid), self.assertRaisesRegex(m.Refused, 'detached HEAD'):
                    m.deployment_branch_tip(root, 'ai', old)
            m.write_json(journal, rollback)
            self.assertEqual(m.deployment_branch_tip(root, 'ai', old), tip)
            config = dict(serverDir=str(root), deployRef='origin/ai')
            with self.assertRaisesRegex(m.Refused, '无法快进'):
                m.inspect_deployment(dict(dryRun=True, currentSha=divergent, config=config))
            m.write_json(manifest, dict(commit=tip, branch='ai'))
            with self.assertRaisesRegex(m.Refused, 'detached HEAD'):
                m.deployment_branch_tip(root, 'ai', old)

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
                info = dict(root=root, old='old-sha', sha='new-sha', branch='ai', branchTip='old-sha', states={'ai-novel-api':'active', 'ai-novel-web':'active'})
                config = dict(remoteWebPort=18080, maintenanceProbePort=18081)
                git_calls = []
                def git(root, *args, **kwargs):
                    git_calls.append(args)
                    return 'ai' if args[0] == 'symbolic-ref' else 'old-sha'
                m.git = git
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
                    code = m.switch_transaction(dict(config=config), info, batch, candidate, dict(mode='full', artifacts=list(m.ARTIFACTS)), {}, m.DeploymentTimings())
                self.assertEqual(code, 7)
                for name in m.ARTIFACTS:
                    self.assertEqual((root / name / 'identity').read_text(), 'old')
                self.assertIn(('switch', '--detach', 'old-sha'), git_calls)
                self.assertIn(('switch', '--no-guess', '--', 'ai'), git_calls)
                self.assertNotIn('update-ref', [args[0] for args in git_calls])
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

    def test_explicit_validation_must_cover_the_same_commit_and_checks(self):
        m = module()
        sha, ref = 'a' * 40, 'origin/ai'
        valid = dict(sha=sha, ref=ref, passed=list(m.VALIDATION_CHECKS), evidence='CI log')
        m.require_validation_record(valid, sha, ref)
        for invalid in (None, dict(valid, sha='b' * 40), dict(valid, ref='origin/main'),
                        dict(valid, passed=['server-build', 'client-build']), dict(valid, evidence=' ')):
            with self.subTest(record=invalid), self.assertRaises(m.Refused):
                m.require_validation_record(invalid, sha, ref)

    def test_validation_precedes_backup_and_service_switch(self):
        for failure, external in ((None, False), ('server-build', False), ('client-build', False),
                                  ('targeted-tests', False), ('invalid-link', False), (None, True)):
            with self.subTest(failure=failure, external=external), tempfile.TemporaryDirectory() as temporary:
                m = module()
                root = pathlib.Path(temporary).resolve()
                (root / '.runtime').mkdir()
                info = dict(root=root, old='b' * 40, branchTip='b' * 40, sha='a' * 40, branch='ai', ref='origin/ai', known=True,
                            differences=[], checks=[], states={}, db=root / 'unused.db', assets=[])
                m.inspect_deployment = Mock(return_value=info)
                m.check_quiescence = Mock()
                m.backup_snapshot = Mock()
                m.switch_transaction = Mock(return_value=0)
                m.live_artifacts = Mock(return_value={})
                m.runtime_toolchain = Mock(return_value={})
                m.check_build_space = Mock()
                m.retain_release = Mock(return_value={})
                supplied = dict(sha=info['sha'], ref=info['ref'], passed=list(m.VALIDATION_CHECKS), evidence='CI log')
                payload = dict(dryRun=False, withBundle=False, config=dict(serverDir=str(root)))
                if external:
                    payload['validation'] = supplied
                steps = []

                def build_step(args, cwd=None, env=None, **kwargs):
                    if args[0] == 'git':
                        package = root / 'shared/package.json'
                        package.parent.mkdir()
                        package.write_text('{"name":"@ai-novel/shared"}')
                        with m.tarfile.open(args[args.index('-o') + 1], 'w') as archive:
                            archive.add(package, 'shared/package.json')
                    elif cwd is not None:
                        name = 'targeted-tests' if args[0] == 'node' else args[2].split('/')[-1] + '-' + args[-1]
                        steps.append(name)
                        self.assertEqual(env['DATABASE_URL'], 'file:' + str(cwd.parent / 'build-only.sqlite'))
                        if name == failure:
                            raise m.Refused('injected failure')
                        for slot in m.ARTIFACTS:
                            (cwd / slot).mkdir(parents=True, exist_ok=True)
                        for artifact in (*m.ENTRYPOINTS, 'pnpm-lock.yaml'):
                            (cwd / artifact).write_text('fixture')
                        link = cwd / 'server/node_modules/@ai-novel' / ('other' if failure == 'invalid-link' else 'shared')
                        if not link.is_symlink():
                            link.parent.mkdir()
                            link.symlink_to('../../../shared')

                m.command = build_step
                if failure:
                    reason = '候选依赖链接' if failure == 'invalid-link' else failure + '.*build.log'
                    with self.assertRaisesRegex(m.Refused, reason):
                        m.run_remote(payload)
                    self.assertEqual(list(root.rglob('validation.json')), [])
                    m.backup_snapshot.assert_not_called()
                    m.switch_transaction.assert_not_called()
                else:
                    self.assertEqual(m.run_remote(payload), 0)
                    m.switch_transaction.assert_called_once()
                    record = json.loads(next(root.rglob('validation.json')).read_text())
                    m.require_validation_record(record, info['sha'], info['ref'])
                    self.assertEqual('targeted-tests' in steps, not external)
                    if external:
                        self.assertEqual(record, supplied)
                    else:
                        self.assertIn('node --test', pathlib.Path(record['evidence']).read_text())

    def test_selective_build_inputs_and_drift(self):
        m = module()
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            src = root / '.runtime/desktop_mac-deploy/prior'
            backup = src / 'backups'
            for path in ('preflight/release.json', 'quiesced/manifest.json'):
                dest = backup / path
                dest.parent.mkdir(parents=True)
                dest.write_text('{}')
            proof = src / 'validation.json'
            m.write_json(proof, dict(sha='A', ref='origin/ai', evidence='old', passed=list(m.VALIDATION_CHECKS)))
            hashes = dict.fromkeys(m.ARTIFACTS, 'digest')
            info = dict(root=root, old='A', sha='B', branch='ai', ref='origin/ai')
            last = dict(sha='A', result='success', backup=str(backup), validation=str(proof), release=dict(version=1, artifacts=hashes, toolchain='v1'))
            record = dict(commit='A', branch='ai', desktopMacDeployment=last)
            cases = [(['client/src/page.tsx'], ['client/dist'], True), (['server/src/app.ts'], ['server/dist'], True),
                     (['server/src/x', 'client/src/y'], ['server/dist', 'client/dist'], True),
                     (['desktop/package.json'], ['client/dist'], True), (['desktop_mac/src/app.ts', 'docs/guide.md'], [], False),
                     (['client/tests/test.js'], [], True), (['shared/types/X.ts'], list(m.ARTIFACTS), True),
                     (['pnpm-lock.yaml'], list(m.ARTIFACTS), True), (['unknown-build-file'], list(m.ARTIFACTS), True)]
            for changed, slots, tests in cases:
                with self.subTest(changed=changed):
                    plan = m.release_plan(dict(info, differences=changed), hashes, 'v1', record)
                    self.assertEqual((plan['slots'], plan['tests']), (slots, tests))
            self.assertEqual(m.release_plan(info, hashes, 'v2', record)['mode'], 'full')
            self.assertEqual(m.release_plan(info, hashes, 'v1', {})['mode'], 'full')
            with self.assertRaisesRegex(m.Refused, '校验值不符'):
                m.release_plan(dict(info, sha='A'), dict(hashes, node_modules='corrupted'), 'v1', record)

    def test_partial_build_replaces_only_requested_output_and_isolates_dependencies(self):
        for package in ('client', 'server'):
            with self.subTest(package=package), tempfile.TemporaryDirectory() as directory:
                m = module()
                root = pathlib.Path(directory).resolve()
                batch = root / '.runtime/test-batch'
                batch.mkdir(parents=True)
                for slot in m.ARTIFACTS:
                    (root / slot).mkdir(parents=True)
                for entry in m.ENTRYPOINTS:
                    (root / entry).write_text('installed')
                (root / 'node_modules/marker').write_text('live dependencies')
                (root / 'pnpm-lock.yaml').write_text('frozen')
                installed = m.live_artifacts(root)
                issued = []
                real_command = m.command
                def command(args, cwd=None, **kwargs):
                    if args[0] == 'cp':
                        return real_command(args, cwd=cwd, **kwargs)
                    if args[0] == 'git':
                        with m.tarfile.open(args[args.index('-o') + 1], 'w') as archive:
                            archive.add(root / 'pnpm-lock.yaml', 'pnpm-lock.yaml')
                    elif args[0] == 'pnpm':
                        self.assertEqual(args, ['pnpm', '--filter', '@ai-novel/' + package, 'build'])
                        entry = next(name for name in m.ENTRYPOINTS if name.startswith(package + '/'))
                        (cwd / entry).parent.mkdir(parents=True, exist_ok=True)
                        (cwd / entry).write_text('new build')
                        (cwd / 'node_modules/marker').write_text('private build writes')
                        issued.append('build')
                    elif args[0] == 'node':
                        self.assertTrue((cwd / 'server/dist/app.js').is_file())
                        issued.append('tests')
                    else:
                        self.assertEqual(args[0], 'chown')
                slot = package + '/dist'
                m.command = command
                staged, manifest = m.build_candidate(dict(root=root, old='A', sha='B', ref='origin/ai'), batch, None,
                    dict(slots=[slot], mode='incremental', tests=True), installed, m.DeploymentTimings())
                self.assertEqual(issued, ['build', 'tests'])
                self.assertEqual([key for key in m.ARTIFACTS if (staged / key).exists()], [slot])
                self.assertEqual([key for key in m.ARTIFACTS if manifest['hashes'][key] != installed[key]], [slot])
                self.assertEqual((root / 'node_modules/marker').read_text(), 'live dependencies')
                validation = json.loads((batch / 'validation.json').read_text())
                self.assertEqual(validation['reused'], ['server-build' if package == 'client' else 'client-build'])
                self.assertFalse(list(batch.glob('build-*')))

    def test_retained_artifacts_can_be_restored_and_deduplicated(self):
        m = module()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            deps = root / 'node_modules/pkg'
            deps.mkdir(parents=True)
            (deps / 'package.json').write_text('previous contents')
            (root / 'node_modules/alias').symlink_to('pkg')
            batch = root / '.runtime/desktop_mac-deploy/batch'
            batch.mkdir(parents=True)
            hashes = {'node_modules': m.artifact_digest(root / 'node_modules')}
            old = m.retain_release(dict(root=root, old='old'), batch, hashes)
            slot = pathlib.Path(old['store']) / 'node_modules' / hashes['node_modules']
            self.assertEqual(m.artifact_digest(slot), hashes['node_modules'])
            self.assertTrue((slot / 'alias').is_symlink())
            with patch.object(m, 'copy_artifact', side_effect=AssertionError('copied an existing release')):
                self.assertEqual(m.retain_release(dict(root=root, old='old'), batch, hashes), old)
            (deps / 'package.json').write_text('new live contents')
            self.assertEqual((slot / 'pkg/package.json').read_text(), 'previous contents')
            (slot / 'pkg/package.json').write_text('bad backup')
            with self.assertRaisesRegex(m.Refused, '旧产物校验失败'):
                m.retain_release(dict(root=root, old='old'), batch, hashes)

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
                info = dict(root=root, old=sha, sha=sha, branch='ai', branchTip=sha,
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

                for slot in m.ARTIFACTS:
                    (root / slot).mkdir(parents=True)
                for entry in m.ENTRYPOINTS:
                    (root / entry).write_text('working')
                info['ref'] = 'origin/ai'
                proof_dir = root / '.runtime/desktop_mac-deploy/prior'
                backup = proof_dir / 'backups'
                for path in (backup / 'preflight/release.json', backup / 'quiesced/manifest.json'):
                    path.parent.mkdir(parents=True)
                    path.write_text('{}')
                validation = proof_dir / 'validation.json'
                m.write_json(validation, dict(sha=sha, ref=info['ref'], evidence='previous build', passed=list(m.VALIDATION_CHECKS)))
                prior = dict(commit=sha, branch='ai', desktopMacDeployment=dict(sha=sha, result='success', backup=str(backup),
                             validation=str(validation), release=dict(version=1, artifacts=m.live_artifacts(root), toolchain={'node':'test'})))
                m.write_json(root / '.runtime/deployment.json', prior)
                m.runtime_toolchain = Mock(return_value={'node':'test'})
                m.build_candidate = Mock(side_effect=AssertionError('same commit built artifacts'))
                m.retain_release = Mock(side_effect=AssertionError('same commit copied dependencies'))
                payload = dict(config=dict(serverDir=str(root), remoteWebPort=18080, maintenanceProbePort=18081),
                               dryRun=False, currentSha=sha, serverBase=sha, withBundle=False)
                with patch.object(m.time, 'sleep'):
                    self.assertEqual(m.run_remote(payload), 0)
                units = [c.args[0] for c in m.command.call_args_list]
                self.assertEqual(units, [['systemctl', 'stop', 'ai-novel-web', 'ai-novel-api'],
                                         ['systemctl', 'start', 'ai-novel-api', 'ai-novel-web'],
                                         ['systemctl', 'is-active', 'ai-novel-api'],
                                         ['systemctl', 'is-active', 'ai-novel-web']])
                self.assertEqual([c.args[0] for c in m.health.call_args_list], [18081, 18080])
                m.backup_snapshot.assert_not_called()
                m.verify_snapshot.assert_not_called()
                self.assertEqual(m.check_connections.call_count, 2)
                deployment = json.loads((root / '.runtime/deployment.json').read_text())
                self.assertEqual(deployment, prior)
                self.assertEqual(deployment['commit'], sha)
                self.assertEqual(deployment['branch'], 'ai')
                record = deployment['desktopMacDeployment']
                self.assertEqual(record['sha'], sha)
                self.assertEqual(record['result'], 'success')


if __name__ == '__main__':
    unittest.main()
