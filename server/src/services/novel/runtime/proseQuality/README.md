# 正文表达安全检查

本模块拥有正文表达的确定性检查，不负责叙事评价、修文决策、正文保存或任务暂停。AI 仍负责判断人物、因果、情节与读者体验。

`detectNewSevereProseFindings` 通过 `index.ts` 向章节运行时提供候选预检：比较原稿与候选的 high/critical 问题 code，仅拦截原稿没有的严重表达问题。它复用接收与最终保存阶段的同一检测器，不另建字符串判断规则，也不扩大普通低严重度问题的阻塞范围。

预检失败时保留原稿，记录可恢复修文失败及章节质量债，不发起候选模型验收。已执行的修文调用仍消耗一次处理额度，不能退还或另开重试。预检通过不代表正文合格，候选继续走 AI 验收和版本选择。原稿已有的同类问题交给该正常流程判断，不由预检代替 AI 评价。

局部修文的 replacement 和完整修文的正文均复用共享 `CHAPTER_PROSE_QUALITY_RULES`；局部定位原文 targetExcerpt 必须逐字保留，表达约束不能改变锚点。

## 本书的表达约定

`detectProseQuality` 和 `detectNewSevereProseFindings` 接受 `ProseQualityOptions`，调用方用 `resolveProseQualityOptions(styleContext)` 从该章生成时的写法上下文取值；不传时按通用规则检查。

- `pausePunctuation: "natural"`：写法档案声明停顿标点自然使用。不再因单次出现记 `prose_dash_or_ellipsis`（high），改按密度记 `prose_pause_punctuation_dense`（medium）：同一段 3 处以上，或全文 8 处以上且超过千分之十二。
- `styleExemplars`：该章使用的文笔样例。正文搬用任一样例 14 个以上实义字符时记 `prose_exemplar_overlap`（high），人名换成本书人物也算；修文候选新增这类问题同样被预检拦下。
- `sourceEntities`：写法档案登记的参考作品专名。正文出现其中任何一个时记 `prose_source_entity_leak`（critical），并排在其他问题之前，因为验收只转交靠前的几条。

检测器只依赖 `shared` 的表达合同和 `styleEngine/exemplars` 两个纯函数模块，不访问数据库和模型。
