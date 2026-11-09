import { useState, type ReactNode } from "react";
import { EntityList, useEntityListHost, type EntityCollection } from "./EntityList";

export interface DirectoryRow { id: string; label: string; description?: string | null; group?: string; disabled?: boolean }
interface DirectoryProps extends EntityCollection {
  rows: DirectoryRow[];
  onSelect: (id: string) => void;
  pending?: boolean;
  error?: boolean;
  retry?: () => void;
  tools?: ReactNode;
  disabled?: boolean;
  empty?: string;
  inline?: ReactNode;
}

export function DirectoryRows({ rows, selection, onSelect, disabled }: Pick<DirectoryProps, "rows" | "selection" | "onSelect" | "disabled">) {
  return rows.map((row, i) => <div key={row.id}>
    {row.group && row.group !== rows[i - 1]?.group && <div className="mac-list-label">{row.group}</div>}
    <button type="button" className={'mac-list-row mac-detail-row' + (row.id === selection ? ' is-selected' : '')}
      aria-current={row.id === selection || undefined} disabled={disabled || row.disabled} onClick={() => onSelect(row.id)}>
      <strong>{row.label}</strong>{row.description && <small>{row.description}</small>}
    </button>
  </div>);
}

function SearchableDirectory(props: DirectoryProps) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLocaleLowerCase();
  const visible = props.rows.filter(row => [row.label, row.description, row.group].some(value => value?.toLocaleLowerCase().includes(needle)));
  return <EntityList {...props} tools={<><input type="search" aria-label={`搜索已加载的${props.title}`} placeholder={`搜索已加载的${props.title}`} value={search} onChange={e => setSearch(e.target.value)}/>{props.tools}</>}>
    {props.pending ? <p role="status">正在读取{props.title}…</p> : props.error ? <p role="alert">读取失败。{props.retry && <button onClick={props.retry}>重新读取</button>}</p> :
      visible.length ? <DirectoryRows {...props} rows={visible}/> : <p className="mac-list-message">{needle ? "没有匹配的条目。" : props.empty ?? `暂无${props.title}。`}</p>}
  </EntityList>;
}

/** Search belongs to this collection, independent of the currently selected row. */
export function EntityDirectory(props: DirectoryProps) {
  return useEntityListHost() ? <SearchableDirectory key={props.collection} {...props}/> : <>{props.inline}</>;
}
