# 项目维护技能

项目维护技能保存在 `.agents/skills/`。用 Codex 打开工作区，即可输入 `$ai-novel-upstream-sync 检查上游更新`。检查、合并、推送和部署均使用该工作区当前检出的分支。

## 服务器更新

在项目聊天输入 **服务器更新**，或输入 `$ai-novel-upstream-sync 服务器更新`。它会把当前分支已提交的代码更新到配置的服务器，重启 API 和网页服务，并检查首页、健康接口和小说列表。尚未推送到 GitHub 的提交也可以部署。服务器须检出同名发布分支，已部署同一提交时仍会重启服务。

执行前先提交要部署的改动。聊天指令和终端的 `make server_update` 共用增量部署流程。校验通过的同一提交直接重启，新提交按受影响的产物构建、验证并留存上一版。只想查看待部署版本和任务状态时，可输入“服务器更新，只预演”或运行 `make server_update DRY_RUN=1`。[部署说明](desktop_mac/README.md#更新服务器)

## 同步小说助手上游

使用 Git 和 Bash 检查上游。新克隆先运行 `git remote -v`，确认 `origin` 指向 `wuwie1/AI-Novel-Writing-Assistant`。如果还没有 `upstream`，在仓库根目录添加一次。

```bash
git remote add upstream https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant.git
```

| 指令 | 执行范围 |
| --- | --- |
| 检查上游更新 | 查看上游默认分支有哪些提交可合入当前分支，同时查看 fork 同名分支的差距。尚未推送过的本地分支也能检查。 |
| 同步上游 | 将上游更新合入当前分支，验证双方的改动。若本地有未提交的文件，会在独立工作目录验证，遇到可能覆盖文件的冲突时保留工作现场。 |
| 同步上游并部署 | 同步并校验当前分支，仅将该分支推送到 fork，再将同一提交部署到服务器。部署流程核验备份、重启服务，并检查网页、健康接口和小说列表。 |

推送需要当前电脑具备 fork 写权限，部署还需要配置能登录目标服务器的 SSH 凭据。[上游同步技能](.agents/skills/ai-novel-upstream-sync/SKILL.md) · [服务器配置](infra/server/README.md)

## 提交与发布说明

`readme-release-updater` 在提交、推送和准备 PR 时核对改动范围，使 README 的最新更新与完整发布说明一致。上游同步也使用此技能。[发布说明技能](.agents/skills/readme-release-updater/SKILL.md)
