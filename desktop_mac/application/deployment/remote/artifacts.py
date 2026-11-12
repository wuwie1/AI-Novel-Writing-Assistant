import stat


DEPENDENCIES = ARTIFACTS[:4]
OUTPUTS = ARTIFACTS[4:]
ENTRYPOINTS = ('shared/dist/index.js', 'server/dist/app.js', 'client/dist/index.html')


def artifact_digest(directory, file_hashes=None):
    if directory.is_symlink() or not directory.is_dir():
        raise Refused('产物目录缺失或顶层是链接：' + str(directory))
    checksum = hashlib.sha256()

    def metadata(info):
        checksum.update(f'{stat.S_IMODE(info.st_mode)}:{info.st_uid}:{info.st_gid}\0'.encode())

    def visit(folder):
        for item in sorted(os.scandir(folder), key=lambda entry: entry.name):
            info = item.stat(follow_symlinks=False)
            mode = info.st_mode
            checksum.update(os.fsencode(item.name) + b'\0')
            metadata(info)
            if stat.S_ISLNK(mode):
                checksum.update(b'L' + os.fsencode(os.readlink(item.path)) + b'\0')
            elif stat.S_ISDIR(mode):
                checksum.update(b'D')
                visit(item.path)
                checksum.update(b'E')
            elif stat.S_ISREG(mode):
                identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                content = file_hashes.get(identity) if file_hashes is not None else None
                if content is None:
                    content = bytes.fromhex(digest(item.path))
                    if file_hashes is not None:
                        after = os.stat(item.path, follow_symlinks=False)
                        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != identity:
                            raise Refused('校验时产物文件发生变化：' + item.path)
                        file_hashes[identity] = content
                checksum.update(b'F' + content)
            else:
                raise Refused('产物含非常规文件：' + item.path)

    metadata(directory.stat())
    visit(directory)
    return checksum.hexdigest()


def live_artifacts(root, file_hashes=None):
    for name in ENTRYPOINTS:
        if not (root / name).is_file() or not (root / name).stat().st_size:
            raise Refused('线上产物入口缺失或为空：' + name)
    return {name: artifact_digest(root / name, file_hashes) for name in ARTIFACTS}


def runtime_toolchain(root):
    node = command([root / '.runtime/node/bin/node', '-p', 'JSON.stringify([process.platform,process.arch,process.version,process.versions.modules,process.versions.openssl])']).stdout
    pnpm = json.loads((root / '.runtime/pnpm/node_modules/pnpm/package.json').read_text())['version']
    return {'node': json.loads(node), 'pnpm': pnpm}


def release_plan(info, installed, toolchain, record):
    last = record.get('desktopMacDeployment', {})
    proof = last.get('release', {})
    verified = (record.get('commit') == last.get('sha') == info['old'] and record.get('branch') == info['branch']
                and last.get('result') == 'success' and proof.get('version') == 1)
    if verified and proof.get('artifacts') != installed:
        raise Refused('线上产物与上次成功发布的校验值不符，已保留现场，请检查产物或从上一版恢复')
    if not verified or proof.get('toolchain') != toolchain:
        return dict(mode='full', slots=list(ARTIFACTS), tests=True, reason='建立产物校验基线或运行工具链已变更')
    backup = pathlib.Path(last.get('backup', ''))
    batches = info['root'] / '.runtime/desktop_mac-deploy'
    if (backup.parent.parent != batches or backup.name != 'backups'
            or not (backup / 'preflight/release.json').is_file() or not (backup / 'quiesced/manifest.json').is_file()):
        raise Refused('上一版回滚清单缺失，需先核对已保留的版本')
    validation = backup.parent / 'validation.json'
    if last.get('validation') != str(validation) or not validation.is_file():
        raise Refused('上次发布缺少验证记录，需先核对已部署版本')
    require_validation_record(json.loads(validation.read_text()), info['old'], info['ref'])
    if info['old'] == info['sha']:
        return dict(mode='restart', slots=[], tests=False, reason='提交、运行工具链和全部产物均已核对')
    affected = set()
    tests = False
    independent = {'.agents', '.claude', '.github', '.superpowers', 'docs', 'desktop', 'desktop_mac', 'site', 'proxy'}
    for path in info['differences']:
        group, _, name = path.partition('/')
        if path == 'desktop/package.json':  # client/vite.config.ts embeds its version.
            affected.add('client/dist')
        elif path in ('client/package.json', 'server/package.json') or group == 'shared':
            affected.update(ARTIFACTS)  # pnpm injects the built shared package into dependencies.
        elif group in ('client', 'server'):
            if name.startswith('tests/'):
                tests = True
            else:
                affected.add(group + '/dist')
        elif (group in independent or path.startswith('infra/server/tunnel/') or path in ('infra/server/tunnel.sh', 'infra/server/README.md')
              or ('/' not in path and (path.endswith('.md') or path in ('.gitignore', 'LICENSE', 'NOTICE', 'Makefile')))):
            continue
        else:
            affected.update(ARTIFACTS)  # Includes lockfiles, install hooks, global TS settings and unknown inputs.
    slots = [name for name in ARTIFACTS if name in affected]
    mode = 'full' if slots == list(ARTIFACTS) else 'incremental' if slots else 'source'
    return dict(mode=mode, slots=slots, tests=bool(slots) or tests, reason='按两个提交之间的构建输入计算')


def copy_artifact(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    args = ['cp', '-a']
    if sys.platform.startswith('linux'):
        args.append('--reflink=auto')
    command([*args, source, destination], timeout=900)


def retain_release(info, batch, installed):
    store = batch.parent / 'artifact-store'
    store.mkdir(mode=0o700, exist_ok=True)
    for slot, expected in installed.items():
        storage = store / slot / expected
        storage.parent.mkdir(parents=True, exist_ok=True)
        if not storage.exists():
            with tempfile.TemporaryDirectory(dir=storage.parent) as scratch:
                copied = pathlib.Path(scratch) / 'artifact'
                copy_artifact(info['root'] / slot, copied)
                if artifact_digest(copied) != expected:
                    raise Refused('旧产物留存校验失败：' + slot)
                os.rename(copied, storage)
        elif artifact_digest(storage) != expected:
            raise Refused('已保留的旧产物校验失败：' + slot)
    return dict(sha=info['old'], store=str(store), artifacts=installed)
