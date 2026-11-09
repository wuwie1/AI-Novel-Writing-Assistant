# 项目维护技能

项目维护技能随 `ai` 分支保存在 `.agents/skills/`。在新电脑上检出包含这些文件的 `ai` 分支，用 Codex 打开仓库，就可以在项目聊天里输入 `$ai-novel-upstream-sync 检查上游更新`。

## 服务器更新

在项目聊天输入 **服务器更新**，或输入 `$ai-novel-upstream-sync 服务器更新`。它会把当前部署分支（默认 `ai`）已提交的代码更新到配置的服务器，重启 API 和网页服务，并检查首页、健康接口和小说列表。尚未推送到 GitHub 的提交也可以部署。服务器已是同一提交时，仍会重启服务。

执行前先提交要部署的改动。聊天指令和终端的 `make server_update` 都会在切换版本前自动构建、测试和备份。只想查看待部署版本和任务状态时，可输入“服务器更新，只预演”或运行 `make server_update DRY_RUN=1`。[部署说明](desktop_mac/README.md#更新服务器)

## 同步小说助手上游

使用 Git 和 Bash 检查上游。新克隆先运行 `git remote -v`，确认 `origin` 指向 `wuwie1/AI-Novel-Writing-Assistant`。如果还没有 `upstream`，在仓库根目录添加一次。

```bash
git remote add upstream https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant.git
```

| 指令 | 执行范围 |
| --- | --- |
| 检查上游更新 | 抓取上游和 fork 的最新提交，列出 `main`、`ai` 各自待合入的更新。已有本地分支会显示与 fork 的差距，尚未建立的分支按对应的 `origin` 引用计算。 |
| 同步上游 | 在本地将上游更新合入 `main`，再将 `main` 合入 `ai`，保留 fork 的定制。完成校验后切回 `ai`。 |
| 同步上游并部署 | 完成本地同步与校验，将两个分支推送到 fork。服务器需要更新时，先备份并校验数据库、配置和资产，再部署 `ai`、重启服务，并检查网页、健康接口和小说列表。 |

推送需要当前电脑具备 fork 写权限，部署还需要配置能登录目标服务器的 SSH 凭据。[上游同步技能](.agents/skills/ai-novel-upstream-sync/SKILL.md) · [服务器配置](infra/server/README.md)

## 提交与发布说明

`readme-release-updater` 在提交、推送和准备 PR 时核对改动范围，使 README 的最新更新与完整发布说明一致。上游同步也使用此技能。[发布说明技能](.agents/skills/readme-release-updater/SKILL.md)
