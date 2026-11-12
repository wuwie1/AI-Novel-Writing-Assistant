import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from deployment_cases import module


class ReleaseFixture:
    def __init__(self, directory):
        self.m = module()
        self.root = pathlib.Path(directory).resolve()
        self.batches = self.root / '.runtime/desktop_mac-deploy'
        self.batches.mkdir(parents=True)
        (self.root / 'server/storage').mkdir(parents=True)
        (self.root / 'server/storage/asset').write_text('keep this image')
        (self.root / 'server/.env').write_text('fixture=private')
        (self.root / '.runtime/nginx.conf').write_text('fixture nginx')
        (self.root / 'data').mkdir()
        self.db = self.root / 'data/novel.db'
        with sqlite3.connect(self.db) as connection:
            connection.execute('CREATE TABLE Novel(content text)')
            connection.execute("INSERT INTO Novel VALUES ('preserve all writing')")
        for args in [('init', '-b', 'ai'), ('config', 'user.name', 'Retention Fixture'),
                     ('config', 'user.email', 'fixture@example.invalid'), ('config', 'commit.gpgsign', 'false')]:
            self.m.git(self.root, *args)
        self.sequence = 0
        self.commit()
        self.artifacts('baseline')
        self.releases = []

    def commit(self):
        self.sequence += 1
        (self.root / 'source.txt').write_text(str(self.sequence))
        self.m.git(self.root, 'add', 'source.txt')
        self.m.git(self.root, 'commit', '-m', 'fixture ' + str(self.sequence))
        return self.m.git(self.root, 'rev-parse', 'HEAD')

    def artifacts(self, value):
        for slot in self.m.ARTIFACTS:
            folder = self.root / slot
            folder.mkdir(parents=True, exist_ok=True)
            (folder / 'identity').write_text(value)
        for entry in self.m.ENTRYPOINTS:
            (self.root / entry).write_text(value)
        return self.m.live_artifacts(self.root)

    def batch(self, number, sha, *, phase='complete', mode='full', old=None):
        folder = self.batches / ('20260101T%06d-%s-fixture' % (number, sha[:12]))
        folder.mkdir()
        self.m.write_json(folder / 'transaction.json', dict(phase=phase, mode=mode, sha=sha, old=old, branch='ai'))
        return folder

    def release(self):
        old = self.m.git(self.root, 'rev-parse', 'HEAD')
        installed = self.m.live_artifacts(self.root)
        sha = self.commit()
        folder = self.batch(self.sequence, sha, old=old)
        info = dict(root=self.root, old=old, sha=sha, branch='ai', ref='origin/ai', db=self.db,
                    assets=[self.root / 'server/storage'])
        retained = self.m.retain_release(info, folder, installed)
        self.m.backup_snapshot(info, folder / 'backups/preflight', retained)
        self.m.backup_snapshot(info, folder / 'backups/quiesced')
        (folder / 'build.log').write_text('verified build output')
        self.m.write_json(folder / 'validation.json', dict(sha=sha, ref='origin/ai', passed=list(self.m.VALIDATION_CHECKS),
                                                         evidence=str(folder / 'build.log')))
        hashes = self.artifacts(sha)
        self.m.write_json(self.root / '.runtime/deployment.json', dict(commit=sha, branch='ai', previousCommit=old,
            desktopMacDeployment=dict(sha=sha, previousSha=old, result='success', backup=str(folder / 'backups'),
                                      validation=str(folder / 'validation.json'),
                                      release=dict(version=1, artifacts=hashes, toolchain='fixture'))))
        self.info = info
        self.releases.append(folder)
        return folder

    def cleanup(self, batch=None):
        return self.m.cleanup_after_success(self.info, batch or self.releases[-1], self.m.DeploymentTimings())


