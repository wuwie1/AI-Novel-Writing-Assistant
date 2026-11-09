import type { ReactNode } from "react";
import { EntityDirectory } from "@/platform";
import type { Selection, WorkspaceBook } from "../model";
import { sameSelection } from "../planning";

const categories = {
  chapter: "正文", volume: "分卷", beat: "节奏段", plan: "规划章节", character: "角色",
  story: "故事规划", world: "世界设定", world_map: "世界地图", character_graph: "关系图",
  character_timeline: "角色时间线", foreshadowing: "伏笔", resources: "背包与资源",
  characters: "角色阵容", volumes: "分卷规划总览",
};
type Category = keyof typeof categories;
interface Entry { value: Selection; label: string; group?: string }

export function readResourceCategory(raw: string | null): Category | null {
  return raw && Object.hasOwn(categories, raw) ? raw as Category : null;
}

export function readResourceSelection(params: URLSearchParams): Selection | null {
  const raw = params.get("resource");
  const id = params.get("resourceId");
  if (raw === "character_resources") return id ? {kind: raw, id} : null;
  const kind = readResourceCategory(raw);
  if (!kind) return null;
  if (kind === "beat") {
    const volumeId = params.get("resourceVolumeId");
    return id && volumeId ? {kind, volumeId, id} : null;
  }
  if (kind === "chapter" || kind === "volume" || kind === "plan" || kind === "character") return id ? {kind, id} : null;
  return {kind};
}

function entries(book: WorkspaceBook, category: Category): Entry[] | null {
  const volumes = book.planning?.volumes ?? [];
  switch (category) {
    case "chapter": return book.chapters.map(c => ({value: {kind: "chapter", id: c.id}, label: `第 ${c.order} 章 · ${c.title}`}));
    case "volume": return (book.planning?.volumes ?? book.materials.volumes).map(v => ({value: {kind: "volume", id: v.id}, label: v.title}));
    case "beat": return (book.planning?.beatSheets ?? []).flatMap(sheet => sheet.beats.map(beat => ({
      value: {kind: "beat" as const, id: beat.key, volumeId: sheet.volumeId}, label: beat.title || beat.label,
      group: volumes.find(volume => volume.id === sheet.volumeId)?.title,
    })));
    case "plan": return volumes.flatMap(volume => volume.chapters.map(plan => ({
      value: {kind: "plan" as const, id: plan.id}, label: `第 ${plan.chapterOrder} 章 · ${plan.title}`, group: volume.title,
    })));
    case "character": return book.materials.characters.map(c => ({value: {kind: "character", id: c.id}, label: c.name}));
    default: return null;
  }
}

export function BookResourcePicker({ book, selected, category, unavailable, onSelect, onEmpty, children }: {
  book: WorkspaceBook; selected: Selection; category: Category | null; unavailable: boolean;
  onSelect: (selection: Selection) => void; onEmpty: (category: Category) => void; children: ReactNode;
}) {
  const kind = category ?? (selected.kind === "character_resources" ? "resources" : selected.kind);
  const rows = entries(book, kind);
  const current = rows?.find(row => sameSelection(row.value, selected));
  function choose(kind: Category) {
    const options = entries(book, kind);
    if (options?.length) onSelect(options[0].value);
    else if (options) onEmpty(kind);
    else if (kind !== "beat" && kind !== "plan" && kind !== "volume" && kind !== "chapter" && kind !== "character") onSelect({kind});
  }
  return <>
    <div className="mac-view-links"><label>本书资料 <select aria-label="本书资料类型" value={kind} onChange={e => choose(e.target.value as Category)}>
      {Object.entries(categories).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
    </select></label></div>
    {rows && <EntityDirectory collection={`director:${book.novel.id}:${kind}`} title={categories[kind]}
      selection={current && !unavailable ? JSON.stringify(current.value) : null}
      rows={rows.map(row => ({id: JSON.stringify(row.value), label: row.label, group: row.group}))}
      onSelect={id => { const row = rows.find(item => JSON.stringify(item.value) === id); if (row) onSelect(row.value); }}/>}
    {unavailable || (rows && !current) ? <p>请从目录选择本书已保存的{categories[kind]}。{rows?.length ? <button onClick={() => choose(kind)}>查看第一项</button> : null}</p> : children}
  </>;
}
