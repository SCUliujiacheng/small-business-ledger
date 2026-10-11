import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { EntryDialog } from "./EntryDialog";
afterEach(() => vi.unstubAllGlobals());
it("显示精确销售预览并将金额字符串提交到 API，保存失败保留内容和具体错误", async () => {
  let request: RequestInit | undefined;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    request = init;
    return new Response(
      JSON.stringify({ detail: "账本已达容量上限，请先导出归档" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  });
  const user = userEvent.setup();
  render(<EntryDialog onClose={() => {}} onSaved={() => {}} />);
  await user.type(screen.getByLabelText("项目"), "帆布袋");
  await user.clear(screen.getByLabelText("数量"));
  await user.type(screen.getByLabelText("数量"), "3");
  await user.type(screen.getByLabelText("单价（元）"), "0.29");
  await user.type(screen.getByLabelText("单位直接成本（元）"), "0.07");
  expect(screen.getByText("¥0.87")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存记录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "账本已达容量上限",
  );
  expect(screen.getByLabelText("项目")).toHaveValue("帆布袋");
  expect(JSON.parse(String(request?.body))).toMatchObject({
    kind: "sale",
    quantity: 3,
    unit_price: "0.29",
    unit_cost: "0.07",
  });
  expect(new Headers(request?.headers).get("X-Ledger-Request")).toBe("1");
});
it("费用提交不包含销售字段，等待期间禁止重复保存", async () => {
  let request: RequestInit | undefined;
  let finish: ((r: Response) => void) | undefined;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    request = init;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const user = userEvent.setup();
  let saved = false;
  render(
    <EntryDialog
      onClose={() => {}}
      onSaved={() => {
        saved = true;
      }}
    />,
  );
  await user.click(screen.getByRole("radio", { name: "费用" }));
  await user.type(screen.getByLabelText("项目"), "房租");
  await user.type(screen.getByLabelText("金额（元）"), "2000.00");
  await user.click(screen.getByRole("button", { name: "保存记录" }));
  expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
  expect(JSON.parse(String(request?.body))).toMatchObject({
    kind: "expense",
    amount: "2000.00",
  });
  expect(JSON.parse(String(request?.body))).not.toHaveProperty("unit_price");
  finish?.(
    new Response("{}", {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  );
  await waitFor(() => expect(saved).toBe(true));
});
