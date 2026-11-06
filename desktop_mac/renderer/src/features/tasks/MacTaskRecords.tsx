import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowUpRight, RefreshCw, Search } from "lucide-react";
import type { TaskKind, TaskStatus } from "@ai-novel/shared/types/task";
import { getTaskDetail, listTasks } from "@/api/tasks";
import { getTaskHistorySourceHref } from "@/lib/novelRoutes";
import { formatDate, formatKind, getTaskQueueLevelLabel, getTaskQueueTone, ACTIVE_STATUSES } from "@/pages/tasks";

const statuses: Array<[TaskStatus | "", string]> = [["", "全部状态"], ["running", "进行中"], ["queued", "排队中"], ["waiting_approval", "待确认"], ["succeeded", "已完成"], ["failed", "未完成"], ["cancelled", "已取消"]];
const kinds: TaskKind[] = ["novel_workflow", "novel_pipeline", "book_analysis", "knowledge_document", "image_generation", "agent_run", "style_extraction"];
/** Read and navigate only. Workflow commands stay on their contextual source page. */
export default function MacTaskRecords() {
  const [params, setParams] = useSearchParams();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [cursor, setCursor] = useState<string>();
  const kind = params.get("kind") as TaskKind;
  const id = params.get("id");
  const list = useQuery({ queryKey: ["mac-records", status, keyword, cursor], queryFn: () => listTasks({ status: status || undefined, keyword: keyword || undefined, cursor, limit: 60 }), refetchInterval: (query) => query.state.data?.data?.items.some((item) => ACTIVE_STATUSES.has(item.status)) ? 4000 : false });
  const detail = useQuery({ queryKey: ["mac-record", kind, id], queryFn: () => getTaskDetail(kind, id!), enabled: !!id && kinds.includes(kind), refetchInterval: (query) => query.state.data?.data && ACTIVE_STATUSES.has(query.state.data.data.status) ? 4000 : false });
  const item = detail.data?.data;
  return <div className="mac-page mac-records"><header className="mac-page-heading"><div><h1>运行记录</h1><p>查看创作进度与提醒，回到创作页面处理后续事项。</p></div><button className="mac-icon-button" title="刷新记录" aria-label="刷新记录" onClick={() => { void list.refetch(); if (id) void detail.refetch(); }}><RefreshCw size={15}/></button></header>
    <div className="mac-shelf-tools"><label className="mac-search"><Search size={15}/><input aria-label="搜索运行记录" placeholder="搜索运行记录" value={keyword} onChange={(event) => { setKeyword(event.target.value); setCursor(undefined); }}/></label><select aria-label="记录状态" value={status} onChange={(event) => { setStatus(event.target.value as TaskStatus | ""); setCursor(undefined); }}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <div className="mac-record-columns"><div className="mac-record-list" aria-label="记录列表">
      {list.isPending ? <p role="status">正在读取运行记录…</p> : list.isError ? <p role="alert">记录暂时无法读取，请刷新重试。</p> : !list.data?.data?.items.length ? <p>还没有符合条件的运行记录。</p> : list.data.data.items.map((row) => <button key={`${row.kind}:${row.id}`} onClick={() => setParams({kind: row.kind, id: row.id})} className={row.id === id && row.kind === kind ? "is-selected" : ""}><div><strong>{row.title}</strong><span data-tone={getTaskQueueTone(row)}>{getTaskQueueLevelLabel(row)}</span></div><p>{formatKind(row.kind)} · {row.currentItemLabel || row.currentStage || row.ownerLabel}</p><progress max={100} value={row.progress}/><small>{formatDate(row.updatedAt)}</small></button>)}
      <div className="mac-record-paging">{cursor ? <button onClick={() => setCursor(undefined)}>回到最新</button> : null}{list.data?.data?.nextCursor ? <button onClick={() => setCursor(list.data?.data?.nextCursor ?? undefined)}>更早记录</button> : null}</div>
    </div><aside className="mac-record-detail" aria-label="记录详情">{!id ? <p>选择一条记录查看详情。</p> : detail.isPending ? <p role="status">正在读取详情…</p> : detail.isError ? <p role="alert">详情暂时无法读取，请刷新重试。</p> : !item ? <p>这条记录暂时不可用。</p> : <>
      <h2>{item.title}</h2><p data-tone={getTaskQueueTone(item)}>{getTaskQueueLevelLabel(item)}</p><dl><dt>所属作品</dt><dd>{item.ownerLabel}</dd><dt>当前进度</dt><dd>{item.progress}% · {item.currentItemLabel || item.currentStage || "—"}</dd><dt>更新时间</dt><dd>{formatDate(item.updatedAt)}</dd></dl>
      {[item.noticeSummary, item.failureSummary || item.lastError, item.recoveryHint, item.checkpointSummary].filter(Boolean).map((message, index) => <p className="mac-record-notice" key={index}>{message}</p>)}
      {item.steps?.length ? <ol className="mac-record-steps">{item.steps.map((step) => <li key={step.key}><span>{step.label}</span><span>{({idle:"待开始",running:"进行中",succeeded:"完成",failed:"未完成",cancelled:"取消"})[step.status]}</span></li>)}</ol> : null}
      {item.sourceRoute?.startsWith("/") && !item.sourceRoute.startsWith("//") ? <Link className="mac-action" to={getTaskHistorySourceHref(item)}>打开创作页面<ArrowUpRight size={14}/></Link> : <p>这条记录没有可打开的创作页面。</p>}
    </>}</aside></div>
  </div>;
}
