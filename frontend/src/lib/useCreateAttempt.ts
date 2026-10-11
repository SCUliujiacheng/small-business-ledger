import { useRef, useState } from "react";
import { errorMessage, request, RequestError } from "./api";

export const uncertainMessage =
  "无法确认上次是否已保存。原内容已锁定，请重试原提交，系统会核对同一操作，避免重复记账。关闭或离开页面后重新录入属于新操作，请先核对账本。";

// An attempt belongs to the form, not a fetch call. In particular, a lost
// response must replay the same payload even if refreshed balances changed.
export function useCreateAttempt(path: "/entries" | "/payments") {
  const attempt = useRef<{ id: string; body: unknown } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  async function submit(body?: unknown) {
    if (!attempt.current) attempt.current = { id: crypto.randomUUID(), body };
    else if (!uncertain) attempt.current.body = body;
    try {
      await request(path, attempt.current.body, undefined, attempt.current.id);
      attempt.current = null;
      setUncertain(false);
    } catch (error) {
      const unresolved =
        uncertain || !(error instanceof RequestError) || error.uncertain;
      setUncertain(unresolved);
      throw new Error(
        unresolved
          ? `${errorMessage(error)}\n${uncertainMessage}`
          : errorMessage(error),
      );
    }
  }
  return { uncertain, submit };
}
