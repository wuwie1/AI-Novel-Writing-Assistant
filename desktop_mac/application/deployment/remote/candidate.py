VALIDATION_CHECKS = ('server-build', 'client-build', 'targeted-tests')


def require_validation_record(record, sha, ref):
    if not isinstance(record, dict) or record.get('sha') != sha or record.get('ref') != ref:
        raise Refused('验证记录的 sha 或 ref 与本次部署不符')
    passed = record.get('passed')
    if not isinstance(passed, list) or not all(check in passed for check in VALIDATION_CHECKS):
        raise Refused('验证记录须包含已通过的 server-build、client-build 和 targeted-tests')
    if not isinstance(record.get('evidence'), str) or not record['evidence'].strip():
        raise Refused('验证记录缺少构建和测试的日志位置 evidence')


def extract_candidate(info, scratch, work):
    source = scratch / 'source.tar'
    command(['git', '-C', info['root'], 'archive', '--format=tar', '-o', source, info['sha']], timeout=600)
    with tarfile.open(source) as archive:
        for member in archive.getmembers():
            target = work / member.name
            if work not in target.resolve().parents:
                raise Refused('候选归档路径越界')
            if member.issym() or member.islnk():
                if work not in (target.parent / member.linkname).resolve().parents:
                    raise Refused('候选源码链接越界')
        archive.extractall(work, filter='data')


def validate_portable_slots(work, slots, workspace_links):
    for name in slots:
        folder = work / name
        if not folder.is_dir() or folder.is_symlink():
            raise Refused('构建产物缺失或顶层为链接：' + name)
        for current, dirs, files in os.walk(folder, followlinks=False):
            for entry in dirs + files:
                link = pathlib.Path(current) / entry
                if not link.is_symlink():
                    continue
                if os.path.isabs(os.readlink(link)):
                    raise Refused('候选依赖含绝对链接，不能事务迁移')
                resolved = link.resolve(strict=True)
                if resolved in workspace_links and link.as_posix().endswith(workspace_links[resolved]):
                    continue
                if not any(resolved == work / slot or work / slot in resolved.parents for slot in ARTIFACTS):
                    raise Refused('候选依赖链接不属于部署的工作区包或产物：' + str(link.relative_to(work)))


def build_candidate(info, batch, validation, plan, installed, timings):
    slots = plan['slots']
    root = info['root']
    candidate = batch / 'candidate'
    candidate.mkdir(mode=0o700)
    logfile = batch / 'build.log'
    hashes = dict(installed)
    built = []
    needs_tests = plan['tests'] and validation is None
    with open(logfile, 'w') as log, tempfile.TemporaryDirectory(dir=batch, prefix='build-') as scratch_name:
        logfile.chmod(0o600)
        scratch = pathlib.Path(scratch_name)
        work = scratch / 'workspace'
        work.mkdir()
        environment = {'PATH': str(root / '.runtime/node/bin') + ':' + str(root / '.runtime/pnpm/node_modules/.bin') + ':/usr/local/bin:/usr/bin:/bin',
                       'XDG_CACHE_HOME': str(scratch / 'cache'), 'npm_config_userconfig': '/dev/null', 'CI': 'true', 'NODE_OPTIONS': '--max-old-space-size=3072',
                       'AI_NOVEL_DATABASE_MODE': 'sqlite', 'DATABASE_URL': 'file:' + str(scratch / 'build-only.sqlite')}
        def run(name, args):
            emit('candidate_build', name=name, log=str(logfile))
            print('\n$ ' + ' '.join(args), file=log, flush=True)
            try:
                with timings.stage(name):
                    command(args, cwd=work, env=environment, timeout=1800, log=log)
            except (Refused, OSError, subprocess.TimeoutExpired) as error:
                raise Refused(f'候选 {name} 失败，服务尚未切换。请查看服务器日志 {logfile}') from error
            built.append(name)

        print('plan:', plan, 'baseline:', info['old'], file=log, flush=True)
        if slots or needs_tests:
            with timings.stage('prepare-workspace'):
                extract_candidate(info, scratch, work)
                if plan['mode'] != 'full':
                    # Private copies keep Vite caches, test programs and pnpm shims away from live data.
                    for slot in (*DEPENDENCIES, 'shared/dist'):
                        copy_artifact(root / slot, work / slot)
                    if needs_tests and 'server/dist' not in slots:
                        copy_artifact(root / 'server/dist', work / 'server/dist')
            packages = {}
            for package in work.glob('*/package.json'):
                package_name = json.loads(package.read_text()).get('name')
                if package_name:
                    packages[package.parent] = '/node_modules/' + package_name
            pnpm = ['pnpm', '--filter', '@ai-novel/server...', '--filter', '@ai-novel/client...', 'install']
            if plan['mode'] == 'full':
                run('install', [*pnpm, '--frozen-lockfile'])
                run('shared-build', ['pnpm', '--filter', '@ai-novel/shared', 'build'])
                run('sync-dependencies', [*pnpm, '--offline', '--frozen-lockfile'])
                run('prisma-generate', ['pnpm', '--filter', '@ai-novel/server', 'prisma:generate'])
            for package in ('server', 'client'):
                if package + '/dist' in slots:
                    run(package + '-build', ['pnpm', '--filter', '@ai-novel/' + package, 'build'])
            if needs_tests:
                run('targeted-tests', ['node', '--test', '--test-concurrency=1', 'server/tests/novelProductionStatus.test.js', 'client/tests/directorPollingErrors.test.js'])
            with timings.stage('verify-candidate'):
                for name in ENTRYPOINTS:
                    if name.rsplit('/', 1)[0] in slots and (not (work / name).is_file() or not (work / name).stat().st_size):
                        raise Refused('候选缺少服务产物：' + name)
                validate_portable_slots(work, slots, packages)
                if slots:
                    command(['chown', '-R', 'ai-novel:ai-novel', *[work / name for name in slots]], timeout=600)
                for name in slots:
                    hashes[name] = artifact_digest(work / name)
                    (candidate / name).parent.mkdir(parents=True, exist_ok=True)
                    os.rename(work / name, candidate / name)
        reused = [package + '-build' for package in ('server', 'client') if package + '/dist' not in slots]
        if not plan['tests']:
            reused.append('targeted-tests')
        passed = [check for check in VALIDATION_CHECKS if check in built or check in reused]
        fingerprint = digest((work if slots or needs_tests else root) / 'pnpm-lock.yaml')
        print('completed:', built, 'reused from verified baseline:', reused, file=log)
    record = validation if validation is not None else dict(sha=info['sha'], ref=info['ref'], passed=passed, evidence=str(logfile), executed=built, reusedFrom=info['old'], reused=reused)
    require_validation_record(record, info['sha'], info['ref'])
    record_path = batch / 'validation.json'
    write_json(record_path, record)
    emit('candidate_validated', sha=info['sha'], record=str(record_path), evidence=record['evidence'])
    manifest = dict(sha=info['sha'], baseline=info['old'], mode=plan['mode'], artifacts=slots, hashes=hashes, validation=str(record_path),
                    fingerprint=fingerprint)
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
