import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  AUTO_DIRECTOR_PAUSE_NOTIFICATION_SETTINGS_EVENT,
  type BrowserNotificationPermissionState,
  getBrowserNotificationPermission,
  isAutoDirectorPauseNotificationEnabled,
  requestBrowserNotificationPermission,
  setAutoDirectorPauseNotificationEnabled,
} from "@/lib/autoDirectorPauseNotifications";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";

function formatPermission(permission: BrowserNotificationPermissionState): string {
  switch (permission) {
    case "granted":
      return "已允许";
    case "denied":
      return "已阻止";
    case "default":
      return "待授权";
    case "unsupported":
      return "不支持";
  }
}

export function AutoDirectorBrowserNotificationSettingsCard(props: {
  onActionResult: (message: string) => void;
}) {
  const { onActionResult } = props;
  const isMacShell = typeof document !== "undefined"
    && document.documentElement.dataset.appShell === "mac";
  const [enabled, setEnabled] = useState(() => isAutoDirectorPauseNotificationEnabled());
  const [permission, setPermission] = useState<BrowserNotificationPermissionState>(() => getBrowserNotificationPermission());

  const refreshState = () => {
    setEnabled(isAutoDirectorPauseNotificationEnabled());
    setPermission(getBrowserNotificationPermission());
  };

  useEffect(() => {
    const handleSettingsChange = () => refreshState();
    window.addEventListener(AUTO_DIRECTOR_PAUSE_NOTIFICATION_SETTINGS_EVENT, handleSettingsChange);
    window.addEventListener("storage", handleSettingsChange);
    return () => {
      window.removeEventListener(AUTO_DIRECTOR_PAUSE_NOTIFICATION_SETTINGS_EVENT, handleSettingsChange);
      window.removeEventListener("storage", handleSettingsChange);
    };
  }, []);

  const handleEnable = async () => {
    let nextPermission = getBrowserNotificationPermission();
    if (nextPermission === "unsupported") {
      setAutoDirectorPauseNotificationEnabled(false);
      refreshState();
      onActionResult(isMacShell
        ? "当前 Mac 桌面还不支持系统通知提醒，请打开「运行记录」或跟进中心查看暂停事项。"
        : "当前浏览器不支持桌面提醒。");
      return;
    }
    if (nextPermission === "default") {
      nextPermission = await requestBrowserNotificationPermission();
    }
    if (nextPermission !== "granted") {
      setAutoDirectorPauseNotificationEnabled(false);
      refreshState();
      onActionResult(isMacShell
        ? "系统未允许通知。可在「系统设置 → 通知」中允许本应用，或直接打开跟进中心查看暂停事项。"
        : "浏览器未允许通知，自动导演暂停时不会发送桌面提醒。");
      return;
    }
    setAutoDirectorPauseNotificationEnabled(true);
    refreshState();
    onActionResult("自动导演暂停提醒已开启。");
  };

  const handleToggle = (checked: boolean) => {
    if (!checked) {
      setAutoDirectorPauseNotificationEnabled(false);
      refreshState();
      onActionResult("自动导演暂停提醒已关闭。");
      return;
    }
    void handleEnable();
  };

  const permissionLabel = formatPermission(permission);
  const canRequestPermission = permission === "default";

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="space-y-1.5">
        <div className="flex min-w-0 items-start gap-3">
          <BellRing className="mt-1 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 space-y-1.5">
            <CardTitle>自动导演暂停提醒</CardTitle>
            <CardDescription className={AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}>
              {isMacShell
                ? "当自动导演等待确认、需要恢复或被校验拦住时，尽量通过系统通知提醒你回到跟进中心。"
                : "当自动导演等待确认、需要恢复或被校验拦住时，通过浏览器通知提醒你回到跟进中心。"}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex min-w-0 items-center justify-between gap-4 rounded-md border bg-muted/10 p-3">
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-medium">桌面提醒</div>
            <div className={`${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText} text-xs text-muted-foreground`}>
              {isMacShell
                ? "只影响这台电脑上的当前桌面应用。"
                : "只影响这台电脑上的当前浏览器。"}
            </div>
          </div>
          <Switch
            checked={enabled && permission === "granted"}
            onCheckedChange={handleToggle}
            disabled={permission === "unsupported" || (isMacShell && permission === "denied")}
            aria-label="开启或关闭自动导演暂停提醒"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-3 rounded-md border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-medium">通知权限：{permissionLabel}</div>
            <div className={`${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText} text-xs text-muted-foreground`}>
              {isMacShell
                ? permission === "denied" || permission === "unsupported"
                  ? "当前桌面环境暂无法发送系统通知。暂停事项仍可在「运行记录」和跟进中心查看。"
                  : "若系统已阻止通知，请在「系统设置 → 通知」中允许本应用。"
                : "若浏览器已阻止通知，请在地址栏权限设置中允许本网站发送通知。"}
            </div>
          </div>
          {canRequestPermission ? (
            <Button
              type="button"
              variant="outline"
              className={AUTO_DIRECTOR_MOBILE_CLASSES.fullWidthAction}
              onClick={() => void handleEnable()}
            >
              {isMacShell ? "授权系统通知" : "授权浏览器通知"}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
