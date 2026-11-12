// Fixed endpoint shared with proxy/infrastructure/config.mjs and checked by the proxy contract test.
export const LOCAL_PROXY_BASE_URL = "http://127.0.0.1:14000/v1";

export function usesLocalProxy(baseURL: string): boolean {
  return baseURL.trim().replace(/\/+$/, "") === LOCAL_PROXY_BASE_URL;
}

export type ProviderCreationKind = "custom" | "local";

export function newProviderConnection(kind: ProviderCreationKind) {
  return kind === "local"
    ? { displayName: "本机模型", baseURL: LOCAL_PROXY_BASE_URL }
    : { displayName: "", baseURL: "" };
}

export function isLocalModelProvider(provider?: { kind: string; currentBaseURL: string }): boolean {
  return provider?.kind === "custom" && usesLocalProxy(provider.currentBaseURL);
}
