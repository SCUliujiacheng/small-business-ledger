import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { sale } from "../test/fixtures";
import { PaymentForm } from "./PaymentForm";
afterEach(() => vi.unstubAllGlobals());
it("收付款响应丢失后仍可按原编号重试，不因已刷新的余额而被本地拦截", async () => {
  const sent: RequestInit[] = [];
  let saved = 0;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(init);
    if (sent.length === 1) throw new TypeError("response lost");
    return new Response("{}", { status: 201 });
  });
  const user = userEvent.setup();
  const view = render(
    <PaymentForm
      entries={[sale]}
      initialEntryId={sale.id}
      onSaved={() => saved++}
    />,
  );
  await user.type(screen.getByLabelText("金额（元）"), "50");
  await user.click(screen.getByRole("button", { name: "保存流水" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法确认");
  expect(screen.getByLabelText("金额（元）")).toBeDisabled();
  view.rerender(
    <PaymentForm
      entries={[{ ...sale, received_cents: 20000 }]}
      initialEntryId={sale.id}
      onSaved={() => saved++}
    />,
  );
  await user.click(screen.getByRole("button", { name: "重试原提交" }));
  await waitFor(() => expect(saved).toBe(1));
  const key = new Headers(sent[0].headers).get("Idempotency-Key");
  expect(key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(new Headers(sent[1].headers).get("Idempotency-Key")).toBe(key);
  expect(sent[1].body).toBe(sent[0].body);
  await user.selectOptions(screen.getByLabelText("流水种类"), "capital_in");
  await user.type(screen.getByLabelText("金额（元）"), "50");
  await user.click(screen.getByRole("button", { name: "保存流水" }));
  await waitFor(() => expect(saved).toBe(2));
  expect(new Headers(sent[2].headers).get("Idempotency-Key")).not.toBe(key);
});
it("选择单据不会悄悄改写用户已填写的实际收付日期", async () => {
  const user = userEvent.setup();
  render(<PaymentForm entries={[sale]} onSaved={() => {}} />);
  fireEvent.change(screen.getByLabelText("实际收付日期"), {
    target: { value: "2026-09-30" },
  });
  await user.selectOptions(screen.getByLabelText("关联单据"), "sale-1");
  expect(screen.getByLabelText("实际收付日期")).toHaveValue("2026-09-30");
});
it("关联收款显示余额并阻止超额提交", async () => {
  let sent = false;
  vi.stubGlobal("fetch", async () => {
    sent = true;
    return new Response("{}");
  });
  const user = userEvent.setup();
  render(
    <PaymentForm
      entries={[sale]}
      onSaved={() => {}}
      initialEntryId="sale-1"
      initialKind="receipt"
    />,
  );
  expect(screen.getByText(/剩余可收/)).toHaveTextContent("50.00");
  await user.type(screen.getByLabelText("金额（元）"), "50.01");
  await user.click(screen.getByRole("button", { name: "保存流水" }));
  expect(screen.getByRole("alert")).toHaveTextContent("超过");
  expect(sent).toBe(false);
});
it("投入资金不关联单据且使用字符串金额", async () => {
  let body: any;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response("{}", { status: 201 });
  });
  const user = userEvent.setup();
  let saved = false;
  render(
    <PaymentForm
      entries={[sale]}
      onSaved={() => {
        saved = true;
      }}
    />,
  );
  await user.selectOptions(screen.getByLabelText("流水种类"), "capital_in");
  expect(screen.queryByLabelText("关联单据")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("金额（元）"), "500.20");
  await user.click(screen.getByRole("button", { name: "保存流水" }));
  await waitFor(() => expect(saved).toBe(true));
  expect(body).toMatchObject({
    kind: "capital_in",
    entry_id: null,
    amount: "500.20",
  });
});
