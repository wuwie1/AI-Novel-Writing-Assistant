VALIDATION_CHECKS = ('server-build', 'client-build', 'targeted-tests')


def require_validation_record(record, sha, ref):
    if not isinstance(record, dict) or record.get('sha') != sha or record.get('ref') != ref:
        raise Refused('验证记录的 sha 或 ref 与本次部署不符')
    passed = record.get('passed')
    if not isinstance(passed, list) or not all(check in passed for check in VALIDATION_CHECKS):
        raise Refused('验证记录须包含已通过的 server-build、client-build 和 targeted-tests')
    if not isinstance(record.get('evidence'), str) or not record['evidence'].strip():
        raise Refused('验证记录缺少构建和测试的日志位置 evidence')


def build_candidate(info, batch, validation):
    root = info['root']
    candidate = batch / 'candidate'
    candidate.mkdir(mode=0o700)
    source = batch / 'candidate-source.tar'
    command(['git', '-C', root, 'archive', '--format=tar', '-o', source, info['sha']], timeout=600)
    with tarfile.open(source) as archive:
        for member in archive.getmembers():
            target = candidate / member.name
            if candidate not in target.resolve().parents:
                raise Refused('候选归档路径越界')
            if member.issym() or member.islnk():
                link = target.parent / member.linkname
                if candidate not in link.resolve().parents:
                    raise Refused('候选源码链接越界')
        # git archive contains reviewed tracked source only; paths validated above.
        archive.extractall(candidate, filter='data')
    # pnpm can link a dependency directly to a tracked workspace package. The
    # same package root will exist at the same relative path after the fast-forward.
    workspace_links = {}
    for package in candidate.glob('*/package.json'):
        name = json.loads(package.read_text()).get('name')
        if isinstance(name, str) and name:
            workspace_links[package.parent] = '/node_modules/' + name
    environment = {'PATH': str(root / '.runtime/node/bin') + ':' + str(root / '.runtime/pnpm/node_modules/.bin') + ':/usr/local/bin:/usr/bin:/bin',
                   'XDG_CACHE_HOME': str(batch / 'build-cache'), 'npm_config_userconfig': '/dev/null', 'CI': 'true', 'NODE_OPTIONS': '--max-old-space-size=3072',
                   'AI_NOVEL_DATABASE_MODE': 'sqlite', 'DATABASE_URL': 'file:' + str(batch / 'build-only.sqlite')}
    pathlib.Path(environment['XDG_CACHE_HOME']).mkdir(mode=0o700)
    steps = [
        ('install', ['pnpm', '--filter', '@ai-novel/server...', '--filter', '@ai-novel/client...', 'install', '--frozen-lockfile']),
        ('shared-build', ['pnpm', '--filter', '@ai-novel/shared', 'build']),
        ('sync-dependencies', ['pnpm', '--filter', '@ai-novel/server...', '--filter', '@ai-novel/client...', 'install', '--offline', '--frozen-lockfile']),
        ('prisma-generate', ['pnpm', '--filter', '@ai-novel/server', 'prisma:generate']),
        ('server-build', ['pnpm', '--filter', '@ai-novel/server', 'build']),
        ('client-build', ['pnpm', '--filter', '@ai-novel/client', 'build']),
    ]
    changed = info['old'] != info['sha']
    if changed and validation is None:
        steps.append(('targeted-tests', ['node', '--test', '--test-concurrency=1',
                                         'server/tests/novelProductionStatus.test.js',
                                         'client/tests/directorPollingErrors.test.js']))
    logfile = batch / 'build.log'
    passed = []
    with open(logfile, 'w') as log:
        logfile.chmod(0o600)
        for index, (name, args) in enumerate(steps, start=1):
            emit('candidate_build', step=index, name=name, log=str(logfile))
            print('\n$ ' + ' '.join(args), file=log, flush=True)
            try:
                command(args, cwd=candidate, env=environment, timeout=1800, log=log)
            except (Refused, OSError, subprocess.TimeoutExpired) as error:
                raise Refused(f'候选 {name} 失败，服务尚未切换。请查看服务器日志 {logfile}') from error
            if name in VALIDATION_CHECKS:
                passed.append(name)
    if not (candidate / 'server/dist/app.js').is_file() or not (candidate / 'client/dist/index.html').is_file():
        raise Refused('候选缺少服务产物')
    for name in ARTIFACTS:
        folder = candidate / name
        if not folder.is_dir() or folder.is_symlink():
            raise Refused('构建产物缺失或顶层为链接：' + name)
        for current, dirs, files in os.walk(folder, followlinks=False):
            for entry in dirs + files:
                link = pathlib.Path(current) / entry
                if not link.is_symlink():
                    continue
                raw = os.readlink(link)
                if os.path.isabs(raw):
                    raise Refused('候选依赖含绝对链接，不能事务迁移')
                resolved = link.resolve(strict=True)
                if resolved in workspace_links and link.as_posix().endswith(workspace_links[resolved]):
                    continue
                if candidate not in resolved.parents or not any(resolved == candidate / item or candidate / item in resolved.parents for item in ARTIFACTS):
                    raise Refused('候选依赖链接不属于部署的工作区包或产物：' + str(link.relative_to(candidate)))
    # Services run as ai-novel; preserve that ownership when moving staged directories.
    command(['chown', '-R', 'ai-novel:ai-novel', *[candidate / item for item in ARTIFACTS]], timeout=600)
    manifest = dict(sha=info['sha'], artifacts=list(ARTIFACTS), fingerprint=digest(candidate / 'pnpm-lock.yaml'))
    if changed:
        record = validation if validation is not None else dict(sha=info['sha'], ref=info['ref'], passed=passed, evidence=str(logfile))
        require_validation_record(record, info['sha'], info['ref'])
        record_path = batch / 'validation.json'
        write_json(record_path, record)
        manifest['validation'] = str(record_path)
        emit('candidate_validated', sha=info['sha'], record=str(record_path), evidence=record['evidence'])
    write_json(batch / 'candidate-manifest.json', manifest)
    return candidate, manifest


def maintenance_config(original, config):
    port = config['remoteWebPort']
    probe = config['maintenanceProbePort']
    marker = '        location /api/ {'
    if original.count(marker) != 1 or original.count('listen 127.0.0.1:%s;' % port) != 1:
        raise Refused('未识别的 Nginx 配置，不能安全插入维护入口')
    begin = original.index('    server {')
    server = original[begin:original.rfind('\n}')]
    probe_server = server.replace('listen 127.0.0.1:%s;' % port, 'listen 127.0.0.1:%s;' % probe)
    probe_server = probe_server.replace('        server_name localhost;', '        server_name localhost;\n        if ($request_method !~ ^(GET|HEAD)$) { return 405; }')
    guard = '''        location = /api/health { proxy_pass http://127.0.0.1:13000; proxy_buffering off; }
        location = /api { add_header Retry-After 30 always; return 503; }
        location ^~ /api/ { add_header Retry-After 30 always; return 503; }
'''
    # Replace exactly the recognized proxy block, keep existing static locations.
    first = server.index(marker)
    last = server.index('\n        }', first) + len('\n        }')
    normal = server[:first] + guard.rstrip() + server[last:]
    return original[:begin] + normal + '\n' + probe_server + '\n}\n'
