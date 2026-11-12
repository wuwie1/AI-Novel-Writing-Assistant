import re


RETAINED_RELEASES = 2
TERMINAL_DEPLOYMENTS = ('complete', 'rolled_back', 'aborted')
DEPLOYMENT_NAME = re.compile(r'\d{8}T\d{6}-[0-9a-f]{12}-[A-Za-z0-9_-]+')


def retention_path(path, root, *, directory=False):
    """Only real paths owned by this deployment; never traverse control-path links."""
    path = pathlib.Path(path)
    if (not path.is_absolute() or '..' in path.parts or root not in path.parents
            or path.resolve() != path or path.is_symlink()
            or not (path.is_dir() if directory else path.is_file())):
        raise Refused('清理路径越界、缺失或包含链接：' + str(path))
    return path


def retention_record(path, root):
    record = json.loads(retention_path(path, root).read_text())
    if not isinstance(record, dict):
        raise Refused('清理依据不是有效清单：' + str(path))
    return record


def retention_hash(value, length=64):
    return isinstance(value, str) and len(value) == length and all(ch in '0123456789abcdef' for ch in value)


def verify_retention_snapshot(directory, root, sha, *, source=False):
    retention_path(directory, root, directory=True)
    manifest = retention_record(directory / 'manifest.json', root)
    required = {'database.sqlite', 'assets.tar.gz', 'config.tar.gz'}
    if source:
        required |= {'source.bundle', 'source.tar', 'release.json'}
    files = manifest.get('files', {})
    if manifest.get('sha') != sha or not required.issubset(files):
        raise Refused('保留备份与发布版本不符或文件不完整')
    for name, item in files.items():
        if (pathlib.Path(name).name != name or name in ('.', '..')
                or not isinstance(item, dict) or not isinstance(item.get('size'), int)
                or item['size'] <= 0 or not retention_hash(item.get('sha256'))):
            raise Refused('保留备份清单含不安全文件记录')
        retention_path(directory / name, root)
    verify_snapshot(directory)
    with sqlite3.connect((directory / 'database.sqlite').as_uri() + '?mode=ro', uri=True) as database:
        if database.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise Refused('保留数据库备份完整性校验失败')
    for name in ('assets.tar.gz', 'config.tar.gz', *(['source.tar'] if source else [])):
        with tarfile.open(directory / name) as archive:
            archive.getmembers()


