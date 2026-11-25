# 文笔样例

写法规则能说清“先行动后设定”，说不清一段话读起来有多快、对白占多少、心里话是什么口吻。写法档案可以带少量参考片段，正文写手按片段校准读感。本模块负责片段的读取、遮名、选用和复用检查，不调用模型，不做 IO。

## 数据

样例存在 `StyleProfile.styleExemplarsJson`，形状由 `@ai-novel/shared/types/styleEngine/exemplars` 的 `styleExemplarSetSchema` 定义：`exemplars`（编号、场景功能、正文、学什么、不带走什么、来源说明、是否启用）和 `sourceEntities`（参考作品里的专名）。一份档案最多 12 条，单条 80 至 1200 字；场景功能和每条说明不超过 80 字，“学什么”“不带走”各不超过 4 条。读出的值不符合当前限制时按没有样例处理。

`PUT /api/style-profiles/:id` 和 `POST /api/style-profiles` 接受 `styleExemplars`。保存时不传该字段不改动已有样例，传 `{ "exemplars": [] }` 清空。

## 选用

`resolveWriterStyleExemplars` 只取一份档案的样例：任务、章节、整本书三级绑定中最具体且有启用样例的那份。不同档案的片段不混用。按登记顺序取，放不下的条目跳过。预算按写手实际收到的整块文字计算：开头的用法说明、遮名后的正文、场景功能和各条说明，合计不超过 4200 字，约为正文上下文预算的四分之一。这个块是必选块，超出预算会把近期章节、人物动态等可选上下文挤掉。

送给写手之前，`maskSourceEntities` 把 `sourceEntities` 里的专名换成〔甲〕〔乙〕这类代称。这些专名另存在写法上下文的 `sourceEntities` 里，成稿出现其中任何一个时，正文表达检查报告 `prose_source_entity_leak`（critical）。该检查在验收服务里执行，旧章节流水线和自动导演的生产内核都经过它。专名也并入 `forbiddenEntities`，用于清理写法合同文本；旧流水线对这份名单另有一次检查，名单里还包含从写法资料里按后缀猜出的称谓，那部分没有带进生产内核。

## 复用检查

`findStyleExemplarOverlaps` 去掉标点和空白后比较成稿与样例，相同的字累计 14 个以上算一次复用：可以是连续的一段，也可以是几段，中间只在样例的人名代称处断开。写手看到的是代称，照搬时会填上本书的人名，所以只认连续相同会漏掉人名较密的段落。正文表达检查（`services/novel/runtime/proseQuality`）据此报告 `prose_exemplar_overlap`。它只是安全检查，不评价文笔是否学到位，那由 AI 验收和作者试读判断。

## 边界

- 样例只影响怎么写，不提供本书事实。人物、设定和章节任务仍以各自的合同为准。
- 样例只进入完整写章的上下文，不进入审校和修文上下文。
- 写手 Prompt 对样例的用法说明在 `prompting/prompts/novel/context/chapterContextBlocks.ts` 的 `style_exemplars` 块里。
