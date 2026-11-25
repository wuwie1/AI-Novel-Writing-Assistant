# 文笔样例与本书停顿标点约定

## 背景

写法档案原先只向正文模型提供抽象规则（句长、对白比例、心理活动写法等）。模型读到的全是“要怎样”的描述，没有一段可以对照的正文，写出来的读感与作者想靠近的作品差距很大。同时，通用表达要求把省略号、破折号一律当作高风险，偏口语、心理活动多的写法在这条规则下写不出来。

## 决策

- 写法档案可以带少量文笔样例。样例是参考正文片段，只用来校准读感，随写法档案绑定到作品、章节或任务。
- 一本书可以在写法档案里声明停顿标点自然使用。声明后，写法合同、正文提示词、验收提示词和确定性检测按同一约定处理。
- 写法合同对停顿标点、心理活动写法或章末收束另有明确约定时，以写法合同为准。这句优先级说明同时写进 writer 和验收提示词，避免两处口径不一。

## 当前规则

### 文笔样例

- 数据在 `StyleProfile.styleExemplarsJson`，结构为 `{ exemplars, sourceEntities }`，由 `shared/types/styleEngine/exemplars.ts` 定义：最多 12 条，每条 80 到 1200 字，带场景功能、学什么、不带走什么。场景功能和每条说明不超过 80 字，“学什么”“不带走”各不超过 4 条。
- 通过 `POST /api/style-profiles` 和 `PUT /api/style-profiles/:id` 的 `styleExemplars` 字段写入。更新时不传该字段保留原值，传空集合才清空。目前没有前端编辑界面。
- 生成时取匹配绑定中最具体的一个带启用样例的写法档案，不跨档案混用。整块上限 4200 字，按模型实际收到的文字计算，包括用法说明、遮名后的正文和各条说明，约占正文上下文预算的四分之一。
- 发给正文模型前，`sourceEntities` 里的原作专名替换为〔甲〕〔乙〕等代称。正文出现其中任何一个时，确定性检测记 `prose_source_entity_leak`，严重度 critical。检测在验收服务里执行，旧章节流水线和自动导演的生产内核都会经过。
- 样例作为 `style_exemplars` 上下文块进入 writer：必选、不摘要、按书复用，只在正文生成模式出现，审阅和修文上下文不带。
- 自定义的高级正文模板需要自己引用 `{{context.style_exemplars}}`，官方模板没有改动。
- 正文搬用任一样例 14 个以上实义字符（忽略标点和空白）时，确定性检测记 `prose_exemplar_overlap`，严重度 high。相同的文字可以是连续一段，也可以只在样例的人名代称处断开，所以把人名换成本书人物的照搬同样会被记录。

### 停顿标点

- `languageRules.pausePunctuation` 取 `"natural"` 时生效，其他值或缺省按通用规则处理。
- 写法合同的语言段追加一句固定说明，不把字段名当普通规则行输出。
- 确定性检测不再因单次出现省略号、破折号记 `prose_dash_or_ellipsis`，改为按密度记 `prose_pause_punctuation_dense`（medium）：同一段 3 处以上，或全文 8 处以上且超过千分之十二。
- 验收提示词说明零散出现不记为问题，只在连续堆叠或明显过密时记录。
- 修文和局部补丁提示词仍沿用通用表达要求，替换文本不新增停顿标点。

### 正文上下文预算

- `NOVEL_PROMPT_BUDGETS.chapterWriter` 为 4200，`GenerationContextAssembler` 的 `stageTokenCap.writer` 和压缩日志使用同一数值。
- 必选块始终保留；预算只决定可选块的去留。新增必选块前先确认它不会把可选的人物动态、读者体验等块挤掉。

## 示例

- 推荐：从一本已分析的参考作品里选 3 到 6 段功能不同的片段（亮相、家常对白、绝境心理、章末收束），每段写清学什么、不带走什么，登记原作专名。
- 不推荐：把整章原文放进样例，或用样例传递本书的人物和设定。本书事实只来自章节任务和人物资料。
- 禁止：为了通过重合检测而调低阈值，或把样例放进审阅、修文上下文。

## 失败模式

- 正文出现原作人名却没有告警：检查 `sourceEntities` 是否登记完整，别名要单独列出；再看该章运行包的 `styleContext.sourceEntities` 是否带上了名单。
- 样例没有进入提示词：检查绑定的写法档案是否有启用的样例、是否被更具体的章节或任务绑定覆盖、是否使用了未引用 `style_exemplars` 的自定义模板。
- 省略号仍被判高风险：检查生效写法档案合并后的 `languageRules.pausePunctuation`，以及该章运行包里的 `styleContext`。
- 读感没有变化：先确认样例与本章场景功能接近，再做同一章任务的对照生成；不要用增加规则条数代替样例。

## 相关模块

- `shared/types/styleEngine/exemplars.ts`
- `shared/types/chapterProseContract.ts`
- `server/src/services/styleEngine/exemplars/`
- `server/src/services/styleEngine/StyleCompiler.ts`
- `server/src/services/styleEngine/styleGenerationSanitizer.ts`
- `server/src/services/novel/runtime/proseQuality/`
- `server/src/prompting/prompts/novel/chapterWriter.prompts.ts`（v12）
- `server/src/prompting/prompts/novel/chapterAcceptance.prompts.ts`（v25）
- `server/src/prompting/prompts/novel/context/chapterContextBlocks.ts`

## 来源文档

- 小说生成质量守卫机制：`./novel-generation-quality-guards.md`
- 章节生产链路：`../workflows/chapter-production-chain.md`
