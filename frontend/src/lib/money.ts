const MAX_CENTS = 10_000_000_000n;
export function parseMoney(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))
    throw new Error("金额请填写非负数字，最多两位小数");
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > MAX_CENTS) throw new Error("单条金额不能超过 100,000,000 元");
  return Number(cents);
}
export function formatMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("金额必须是安全整数分");
  const raw = BigInt(cents),
    absolute = raw < 0n ? -raw : raw;
  const whole = (absolute / 100n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${raw < 0n ? "-" : ""}${whole}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
export function saleTotals(
  quantity: string,
  price: string,
  cost: string,
): { revenue: number; cost: number } {
  if (
    !/^\d+$/.test(quantity) ||
    BigInt(quantity) < 1n ||
    BigInt(quantity) > 1_000_000n
  )
    throw new Error("数量须为 1 至 1,000,000 的整数");
  const revenue = BigInt(quantity) * BigInt(parseMoney(price)),
    totalCost = BigInt(quantity) * BigInt(parseMoney(cost));
  if (revenue > MAX_CENTS || totalCost > MAX_CENTS)
    throw new Error("单条销售额或直接成本不能超过 100,000,000 元");
  return { revenue: Number(revenue), cost: Number(totalCost) };
}
export function validDate(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "2000-01-01" ||
    value > "2100-12-31"
  )
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function validateRange(start: string, end: string): string {
  if (!validDate(start) || !validDate(end))
    return "请选择 2000 至 2100 年内的有效日期";
  if (start > end) return "开始日期不能晚于截止日期";
  if ((Date.parse(end) - Date.parse(start)) / 86400000 > 365)
    return "一次最多查看 366 天，请缩小日期范围";
  return "";
}
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function currentMonth() {
  const today = new Date();
  return {
    start: localDate(new Date(today.getFullYear(), today.getMonth(), 1)),
    end: localDate(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
  };
}
