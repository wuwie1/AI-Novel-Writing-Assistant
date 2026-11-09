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
    branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False)
    if not branch or git(root, 'status', '--porcelain', '--untracked-files=no'):
        raise Refused('服务器源码有修改或处于 detached HEAD，需先人工核对发布分支')
    ref = config['deployRef']
    if not ref.startswith('origin/') or ref[7:] != branch or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.' for c in ref):
        raise Refused('DEPLOY_REF 必须是服务器当前发布分支的 origin/<branch>，不能自动换线')
    candidate_sha = candidate_commit(root, payload.get('currentSha'), import_bundle=import_bundle)
    candidate_known = command(['git', '-C', root, 'cat-file', '-e', candidate_sha + '^{commit}'], check=False).returncode == 0
    checks = []
    differences = []
    if not candidate_known:
        checks.append('服务器缺少本地候选提交，需在导入 Git bundle 后校验兼容性')
    else:
        if command(['git', '-C', root, 'merge-base', '--is-ancestor', old, candidate_sha], check=False).returncode:
            raise Refused('候选不是当前部署的后代，拒绝分叉或降级')
        differences = git(root, 'diff', '--name-only', old, candidate_sha).splitlines()
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
        untracked = set(git(root, 'ls-files', '--others', '--exclude-standard').splitlines())
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
        checks.append('正式更新时会在候选目录完成构建和回归测试，并保存本次提交的验证记录')
    # Preserve sufficient room for old dependencies, two snapshots and a candidate.
    sizes = command(['du', '-sk', root / 'node_modules', root / 'server/storage', db], check=False).stdout.splitlines()
    used = sum(int(line.split()[0]) * 1024 for line in sizes if line.split() and line.split()[0].isdigit())
    minimum = max(4 * 1024 ** 3, used * 4)
    if shutil.disk_usage(root).free < minimum:
        checks.append('磁盘余量不足，需至少 %s 字节；不会自动清理任何数据' % minimum)
    if states['ai-novel-api'] == 'active':
        health(config['remoteWebPort'])
    return dict(root=root, old=old, branch=branch, ref=ref, sha=candidate_sha, differences=differences,
                checks=checks, states=states, db=db, assets=assets, known=candidate_known)


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


def check_connections():
    result = command(['ss', '-Htn', 'state', 'established', '( sport = :13000 or dport = :13000 )'])
    if result.stdout.strip():
        raise Refused('API 仍有连接（包括旧流式请求/直连调用），暂不停止')
