# 项目维护技能

## 同步小说助手上游（`ai-novel-upstream-sync`）

在本项目的 Codex 聊天中输入下列指令即可使用。这个个人技能安装在 `~/.codex/skills/ai-novel-upstream-sync/`，用于把原项目 `ExplosiveCoderflome/AI-Novel-Writing-Assistant` 的更新合入 `wuwie1/AI-Novel-Writing-Assistant`。

| 指令 | 执行范围 |
| --- | --- |
| 检查上游更新 | 抓取上游和 fork 的最新提交，列出本地 `main`、`ai` 各自待合入的更新，以及与 fork 的差距。 |
| 同步上游 | 在本地将上游更新合入 `main`，再将 `main` 合入 `ai`，保留 fork 的定制。完成校验后切回 `ai`。 |
| 同步上游并部署 | 完成本地同步与校验，将两个分支推送到 fork。服务器需要更新时，先备份并校验数据库、配置和资产，再部署 `ai`、重启服务，并检查网页、健康接口和小说列表。 |
