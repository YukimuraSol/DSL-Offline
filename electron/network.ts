/**
 * 把 Electron/Chromium 的 fetch 适配成标准 fetch。
 * Chromium 网络栈会继承系统代理，避免主进程的 Node fetch 绕过代理直连。
 */
export function createProxyAwareFetch(
  chromiumFetch: (input: string | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return (input, init) => chromiumFetch(input instanceof URL ? input.href : input, init)
}
