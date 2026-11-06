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


def start_and_check(info, port):
    command(['systemctl', 'start', 'ai-novel-api', 'ai-novel-web'])
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            health(port)
            return
        except Exception:
            time.sleep(2)
    raise Refused('新版本未通过 API、网页与小说读取检查')


def restore_service_state(info):
    if info['states']['ai-novel-api'] == 'inactive':
        command(['systemctl', 'stop', 'ai-novel-web', 'ai-novel-api'])


def switch_transaction(payload, info, batch, candidate, manifest):
    root, config = info['root'], payload['config']
    nginx_path = root / '.runtime/nginx.conf'
    original = nginx_path.read_text()
    expected = (root / 'infra/server/nginx.conf.template').read_text().replace('@ROOT@', str(root))
    if original != expected:
        raise Refused('Nginx 与既有安装模板不符，需人工核实维护入口')
    maintained = maintenance_config(original, config)
    rollback = batch / 'rollback'
    rollback.mkdir(mode=0o700)
    journal_path = batch / 'transaction.json'
    journal = dict(phase='prepared', old=info['old'], sha=info['sha'], branch=info['branch'], states=info['states'], movedOld=[], installed=[], pending=None)
    write_json(journal_path, journal)
    switched = False
    stopped = False
    maintenance = False
    try:
        check_quiescence(payload, info)
        maintenance = True
        set_nginx(root, maintained, reload=info['states']['ai-novel-web'] == 'active')
        for attempt in range(2):
            if attempt:
                time.sleep(5)
            check_quiescence(payload, info)
            check_connections()
        journal['phase'] = 'stopping'; write_json(journal_path, journal)
        # Mark before command so partial systemd failure also restores prior state.
        stopped = True
        command(['systemctl', 'stop', 'ai-novel-web', 'ai-novel-api'])
        check_quiescence(payload, info)
        final_backup = backup_snapshot(info, batch / 'backups/quiesced')
        verify_snapshot(final_backup)
        verify_snapshot(batch / 'backups/preflight')
        journal['phase'] = 'switching-source'; write_json(journal_path, journal)
        switched = True
        git(root, 'merge', '--ff-only', info['sha'])
        for name in ARTIFACTS:
            old, new, saved = root / name, candidate / name, rollback / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            if old.exists() or old.is_symlink():
                journal['pending'] = ['save-old', name]; write_json(journal_path, journal)
                os.rename(old, saved)
                journal['movedOld'].append(name)
            journal['pending'] = ['install', name]; write_json(journal_path, journal)
            os.rename(new, old)
            journal['installed'].append(name)
            journal['pending'] = None; write_json(journal_path, journal)
        journal['phase'] = 'verifying'; write_json(journal_path, journal)
        validate_nginx(root)
        start_and_check(info, config['maintenanceProbePort'])
        set_nginx(root, original, reload=True)
        maintenance = False
        health(config['remoteWebPort'])
        restore_service_state(info)
        record_path = root / '.runtime/deployment.json'
        record = json.loads(record_path.read_text()) if record_path.exists() else {}
        record['desktopMacDeployment'] = dict(sha=info['sha'], previousSha=info['old'], backup=str(batch / 'backups'), fingerprint=manifest['fingerprint'], result='success', time=datetime.datetime.now(datetime.timezone.utc).isoformat())
        write_json(record_path, record)
        journal['phase'] = 'complete'; write_json(journal_path, journal)
        emit('deployed', sha=info['sha'], backup=str(batch / 'backups'))
        return 0
    except BaseException as failure:
        emit('deployment_failed', stageDetail=journal['phase'], record=str(journal_path))
        try:
            if switched:
                command(['systemctl', 'stop', 'ai-novel-web', 'ai-novel-api'])
                # A rename may have completed just before an exception/journal write.
                for name in reversed(ARTIFACTS):
                    live, staged, saved = root / name, candidate / name, rollback / name
                    if not staged.exists() and (live.exists() or live.is_symlink()):
                        staged.parent.mkdir(parents=True, exist_ok=True)
                        os.rename(live, staged)
                    if saved.exists() or saved.is_symlink():
                        if live.exists() or live.is_symlink():
                            raise Refused('回滚目录存在未登记内容，保留现场')
                        os.rename(saved, live)
                # No hard reset, database restore, or deletion is permitted.
                git(root, 'switch', '--detach', info['old'])
            set_nginx(root, original, reload=not stopped and info['states']['ai-novel-web'] == 'active')
            maintenance = False
            if stopped and info['states']['ai-novel-api'] == 'active':
                start_and_check(info, config['remoteWebPort'])
            restore_service_state(info)
            journal['phase'] = 'rolled_back' if switched else 'aborted'; write_json(journal_path, journal)
            emit('rolled_back' if switched else 'aborted', sha=info['old'], detached=switched, backup=str(batch / 'backups'), reason=str(failure))
            return 7 if switched else 6
        except BaseException:
            journal['phase'] = 'rollback_failed'; write_json(journal_path, journal)
            emit('rollback_failed', record=str(journal_path), backup=str(batch / 'backups'))
            return 8
