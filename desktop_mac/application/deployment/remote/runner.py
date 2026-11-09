def run_remote(payload):
    os.umask(0o077)
    info = inspect_deployment(payload)
    emit('inspection', current=info['old'], candidate=info['sha'], known=info['known'], differences=info['differences'], checks=info['checks'], artifacts=list(ARTIFACTS), protected=list(PROTECTED), database=str(info['db']), assets=[str(item) for item in info['assets']])
    if payload['dryRun']:
        # Dry runs only inspect the existing deployment and running tasks.
        check_quiescence(payload, info)
        emit('dry_run', candidate=info['sha'], verified=not info['checks'], steps=['验证发布记录与迁移边界', '隔离构建候选', '备份并验证数据库、资产、配置、源码及依赖', '锁定服务并关闭新 API 请求', '两次静止与连接检查', '停服并保存最终备份', '源码快进及产物事务替换', '健康检查或完整代码回滚'])
        return 0
    root = info['root']
    if not (root / '.runtime').is_dir():
        raise Refused('运行目录不存在，不能作为已部署服务更新')
    with remote_lock(root / '.runtime/deploy.lock'):
        info = inspect_deployment(payload, import_bundle=payload['withBundle'])
        if info['checks']:
            raise Refused('; '.join(info['checks']))
        check_quiescence(payload, info)
        deployments = root / '.runtime/desktop_mac-deploy'
        deployments.mkdir(exist_ok=True, mode=0o700)
        for previous in deployments.glob('*/transaction.json'):
            if json.loads(previous.read_text()).get('phase') not in ('complete', 'rolled_back', 'aborted'):
                raise Refused('上次事务未完成，请按 transaction.json 和备份人工恢复；不会覆盖现场')
        prefix = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + info['sha'][:12] + '-'
        batch = pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir=deployments))
        candidate, manifest = build_candidate(info, batch, payload.get('validation'))
        backup_snapshot(info, batch / 'backups/preflight', full=True)
        with remote_lock(root / '.runtime/service-control.lock'):
            fresh = inspect_deployment(payload)
            if any(fresh[key] != info[key] for key in ('old', 'branchTip', 'sha', 'states')):
                raise Refused('构建期间部署基线或服务状态变化，请重新执行')
            return switch_transaction(payload, info, batch, candidate, manifest)


if __name__ == '__main__':
    try:
        payload = json.loads(base64.b64decode(sys.argv[1]))
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(InterruptedError('部署收到终止信号')))
        code = run_remote(payload)
    except BaseException as error:
        emit('refused', reason=str(error))
        code = 6
    sys.exit(code)
