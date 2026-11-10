import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import type { UnifiedTaskDetail } from "@ai-novel/shared/types/task";
import { getTaskHistorySourceHref } from "@/lib/novelRoutes";
import { formatDate, formatTaskStage, getTaskQueueLevelLabel, getTaskQueueTone } from "@/pages/tasks";
import { toUserFacingErrorText } from "@/lib/userFacingErrorText";

function getSource(item: UnifiedTaskDetail) {
  if (!item.sourceRoute?.startsWith("/")) return null;
  try {
    const href = getTaskHistorySourceHref(item);
    return new URL(href, "https://novel.local").origin === "https://novel.local" ? href : null;
  } catch { return null; }
}

export function RecordDetail({ item }: { item: UnifiedTaskDetail }) {
  const sourceHref = getSource(item);
  return <>
      <h2>{item.title}</h2><p data-tone={getTaskQueueTone(item)}>{getTaskQueueLevelLabel(item)}</p><dl><dt>所属作品</dt><dd>{item.ownerLabel}</dd><dt>当前进度</dt><dd>{item.progress}% · {item.currentItemLabel || formatTaskStage(item.currentStage) || "—"}</dd><dt>更新时间</dt><dd>{formatDate(item.updatedAt)}</dd></dl>
      {[item.noticeSummary, toUserFacingErrorText(item.failureSummary || item.lastError), item.recoveryHint, item.checkpointSummary].filter(Boolean).map((message, index) => <p className="mac-record-notice" key={index}>{message}</p>)}
      {item.steps?.length ? <ol className="mac-record-steps">{item.steps.map((step) => <li key={step.key}><span>{formatTaskStage(step.label) || step.label}</span><span>{({idle:"待开始",running:"进行中",succeeded:"完成",failed:"未完成",cancelled:"取消"})[step.status]}</span></li>)}</ol> : null}
      {sourceHref ? <Link className="mac-action" to={sourceHref}>打开创作页面<ArrowUpRight size={14}/></Link> : <p>这条记录没有可打开的创作页面。</p>}
  </>;
}
