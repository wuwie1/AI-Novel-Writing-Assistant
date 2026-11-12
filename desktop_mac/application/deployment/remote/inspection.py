def candidate_commit(root, sha, *, import_bundle=False):
    if not isinstance(sha, str) or len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
        raise Refused('本地候选必须是完整的 Git 提交 SHA')
    if import_bundle:
        with tempfile.NamedTemporaryFile(dir=root / '.runtime', suffix='.bundle') as incoming:
            shutil.copyfileobj(sys.stdin.buffer, incoming)
            incoming.flush()
            if git(root, 'bundle', 'list-heads', incoming.name) != sha + ' HEAD':
                raise Refused('传入的 Git bundle 与本次提交不符')
            git(root, 'bundle', 'verify', incoming.name)
            # The deployment transaction advances the branch after the backups are verified.
            git(root, 'bundle', 'unbundle', incoming.name)
    return sha


def deployment_branch_tip(root, branch, old):
    attached = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False)
    if attached == branch:
        return old
    if attached:
        raise Refused('服务器已检出其他分支，请核对 DEPLOY_REF')
    # A previous updater could restore the old checkout after advancing the branch.
    # Accept only the precise state witnessed by the last transaction and live manifest.
    runtime = root / '.runtime'
    manifest_path = runtime / 'deployment.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
    tip = git(root, 'rev-parse', '--verify', 'refs/heads/' + branch)
    if manifest.get('commit') == old and manifest.get('branch') == branch:
        for path in sorted((runtime / 'desktop_mac-deploy').glob('*/transaction.json'), reverse=True):
            record = json.loads(path.read_text())
            if record.get('phase') == 'aborted':
                continue  # Aborted before switching source.
            if (record.get('phase') == 'rolled_back' and record.get('branch') == branch
                    and record.get('old') == old and tip in (record.get('sha'), record.get('branchTip'))
                    and command(['git', '-C', root, 'merge-base', '--is-ancestor', old, tip], check=False).returncode == 0):
                return tip
            break
    raise Refused('服务器处于 detached HEAD，部署清单、发布分支和最近的回滚记录未能确认同一基线')


def inspect_deployment(payload, *, import_bundle=False):
    config = payload['config']
    root = pathlib.Path(config['serverDir']).resolve(strict=True)
    if git(root, 'rev-parse', '--show-toplevel') != str(root):
        raise Refused('目标不是仓库根目录')
    origin = git(root, 'remote', 'get-url', 'origin')
    if origin not in ('git@github.com:wuwie1/AI-Novel-Writing-Assistant.git', 'https://github.com/wuwie1/AI-Novel-Writing-Assistant.git'):
        raise Refused('origin 不是指定 fork')
    old = git(root, 'rev-parse', 'HEAD')
    if not payload['dryRun'] and old != payload.get('serverBase'):
        raise Refused('服务器版本与本次预演基线不符，请重新预演')
    if git(root, 'status', '--porcelain', '--untracked-files=no'):
        raise Refused('服务器源码有修改，请先核对工作区')
    ref = config['deployRef']
    if not ref.startswith('origin/') or command(['git', 'check-ref-format', 'refs/heads/' + ref[7:]], check=False).returncode:
        raise Refused('DEPLOY_REF 必须是服务器发布分支的 origin/<branch>')
    branch = ref[7:]
    branch_tip = deployment_branch_tip(root, branch, old)
    candidate_sha = candidate_commit(root, payload.get('currentSha'), import_bundle=import_bundle)
    candidate_known = command(['git', '-C', root, 'cat-file', '-e', candidate_sha + '^{commit}'], check=False).returncode == 0
    checks = []
    differences = []
    if not candidate_known:
        checks.append('服务器缺少本地候选提交，需在导入 Git bundle 后校验兼容性')
    else:
        if command(['git', '-C', root, 'merge-base', '--is-ancestor', old, candidate_sha], check=False).returncode:
            raise Refused('候选不是当前部署的后代，拒绝分叉或降级')
        if branch_tip != old and command(['git', '-C', root, 'merge-base', '--is-ancestor', branch_tip, candidate_sha], check=False).returncode:
            raise Refused('候选未包含服务器发布分支上的提交，无法快进')
        differences = command(['git', '-C', root, 'diff', '--no-renames', '--name-only', '-z', old, candidate_sha]).stdout.split('\0')[:-1]
        compatibility = git(root, 'diff', '--name-only', old, candidate_sha, '--', *COMPATIBILITY)
        old_dependencies = json.loads(git(root, 'show', old + ':server/package.json'))['dependencies']
        new_dependencies = json.loads(git(root, 'show', candidate_sha + ':server/package.json'))['dependencies']
        database_dependencies = ('@prisma/client', '@prisma/adapter-better-sqlite3', 'better-sqlite3', '@prisma/adapter-pg')
        if compatibility or any(old_dependencies.get(key) != new_dependencies.get(key) for key in database_dependencies):
            raise Refused('数据库 schema、迁移、启动兼容逻辑或数据库依赖发生变化，请单独核验迁移和回滚方案')
        for file in git(root, 'ls-tree', '-r', '--name-only', candidate_sha).splitlines():
            if any(file == item or file.startswith(item + '/') for item in (*PROTECTED, *ARTIFACTS)):
                raise Refused('候选受控文件与持久数据/产物保护清单冲突')
        # Untracked source paths must not be overwritten by fast-forward checkout.
        untracked = set(command(['git', '-C', root, 'ls-files', '-z', '--others', '--exclude-standard']).stdout.split('\0'))
        if untracked.intersection(differences):
            raise Refused('候选会覆盖服务器未跟踪文件')
    states = {}
    for unit, expected in (('ai-novel-api', root / 'server'), ('ai-novel-web', root)):
        if command(['systemctl', 'show', unit, '-p', 'WorkingDirectory', '--value']).stdout.strip() != str(expected):
            raise Refused('systemd 服务不属于指定部署目录')
        state = command(['systemctl', 'is-active', unit], check=False).stdout.strip()
        if state not in ('active', 'inactive'):
            raise Refused('systemd 服务状态未知或失败，先恢复稳定基线')
        states[unit] = state
    if states['ai-novel-api'] != states['ai-novel-web']:
        raise Refused('API/Web 启停状态不一致，先核实基线')
    db, assets = runtime_paths(root)
    if 'validation' in payload:
        require_validation_record(payload['validation'], candidate_sha, ref)
    elif payload['dryRun'] and old != candidate_sha:
        checks.append('正式更新将核对线上产物，只构建受影响的部分，并记录本次验证结果')
    if states['ai-novel-api'] == 'active':
        health(config['remoteWebPort'], root)
    return dict(root=root, old=old, branch=branch, branchTip=branch_tip, ref=ref, sha=candidate_sha, differences=differences,
                checks=checks, states=states, db=db, assets=assets, known=candidate_known)


