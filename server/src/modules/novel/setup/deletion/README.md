# 小说删除编排

`deleteNovel` 是小说删除的唯一应用入口：取得书级行锁，收集取消键，准备可回滚的关联记录清理与外部清理凭据，解除大纲绑定后删除小说，提交成功才取消执行并尝试清理文件。

RAG 来源与集合归属由 `services/rag/ownership` 拥有；关联记录及图片凭据通过 `services/novel/lifecycle` 门面处理；外部失败交给既有 side-effect worker 重试。调用方不得自行拼接第二条删除路径，也不得在数据库事务成功前删除外部文件或中断运行任务。

完整边界与回归要求见 [小说删除的事务与外部资源边界](../../../../../../docs/wiki/workflows/novel-deletion.md)。
