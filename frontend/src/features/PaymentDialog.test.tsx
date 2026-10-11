import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PaymentDialog } from "./PaymentDialog";
import { sale } from "../test/fixtures";
afterEach(() => vi.unstubAllGlobals());
it("收付款提交中不能关闭对话框，失败后保留输入并恢复关闭操作", async () => {
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  let closed = false;
  render(
    <PaymentDialog
      entries={[sale]}
      entryId={sale.id}
      kind="receipt"
      onClose={() => {
        closed = true;
      }}
      onSaved={() => {}}
    />,
  );
  await user.type(screen.getByLabelText("金额（元）"), "10.00");
  await user.click(screen.getByRole("button", { name: "保存流水" }));
  expect(screen.getByRole("button", { name: "关闭对话框" })).toBeDisabled();
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { cancelable: true }),
  );
  expect(closed).toBe(false);
  await act(async () => {
    finish?.(
      new Response(JSON.stringify({ detail: "服务器暂时不可用" }), {
        status: 503,
      }),
    );
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "服务器暂时不可用",
  );
  expect(screen.getByLabelText("金额（元）")).toHaveValue("10.00");
  expect(screen.getByRole("button", { name: "关闭对话框" })).toBeEnabled();
});