def check_build_space(info):
    root = info['root']
    sizes = command(['du', '-sk', root / 'node_modules', root / 'server/storage', info['db']]).stdout.splitlines()
    minimum = max(4 * 1024 ** 3, 4 * sum(int(line.split()[0]) * 1024 for line in sizes))
    if shutil.disk_usage(root).free < minimum:
        raise Refused('磁盘余量不足，需至少 %s 字节' % minimum)


def check_quiescence(payload, info):
    # Execute the exact reviewed read-only adapter, without importing backend bootstrap.
    script = payload['quiescence'] + '\nconsole.log(JSON.stringify(await inspectSqliteQuiescence({dbPath: process.argv[2], repoRoot: process.argv[3]})));\n'
    result = subprocess.run([str(info['root'] / '.runtime/node/bin/node'), '--input-type=module', '-', str(info['db']), str(info['root'])], input=script,
                            capture_output=True, text=True, timeout=30)
    try:
        body = json.loads(result.stdout.splitlines()[-1])
    except (ValueError, IndexError):
        raise Refused('任务静止检查未得到完整结果')
    if result.returncode or body.get('safeToStop') is not True:
        emit('quiescence_blocked', reason=body.get('reason'), blockers=[{key: value for key, value in item.items() if key in ('kind', 'table', 'tables', 'count', 'missingColumns', 'unclassifiedColumns')} for item in body.get('blockers', [])][:40])
        raise Refused('仍有活跃/待执行任务或任务覆盖未知；服务保持原状态')


class ActiveConnections(Refused):
    pass


def check_connections():
    result = command(['ss', '-Htn', 'state', 'established', '( sport = :13000 or dport = :13000 )'])
    if result.stdout.strip():
        raise ActiveConnections('API 仍有连接（包括旧流式请求/直连调用），暂不停止')


def wait_for_drain(payload, info):
    deadline = time.monotonic() + 30
    clear_once = waiting = False
    while True:
        check_quiescence(payload, info)
        try:
            check_connections()
        except ActiveConnections:
            if time.monotonic() >= deadline:
                raise
            clear_once = False
            if not waiting:
                emit('waiting_for_connections', seconds=30)
                waiting = True
        else:
            if clear_once:
                return
            clear_once = True
        time.sleep(5)


def begin_observer_drain(info):
    # This is a short-lived control lease, not task state. The API can read it as its service user.
    file = info['root'] / 'server/storage/.llm-live-drain.json'
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.is_symlink():
        raise Refused('实况排空标记不能是符号链接')
    if file.exists():
        existing = json.loads(file.read_text())
        if existing.get('expiresAt', 0) > time.time() * 1000:
            raise Refused('已有实况排空操作，请等待租约到期后重试')
    owner = os.urandom(16).hex()
    # Publish readable contents atomically; readers never see a partial or root-only lease.
    with tempfile.NamedTemporaryFile(mode='w', dir=file.parent, delete=False) as stream:
        temporary = pathlib.Path(stream.name)
        try:
            json.dump(dict(version=1, owner=owner, expiresAt=int(time.time() * 1000) + 90000), stream)
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
            os.replace(temporary, file)
        finally:
            if temporary.exists():
                temporary.unlink()
    emit('observer_drain', expiresInSeconds=90)
    return file, owner


def end_observer_drain(lease):
    if lease is None:
        return
    file, owner = lease
    if file.is_file() and not file.is_symlink() and json.loads(file.read_text()).get('owner') == owner:
        file.unlink()
