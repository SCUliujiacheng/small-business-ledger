import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { sale } from "../test/fixtures";
import { OutstandingPage } from "./OutstandingPage";

afterEach(() => vi.unstubAllGlobals());

it("历史截止日到期状态明确指向当日，不误写成现实中的今天", async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    const asOf = new URL(url, "http://127.0.0.1").searchParams.get("as_of");
    return new Response(
      JSON.stringify({
        as_of: asOf,
        receivable_cents: 5000,
        payable_cents: 0,
        overdue_receivable_cents: 0,
        overdue_payable_cents: 0,
        items: [
          {
            entry_id: sale.id,
            kind: "receipt",
            date: sale.date,
            description: sale.description,
            category: sale.category,
            counterparty: "林小姐",
            due_date: asOf,
            outstanding_cents: 5000,
            original_cents: 20000,
            settled_cents: 15000,
            overdue_days: 0,
            status: "due_today",
          },
        ],
      }),
    );
  });
  const user = userEvent.setup();
  render(
    <OutstandingPage
      entries={[sale]}
      revision={0}
      entriesLoading={false}
      onPayment={() => {}}
    />,
  );
  await screen.findByText("林小姐");
  fireEvent.change(screen.getByLabelText("欠款截止日期"), {
    target: { value: "2026-10-02" },
  });
  await user.click(screen.getByRole("button", { name: "查看欠款" }));
  expect(await screen.findByText("当日到期")).toBeInTheDocument();
  expect(screen.queryByText("今天到期")).not.toBeInTheDocument();
});
