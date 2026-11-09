import base64
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request


class Refused(Exception):
    pass


ARTIFACTS = ('node_modules', 'server/node_modules', 'client/node_modules', 'shared/node_modules', 'shared/dist', 'server/dist', 'client/dist')
PROTECTED = ('.git', 'server/.env', 'data', 'server/storage', '.runtime', 'logs', '.logs')
COMPATIBILITY = ('server/src/prisma', 'server/src/db', 'server/src/config/database.ts', 'server/src/runtime', 'server/prisma.config.ts', 'server/scripts/ensure-dev-prisma.cjs')


def emit(stage, **fields):
    print(json.dumps(dict(stage=stage, **fields), ensure_ascii=False), flush=True)


def command(args, cwd=None, env=None, check=True, timeout=120, log=None, umask=-1):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, text=True,
                            stdout=log or subprocess.PIPE, stderr=log or subprocess.PIPE, timeout=timeout, umask=umask)
    if check and result.returncode:
        # Never echo command output: install/build/env output can contain credentials.
        raise Refused('命令未通过：%s（退出码 %s）' % (pathlib.Path(str(args[0])).name, result.returncode))
    return result


def git(root, *args, check=True):
    try:
        # Only tracked source checked out by root must be readable by the service account.
        checkout_umask = 0o022 if args[0] in ('merge', 'switch') else -1
        return command(['git', '-c', 'core.fsmonitor=false', '-C', root, *args], env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0'}, check=check, umask=checkout_umask).stdout.strip()
    except Refused:
        raise Refused('服务器 Git %s 失败，请核对部署目录的仓库权限、提交和发布分支' % args[0])


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def write_json(file, value):
    temporary = pathlib.Path(str(file) + '.tmp')
    with open(temporary, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, file)


def read_env(root):
    result = {}
    for raw in (root / 'server/.env').read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:]
        key, separator, value = line.partition('=')
        if not separator or '${' in value or '\\' in value:
            raise Refused('server/.env 含不能可靠解析的路径配置；请使用单行字面值配置后重试')
        value = value.strip()
        if value[:1] in ('"', "'") and value[-1:] == value[:1]:
            value = value[1:-1]
        else:
            value = value.split(' #')[0].rstrip()
        result[key.strip()] = value
    return result


def runtime_paths(root):
    env = read_env(root)
    if env.get('AI_NOVEL_DATABASE_MODE', 'sqlite') != 'sqlite' or not env.get('DATABASE_URL', '').startswith('file:'):
        raise Refused('首版部署仅覆盖已核实的 SQLite 服务，其他数据库需要独立备份与迁移方案')
    if env.get('IMAGE_STORAGE_DRIVER', 'local') != 'local' or env.get('AI_NOVEL_RUNTIME', 'web') != 'web':
        raise Refused('未覆盖此存储或运行模式，拒绝停止服务')
    value = env['DATABASE_URL'][5:]
    if '?' in value or not value:
        raise Refused('DATABASE_URL 必须指向确定的 SQLite 文件')
    db = pathlib.Path(value)
    if not db.is_absolute():
        db = root / 'server' / db
    db = db.resolve(strict=True)
    asset = pathlib.Path(env.get('IMAGE_STORAGE_ROOT', 'storage/generated-images'))
    if not asset.is_absolute():
        asset = root / 'server' / asset
    paths = [root / 'server/storage', asset.resolve()]
    if env.get('AI_NOVEL_APP_DATA_DIR'):
        paths.append(pathlib.Path(env['AI_NOVEL_APP_DATA_DIR']).resolve())
    # Reject unknown persistence overrides, without printing their values.
    allowed = {'IMAGE_STORAGE_ROOT', 'AI_NOVEL_APP_DATA_DIR', 'RUN_WITH_LOG_PATH', 'RUN_WITH_LOG_LLM_PATH', 'RUN_WITH_LOG_LLM_REPAIR_PATH'}
    if any(key.endswith(('_DIR', '_PATH', '_ROOT')) and key not in allowed for key in env):
        raise Refused('发现未登记的持久路径配置，请先扩展保护与备份清单')
    if env.get('HOST', '127.0.0.1') != '127.0.0.1' or int(env.get('PORT', '13000')) != 13000:
        raise Refused('API 监听与既有 systemd/Nginx 合同不符')
    # All writable directories must be outside code/dependency replacement slots.
    for target in [db, *paths]:
        if target == root or any(target == root / item or (root / item) in target.parents for item in ARTIFACTS):
            raise Refused('持久路径与构建产物重叠，拒绝部署')
    return db, list(dict.fromkeys(paths))


def health(port):
    for route in ('/api/health', '/', '/api/novels?page=1&limit=1'):
        with urllib.request.urlopen('http://127.0.0.1:%s%s' % (port, route), timeout=5) as response:
            if response.status != 200:
                raise Refused('服务健康检查未通过')
            if route == '/api/health':
                body = json.load(response)
                if body.get('success') is not True or body.get('data', {}).get('status') != 'ok':
                    raise Refused('API 健康响应不符合合同')
            elif route.startswith('/api/') and json.load(response).get('success') is not True:
                raise Refused('小说只读检查未通过')


@contextlib.contextmanager
def remote_lock(path):
    with open(path, 'a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('服务器部署/服务锁正被使用')
        yield
