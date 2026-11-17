# 卷工作区注水与大纲保留字段

## Background

历史 V1 卷工作区读取路径（`NovelVolumeService.ensureVolumeWorkspace`）会用规范 Chapter 行的字段
回填卷规划文档：章标题取 Chapter 标题，章摘要取 Chapter `expectation`。
回填后只要文档有变化，读路径就会把文档落盘。V2 的准备结果有独立归属，读取不能
将空白或旧 Chapter 字段写回已经确认的规划；是否绑定大纲不能替代导演归属判断。

大纲开书的书另有保留守卫（`assertOutlineWorkspaceCandidate`）：绑定策略里
`mode !== "fill_missing"` 的章字段（标题、摘要、目标）必须与策略值逐字一致，
写路径一律拒绝改动。

历史执行数据中的 `Chapter.expectation` 可能与大纲原摘要不一致。正文摘要生成必须
写入 `ChapterSummary`，不能继续改写作者确认的章节目标。读取旧数据时也不能假定
两者相同：读路径回填把旧简报写进规划摘要，落盘时
守卫以 `OUTLINE_PRESERVED_FIELD` 拒绝；写不进去，下一次读又重复同一套，
卷版本读取与卷工作区写入被永久楔死，编辑页每次加载都弹出冲突提示。

## Decision

先判断规划归属，再决定允许回填的字段，守卫本身不放宽：

- V2 小说通过统一 `readNovelDirectorIdentity` 判断归属，读取直接保留已准备的
  卷章文档；没有大纲绑定或只有历史 V2 运行记录，也不能退回 V1 回填逻辑。
- 大纲 A2 当前章准备上下文只处理授权章，普通读取不能顺带回填其他章节。

- `readPreservedChapterFields`（`protection.ts`）只读绑定行的 mapping 与 policy，
  按与守卫相同的过滤条件（`mode !== "fill_missing"`、章字段表）算出每个
  plan 章节受保护的字段集合；无绑定的书返回空集。
- 允许回填的 V1 路径中，`hydrateCanonicalChapterFields` 对受保护的标题/摘要
  保留文档里的值，只回填其余规范字段（任务单、场景卡、字数等）。
- 显式写路径（`mirrorChapterIntoWorkspace`、卷更新）不走这条豁免：显式写入
  违反保留策略时守卫照常 409，由调用方提示用户调整保留策略。

## Current Rule

- 读路径的任何“回读再持久化”都不得改写守卫保护的字段；先查策略，再决定
  哪些字段可以回填。
- 保留策略的唯一真相来源是绑定行的 policyJson；注水与守卫必须用同一张
  字段表、同一条 mode 过滤，不得各自维护一份。
- 规划、章节目标和正文摘要各有写入入口；正文摘要归 `ChapterSummary`，不能
  通过摘要生成或正文保存覆盖 `Chapter.expectation` 与卷规划。历史值不一致时
  先判断字段归属，不得用批量数据补丁掩盖读路径问题。

## Failure Modes

- 症状：小说编辑页每次加载弹出多条红色「保留内容发生冲突：`<nodeId>.summary`」，
  `GET /volumes/versions` 与 `GET /volumes` 返回 409 `OUTLINE_PRESERVED_FIELD`。
- 定位：按 nodeId 在绑定 mapping 里找到章，比较三处值——policy 规则值、
  卷规划文档摘要、Chapter `expectation`。文档值与策略值一致、而
  `expectation` 不同，即为本模式。
- 与“回读再持久化毒化冻结指纹”同属读路径写回家族，但机制不同：那一例是
  指纹被改写，这里是注水字段撞上保留守卫。

## Related Modules

- `server/src/services/novel/volume/NovelVolumeService.ts`（`hydrateCanonicalChapterFields`）
- `server/src/modules/planning/outline/openBook/domain/protection.ts`（守卫与
  `readPreservedChapterFields`）
- `server/src/services/novel/volume/volumeWorkspacePersistence.ts`（`persistActiveVolumeWorkspace`）
- 回归测试：`server/tests/volumeHydrationSkipsPreservedFields.test.js`
