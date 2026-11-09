def run_remote(payload):
    os.umask(0o077)
    if payload['dryRun']:
        info = inspect_deployment(payload)
        emit('inspection', current=info['old'], candidate=info['sha'], known=info['known'], differences=info['differences'], checks=info['checks'], artifacts=list(ARTIFACTS), protected=list(PROTECTED), database=str(info['db']), assets=[str(item) for item in info['assets']])
        check_quiescence(payload, info)
        emit('dry_run', candidate=info['sha'], verified=not info['checks'], steps=['核对提交、任务状态与产物', '同版本校验通过后重启', '版本变化时按构建输入准备候选，留存上一版并备份数据', '重启并验收网页、健康接口和小说读取'])
        return 0
    timings = DeploymentTimings()
    try:
        root = pathlib.Path(payload['config']['serverDir']).resolve(strict=True)
        if not (root / '.runtime').is_dir():
            raise Refused('运行目录不存在，不能作为已部署服务更新')
        with remote_lock(root / '.runtime/deploy.lock'):
            with timings.stage('inspect-import'):
                info = inspect_deployment(payload, import_bundle=payload['withBundle'])
                if info['checks']:
                    raise Refused('；'.join(info['checks']))
                check_quiescence(payload, info)
                deployments = root / '.runtime/desktop_mac-deploy'
                deployments.mkdir(exist_ok=True, mode=0o700)
                for path in deployments.glob('*/transaction.json'):
                    if json.loads(path.read_text()).get('phase') not in ('complete', 'rolled_back', 'aborted'):
                        raise Refused('上次事务未完成，请按 transaction.json 和备份人工恢复')
                prefix = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + info['sha'][:12] + '-'
                batch = pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir=deployments))
                timings.batch = batch
                record_path = root / '.runtime/deployment.json'
                previous = json.loads(record_path.read_text()) if record_path.is_file() else {}
            with timings.stage('verify-live'):
                # Only this invocation may reuse a file read. Re-enumerate paths and check
                # inode, size, mtime and ctime again under the service lock.
                file_hashes = {}
                installed = live_artifacts(root, file_hashes)
                toolchain = runtime_toolchain(root)
                plan = release_plan(info, installed, toolchain, previous)
            emit('deployment_plan', **plan)
            candidate = None
            manifest = dict(mode=plan['mode'], artifacts=[])
            if plan['mode'] != 'restart':
                check_build_space(info)
                with timings.stage('candidate-total'):
                    candidate, manifest = prepare_candidate(info, batch, payload.get('validation'), plan, installed, toolchain, timings)
                with timings.stage('retain-previous'):
                    retained = retain_release(info, batch, installed)
                with timings.stage('preflight-backup'):
                    backup_snapshot(info, batch / 'backups/preflight', previous_release=retained)
            with remote_lock(root / '.runtime/service-control.lock'):
                with timings.stage('recheck'):
                    fresh = inspect_deployment(payload)
                    if any(fresh[k] != info[k] for k in ('old', 'branchTip', 'sha', 'states')):
                        raise Refused('准备期间部署基线或服务状态变化，请重新执行')
                    if plan['mode'] != 'restart' and live_artifacts(root, file_hashes) != installed:
                        raise Refused('准备期间线上产物发生变化，请核对后重新执行')
                return switch_transaction(payload, info, batch, candidate, manifest, previous, timings)
    finally:
        timings.finish()


if __name__ == '__main__':
    try:
        payload = json.loads(base64.b64decode(sys.argv[1]))
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(InterruptedError('部署收到终止信号')))
        code = run_remote(payload)
    except BaseException as error:
        emit('refused', reason=str(error))
        code = 6
    sys.exit(code)
