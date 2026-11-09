import { CollectionFilters } from "../../shell/CollectionFilters";
import type { UnifiedTaskSummary } from "@ai-novel/shared/types/task";
import { formatDate, formatKind, formatTaskStage, getTaskQueueLevelLabel } from "@/pages/tasks";
import { taskStatusOptions } from "./filters";
import type { TaskKind } from "@ai-novel/shared/types/task";

export const kinds: TaskKind[] = ["novel_workflow", "novel_pipeline", "book_analysis", "knowledge_document", "image_generation", "agent_run", "style_extraction"];
export const readKind = (value: string | null) => kinds.find((kind) => kind === value);

export function RecordTools({ keyword, status, kind, change }: {
  keyword: string; status: string; kind?: TaskKind;
  change: (key: string, value: string) => void;
}) {
  return <><input type="search" aria-label="搜索运行记录" placeholder="搜索运行记录" value={keyword} onChange={(e) => change("q", e.target.value)}/>
    <CollectionFilters active={Boolean(status || kind)}>
      <label>状态<select aria-label="记录状态" value={status} onChange={(e) => change("status", e.target.value)}>{taskStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>类型<select aria-label="记录类型" value={kind ?? ""} onChange={(e) => change("filterKind", e.target.value)}><option value="">全部类型</option>{kinds.map((k) => <option key={k} value={k}>{formatKind(k)}</option>)}</select></label>
    </CollectionFilters></>;
}

export function RecordList({ rows, selection, select }: { rows: UnifiedTaskSummary[]; selection: string | null; select: (row: UnifiedTaskSummary) => void }) {
  return <div className="mac-record-list">{rows.map((row) => {
    const key = row.kind + ":" + row.id;
    return <button type="button" key={key} aria-current={key === selection || undefined} className={'mac-list-row mac-detail-row' + (key === selection ? " is-selected" : "")} onClick={() => select(row)}>
      <strong>{row.title}</strong><span>{getTaskQueueLevelLabel(row)} · {row.progress}%</span>
      <small>{formatKind(row.kind)} · {row.currentItemLabel || formatTaskStage(row.currentStage) || row.ownerLabel}</small>
      <small>{formatDate(row.updatedAt)}</small>
    </button>;
  })}</div>;
}
