import { useRef, type ReactNode } from "react";

export function CollectionFilters({ active, children }: { active: boolean; children: ReactNode }) {
  const trigger = useRef<HTMLElement>(null);
  return <details className="mac-collection-filters" onKeyDown={event => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.open = false;
    trigger.current?.focus();
  }}>
    <summary ref={trigger}>{active ? "筛选 · 已选条件" : "筛选"}</summary>
    <div className="mac-filter-fields">{children}</div>
  </details>;
}
