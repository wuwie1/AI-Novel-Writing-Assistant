import { CreationSetupProvider } from "@/components/onboarding/CreationSetupContext";
import { TaskRecoveryProvider } from "@/components/layout/TaskRecoveryContext";
import AccessTokenGate from "@/components/layout/AccessTokenGate";
import TaskRecoveryDialog from "@/components/layout/TaskRecoveryDialog";
import LLMSelectionBootstrap from "@/components/layout/LLMSelectionBootstrap";
import AutoDirectorPauseNotificationWatcher from "@/components/autoDirector/AutoDirectorPauseNotificationWatcher";
import LiveExecutionDialog from "@/components/liveExecution/LiveExecutionDialog";
import { MacAppLayout } from "../shell";
import { MacDocumentProtection } from "../platform/MacDocumentProtection";
import { MacConnection } from "./MacConnection";

export function MacWorkspace() {
  return <MacDocumentProtection><MacConnection><AccessTokenGate checkPath="/novels?page=1&limit=1"><CreationSetupProvider><TaskRecoveryProvider>
    <LLMSelectionBootstrap />
    <AutoDirectorPauseNotificationWatcher />
    <MacAppLayout />
    <LiveExecutionDialog compact className="fixed bottom-3 right-3 z-40" />
    <TaskRecoveryDialog />
  </TaskRecoveryProvider></CreationSetupProvider></AccessTokenGate></MacConnection></MacDocumentProtection>;
}
