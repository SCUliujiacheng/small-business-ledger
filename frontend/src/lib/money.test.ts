import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney, saleTotals, validateRange } from "./money";
describe("金额与范围校验", () => {
  it.each([
    ["0.29", 29],
    ["100000000.00", 10000000000],
    ["12.3", 1230],
    ["0", 0],
  ])("精确转换 %s 为整数分", (value, want) =>
    expect(parseMoney(value)).toBe(want),
  );
  it.each(["1.001", "1e3", "-1", "", "100000000.01"])(
    "拒绝不合法金额 %s",
    (value) => expect(() => parseMoney(value)).toThrow(),
  );
  it("销售按整数数量精确计算两个合计", () =>
    expect(saleTotals("3", "0.29", "0.07")).toEqual({ revenue: 87, cost: 21 }));
  it("拒绝超过单条上限的总价", () =>
    expect(() => saleTotals("2", "100000000", "0")).toThrow());
  it("拒绝小数数量", () =>
    expect(() => saleTotals("1.5", "20", "2")).toThrow());
  it("格式化负数分和千位且不丢分", () =>
    expect(formatMoney(-123456789)).toBe("-1,234,567.89"));
  it("拒绝颠倒及超长的日期范围", () => {
    expect(validateRange("2026-10-31", "2026-10-01")).not.toBe("");
    expect(validateRange("2025-01-01", "2026-12-31")).not.toBe("");
  });
  it("允许完整闰年并拒绝不存在的日期", () => {
    expect(validateRange("2024-01-01", "2024-12-31")).toBe("");
    expect(validateRange("2026-02-30", "2026-03-01")).not.toBe("");
  });
});
