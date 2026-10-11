import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { sale } from "../test/fixtures";
import { PaymentForm } from "./PaymentForm";
afterEach(() => vi.unstubAllGlobals());
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
