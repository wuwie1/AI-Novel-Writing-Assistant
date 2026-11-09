---
name: ai-novel-upstream-sync
description: 在 wuwie1/AI-Novel-Writing-Assistant 中处理“检查上游更新”“同步上游”“同步上游并部署”，将 ExplosiveCoderflome 的更新整合到 main 和 ai，并按请求推送、部署或核对已部署版本。
---

# 小说助手上游同步

在目标仓库执行。先读仓库的 AGENTS.md 和当前 ai 分支的 docs/wiki/architecture/server-deployment.md。上游为 ExplosiveCoderflome，fork 为 wuwie1，均在 GitHub，仓库名均为 AI-Novel-Writing-Assistant。main 跟随上游已发布的 main，ai 承载 fork 的部署脚本和定制。

## 选择执行范围

- “检查上游更新”只运行随技能提供的检查脚本，汇报上游提交和两个分支的差距。
- “同步上游”包含本地合并与校验，最后回到 ai。“推送”表示把通过验证的两个分支推送到 fork。
- 本仓库约定的简写“同步上游并部署”包含本地整合、校验、推送两个分支到 fork、部署 ai 及重启验收。用户指定的分支、环境、只检查、本地同步或不推送等范围优先。
- 可单独补推或补部署。上游无新提交时，逐项核对用户要求的本地分支、远端分支及实际部署版本。远端仍落后就补推；服务器的代码、部署清单和服务健康均已对齐时，无需重新构建、备份或重启。明确要求重启时按请求执行。

## 检查与合并

在包含此技能的工作区根目录运行检查脚本。检查另一个 worktree 时，将最后的 `.` 换成它的路径。

```bash
bash .agents/skills/ai-novel-upstream-sync/scripts/check-upstream.sh .
```

脚本抓取两个远端的引用并报告提交差距。新克隆若只有一个本地分支，缺少的分支按对应的 `origin/<分支>` 报告。开始本地合并时，再从已核实的 fork 跟踪引用建立缺少的本地分支。抓取失败时报告失败。新克隆缺少 upstream 时，按仓库根目录 `skill_tools.md` 核实 origin 并添加原项目。替换已有远端时遵循仓库 wiki 的备份规则。

记录抓取到的上游 SHA、本地和 origin 两个分支头、工作树及 worktree 占用情况。固定本轮上游 SHA，检查完整差集。若 fork 远端领先，先纳入相应分支；遇到分叉或工作区有改动，使用隔离 worktree 做整合，保留已有提交与用户文件。main 通常可快进；若 main 与发布线分叉，按仓库 beta 集成规则审查验证后再晋升。ai 合入更新后的 main。禁止强推、重置本地定制或把 ai 独有提交倒灌到 main。

同时检查文本冲突和双方都改动过、却被 Git 自动合并的文件。既有交叉点包括拆章预算、角色目录、Prompt 版本、注册器与回归用例。按随仓库提供的发布说明技能核对本次范围。README 仅保留最新日期，完整历史保留 fork 与上游旧条目，有独立长期价值的 wiki 规则两边都保留。[readme-release-updater](../readme-release-updater/SKILL.md)

## 校验与推送

按本轮实际差异选择构建和回归测试。检查上游 SHA 已包含于两个结果，且旧 ai 是新 ai 的祖先。交叉修改同时运行上游和 fork 相关用例，记录通过、失败、跳过数。验证合并树时核对测试时的 tree 与最终提交的 tree。共享包、前端或后端的输入（含配置、依赖、版本元数据）与工具链相同时才复用已通过的检查。用隔离的测试库；UI 交互验收按仓库规则。只在要求推送时复核 origin 所有 push URL，执行 git push --atomic origin main ai 并回读两个远端 SHA。如远端在校验期间变化，重新抓取和整合。

## 部署请求

遵循 ai 分支的 `infra/server/README.md`。默认主机、账户和部署目录见同分支 `desktop_mac/config/app.example.json` 的 `sshTarget` 和 `serverDir`。使用本机 SSH 别名时，用 `ssh -G` 核对它解析到请求的部署目标。SSH 使用 BatchMode=yes、ClearAllForwardings=yes。先核实实际主机、路径、分支、部署清单、服务、可用空间及工作区状态。实际目标与请求不同或存在服务器本地修改时先查明，不覆盖。

- 在隔离目录按当前锁文件和服务器运行版本构建。若迁移、依赖或环境配置有差异，重新评估并验证；不要复用上次的 SHA、临时目录或构建产物。用临时数据库测试，不复制生产密钥。
- 部署前用 SQLite backup API 创建线上一致快照，核验 integrity_check；备份资产、配置和可回退的旧构建并校验，记录备份目录。涉及删除、重建或其他破坏性数据操作时遵循 AGENTS.md 的明确批准门槛。
- 只部署已验证的 ai 提交，服务器工作区干净且可快进才更新。可使用核验过的 Git bundle，保留服务器自己的数据、配置、资产与日志。必要时按文档更新依赖和注入的 shared 产物。执行仓库 restart.sh 并核验 systemd 两项服务、网页及其静态资源、/api/health 和只读 /api/novels；本机隧道存在时也检查。验收成功后更新部署清单，报告 SHA 和备份位置。中断后先比对源码、产物与清单，不能只依据 Git HEAD 宣布已部署。
