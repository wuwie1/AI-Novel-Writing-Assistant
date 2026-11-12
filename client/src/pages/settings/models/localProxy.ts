// Fixed endpoint shared with proxy/infrastructure/config.mjs and checked by the proxy contract test.
export const LOCAL_PROXY_BASE_URL = "http://127.0.0.1:14000/v1";

export function usesLocalProxy(baseURL: string): boolean {
  return baseURL.trim().replace(/\/+$/, "") === LOCAL_PROXY_BASE_URL;
}

export function selectLocalProxy<T extends { baseURL: string; directBaseURL?: string }>(
  form: T, enabled: boolean, defaultBaseURL = "",
): T {
  if (enabled) {
    return { ...form, baseURL: LOCAL_PROXY_BASE_URL,
      directBaseURL: usesLocalProxy(form.baseURL) ? form.directBaseURL : form.baseURL };
  }
  const directBaseURL = form.directBaseURL ?? (usesLocalProxy(defaultBaseURL) ? "" : defaultBaseURL);
  return { ...form, baseURL: directBaseURL, directBaseURL: undefined };
}
