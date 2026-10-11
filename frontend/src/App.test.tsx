import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { emptyMeta, sale, summary } from "./test/fixtures";
import App from "./App";
afterEach(() => vi.unstubAllGlobals());
it("业务明细中的收款弹窗在请求完成前禁止关闭", async () => {
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST")
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    const query = new URL(url, "http://127.0.0.1").searchParams;
    return new Response(
      JSON.stringify(
        url.includes("/meta")
          ? { ...emptyMeta, entry_count: 1 }
          : url.includes("/summary")
            ? { ...summary, start: query.get("start"), end: query.get("end") }
            : url.includes("/entries")
              ? { items: [sale] }
              : { items: [] },
      ),
    );
  });
  const user = userEvent.setup();
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "记一笔" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "销售与费用" }));
  await user.click(screen.getByRole("button", { name: "详情" }));
  await user.click(screen.getByRole("button", { name: "登记收款" }));
  await user.type(screen.getByLabelText("金额（元）"), "10.00");
  fireEvent.change(screen.getByLabelText("实际收付日期"), {
    target: { value: "2026-10-03" },
  });
  await user.click(screen.getByRole("button", { name: "保存流水" }));
  try {
    expect(screen.getByRole("button", { name: "关闭对话框" })).toBeDisabled();
  } finally {
    await act(async () => {
      finish?.(
        new Response(JSON.stringify({ detail: "暂时无法保存" }), {
          status: 503,
        }),
      );
    });
  }
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByLabelText("金额（元）")).toHaveValue("10.00");
});
it("空账本显示真实空态且不自动创建示例", async () => {
  let writes = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") writes++;
    return new Response(
      JSON.stringify(
        url.includes("/meta")
          ? emptyMeta
          : url.includes("/summary")
            ? {
                ...summary,
                start: new URL(url, "http://127.0.0.1").searchParams.get(
                  "start",
                ),
                end: new URL(url, "http://127.0.0.1").searchParams.get("end"),
              }
            : { items: [] },
      ),
    );
  });
  render(<App />);
  expect(
    await screen.findByText(/还没有记录，可以记第一笔/),
  ).toBeInTheDocument();
  expect(writes).toBe(0);
  expect(screen.getByRole("navigation")).toBeInTheDocument();
});
