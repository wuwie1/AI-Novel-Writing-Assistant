import { useState } from "react";
import { EntityDirectory } from "@/platform";
import type { Selection, WorkspaceBook } from "../model";
import { sameSelection } from "../planning";

const categories = {
  chapter:"正文", volume:"分卷", beat:"节奏段", plan:"规划章节", character:"角色",
  story:"故事规划", world:"世界设定", world_map:"世界地图", character_graph:"关系图", character_timeline:"角色时间线",
  foreshadowing:"伏笔", resources:"背包与资源", characters:"角色阵容", volumes:"分卷规划总览",
};
type Category = keyof typeof categories;
interface Entry { value: Selection; label: string; group?: string }
function entries(book: WorkspaceBook, category: Category): Entry[] | null {
  const volumes = book.planning?.volumes ?? [];
  switch (category) {
    case "chapter": return book.chapters.map(c => ({value:{kind:"chapter",id:c.id},label:`第 ${c.order} 章 · ${c.title}`}));
    case "volume": return (book.planning?.volumes ?? book.materials.volumes).map(v => ({value:{kind:"volume",id:v.id}, label:v.title}));
    case "beat": return (book.planning?.beatSheets ?? []).flatMap(s => s.beats.map(b => ({value:{kind:"beat" as const,id:b.key,volumeId:s.volumeId},label:b.title || b.label,group:volumes.find(v => v.id === s.volumeId)?.title})));
    case "plan": return volumes.flatMap(v => v.chapters.map(p => ({value:{kind:"plan" as const,id:p.id},label:`第 ${p.chapterOrder} 章 · ${p.title}`,group:v.title})));
    case "character": return book.materials.characters.map(c => ({value:{kind:"character",id:c.id},label:c.name}));
    default: return null;
  }
}

export function BookResourcePicker({book,selected,onSelect}: {book:WorkspaceBook;selected:Selection;onSelect:(s:Selection)=>void}) {
  const [empty, setEmpty] = useState<{kind:Category; previous:Selection} | null>(null);
  const kind = empty && sameSelection(empty.previous,selected) ? empty.kind : selected.kind === "character_resources" ? "resources" : selected.kind;
  const rows = entries(book,kind);
  const choose = (category:Category) => {
    const options = entries(book,category);
    if (options && !options.length) { setEmpty({kind:category,previous:selected}); return; }
    setEmpty(null);
    if (options) onSelect(options[0].value);
    else if (category !== "beat" && category !== "plan" && category !== "volume" && category !== "character" && category !== "chapter") onSelect({kind:category});
  };
  return <div className="mac-view-links"><label>本书资料 <select aria-label="本书资料类型" value={kind} onChange={e => choose(e.target.value as Category)}>
    {Object.entries(categories).map(([key,title]) => <option key={key} value={key}>{title}</option>)}
  </select></label>
    {rows && <EntityDirectory collection={`director:${book.novel.id}:${kind}`} title={categories[kind]} selection={rows.some(r => sameSelection(r.value,selected)) ? JSON.stringify(selected) : null}
      rows={rows.map(r => ({id:JSON.stringify(r.value),label:r.label,group:r.group}))} onSelect={id => {const row=rows.find(r=>JSON.stringify(r.value)===id);if(row){setEmpty(null);onSelect(row.value);}}}/>}
  </div>;
}
