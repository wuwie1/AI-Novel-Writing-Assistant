import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const shaPattern = /^[0-9a-f]{40}$/;
const fork = 'wuwie1/AI-Novel-Writing-Assistant';

async function git(root, ...args) {
  const { stdout } = await exec('git', ['-C', root, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function currentCommit({ repoRealPath: root, deployRef }) {
  const origin = (await git(root, 'remote', 'get-url', 'origin')).replace(/\.git$/, '');
  if (![`https://github.com/${fork}`, `git@github.com:${fork}`, `ssh://git@github.com/${fork}`].includes(origin)) {
    throw new Error('当前仓库的 origin 与部署 fork 不符。');
  }
  const branch = await git(root, 'branch', '--show-current');
  if (!branch || deployRef !== `origin/${branch}`) throw new Error(`请从服务器发布分支执行更新（${deployRef}）。`);
  if (await git(root, 'status', '--porcelain', '--untracked-files=normal')) {
    throw new Error('工作区含未提交的改动。请用 git status 核对要部署的内容，提交后再运行服务器更新。');
  }
  return git(root, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
}

/** Only the pinned commit and its missing ancestors travel to the server. GitHub refs are untouched. */
export async function deployCurrentSource({ config, dryRun, validation, execute, report }) {
  const root = config.repoRealPath;
  const currentSha = await currentCommit(config);
  async function run(options, expectedStage, bundleFile) {
    let result;
    await execute({ currentSha, ...options }, (line) => {
      report(line);
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.stage === expectedStage) result = event;
    }, bundleFile);
    if (!result) throw new Error(`服务器未返回 ${expectedStage} 结果，请核对部署记录。`);
    return result;
  }
  const inspection = await run({ dryRun: true }, 'inspection');
  if (inspection.candidate !== currentSha || !shaPattern.test(inspection.current) || typeof inspection.known !== 'boolean') {
    throw new Error('服务器预演未确认本次提交和部署基线。');
  }
  if (dryRun) return inspection;
  if (inspection.current !== currentSha && (validation?.sha !== currentSha || validation?.ref !== config.deployRef)) {
    throw new Error(`请按本次提交 ${currentSha} 的构建与测试结果准备 DEPLOY_VALIDATION_FILE。`);
  }
  const apply = async (bundleFile) => {
    const result = await run({ dryRun: false, serverBase: inspection.current, withBundle: Boolean(bundleFile) }, 'deployed', bundleFile);
    if (result.sha !== currentSha || !result.backup) throw new Error('部署回执缺少目标提交或已校验的备份路径。');
    return result;
  };
  if (inspection.known) return apply();

  try { await git(root, 'merge-base', '--is-ancestor', inspection.current, currentSha); }
  catch { throw new Error('无法确认服务器基线是当前提交的祖先，请核对发布历史。'); }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-novel-server-update-'));
  try {
    const bundle = path.join(directory, 'candidate.bundle');
    await git(root, 'bundle', 'create', bundle, 'HEAD', `^${inspection.current}`);
    if (await git(root, 'bundle', 'list-heads', bundle) !== `${currentSha} HEAD`) {
      throw new Error('打包期间本地 HEAD 发生变化，请重新运行服务器更新。');
    }
    return await apply(bundle);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