def plan_deployment_retention(info, batch):
    root = info['root']
    batches = retention_path(root / '.runtime/desktop_mac-deploy', root, directory=True)
    retention_path(batch, root, directory=True)
    record = retention_record(root / '.runtime/deployment.json', root)
    last = record.get('desktopMacDeployment', {})
    if (record.get('commit') != info['sha'] or record.get('branch') != info['branch']
            or last.get('sha') != info['sha'] or last.get('result') != 'success'
            or git(root, 'rev-parse', 'HEAD') != info['sha']):
        raise Refused('清理前线上版本与成功发布清单不一致')
    backup = retention_path(last.get('backup', ''), root, directory=True)
    current = backup.parent
    if current.parent != batches or backup.name != 'backups' or last.get('validation') != str(current / 'validation.json'):
        raise Refused('当前发布备份或验证记录不属于部署批次')

    journals, protected = {}, set()
    for folder in sorted(batches.iterdir()):
        if folder.name == 'artifact-store':
            continue
        if folder.is_symlink():
            raise Refused('部署目录含未知链接，保留现场：' + str(folder))
        if not folder.is_dir():
            continue
        retention_path(folder, root, directory=True)
        journal = folder / 'transaction.json'
        data = retention_record(journal, root) if journal.exists() else {}
        journals[folder] = data
        if (not DEPLOYMENT_NAME.fullmatch(folder.name) or data.get('phase') not in TERMINAL_DEPLOYMENTS
                or data.get('branch') != info['branch'] or not retention_hash(data.get('sha'), 40)):
            protected.add(folder)
    for folder in (current, batch):
        data = journals.get(folder, {})
        if data.get('phase') != 'complete' or data.get('sha') != info['sha'] or folder in protected:
            raise Refused('当前发布事务未完整成功，不能清理')

    previous_sha = last.get('previousSha')
    if previous_sha == info['sha']:
        previous_sha = record.get('previousCommit')
    previous = [folder for folder, data in journals.items()
                if folder not in protected and data.get('phase') == 'complete'
                and data.get('sha') == previous_sha and data.get('mode') != 'restart'
                and (folder / 'backups').is_dir()]
    recovery = {current}
    if previous:
        recovery.add(max(previous))
    keep = recovery | protected | {batch}

    # Older releases may reuse a build log from an aborted batch. Retain its small
    # receipt, not its now-unused candidate/rollback/backup payloads.
    while True:
        evidence_batches = set()
        for folder in keep:
            validation = folder / 'validation.json'
            if not validation.exists():
                if folder in recovery:
                    raise Refused('保留版本缺少验证记录')
                continue
            proof = retention_record(validation, root)
            if folder in recovery:
                require_validation_record(proof, journals[folder]['sha'], info['ref'])
            evidence = pathlib.Path(proof.get('evidence', ''))
            if batches in evidence.parents:
                retention_path(evidence, root)
                owner = batches / evidence.relative_to(batches).parts[0]
                if owner not in journals:
                    raise Refused('验证日志引用未知部署目录')
                evidence_batches.add(owner)
                if evidence.parent != owner:
                    protected.add(owner)  # An unusual nested evidence path is never trimmed.
        if evidence_batches <= keep:
            break
        keep |= evidence_batches

    backups = []
    for folder in sorted(recovery):
        sha = journals[folder].get('old')
        if not retention_hash(sha, 40):
            raise Refused('保留版本缺少回滚提交')
        for name in ('preflight', 'quiesced'):
            snapshot = folder / 'backups' / name
            verify_retention_snapshot(snapshot, root, sha, source=name == 'preflight')
            backups.append(str(snapshot))

    referenced = set()
    store = retention_path(batches / 'artifact-store', root, directory=True)
    for folder in recovery | protected:
        backup_root = folder / 'backups'
        if backup_root.exists():
            retention_path(backup_root, root, directory=True)
            for snapshot in backup_root.iterdir():
                retention_path(snapshot, root, directory=True)
                release_file = snapshot / 'release.json'
                if not release_file.exists():
                    continue
                release = retention_record(release_file, root)
                artifacts = release.get('artifacts')
                if (release.get('store') != str(store) or not isinstance(artifacts, dict)
                        or (folder in recovery and set(artifacts) != set(ARTIFACTS))):
                    raise Refused('保留版本的产物引用不完整或越界')
                if folder in recovery and release.get('sha') != journals[folder]['old']:
                    raise Refused('保留产物与回滚提交不一致')
                for slot, fingerprint in artifacts.items():
                    if slot not in ARTIFACTS or not retention_hash(fingerprint):
                        raise Refused('保留版本包含未知产物引用')
                    referenced.add(retention_path(store / slot / fingerprint, root, directory=True))
    hashes = {}
    for artifact in sorted(referenced):
        if artifact_digest(artifact, hashes) != artifact.name:
            raise Refused('保留的回滚产物校验失败：' + str(artifact))

    obsolete_artifacts = []
    for slot in ARTIFACTS:
        parent = store / slot
        if not parent.exists():
            continue
        retention_path(parent, root, directory=True)
        for folder in parent.iterdir():
            if retention_hash(folder.name):
                retention_path(folder, root, directory=True)
                if folder not in referenced:
                    obsolete_artifacts.append(folder)
    obsolete_batches = sorted(set(journals) - keep)
    redundant_payloads = []
    for folder in sorted(keep - protected):
        names = ['candidate', 'rollback'] + ([] if folder in recovery else ['backups'])
        payloads = [folder / name for name in names] + list(folder.glob('build-*'))
        for payload in payloads:
            if payload.exists() or payload.is_symlink():
                retention_path(payload, root, directory=True)
                redundant_payloads.append(payload)
    return dict(retainedReleases=RETAINED_RELEASES, retainedBatches=[str(p) for p in sorted(keep)],
                recoveryBatches=[str(p) for p in sorted(recovery)], protectedBatches=[str(p) for p in sorted(protected)],
                verifiedBackups=backups, referencedArtifacts=[str(p) for p in sorted(referenced)],
                deleteBatches=[str(p) for p in obsolete_batches],
                deletePayloads=[str(p) for p in sorted(redundant_payloads)],
                deleteArtifacts=[str(p) for p in sorted(obsolete_artifacts)])


def cleanup_after_success(info, batch, timings):
    """Called under both deployment locks, outside the release rollback boundary."""
    report = dict(version=1, sha=info['sha'], status='checking', deleted=[])
    receipt = batch / 'cleanup.json'
    try:
        with timings.stage('cleanup'):
            report.update(plan_deployment_retention(info, batch))
            report.update(status='deleting', freeBefore=shutil.disk_usage(info['root']).free)
            write_json(receipt, report)
            for name in ('deleteBatches', 'deletePayloads', 'deleteArtifacts'):
                for value in report[name]:
                    target = retention_path(value, info['root'] / '.runtime/desktop_mac-deploy', directory=True)
                    shutil.rmtree(target)
                    report['deleted'].append(value)
                    write_json(receipt, report)
            report.update(status='complete', freeAfter=shutil.disk_usage(info['root']).free)
            report['reclaimedBytes'] = report['freeAfter'] - report['freeBefore']
            write_json(receipt, report)
        emit('cleanup_complete', deletedBatches=len(report['deleteBatches']),
             deletedPayloads=len(report['deletePayloads']), deletedArtifactVersions=len(report['deleteArtifacts']),
             reclaimedBytes=report['reclaimedBytes'], record=str(receipt), backups=report['verifiedBackups'])
    except Exception as error:
        # Cleanup cannot turn a healthy, committed release into a failed deployment.
        report.update(status='warning', reason=str(error))
        try:
            write_json(receipt, report)
        except OSError:
            pass
        emit('cleanup_warning', reason=str(error), deleted=len(report['deleted']), record=str(receipt))
    return report
