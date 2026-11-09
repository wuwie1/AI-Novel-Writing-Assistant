import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import AppearanceSettingsPage from "@/pages/settings/views/AppearanceSettingsPage";
import { macEnvironment } from "../../platform/native";
import { settingsSections } from "./sections";

export default function MacSettings() {
  return <div className="mac-page mac-settings"><header className="mac-page-heading"><div><h1>设置</h1><p>准备好 AI 服务，然后开始你的下一部作品。</p></div></header>
    <div className="mac-preference-list">{settingsSections.map(([path, title, description]) => <Link key={path} to={`/settings/${path}`}><div><strong>{title}</strong><p>{description}</p></div><ChevronRight size={15}/></Link>)}</div>
  </div>;
}
export function MacAppearance() {
  return <div className="mac-page mac-settings mac-appearance-host">
    <AppearanceSettingsPage />
    <dl className="mac-preference-list mac-appearance-notes">
      <div><dt>桌面工作台</dt><dd>浅灰色侧栏、紧凑工具栏与浅色写作画布。主题切换会同步到当前桌面窗口。</dd></div>
      <div><dt>正文</dt><dd>霞鹜文楷 · 20 像素 · 1.6 倍行距；可在章节编辑器里单独调整。</dd></div>
      <div><dt>保存</dt><dd>⌘S 保存当前章节；离开编辑页前会提醒保存修改。</dd></div>
    </dl>
  </div>;
}
export function MacMaintenance() {
  const environment = macEnvironment();
  return <div className="mac-page mac-settings"><header className="mac-page-heading"><h1>连接与维护</h1></header><dl className="mac-preference-list">
    <div><dt>创作服务</dt><dd>{environment?.mode === "local" ? "本机测试服务" : "服务器 · 安全远程连接"}</dd></div>
    <div><dt>当前模式</dt><dd>{environment?.mode === "local" ? "正在使用本机测试环境，适合验收和新功能联调。" : "正在连接服务器上的创作服务，作品保存在服务器。"}</dd></div>
    <div><dt>关闭应用</dt><dd>从菜单栏选择「退出」，或关闭全部窗口。后台若仍有未完成的创作任务，本机测试服务可能会继续保留。</dd></div>
    <div><dt>服务状态</dt><dd>顶部工具栏会显示「本地测试」或「服务器」。连接异常时，请先检查网络，再重新打开应用。</dd></div>
  </dl><p className="mac-settings-note">切换连接不会搬移小说数据。服务器作品和本机测试作品分别保存在各自的服务中。</p></div>;
}
