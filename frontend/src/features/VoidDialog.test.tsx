import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { VoidDialog } from "./VoidDialog";
afterEach(() => vi.unstubAllGlobals());
it("作废冲突保留原因，提示先处理关联流水", async () => {
  let body: unknown;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ detail: "请先作废关联流水" }), {
      status: 409,
    });
  });
  const user = userEvent.setup();
  render(
    <VoidDialog
      target={{ resource: "entries", id: "sale-1", description: "帆布袋" }}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  await user.type(screen.getByLabelText("作废原因"), "数量录入有误");
  await user.click(screen.getByRole("button", { name: "确认作废" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "请先作废关联流水",
  );
  expect(screen.getByLabelText("作废原因")).toHaveValue("数量录入有误");
  expect(body).toEqual({ reason: "数量录入有误" });
});
