import { useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ChevronLeft, ChevronRight, Download, Image, MoreHorizontal, Plus, Search, Trash2, Workflow } from "lucide-react";
import { NovelList, type NovelListPresentation } from "@/pages/novels";
import { resolveImageAssetUrl } from "@/api/images";

function Shelf({ model }: { model: NovelListPresentation }) {
  const [menu, setMenu] = useState<string | null>(null);
  return <div className="mac-page mac-shelf">
    <header className="mac-page-heading"><div><h1>我的小说</h1><p>从一个想法开始，写完属于你的故事。</p></div><Link className="mac-action" to="/create"><Plus size={15} />新建小说</Link></header>
    <div className="mac-shelf-tools">
      <label className="mac-search"><Search size={16} /><input aria-label="搜索小说" placeholder="搜索小说" value={model.search} onChange={(event) => model.setSearch(event.target.value)} /></label>
      <select aria-label="作品类型" value={model.narrativeForm} onChange={(event) => model.setNarrativeForm(event.target.value as NovelListPresentation["narrativeForm"])}><option value="all">全部作品</option><option value="long_novel">长篇小说</option><option value="short_story">短篇小说</option></select>
      <select aria-label="作品状态" value={model.status} onChange={(event) => model.setStatus(event.target.value as NovelListPresentation["status"])}><option value="all">全部状态</option><option value="draft">创作中</option><option value="published">已发布</option></select>
    </div>
    {model.isPending ? <div className="mac-empty" role="status">正在读取你的小说…</div> : model.isError ? <div className="mac-empty" role="alert"><p>小说暂时无法读取</p><button className="mac-action" onClick={model.refetch}>重新读取</button></div> : !model.novels.length ? <div className="mac-empty"><BookOpen size={28} strokeWidth={1.3}/><h2>{model.search ? "没有找到这本小说" : "开始你的第一本小说"}</h2><p>{model.search ? "试试其他关键词。" : "告诉 AI 你的想法，一起完成设定、规划和正文。"}</p><Link className="mac-action" to="/create">开始创作</Link></div> : <div className="mac-book-grid">
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
          {menu === novel.id ? <><button className="mac-menu-dismiss" aria-label="关闭作品菜单" onClick={() => setMenu(null)}/><div role="menu" className="mac-book-menu"><button role="menuitem" onClick={() => { setMenu(null); model.openCover(novel.id); }}><Image size={14}/>管理封面</button><button role="menuitem" disabled={model.downloadPendingId === novel.id} onClick={() => { setMenu(null); model.download({ novelId: novel.id, novelTitle: novel.title }); }}><Download size={14}/>导出正文</button><button role="menuitem" onClick={() => { setMenu(null); model.openCockpit(novel.id); }}><Workflow size={14}/>AI 创作进度</button><button role="menuitem" className="is-danger" disabled={model.deletePendingId === novel.id} onClick={() => { setMenu(null); model.remove(novel.id, novel.title); }}><Trash2 size={14}/>删除小说</button></div></> : null}
        </article>;
      })}
    </div>}
    <footer className="mac-pagination"><span>共 {model.total} 部作品</span><button className="mac-icon-button" aria-label="上一页" disabled={model.page <= 1 || model.isFetching} onClick={() => model.setPage(model.page - 1)}><ChevronLeft size={16}/></button><span>{model.page} / {model.totalPages}</span><button className="mac-icon-button" aria-label="下一页" disabled={model.page >= model.totalPages || model.isFetching} onClick={() => model.setPage(model.page + 1)}><ChevronRight size={16}/></button></footer>
  </div>;
}

export default function MacNovelShelf() {
  return <NovelList render={(model) => <Shelf model={model}/>}/>;
}
