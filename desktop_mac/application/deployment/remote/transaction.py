def validate_nginx(root):
    command(['runuser', '-u', 'ai-novel', '--', root / '.runtime/nginx/usr/sbin/nginx', '-t', '-e', root / 'logs/nginx-error.log', '-p', str(root / '.runtime/nginx') + '/', '-c', root / '.runtime/nginx.conf'])


def set_nginx(root, text, reload=False):
    config = root / '.runtime/nginx.conf'
    # Retain ai-novel-readable ownership/mode; never truncate before durable write.
    current = config.stat()
    temporary = config.with_suffix('.desktop-mac.tmp')
    with open(temporary, 'w') as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, current.st_mode & 0o777)
    os.chown(temporary, current.st_uid, current.st_gid)
    os.replace(temporary, config)
    validate_nginx(root)
    if reload:
        command(['systemctl', 'reload', 'ai-novel-web'])


def wait_for_health(port, timeout, root):
    deadline = time.monotonic() + timeout
    while True:
        try:
            health(port, root)
            return
        except Exception as error:
            if time.monotonic() >= deadline:
                raise Refused(f'端口 {port} 的 API、网页与小说读取检查超时：{error}') from error
            time.sleep(2)


def start_and_check(port, root):
    command(['systemctl', 'start', 'ai-novel-api', 'ai-novel-web'])
    wait_for_health(port, 120, root)


def switch_transaction(payload, info, batch, candidate, manifest, previous, timings):
    root, config = info['root'], payload['config']
    original = (root / '.runtime/nginx.conf').read_text()
    expected = (root / 'infra/server/nginx.conf.template').read_text().replace('@ROOT@', str(root))
    if original != expected:
        raise Refused('Nginx 与既有安装模板不符，需人工核实维护入口')
    maintained = maintenance_config(original, config)
    restart = manifest['mode'] == 'restart'
    slots = manifest['artifacts']
    rollback = batch / 'rollback'
    if slots:
        rollback.mkdir(mode=0o700)
    journal_path = batch / 'transaction.json'
    branch_ref = 'refs/heads/' + info['branch']
    backup = previous.get('desktopMacDeployment', {}).get('backup') if restart else str(batch / 'backups')
    journal = dict(phase='prepared', mode=manifest['mode'], artifacts=slots, old=info['old'], sha=info['sha'], branch=info['branch'], branchTip=info['branchTip'], states=info['states'], movedOld=[], installed=[], pending=None)
    def phase(name):
        journal['phase'] = name
        write_json(journal_path, journal)
    phase('prepared')
    switched = stopped = record_written = False
    record_path = root / '.runtime/deployment.json'
    try:
        with timings.stage('drain'):
            check_quiescence(payload, info)
            set_nginx(root, maintained, reload=info['states']['ai-novel-web'] == 'active')
            wait_for_drain(payload, info)
        with timings.stage('stop'):
            phase('stopping')
            stopped = True
            command(['systemctl', 'stop', 'ai-novel-web', 'ai-novel-api'])
            check_quiescence(payload, info)
        if not restart:
            with timings.stage('final-backup'):
                final_backup = backup_snapshot(info, batch / 'backups/quiesced')
                verify_snapshot(final_backup)
                verify_snapshot(batch / 'backups/preflight')
            with timings.stage('switch'):
                phase('switching-source')
                switched = True
                if info['sha'] != info['old']:
                    git(root, 'switch', '--detach', info['sha'])
                for name in slots:
                    old, new, saved = root / name, candidate / name, rollback / name
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    journal['pending'] = ['save-old', name]; write_json(journal_path, journal)
                    os.rename(old, saved)
                    journal['movedOld'].append(name)
                    journal['pending'] = ['install', name]; write_json(journal_path, journal)
                    os.rename(new, old)
                    journal['installed'].append(name)
                    journal['pending'] = None; write_json(journal_path, journal)
        with timings.stage('start-health'):
            phase('verifying')
            validate_nginx(root)
            start_and_check(config['maintenanceProbePort'], root)
            set_nginx(root, original, reload=True)
            wait_for_health(config['remoteWebPort'], 30, root)
            for unit in info['states']:
                if command(['systemctl', 'is-active', unit], check=False).stdout.strip() != 'active':
                    raise Refused(unit + ' 重启后未处于 active 状态')
        if git(root, 'rev-parse', 'HEAD') != info['sha']:
            raise Refused('实际部署提交与本次候选不符')
        if not restart:
            # Fast-forward ancestry was checked before stopping. Compare-and-swap the inspected ref.
            git(root, 'update-ref', branch_ref, info['sha'], info['branchTip'])
            git(root, 'switch', '--no-guess', '--', info['branch'])
            if git(root, 'rev-parse', 'HEAD') != info['sha']:
                raise Refused('发布分支与已验证的提交不符')
            timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
            record = dict(previous, commit=info['sha'], branch=info['branch'], updatedAt=timestamp)
            if info['sha'] != info['old']:
                record['previousCommit'] = info['old']
            record['desktopMacDeployment'] = dict(sha=info['sha'], previousSha=info['old'], backup=backup,
                fingerprint=manifest['fingerprint'], result='success', time=timestamp, validation=manifest['validation'],
                release=dict(version=1, artifacts=manifest['hashes'], toolchain=manifest['toolchain']))
            write_json(record_path, record)
            record_written = True
        phase('complete')
    except BaseException as failure:
        emit('deployment_failed', stageDetail=journal['phase'], record=str(journal_path))
        try:
            if switched:
                command(['systemctl', 'stop', 'ai-novel-web', 'ai-novel-api'])
                for name in reversed(slots):
                    live, staged, saved = root / name, candidate / name, rollback / name
                    if not staged.exists() and (live.exists() or live.is_symlink()):
                        os.rename(live, staged)
                    if saved.exists() or saved.is_symlink():
                        if live.exists() or live.is_symlink():
                            raise Refused('回滚目录存在未登记内容，保留现场')
                        os.rename(saved, live)
                git(root, 'switch', '--detach', info['old'])
                if git(root, 'rev-parse', '--verify', branch_ref) == info['old']:
                    git(root, 'switch', '--no-guess', '--', info['branch'])
                if record_written:
                    if previous:
                        write_json(record_path, previous)
                    else:
                        os.rename(record_path, batch / 'uncommitted-deployment.json')
            set_nginx(root, original, reload=not stopped and info['states']['ai-novel-web'] == 'active')
            if stopped and info['states']['ai-novel-api'] == 'active':
                start_and_check(config['remoteWebPort'], root)
            if info['states']['ai-novel-api'] == 'inactive':
                command(['systemctl', 'stop', 'ai-novel-web', 'ai-novel-api'])
            phase('rolled_back' if switched else 'aborted')
            detached = not git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False)
            emit(journal['phase'], sha=info['old'], detached=detached, backup=backup, reason=str(failure))
            return 7 if switched else 6
        except BaseException:
            phase('rollback_failed')
            emit('rollback_failed', record=str(journal_path), backup=backup)
            return 8
    emit('deployed', sha=info['sha'], mode=manifest['mode'], artifacts=slots, backup=backup,
         backupReused=restart, timings=str(batch / 'timings.json'))
    return 0
