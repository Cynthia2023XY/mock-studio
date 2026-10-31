/** 本机管理接口与业务演示请求分开，管理令牌绝不发送到演示域名。 */
const apiBase = 'http://127.0.0.1:17321';
let tokenPromise: Promise<string> | null = null;

const getManagementToken = () => {
  if (!tokenPromise)
    tokenPromise = fetch(`${apiBase}/api/token`, {
      signal: AbortSignal.timeout(25000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('无法获取本地管理令牌');
        return ((await response.json()) as { token: string }).token;
      })
      .catch((error) => {
        tokenPromise = null;
        throw error;
      });
  return tokenPromise;
};

export async function apiRequest<T>(
  pathname: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/json');
  headers.set('x-mock-token', await getManagementToken());
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(25000),
    headers,
  });
  const data = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data;
}
