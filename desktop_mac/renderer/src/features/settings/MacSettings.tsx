import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { macEnvironment } from "../../platform/native";
import { settingsSections } from "./sections";

export default function MacSettings() {
  return <div className="mac-page mac-settings"><header className="mac-page-heading"><div><h1>设置</h1><p>准备好 AI 服务，然后开始你的下一部作品。</p></div></header>
    <div className="mac-preference-list">{settingsSections.map(([path, title, description]) => <Link key={path} to={`/settings/${path}`}><div><strong>{title}</strong><p>{description}</p></div><ChevronRight size={15}/></Link>)}</div>
  </div>;
}
export function MacAppearance() {
  return <div className="mac-page mac-settings"><header className="mac-page-heading"><h1>阅读与外观</h1></header><dl className="mac-preference-list">
    <div><dt>工作台</dt><dd>浅灰色侧栏、紧凑工具栏与浅色写作画布</dd></div>
    <div><dt>正文</dt><dd>霞鹜文楷 · 20 像素 · 1.6 倍行距</dd></div>
    <div><dt>保存</dt><dd>⌘S 保存当前章节；离开编辑页前会提醒保存修改。</dd></div>
    <div><dt>窗口</dt><dd>窗口位置和大小会自动记住，目录可从工具栏收起。</dd></div>
  </dl></div>;
}
export function MacMaintenance() {
  const environment = macEnvironment();
  return <div className="mac-page mac-settings"><header className="mac-page-heading"><h1>连接与维护</h1></header><dl className="mac-preference-list">
    <div><dt>创作服务</dt><dd>{environment?.mode === "local" ? "本机测试服务" : "服务器 · SSH 安全连接"}</dd></div>
    <div><dt>启动桌面</dt><dd><code>make app</code> 连接服务器；<code>make dev_app</code> 连接本机。</dd></div>
    <div><dt>关闭与重启</dt><dd><code>make stop_app</code> 关闭；<code>make restart_app</code> 按最近使用的模式重启。</dd></div>
    <div><dt>更新服务</dt><dd><code>make up_app</code> 更新服务器。服务器有正在执行的任务时，请等待任务结束。</dd></div>
  </dl><p className="mac-settings-note">切换连接不会搬移小说数据。服务器作品和本机测试作品分别保存在各自的服务中。</p></div>;
}
