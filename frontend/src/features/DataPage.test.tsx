import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { emptyMeta } from "../test/fixtures";
import { DataPage } from "./DataPage";
afterEach(() => vi.unstubAllGlobals());
it("导入预览展示业务金额，供确认前核对", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          rows: [
            {
              kind: "sale",
              date: "2026-10-01",
              description: "帆布袋",
              category: "商品",
              quantity: 3,
              unit_price: "0.29",
              unit_cost: "0.07",
              note: "",
              external_id: "bag-1",
            },
          ],
          count: 1,
          errors: [],
        }),
      ),
  );
  const user = userEvent.setup();
  render(<DataPage meta={emptyMeta} onChanged={() => {}} />);
  await user.upload(
    screen.getByLabelText("选择 CSV 文件"),
    new File(["external_id,kind\nbag-1,sale"], "sales.csv", {
      type: "text/csv",
    }),
  );
  await user.click(screen.getByRole("button", { name: "预检文件" }));
  expect(await screen.findByText("¥0.87")).toBeInTheDocument();
  expect(screen.getByText("¥0.21")).toBeInTheDocument();
});
it("CSV预检错误显示行号且不允许提交", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          rows: [],
          count: 0,
          errors: [{ row: 3, message: "导入编号重复" }],
        }),
      ),
  );
  const user = userEvent.setup();
  render(<DataPage meta={emptyMeta} onChanged={() => {}} />);
  await user.upload(
    screen.getByLabelText("选择 CSV 文件"),
    new File(["external_id,kind\na,sale"], "sales.csv", { type: "text/csv" }),
  );
  await user.click(screen.getByRole("button", { name: "预检文件" }));
  expect(await screen.findByText(/第 3 行/)).toHaveTextContent("导入编号重复");
  expect(
    screen.queryByRole("button", { name: /确认导入/ }),
  ).not.toBeInTheDocument();
});
it("非空账本不允许载入示例或恢复备份", () => {
  render(
    <DataPage meta={{ ...emptyMeta, entry_count: 1 }} onChanged={() => {}} />,
  );
  expect(screen.getByRole("button", { name: "载入示例账本" })).toBeDisabled();
  expect(screen.getByLabelText("选择 JSON 备份")).toBeDisabled();
});
