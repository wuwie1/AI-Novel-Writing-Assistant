def archive_paths(destination, entries):
    with tarfile.open(destination, 'w:gz', dereference=False) as archive:
        for source, name in entries:
            if source.exists() or source.is_symlink():
                archive.add(source, arcname=name)
    destination.chmod(0o600)
    if destination.stat().st_size == 0:
        raise Refused('备份归档为空')
    with tarfile.open(destination) as archive:
        archive.getmembers()


def backup_snapshot(info, directory, previous_release=None):
    directory.mkdir(parents=True, mode=0o700)
    root, database = info['root'], info['db']
    target = directory / 'database.sqlite'
    source = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=20)
    destination = sqlite3.connect(target)
    try:
        source.backup(destination)
        if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise Refused('数据库备份完整性校验失败')
    finally:
        destination.close()
        source.close()
    target.chmod(0o600)
    if not target.stat().st_size:
        raise Refused('数据库备份为空')
    assets = [(item, 'assets/%s' % index) for index, item in enumerate(info['assets']) if item.exists()]
    # Data files besides the live SQLite triplet are backed up too.
    if (root / 'data').exists():
        assets += [(item, 'data/' + item.name) for item in (root / 'data').iterdir()
                   if item.resolve() not in (database, pathlib.Path(str(database) + '-wal'), pathlib.Path(str(database) + '-shm'))]
    archive_paths(directory / 'assets.tar.gz', assets)
    archive_paths(directory / 'config.tar.gz', [(root / 'server/.env', 'server.env'), (root / '.runtime/nginx.conf', 'nginx.conf')])
    if previous_release is not None:
        write_json(directory / 'release.json', previous_release)
        command(['git', '-C', root, 'bundle', 'create', directory / 'source.bundle', '--all'], timeout=600)
        command(['git', '-C', root, 'bundle', 'verify', directory / 'source.bundle'])
        command(['git', '-C', root, 'archive', '--format=tar', '-o', directory / 'source.tar', info['old']], timeout=600)
    files = {item.name: dict(size=item.stat().st_size, sha256=digest(item)) for item in directory.iterdir() if item.is_file()}
    write_json(directory / 'manifest.json', dict(sha=info['old'], database=str(database), assets=[str(item) for item in info['assets']], files=files))
    for item in directory.iterdir():
        if item.is_file():
            item.chmod(0o600)
    emit('backup_verified', path=str(directory))
    return directory


def verify_snapshot(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    for name, item in manifest['files'].items():
        file = directory / name
        if not file.is_file() or file.stat().st_size != item['size'] or digest(file) != item['sha256']:
            raise Refused('备份文件缺失或校验值不符，拒绝切换')
