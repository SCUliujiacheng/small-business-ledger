export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
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
            },
            body: JSON.stringify(body),
            signal,
          },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("无法连接本机账本服务，请确认服务运行后重试");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    throw new Error(
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
    );
  }
  if (data === null) throw new Error("服务返回了无效数据，请重试");
  return data as T;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试";
}
