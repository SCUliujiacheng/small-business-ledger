export class RequestError extends Error {
  readonly uncertain: boolean;
  constructor(message: string, uncertain = false) {
    super(message);
    this.uncertain = uncertain;
  }
}
export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  requestId?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      `/api${path}`,
      body === undefined
        ? { signal }
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Ledger-Request": "1",
              ...(requestId ? { "Idempotency-Key": requestId } : {}),
            },
            body: JSON.stringify(body),
            signal,
          },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new RequestError("无法连接本机账本服务，请确认服务运行后重试", true);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    throw new RequestError(
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail
              .map(
                (item: { msg?: string; loc?: unknown[] }) =>
                  `${item.loc?.slice(1).join(" · ") ?? "输入"}：${item.msg ?? "格式不正确"}`,
              )
              .join("；")
          : `请求未完成（${response.status}），请重试`,
      response.status >= 500,
    );
  }
  if (data === null) throw new RequestError("服务返回了无效数据，请重试", true);
  return data as T;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试";
}
