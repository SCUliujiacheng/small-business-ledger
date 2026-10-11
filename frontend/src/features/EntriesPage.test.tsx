import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { sale } from "../test/fixtures";
import { EntriesPage } from "./EntriesPage";
it("默认隐藏作废记录，搜索与作废筛选同时生效", async () => {
  const user = userEvent.setup();
  render(
    <EntriesPage
      entries={[
        sale,
        {
          ...sale,
          id: "voided",
          description: "错误订单",
          voided_at: "2026-10-02T00:00:00Z",
          void_reason: "重复",
        },
      ]}
      onPayment={() => {}}
      onVoid={() => {}}
    />,
  );
  expect(screen.queryByText("错误订单")).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("查看作废记录"));
  expect(screen.getByText("错误订单")).toBeInTheDocument();
  await user.type(screen.getByLabelText("检索项目或分类"), "错误");
  expect(screen.queryByText("帆布袋")).not.toBeInTheDocument();
  expect(screen.getByText("错误订单")).toBeInTheDocument();
});
