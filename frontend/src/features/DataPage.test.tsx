import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyMeta } from "../test/fixtures";
import { DataPage } from "./DataPage";

it("手机版显示实际的 16 MiB 备份导入限制", async () => {
  const marker = document.createElement("meta");
  marker.name = "ledger-runtime";
  marker.content = "mobile";
  document.head.append(marker);
  try {
    render(
      <DataPage
        meta={{
          name: "小本账",
          currency: "CNY",
          demo: false,
          entry_count: 0,
          payment_count: 0,
        }}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/手机备份导入上限 16 MiB/)).toBeInTheDocument();
  } finally {
    marker.remove();
  }
});
afterEach(() => vi.unstubAllGlobals());
const backups = {
  directory: "C:\\ledger.db.backups",
  retention: 30,
  items: [
    {
      filename: "ledger-auto-20261001-001.json",
      created_at: "2026-10-01T12:00:00Z",
      size_bytes: 1024,
    },
  ],
};
beforeEach(() =>
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(backups))),
);
it("备份显示目录和保留数，生成失败保留历史下载与当前完整备份入口", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      attempts++;
      return new Response(
        JSON.stringify({ detail: "备份目录无法写入，账目未改变" }),
        { status: 503 },
      );
    }
    return new Response(JSON.stringify(backups));
  });
  const user = userEvent.setup();
  render(<DataPage meta={emptyMeta} onChanged={() => {}} />);
  expect(await screen.findByText(backups.directory)).toBeInTheDocument();
  expect(screen.getByText(/保留最近 30 份/)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /ledger-auto-20261001-001.json/ }),
  ).toHaveAttribute("href", "/api/local-backups/ledger-auto-20261001-001.json");
  await user.click(screen.getByRole("button", { name: "生成当前快照" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "备份目录无法写入",
  );
  expect(attempts).toBe(1);
  expect(
    screen.getByRole("link", { name: "下载完整 JSON 备份" }),
  ).toHaveAttribute("href", "/api/backup");
  expect(
    screen.getByRole("link", { name: /ledger-auto-20261001-001.json/ }),
  ).toBeInTheDocument();
});
it("手动生成当前快照后刷新列表并展示新下载", async () => {
  let created = false;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      created = true;
      return new Response(
        JSON.stringify({
          filename: "ledger-auto-current.json",
          created_at: "2026-10-02T12:00:00Z",
          size_bytes: 2048,
        }),
      );
    }
    return new Response(
      JSON.stringify({
        ...backups,
        items: created
          ? [
              {
                filename: "ledger-auto-current.json",
                created_at: "2026-10-02T12:00:00Z",
                size_bytes: 2048,
              },
              ...backups.items,
            ]
          : backups.items,
      }),
    );
  });
  const user = userEvent.setup();
  render(<DataPage meta={emptyMeta} onChanged={() => {}} />);
  await screen.findByText(backups.directory);
  await user.click(screen.getByRole("button", { name: "生成当前快照" }));
  expect(
    await screen.findByRole("link", { name: /ledger-auto-current.json/ }),
  ).toHaveAttribute("href", "/api/local-backups/ledger-auto-current.json");
});
it("导入预览展示业务金额，供确认前核对", async () => {
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("local-backups")
            ? backups
            : {
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
              },
        ),
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
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("local-backups")
            ? backups
            : {
                rows: [],
                count: 0,
                errors: [{ row: 3, message: "导入编号重复" }],
              },
        ),
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
it("非空账本不允许载入示例或恢复备份", async () => {
  render(
    <DataPage meta={{ ...emptyMeta, entry_count: 1 }} onChanged={() => {}} />,
  );
  expect(screen.getByRole("button", { name: "载入示例账本" })).toBeDisabled();
  expect(screen.getByLabelText("选择 JSON 备份")).toBeDisabled();
  await waitFor(() =>
    expect(screen.getByText(backups.directory)).toBeInTheDocument(),
  );
});