class RetentionTests(unittest.TestCase):
    def fixture(self, count=3):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        fixture = ReleaseFixture(temporary.name)
        for _ in range(count):
            fixture.release()
        return fixture

    def assert_safe_warning(self, fixture):
        before = fixture.m.digest(fixture.db)
        result = fixture.cleanup()
        self.assertEqual(result['status'], 'warning', result)
        self.assertEqual(result['deleted'], [])
        self.assertTrue(fixture.releases[0].exists())
        self.assertEqual(fixture.m.digest(fixture.db), before)
        return result

    def test_retains_two_releases_and_restorable_backups_while_removing_unused_payloads(self):
        f = self.fixture()
        stale = f.batch(20, 'e' * 40, phase='aborted')
        restart = f.batch(21, f.info['sha'], mode='restart')
        unknown = f.batches / 'unclassified-work'
        unknown.mkdir()
        (unknown / 'keep').write_text('unclassified')
        manual = f.root / '.runtime/backups/manual.sqlite'
        manual.parent.mkdir()
        manual.write_text('separate maintenance backup')
        for folder in f.releases:
            for name in ('candidate', 'rollback', 'build-leftover'):
                (folder / name).mkdir()
                (folder / name / 'payload').write_text('duplicate build bytes')
        database_before = f.m.digest(f.db)
        report = f.cleanup()
        self.assertEqual(report['status'], 'complete', report)
        self.assertEqual(report['recoveryBatches'], [str(p) for p in f.releases[-2:]])
        self.assertFalse(f.releases[0].exists())
        self.assertFalse(stale.exists())
        self.assertFalse(restart.exists())
        self.assertTrue(unknown.exists())
        self.assertTrue(manual.exists())
        self.assertEqual(f.m.digest(f.db), database_before)
        self.assertEqual((f.root / 'server/.env').read_text(), 'fixture=private')
        for folder in f.releases[-2:]:
            self.assertFalse((folder / 'rollback').exists())
            self.assertFalse((folder / 'candidate').exists())
            self.assertFalse((folder / 'build-leftover').exists())
            with sqlite3.connect(folder / 'backups/quiesced/database.sqlite') as database:
                self.assertEqual(database.execute('SELECT content FROM Novel').fetchone()[0], 'preserve all writing')
        for path in report['referencedArtifacts']:
            self.assertEqual(f.m.artifact_digest(pathlib.Path(path)), pathlib.Path(path).name)
        self.assertTrue(report['deleteArtifacts'])
        self.assertTrue(all(not pathlib.Path(p).exists() for p in report['deleteArtifacts']))

    def test_restarts_do_not_accumulate_or_consume_a_release_retention_slot(self):
        f = self.fixture()
        for number in (20, 21, 22):
            restart = f.batch(number, f.info['sha'], mode='restart')
            report = f.cleanup(restart)
            self.assertEqual(report['status'], 'complete', report)
            self.assertEqual(report['recoveryBatches'], [str(p) for p in f.releases[-2:]])
            self.assertEqual({p for p in f.batches.iterdir() if '-fixture' in p.name}, set(f.releases[-2:] + [restart]))
        f.release()
        result = f.cleanup()
        self.assertEqual(result['status'], 'complete', result)
        self.assertFalse(restart.exists())
        self.assertFalse(f.releases[-3].exists())

    def test_first_tracked_release_keeps_its_verified_baseline_recovery(self):
        f = self.fixture(1)
        result = f.cleanup()
        self.assertEqual(result['status'], 'complete', result)
        self.assertEqual(result['recoveryBatches'], [str(f.releases[0])])
        self.assertEqual(len(result['verifiedBackups']), 2)

    def test_legacy_reused_build_evidence_keeps_receipt_but_not_unused_backups(self):
        f = self.fixture()
        earlier = f.releases[0]
        proof_file = f.releases[-1] / 'validation.json'
        proof = json.loads(proof_file.read_text())
        proof['evidence'] = str(earlier / 'build.log')
        f.m.write_json(proof_file, proof)
        (earlier / 'candidate').mkdir()
        (earlier / 'candidate/large-output').write_text('unused build')
        result = f.cleanup()
        self.assertEqual(result['status'], 'complete', result)
        self.assertTrue((earlier / 'build.log').is_file())
        self.assertTrue((earlier / 'validation.json').is_file())
        self.assertFalse((earlier / 'candidate').exists())
        self.assertFalse((earlier / 'backups').exists())
        self.assertEqual(f.cleanup()['status'], 'complete')

    def test_missing_or_corrupt_snapshot_prevents_all_deletion(self):
        for corrupt in ('bytes', 'missing-fields', 'wrong-sha', 'traversal', 'invalid-sqlite'):
            with self.subTest(corrupt=corrupt):
                f = self.fixture()
                snapshot = f.releases[-2] / 'backups/quiesced'
                file = snapshot / 'manifest.json'
                manifest = json.loads(file.read_text())
                if corrupt == 'bytes':
                    (snapshot / 'assets.tar.gz').write_bytes(b'corrupted')
                elif corrupt == 'missing-fields':
                    manifest['files'] = {}
                elif corrupt == 'wrong-sha':
                    manifest['sha'] = 'f' * 40
                elif corrupt == 'traversal':
                    manifest['files']['../outside'] = dict(size=1, sha256='a' * 64)
                else:
                    database = snapshot / 'database.sqlite'
                    database.write_bytes(b'not a database')
                    manifest['files']['database.sqlite'] = dict(size=database.stat().st_size, sha256=f.m.digest(database))
                f.m.write_json(file, manifest)
                self.assert_safe_warning(f)

    def test_missing_corrupt_or_escaping_artifact_reference_prevents_all_deletion(self):
        for problem in ('missing', 'corrupt', 'slot', 'store'):
            with self.subTest(problem=problem):
                f = self.fixture()
                snapshot = f.releases[-1] / 'backups/preflight'
                release_file = snapshot / 'release.json'
                release = json.loads(release_file.read_text())
                asset = pathlib.Path(release['store']) / 'node_modules' / release['artifacts']['node_modules']
                if problem == 'missing':
                    asset.rename(asset.with_name('not-a-hash'))
                elif problem == 'corrupt':
                    (asset / 'identity').write_text('tampered')
                else:
                    if problem == 'slot':
                        release['artifacts']['../../data'] = 'a' * 64
                    else:
                        release['store'] = str(f.root / 'data')
                    f.m.write_json(release_file, release)
                    manifest = json.loads((snapshot / 'manifest.json').read_text())
                    manifest['files']['release.json'] = dict(size=release_file.stat().st_size, sha256=f.m.digest(release_file))
                    f.m.write_json(snapshot / 'manifest.json', manifest)
                self.assert_safe_warning(f)

    def test_symlinks_in_backup_store_or_payload_are_never_followed(self):
        for relative in ('backups/quiesced/database.sqlite', 'rollback', 'store-parent'):
            with self.subTest(relative=relative):
                f = self.fixture()
                external = f.root / 'protected-outside'
                external.mkdir()
                (external / 'keep').write_text('protected')
                if relative == 'store-parent':
                    target = f.batches / 'artifact-store/server'
                    target.rename(f.root / 'saved-store-server')
                    target.symlink_to(f.root / 'saved-store-server', target_is_directory=True)
                else:
                    target = f.releases[-1] / relative
                    if target.exists():
                        target.rename(external / 'original')
                    target.symlink_to(external)
                self.assert_safe_warning(f)
                self.assertEqual((external / 'keep').read_text(), 'protected')

    def test_unknown_and_unfinished_batches_protect_their_referenced_artifacts(self):
        f = self.fixture()
        unknown = f.batches / 'unknown-recovery'
        (unknown / 'backups/preflight').mkdir(parents=True)
        old_release = f.releases[0] / 'backups/preflight/release.json'
        (unknown / 'backups/preflight/release.json').write_bytes(old_release.read_bytes())
        active = f.batch(20, 'f' * 40, phase='switching-source')
        (active / 'rollback').mkdir()
        result = f.cleanup()
        self.assertEqual(result['status'], 'complete', result)
        self.assertIn(str(unknown), result['protectedBatches'])
        self.assertIn(str(active), result['protectedBatches'])
        release = json.loads(old_release.read_text()) if old_release.exists() else json.loads((unknown / 'backups/preflight/release.json').read_text())
        for slot, sha in release['artifacts'].items():
            self.assertTrue((pathlib.Path(release['store']) / slot / sha).is_dir())
        self.assertTrue((active / 'rollback').is_dir())

    def test_wrong_live_commit_or_non_success_manifest_never_deletes(self):
        for change in ('commit', 'result', 'backup'):
            with self.subTest(change=change):
                f = self.fixture()
                file = f.root / '.runtime/deployment.json'
                record = json.loads(file.read_text())
                if change == 'commit':
                    record['commit'] = 'f' * 40
                elif change == 'result':
                    record['desktopMacDeployment']['result'] = 'failed'
                else:
                    record['desktopMacDeployment']['backup'] = str(f.root / 'data')
                f.m.write_json(file, record)
                self.assert_safe_warning(f)

    def test_deletion_failure_is_a_recorded_warning_without_rollback_or_service_operations(self):
        f = self.fixture()
        before = (f.root / '.runtime/deployment.json').read_bytes()
        real_command = f.m.command
        commands = []
        def command(args, **kwargs):
            commands.append(args[0])
            return real_command(args, **kwargs)
        f.m.command = command
        with patch.object(f.m.shutil, 'rmtree', side_effect=OSError('injected removal failure')):
            result = f.cleanup()
        self.assertEqual(result['status'], 'warning')
        self.assertIn('injected removal failure', result['reason'])
        self.assertNotIn('systemctl', commands)
        self.assertEqual((f.root / '.runtime/deployment.json').read_bytes(), before)
        self.assertEqual(json.loads((f.releases[-1] / 'transaction.json').read_text())['phase'], 'complete')
        self.assertEqual(json.loads((f.releases[-1] / 'cleanup.json').read_text())['status'], 'warning')
        self.assertEqual(f.cleanup()['status'], 'complete')

    def test_runner_cleans_only_after_success_and_under_service_lock(self):
        for outcome in (0, 6, 7):
            with self.subTest(outcome=outcome):
                f = self.fixture(1)
                info = dict(f.info, old=f.info['sha'], branchTip=f.info['sha'], checks=[], states={})
                f.m.inspect_deployment = Mock(return_value=info)
                f.m.check_quiescence = Mock()
                f.m.runtime_toolchain = Mock(return_value='fixture')
                f.m.switch_transaction = Mock(return_value=outcome)
                def check_locks(*args):
                    for name in ('deploy.lock', 'service-control.lock'):
                        with self.assertRaises(f.m.Refused):
                            with f.m.remote_lock(f.root / '.runtime' / name):
                                self.fail('cleanup ran without lock')
                f.m.cleanup_after_success = Mock(side_effect=check_locks)
                result = f.m.run_remote(dict(dryRun=False, withBundle=False, config=dict(serverDir=str(f.root))))
                self.assertEqual(result, outcome)
                self.assertEqual(f.m.cleanup_after_success.call_count, 1 if outcome == 0 else 0)

    def test_preparation_interruption_stays_unresolved_instead_of_becoming_cleanup_eligible(self):
        for timeout in (False, True):
            with self.subTest(timeout=timeout):
                f = self.fixture(1)
                info = dict(f.info, old=f.info['sha'], checks=[])
                f.m.inspect_deployment = Mock(return_value=info)
                f.m.check_quiescence = Mock()
                failure = f.m.subprocess.TimeoutExpired('fixture', 1) if timeout else InterruptedError('fixture interruption')
                f.m.live_artifacts = Mock(side_effect=failure)
                f.m.cleanup_after_success = Mock()
                with self.assertRaises(type(failure)):
                    f.m.run_remote(dict(dryRun=False, withBundle=False, config=dict(serverDir=str(f.root))))
                journal = next(folder / 'transaction.json' for folder in f.batches.iterdir()
                               if folder.is_dir() and folder.name != 'artifact-store' and folder not in f.releases)
                self.assertEqual(json.loads(journal.read_text())['phase'], 'preparing')
                f.m.cleanup_after_success.assert_not_called()


if __name__ == '__main__':
    unittest.main()
