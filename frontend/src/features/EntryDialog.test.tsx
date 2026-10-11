import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { EntryDialog } from "./EntryDialog";
afterEach(() => vi.unstubAllGlobals());
it("销售保存往来与到期日，切换费用后只提交付款方字段", async () => {
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 201 });
  });
  const user = userEvent.setup();
  render(<EntryDialog onClose={() => {}} onSaved={() => {}} />);
  fireEvent.change(screen.getByLabelText("日期"), {
    target: { value: "2026-10-01" },
  });
  await user.type(screen.getByLabelText("项目"), "布袋");
  await user.type(screen.getByLabelText("单价（元）"), "20");
  await user.type(screen.getByLabelText("单位直接成本（元）"), "8");
  await user.type(screen.getByLabelText("客户（可选）"), " 林小姐 ");
  await user.type(screen.getByLabelText("供应商 / 收款方（可选）"), " 布料厂 ");
  fireEvent.change(screen.getByLabelText("收款到期日（可选）"), {
    target: { value: "2026-10-10" },
  });
  fireEvent.change(screen.getByLabelText("付款到期日（可选）"), {
    target: { value: "2026-10-15" },
  });
  await user.click(screen.getByRole("button", { name: "保存记录" }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({
    customer: "林小姐",
    supplier: "布料厂",
    receivable_due_date: "2026-10-10",
    payable_due_date: "2026-10-15",
  });
  await user.click(screen.getByRole("radio", { name: "费用" }));
  expect(screen.queryByLabelText("客户（可选）")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("金额（元）"), "10");
  await user.click(screen.getByRole("button", { name: "保存记录" }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({
    supplier: "布料厂",
    payable_due_date: "2026-10-15",
  });
  expect(sent[1]).not.toHaveProperty("customer");
  expect(sent[1]).not.toHaveProperty("receivable_due_date");
});
it("丢失保存响应后锁住原内容，用同一编号重试，新操作使用新编号", async () => {
  const sent: RequestInit[] = [];
  let saved = 0;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(init);
    if (sent.length === 1) throw new TypeError("response lost");
    return new Response("{}", { status: 201 });
  });
  const user = userEvent.setup();
  const mounted = render(
    <EntryDialog onClose={() => {}} onSaved={() => saved++} />,
  );
  await user.click(screen.getByRole("radio", { name: "费用" }));
  await user.type(screen.getByLabelText("项目"), "房租");
  await user.type(screen.getByLabelText("金额（元）"), "2000");
  await user.click(screen.getByRole("button", { name: "保存记录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法确认");
  expect(screen.getByLabelText("项目")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "重试原提交" }));
  await waitFor(() => expect(saved).toBe(1));
  const firstKey = new Headers(sent[0].headers).get("Idempotency-Key");
  expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(new Headers(sent[1].headers).get("Idempotency-Key")).toBe(firstKey);
  expect(sent[1].body).toBe(sent[0].body);
  mounted.unmount();
  render(<EntryDialog onClose={() => {}} onSaved={() => saved++} />);
  await user.click(screen.getByRole("radio", { name: "费用" }));
  await user.type(screen.getByLabelText("项目"), "房租");
  await user.type(screen.getByLabelText("金额（元）"), "2000");
  await user.click(screen.getByRole("button", { name: "保存记录" }));
  await waitFor(() => expect(saved).toBe(2));
  expect(new Headers(sent[2].headers).get("Idempotency-Key")).not.toBe(
    firstKey,
  );
});
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
