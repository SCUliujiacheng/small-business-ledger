import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { emptyMeta, sale, summary } from "./test/fixtures";
import App from "./App";
afterEach(() => vi.unstubAllGlobals());
it("欠款按截止日筛选与导出，登记使用当前余额，历史已结清项不可再收款", async () => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url);
    const query = new URL(url, "http://127.0.0.1").searchParams;
    const report = {
      as_of: query.get("as_of"),
      receivable_cents: 23000,
      payable_cents: 8000,
      overdue_receivable_cents: 20000,
      overdue_payable_cents: 0,
      items: [
        {
          entry_id: sale.id,
          kind: "receipt",
          date: sale.date,
          description: sale.description,
          category: sale.category,
          counterparty: "林小姐",
          due_date: "2026-10-02",
          outstanding_cents: 20000,
          original_cents: 20000,
          settled_cents: 0,
          overdue_days: 3,
          status: "overdue",
        },
        {
          entry_id: sale.id,
          kind: "cost_payment",
          date: sale.date,
          description: sale.description,
          category: sale.category,
          counterparty: "布料厂",
          due_date: null,
          outstanding_cents: 8000,
          original_cents: 8000,
          settled_cents: 0,
          overdue_days: 0,
          status: "no_due_date",
        },
        {
          entry_id: "settled",
          kind: "receipt",
          date: sale.date,
          description: "后来结清订单",
          category: sale.category,
          counterparty: "陈女士",
          due_date: "2026-10-10",
          outstanding_cents: 3000,
          original_cents: 3000,
          settled_cents: 0,
          overdue_days: 0,
          status: "upcoming",
        },
      ],
    };
    return new Response(
      JSON.stringify(
        url.includes("/outstanding")
          ? report
          : url.includes("/meta")
            ? { ...emptyMeta, entry_count: 2 }
            : url.includes("/summary")
              ? { ...summary, start: query.get("start"), end: query.get("end") }
              : url.includes("/entries")
                ? {
                    items: [
                      sale,
                      {
                        ...sale,
                        id: "settled",
                        description: "后来结清订单",
                        revenue_cents: 3000,
                        received_cents: 3000,
                      },
                    ],
                  }
                : { items: [] },
      ),
    );
  });
  const user = userEvent.setup();
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "记一笔" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "欠款清单" }));
  expect(await screen.findByText("林小姐")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("欠款截止日期"), {
    target: { value: "2026-10-05" },
  });
  await user.click(screen.getByRole("button", { name: "查看欠款" }));
  await waitFor(() =>
    expect(requested).toContain("/api/outstanding?as_of=2026-10-05"),
  );
  expect(
    await screen.findByRole("link", { name: "导出此截止日全部欠款 CSV" }),
  ).toHaveAttribute("href", "/api/export/outstanding.csv?as_of=2026-10-05");
  const settledRow = screen.getByText("后来结清订单").closest("tr")!;
  expect(
    within(settledRow).getByRole("button", { name: "登记收款" }),
  ).toBeDisabled();
  expect(within(settledRow).getByText(/当前已结清/)).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("收付方向"), "payable");
  expect(screen.getByText("布料厂")).toBeInTheDocument();
  expect(screen.queryByText("林小姐")).not.toBeInTheDocument();
  expect(screen.getByText(/筛选合计/)).toHaveTextContent("未付 ¥80.00");
  await user.selectOptions(screen.getByLabelText("收付方向"), "receivable");
  await user.click(screen.getByLabelText("只看逾期"));
  expect(screen.queryByText("后来结清订单")).not.toBeInTheDocument();
  expect(screen.getByText(/筛选合计/)).toHaveTextContent("未收 ¥200.00");
  await user.type(screen.getByRole("searchbox"), "布料厂");
  expect(screen.getByText("没有符合条件的欠款")).toBeInTheDocument();
  await user.clear(screen.getByRole("searchbox"));
  await user.click(screen.getByRole("button", { name: "登记收款" }));
  expect(screen.getByText(/剩余可收/)).toHaveTextContent("¥50.00");
  await user.type(screen.getByLabelText("金额（元）"), "200");
  await user.click(screen.getByRole("button", { name: "保存流水" }));
  expect(screen.getByRole("alert")).toHaveTextContent("超过剩余");
});
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
