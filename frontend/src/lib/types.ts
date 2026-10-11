export type EntryKind = "sale" | "expense";
export type PaymentKind =
  "receipt" | "cost_payment" | "expense_payment" | "capital_in" | "capital_out";
export interface Entry {
  id: string;
  kind: EntryKind;
  date: string;
  description: string;
  category: string;
  customer: string;
  supplier: string;
  receivable_due_date: string | null;
  payable_due_date: string | null;
  quantity: number | null;
  unit_price_cents: number | null;
  unit_cost_cents: number | null;
  revenue_cents: number;
  cost_cents: number;
  amount_cents: number;
  note: string;
  external_id: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  received_cents: number;
  paid_cents: number;
}
export interface Payment {
  id: string;
  kind: PaymentKind;
  entry_id: string | null;
  date: string;
  amount_cents: number;
  note: string;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}
export interface Meta {
  name: string;
  currency: string;
  demo: boolean;
  entry_count: number;
  payment_count: number;
}
export interface Monthly {
  month: string;
  revenue_cents: number;
  cost_cents: number;
  expense_cents: number;
  profit_cents: number;
  cash_in_cents: number;
  cash_out_cents: number;
}
export interface Summary {
  start: string;
  end: string;
  revenue_cents: number;
  cost_cents: number;
  gross_profit_cents: number;
  expense_cents: number;
  profit_cents: number;
  cash_in_cents: number;
  cash_out_cents: number;
  net_cash_cents: number;
  balance_cents: number;
  receivable_cents: number;
  payable_cents: number;
  monthly: Monthly[];
  entry_count: number;
}
export interface EntryInput {
  kind: EntryKind;
  date: string;
  description: string;
  category: string;
  customer?: string;
  supplier?: string;
  receivable_due_date?: string | null;
  payable_due_date?: string | null;
  quantity?: number;
  unit_price?: string;
  unit_cost?: string;
  amount?: string;
  note: string;
  external_id?: string;
}
export interface ImportPreview {
  rows: EntryInput[];
  count: number;
  errors: { row: number; message: string }[];
}
export interface OutstandingItem {
  entry_id: string;
  kind: "receipt" | "cost_payment" | "expense_payment";
  date: string;
  description: string;
  category: string;
  counterparty: string;
  due_date: string | null;
  outstanding_cents: number;
  original_cents: number;
  settled_cents: number;
  overdue_days: number;
  status: "overdue" | "due_today" | "upcoming" | "no_due_date";
}
export interface OutstandingReport {
  as_of: string;
  receivable_cents: number;
  payable_cents: number;
  overdue_receivable_cents: number;
  overdue_payable_cents: number;
  items: OutstandingItem[];
}
export interface LocalBackup {
  filename: string;
  created_at: string;
  size_bytes: number;
}
export interface LocalBackups {
  directory: string;
  retention: number;
  items: LocalBackup[];
}
export const paymentLabels: Record<PaymentKind, string> = {
  receipt: "销售收款",
  cost_payment: "支付直接成本",
  expense_payment: "支付日常费用",
  capital_in: "资金投入",
  capital_out: "资金取出",
};
