def build_candidate(info, batch):
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
    environment = {'PATH': str(root / '.runtime/node/bin') + ':' + str(root / '.runtime/pnpm/node_modules/.bin') + ':/usr/local/bin:/usr/bin:/bin',
                   'XDG_CACHE_HOME': str(batch / 'build-cache'), 'npm_config_userconfig': '/dev/null', 'CI': 'true', 'NODE_OPTIONS': '--max-old-space-size=3072',
                   'AI_NOVEL_DATABASE_MODE': 'sqlite', 'DATABASE_URL': 'file:' + str(batch / 'build-only.sqlite')}
    pathlib.Path(environment['XDG_CACHE_HOME']).mkdir(mode=0o700)
    steps = [
        ['pnpm', '--filter', '@ai-novel/server...', '--filter', '@ai-novel/client...', 'install', '--frozen-lockfile'],
        ['pnpm', '--filter', '@ai-novel/shared', 'build'],
        ['pnpm', '--filter', '@ai-novel/server...', '--filter', '@ai-novel/client...', 'install', '--offline', '--frozen-lockfile'],
        ['pnpm', '--filter', '@ai-novel/server', 'prisma:generate'],
        ['pnpm', '--filter', '@ai-novel/server', 'build'],
        ['pnpm', '--filter', '@ai-novel/client', 'build'],
    ]
    logfile = batch / 'build.log'
    with open(logfile, 'w') as log:
        logfile.chmod(0o600)
        for index, step in enumerate(steps):
            emit('candidate_build', step=index + 1, log=str(logfile))
            command(step, cwd=candidate, env=environment, timeout=1800, log=log)
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
                if candidate not in resolved.parents or not any(resolved == candidate / item or candidate / item in resolved.parents for item in ARTIFACTS):
                    raise Refused('候选依赖链接不属于完整替换清单')
    # Services run as ai-novel; preserve that ownership when moving staged directories.
    command(['chown', '-R', 'ai-novel:ai-novel', *[candidate / item for item in ARTIFACTS]], timeout=600)
    manifest = dict(sha=info['sha'], artifacts=list(ARTIFACTS), fingerprint=digest(candidate / 'pnpm-lock.yaml'))
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
