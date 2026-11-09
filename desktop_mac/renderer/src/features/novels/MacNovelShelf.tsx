import { useState } from "react";
import { Link } from "react-router-dom";
import { BookCopy, BookOpen, BookOpenText, ChevronLeft, ChevronRight, Download, Image, MoreHorizontal, Plus, Search, Sparkles, Trash2, Workflow } from "lucide-react";
import { NovelList, type NovelListPresentation } from "@/pages/novels";
import { resolveImageAssetUrl } from "@/api/images";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

function Shelf({ model }: { model: NovelListPresentation }) {
  const [menu, setMenu] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const hasFilters = Boolean(model.search.trim())
    || model.narrativeForm !== "all"
    || model.status !== "all"
    || model.writingMode !== "all"
    || model.sort !== "updated";
  return <div className="mac-page mac-shelf">
    <header className="mac-page-heading">
      <div>
        <h1>{model.view === "workbench" ? "小说工作台" : "我的小说"}</h1>
        <p>{model.view === "workbench" ? "查看进度、继续创作，并处理需要跟进的作品。" : "从一个想法开始，写完属于你的故事。"}</p>
      </div>
      <div className="mac-shelf-actions">
        <Link className="mac-action" to="/novels/auto-director"><Sparkles size={15} />AI 开书</Link>
        <Link className="mac-action" to="/novels/auto-director?start=reference"><BookCopy size={15} />照着一本书写</Link>
        <Link className="mac-action" to="/create?form=short_story"><BookOpenText size={15} />创作短篇</Link>
        <Link className="mac-action" to="/create"><Plus size={15} />新建小说</Link>
      </div>
    </header>
    <div className="mac-shelf-tools">
      <label className="mac-search"><Search size={16} /><input aria-label="搜索小说" placeholder="搜索小说" value={model.search} onChange={(event) => model.setSearch(event.target.value)} /></label>
      <div className="mac-view-toggle" role="tablist" aria-label="书架视图">
        <button type="button" role="tab" aria-selected={model.view === "shelf"} className={model.view === "shelf" ? "is-active" : ""} onClick={() => model.setView("shelf")}>书架</button>
        <button type="button" role="tab" aria-selected={model.view === "workbench"} className={model.view === "workbench" ? "is-active" : ""} onClick={() => model.setView("workbench")}>工作台</button>
      </div>
      <select aria-label="作品类型" value={model.narrativeForm} onChange={(event) => model.setNarrativeForm(event.target.value as NovelListPresentation["narrativeForm"])}><option value="all">全部作品</option><option value="long_novel">长篇小说</option><option value="short_story">短篇小说</option></select>
      <select aria-label="写作模式" value={model.writingMode} onChange={(event) => model.setWritingMode(event.target.value as NovelListPresentation["writingMode"])}><option value="all">全部模式</option><option value="original">原创</option><option value="continuation">续写</option></select>
      <select aria-label="作品状态" value={model.status} onChange={(event) => model.setStatus(event.target.value as NovelListPresentation["status"])}><option value="all">全部状态</option><option value="draft">创作中</option><option value="published">已发布</option></select>
      <select aria-label="排序方式" value={model.sort} onChange={(event) => model.setSort(event.target.value as NovelListPresentation["sort"])}><option value="updated">最近编辑</option><option value="created">最近创建</option><option value="progress">完成度</option></select>
    </div>
    {model.isPending ? <div className="mac-empty" role="status">正在读取你的小说…</div> : model.isError ? <div className="mac-empty" role="alert"><p>小说暂时无法读取</p><button className="mac-action" onClick={model.refetch}>重新读取</button></div> : !model.novels.length ? (
      <div className="mac-empty"><BookOpen size={28} strokeWidth={1.3}/><h2>{hasFilters ? "没有符合条件的小说" : "开始你的第一本小说"}</h2><p>{hasFilters ? "试试调整搜索词或筛选条件。" : "告诉 AI 你的想法，一起完成设定、规划和正文。"}</p>{hasFilters ? <button className="mac-action" onClick={() => { model.setSearch(""); model.setNarrativeForm("all"); model.setStatus("all"); model.setWritingMode("all"); model.setSort("updated"); }}>清除筛选</button> : <Link className="mac-action" to="/create">开始创作</Link>}</div>
    ) : model.view === "workbench" ? <div className="mac-workbench-list">
      {model.novels.map((novel) => {
        const task = novel.narrativeForm === "short_story" ? novel.latestCreationStudioTask : novel.latestAutoDirectorTask;
        const needsAttention = task && ["failed", "blocked", "waiting_recovery", "waiting_approval"].includes(task.status);
        return <article key={novel.id} className="mac-workbench-row">
          <button type="button" className="mac-workbench-main" onClick={() => model.openNovel(novel.id)}>
            <strong>{novel.title}</strong>
            <span>{novel._count.chapters} 章 · {novel.narrativeForm === "short_story" ? "短篇" : "长篇"} · {novel.writingMode === "continuation" ? "续写" : "原创"}</span>
          </button>
          <div className="mac-workbench-actions">
            {task ? <button type="button" className={needsAttention ? "needs-attention" : ""} onClick={() => model.openCockpit(novel.id)}>{needsAttention ? "需要处理" : "创作进度"}</button> : null}
            <button type="button" onClick={() => model.openNovel(novel.id)}>继续写作</button>
          </div>
        </article>;
      })}
    </div> : <div className="mac-book-grid">
      {model.novels.map((novel) => {
        const task = novel.narrativeForm === "short_story" ? novel.latestCreationStudioTask : novel.latestAutoDirectorTask;
        const needsAttention = task && ["failed", "blocked", "waiting_recovery", "waiting_approval"].includes(task.status);
        const cover = novel.primaryCover?.url;
        return <article key={novel.id} className="mac-book-entry">
          <button className="mac-book-cover" onClick={() => model.openNovel(novel.id)} aria-label={`打开《${novel.title}》`}>
            {cover ? <img src={resolveImageAssetUrl(cover)} alt="" /> : <span className="mac-book-typography"><span>{novel.genre?.name || "故事"}</span><strong>{novel.title}</strong><i>写下你的世界</i></span>}
          </button>
          <div className="mac-book-caption"><button className="mac-book-name" onClick={() => model.openNovel(novel.id)}>{novel.title}</button><button className="mac-icon-button" aria-label={`《${novel.title}》更多操作`} aria-expanded={menu === novel.id} onClick={() => setMenu(menu === novel.id ? null : novel.id)}><MoreHorizontal size={16}/></button></div>
          <p className="mac-book-meta">{novel._count.chapters} 章 · {novel.narrativeForm === "short_story" ? "短篇" : "长篇"}</p>
          {task ? <button className={`mac-book-progress${needsAttention ? " needs-attention" : ""}`} onClick={() => model.openCockpit(novel.id)}><Workflow size={12}/>{needsAttention ? "查看需要处理的事项" : task.status === "running" || task.status === "queued" ? "AI 正在创作" : "查看创作进度"}</button> : null}
          {menu === novel.id ? <><button className="mac-menu-dismiss" aria-label="关闭作品菜单" onClick={() => setMenu(null)}/><div role="menu" className="mac-book-menu"><button role="menuitem" onClick={() => { setMenu(null); model.openCover(novel.id); }}><Image size={14}/>管理封面</button><button role="menuitem" disabled={model.downloadPendingId === novel.id} onClick={() => { setMenu(null); model.download({ novelId: novel.id, novelTitle: novel.title }); }}><Download size={14}/>导出正文</button><button role="menuitem" onClick={() => { setMenu(null); model.openCockpit(novel.id); }}><Workflow size={14}/>AI 创作进度</button><button role="menuitem" className="is-danger" disabled={model.deletePendingId === novel.id} onClick={() => { setMenu(null); setPendingDelete({ id: novel.id, title: novel.title }); }}><Trash2 size={14}/>删除小说</button></div></> : null}
        </article>;
      })}
    </div>}
    {!model.isPending && !model.isError && model.novels.length ? <footer className="mac-pagination"><span>共 {model.total} 部作品</span>{model.totalPages > 1 ? <><button className="mac-icon-button" aria-label="上一页" disabled={model.page <= 1 || model.isFetching} onClick={() => model.setPage(model.page - 1)}><ChevronLeft size={16}/></button><span>{model.page} / {model.totalPages}</span><button className="mac-icon-button" aria-label="下一页" disabled={model.page >= model.totalPages || model.isFetching} onClick={() => model.setPage(model.page + 1)}><ChevronRight size={16}/></button></> : null}</footer> : null}
    <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
      <DialogContent aria-describedby="mac-delete-novel-description">
        <DialogTitle>删除这本小说？</DialogTitle>
        <DialogDescription id="mac-delete-novel-description">
          {pendingDelete ? `《${pendingDelete.title}》删除后不能从回收站恢复。请确认你不再需要这本书。` : null}
        </DialogDescription>
        <div className="flex flex-wrap justify-end gap-2">
          <Button autoFocus onClick={() => setPendingDelete(null)}>取消</Button>
          <Button
            variant="outline"
            className="text-destructive"
            disabled={model.deletePendingId === pendingDelete?.id}
            onClick={() => {
              if (!pendingDelete) return;
              const target = pendingDelete;
              setPendingDelete(null);
              model.remove(target.id, target.title, { confirmed: true });
            }}
          >
            确认删除
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}

export default function MacNovelShelf() {
  return <NovelList render={(model) => <Shelf model={model}/>}/>;
}
