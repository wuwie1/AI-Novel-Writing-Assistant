export interface MacMessage {
  protocolVersion: 1;
  type: string;
  requestId?: string;
  decision?: "allow" | "cancel";
  [key: string]: unknown;
}

export interface MacBridge {
  protocolVersion: 1;
  mode: "local" | "remote";
  backendIdentity: string;
  postMessage: (message: MacMessage) => void;
}

declare global {
  interface Window {
    __AI_NOVEL_MAC__?: MacBridge;
    __AI_NOVEL_MAC_CONFIG__?: { mode: "local" | "remote"; backendIdentity?: string; appVersion: string };
  }
}

export function macEnvironment() {
  return window.__AI_NOVEL_MAC__ ?? window.__AI_NOVEL_MAC_CONFIG__;
}

export function postNative(message: Omit<MacMessage, "protocolVersion">): void {
  window.__AI_NOVEL_MAC__?.postMessage({ ...message, protocolVersion: 1 } as MacMessage);
}
