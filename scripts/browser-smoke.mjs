// Real-browser workflows against temporary SQLite ledgers. Responses come from
// the real server; one committed response is deliberately dropped to test retry.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend/package.json'));
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const work = await mkdtemp(path.join(tmpdir(), 'small-ledger-smoke-'));
const screenshots = process.env.LEDGER_SCREENSHOT_DIR || path.join(work, 'screenshots');
await mkdir(screenshots, { recursive: true });
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
const browser = await chromium.launch({ headless: true, executablePath: chrome });
const servers = [];
const errors = [];
// Only the explicitly injected lost response may produce this network error.
// Match its exact page, endpoint and message; unexpected errors still fail.
const expectedNetworkErrors = [];

async function start(name) {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(python, ['-m', 'uvicorn', 'small_business_ledger.app:create_app', '--factory',
    '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root, env: { ...process.env, LEDGER_DB_PATH: path.join(work, `${name}.db`), LEDGER_DEV: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  servers.push(child);
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/meta`)).ok) return base; } catch { /* startup */ }
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become ready: ${output}`);
}

async function open(base, width = 1505, height = 1045) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (!['error', 'warning'].includes(message.type())) return;
    const expected = expectedNetworkErrors.find(item => item.page === page &&
      item.url === message.location().url && item.message === message.text() && item.observed === 0);
    if (expected) expected.observed++;
    else errors.push(`${message.text()} (${message.location().url})`);
  });
  await page.goto(base);
  await page.getByRole('heading', { name: '经营概览', exact: true }).waitFor();
  assert.equal(page.url(), `${base}/`);
  assert.match(await page.title(), /小本账/);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  return page;
}

async function tab(page, name) {
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}

async function summary(base) {
  return (await fetch(`${base}/api/summary?start=2026-10-01&end=2026-10-31`)).json();
}

async function downloadJson(page) {
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载完整 JSON 备份' }).click();
  const item = await download;
  return readFile(await item.path(), 'utf8');
}

async function chooseCutoff(page, date) {
  await page.getByLabel('欠款截止日期').fill(date);
  const loaded = page.waitForResponse(response =>
    response.url().endsWith(`/api/outstanding?as_of=${date}`) && response.status() === 200);
  await page.getByRole('button', { name: '查看欠款', exact: true }).click();
  await loaded;
  await page.getByRole('heading', { name: `截至 ${date} · 全部欠款`, exact: true }).waitFor();
}

async function downloadFile(page, link) {
  const pending = page.waitForEvent('download');
  await link.click();
  const item = await pending;
  return readFile(await item.path(), 'utf8');
}

async function dailyUseFlow() {
  const base = await start('daily-v02');
  const page = await open(base);
  const transmitted = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/(entries|payments)$/.test(request.url())) {
      transmitted.push({ url: request.url(), key: request.headers()['idempotency-key'], body: request.postData() });
    }
  });
  await page.getByText(/还没有记录/).waitFor();
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await dialog.getByLabel('日期', { exact: true }).fill('2026-10-01');
  await dialog.getByLabel('项目', { exact: true }).fill('虚构订单 · 帆布袋团购');
  await dialog.getByLabel('数量', { exact: true }).fill('10');
  await dialog.getByLabel('单价（元）', { exact: true }).fill('100.00');
  await dialog.getByLabel('单位直接成本（元）', { exact: true }).fill('60.00');
  await dialog.getByLabel('客户（可选）', { exact: true }).fill('虚构客户 · 林记小铺');
  await dialog.getByLabel('供应商 / 收款方（可选）', { exact: true }).fill('虚构供应商 · 南街工坊');
  await dialog.getByLabel('收款到期日（可选）', { exact: true }).fill('2026-10-05');
  await dialog.getByLabel('付款到期日（可选）', { exact: true }).fill('2026-10-10');
  await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const sale = (await (await fetch(`${base}/api/entries`)).json()).items[0];
  assert.equal(sale.customer, '虚构客户 · 林记小铺');
  assert.equal(sale.supplier, '虚构供应商 · 南街工坊');
  assert.equal(sale.receivable_due_date, '2026-10-05');
  assert.equal(sale.payable_due_date, '2026-10-10');

  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await dialog.getByRole('radio', { name: '费用', exact: true }).check();
  assert.equal(await dialog.getByLabel('客户（可选）', { exact: true }).count(), 0);
  assert.equal(await dialog.getByLabel('收款到期日（可选）', { exact: true }).count(), 0);
  await dialog.getByLabel('日期', { exact: true }).fill('2026-10-02');
  await dialog.getByLabel('项目', { exact: true }).fill('虚构费用 · 摊位租金');
  await dialog.getByLabel('金额（元）', { exact: true }).fill('120.00');
  await dialog.getByLabel('供应商 / 收款方（可选）', { exact: true }).fill('虚构摊位方 · 周末市集');
  await dialog.getByLabel('付款到期日（可选）', { exact: true }).fill('2026-10-07');
  await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const expense = (await (await fetch(`${base}/api/entries`)).json()).items.find(item => item.kind === 'expense');
  assert.equal(expense.customer, '');
  assert.equal(expense.receivable_due_date, null);
  assert.equal(expense.supplier, '虚构摊位方 · 周末市集');
  assert.equal(expense.payable_due_date, '2026-10-07');

  await tab(page, '欠款清单');
  await page.getByRole('heading', { name: '欠款明细', exact: true }).waitFor();
  await chooseCutoff(page, '2026-10-08');
  const report = await (await fetch(`${base}/api/outstanding?as_of=2026-10-08`)).json();
  const sameCutoff = await (await fetch(`${base}/api/summary?start=2026-10-01&end=2026-10-08`)).json();
  assert.equal(report.items.length, 3);
  assert.equal(report.receivable_cents, 100000);
  assert.equal(report.payable_cents, 72000);
  assert.equal(report.overdue_receivable_cents, 100000);
  assert.equal(report.overdue_payable_cents, 12000);
  assert.equal(report.receivable_cents, sameCutoff.receivable_cents);
  assert.equal(report.payable_cents, sameCutoff.payable_cents);
  await expect(page.getByText('逾期 3 天', { exact: true })).toBeVisible();
  await expect(page.getByText('逾期 1 天', { exact: true })).toBeVisible();
  await page.getByLabel('收付方向').selectOption('payable');
  await expect(page.getByText('虚构客户 · 林记小铺', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/筛选合计/)).toContainText('未付 ¥720.00');
  await page.getByLabel('只看逾期', { exact: true }).check();
  await expect(page.getByText('虚构供应商 · 南街工坊', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/筛选合计/)).toContainText('未付 ¥120.00');
  await page.getByLabel('检索欠款', { exact: true }).fill('南街工坊');
  await expect(page.getByText('没有符合条件的欠款', { exact: true })).toBeVisible();
  await page.getByLabel('只看逾期', { exact: true }).uncheck();
  await expect(page.getByText('虚构供应商 · 南街工坊', { exact: true })).toBeVisible();
  await expect(page.getByText(/筛选合计/)).toContainText('未付 ¥600.00');
  // Export is explicitly full-cutoff data even while visible rows are filtered.
  const csvLink = page.getByRole('link', { name: '导出此截止日全部欠款 CSV', exact: true });
  await expect(csvLink).toHaveAttribute('href', '/api/export/outstanding.csv?as_of=2026-10-08');
  const csv = await downloadFile(page, csvLink);
  assert.match(csv, /虚构客户 · 林记小铺/);
  assert.match(csv, /虚构供应商 · 南街工坊/);
  assert.match(csv, /虚构摊位方 · 周末市集/);
  await page.getByLabel('检索欠款', { exact: true }).fill('');
  await page.getByLabel('收付方向').selectOption('all');
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  await page.getByRole('heading', { name: '欠款清单', exact: true }).click();
  await page.screenshot({ path: path.join(screenshots, 'outstanding.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: path.join(screenshots, 'outstanding-mobile.png'), fullPage: true });
  const tableViewport = page.locator('.table-scroll');
  await tableViewport.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  assert.ok(await tableViewport.evaluate(element => element.scrollLeft > 0), 'Mobile debt table scrolls horizontally to payment actions');
  await page.screenshot({ path: path.join(screenshots, 'outstanding-mobile-actions.png'), fullPage: true });
  await tableViewport.evaluate(element => { element.scrollLeft = 0; });
  await page.setViewportSize({ width: 1505, height: 1045 });

  const saleRow = page.getByRole('row').filter({ hasText: '虚构客户 · 林记小铺' });
  await saleRow.getByRole('button', { name: '登记收款', exact: true }).click();
  await expect(dialog.getByText(/剩余可收/)).toContainText('¥1,000.00');
  await dialog.getByLabel('实际收付日期', { exact: true }).fill('2026-10-09');
  await dialog.getByLabel('金额（元）', { exact: true }).fill('200.00');
  await dialog.getByRole('button', { name: '保存流水', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await expect(saleRow.getByText('当前可收 ¥800.00', { exact: true })).toBeVisible();
  assert.equal((await (await fetch(`${base}/api/outstanding?as_of=2026-10-08`)).json()).receivable_cents, 100000);
  await saleRow.getByRole('button', { name: '登记收款', exact: true }).click();
  await expect(dialog.getByText(/剩余可收/)).toContainText('¥800.00');
  await dialog.getByLabel('实际收付日期', { exact: true }).fill('2026-10-10');
  await dialog.getByLabel('金额（元）', { exact: true }).fill('800.00');
  await dialog.getByRole('button', { name: '保存流水', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await expect(saleRow.getByRole('button', { name: '登记收款', exact: true })).toBeDisabled();
  await expect(saleRow.getByText('当前已结清，历史欠款仍保留', { exact: true })).toBeVisible();
  assert.equal((await (await fetch(`${base}/api/outstanding?as_of=2026-10-08`)).json()).receivable_cents, 100000);
  assert.equal((await (await fetch(`${base}/api/entries`)).json()).items.find(item => item.id === sale.id).received_cents, 100000);
  await page.screenshot({ path: path.join(screenshots, 'outstanding-historical-settled.png'), fullPage: true });
  await chooseCutoff(page, '2026-10-10');
  await expect(page.getByText('虚构客户 · 林记小铺', { exact: true })).toHaveCount(0);
  await expect(page.getByText('当日到期', { exact: true })).toBeVisible();

  // Forward this real POST to the server, verify that it committed, then drop
  // only its response. The retry must replay the same key and body, not insert.
  let committedBeforeLoss = null;
  let dropNextResponse = true;
  const networkFault = { page, url: `${base}/api/entries`, message: 'Failed to load resource: net::ERR_FAILED', observed: 0 };
  await page.route(`${base}/api/entries`, async route => {
    if (route.request().method() === 'POST' && dropNextResponse) {
      dropNextResponse = false;
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      committedBeforeLoss = await response.json();
      expectedNetworkErrors.push(networkFault);
      await route.abort('failed');
    } else await route.continue();
  });
  async function fillRetryExpense() {
    await page.getByRole('button', { name: '记一笔', exact: true }).click();
    await dialog.getByRole('radio', { name: '费用', exact: true }).check();
    await dialog.getByLabel('日期', { exact: true }).fill('2026-10-11');
    await dialog.getByLabel('项目', { exact: true }).fill('虚构费用 · 响应中断验证');
    await dialog.getByLabel('金额（元）', { exact: true }).fill('23.45');
    await dialog.getByLabel('供应商 / 收款方（可选）', { exact: true }).fill('虚构收款方 · 测试商户');
    await dialog.getByLabel('付款到期日（可选）', { exact: true }).fill('2026-10-15');
  }
  await fillRetryExpense();
  const firstAttemptIndex = transmitted.length;
  await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: /无法确认上次是否已保存/ }).waitFor();
  await expect(dialog.getByLabel('项目', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('金额（元）', { exact: true })).toBeDisabled();
  assert.ok(committedBeforeLoss?.id);
  assert.equal((await (await fetch(`${base}/api/entries`)).json()).items.length, 3);
  await dialog.getByRole('button', { name: '重试原提交', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const firstAttempt = transmitted[firstAttemptIndex];
  const retryAttempt = transmitted[firstAttemptIndex + 1];
  assert.match(firstAttempt.key, /^[0-9a-f-]{36}$/i);
  assert.equal(firstAttempt.key, retryAttempt.key);
  assert.equal(firstAttempt.body, retryAttempt.body);
  assert.equal((await (await fetch(`${base}/api/entries`)).json()).items.length, 3);
  assert.equal(networkFault.observed, 1);
  await page.unroute(`${base}/api/entries`);
  // Identical values entered deliberately after success are a separate operation.
  await fillRetryExpense();
  await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.notEqual(transmitted.at(-1).key, firstAttempt.key);
  assert.equal(transmitted.at(-1).body, firstAttempt.body);
  assert.equal((await (await fetch(`${base}/api/entries`)).json()).items.length, 4);

  await tab(page, '导入与备份');
  const backupPanel = page.getByRole('region', { name: '本机自动备份', exact: true });
  await expect(backupPanel.getByText(/保留最近 30 份/)).toBeVisible();
  const before = await (await fetch(`${base}/api/local-backups`)).json();
  assert.equal(before.retention, 30);
  assert.ok(before.items.length > 0);
  const previous = JSON.parse(await downloadFile(page, backupPanel.getByRole('link', { name: before.items[0].filename, exact: true })));
  assert.equal(previous.version, 2);
  assert.equal(previous.entries.length, 3, 'Automatic snapshot is before the last mutation');
  const created = page.waitForResponse(response => response.url() === `${base}/api/local-backups` && response.request().method() === 'POST');
  await backupPanel.getByRole('button', { name: '生成当前快照', exact: true }).click();
  const createdResponse = await created;
  assert.equal(createdResponse.status(), 201);
  const currentMetadata = await createdResponse.json();
  const snapshotLink = backupPanel.getByRole('link', { name: currentMetadata.filename, exact: true });
  await snapshotLink.waitFor();
  const current = JSON.parse(await downloadFile(page, snapshotLink));
  assert.equal(current.version, 2);
  assert.equal(current.currency, 'CNY');
  assert.equal(current.entries.length, 4);
  assert.equal(current.payments.length, 2);
  assert.equal(current.write_requests.length, 6);
  const backedSale = current.entries.find(item => item.id === sale.id);
  for (const field of ['customer', 'supplier', 'receivable_due_date', 'payable_due_date']) assert.equal(backedSale[field], sale[field]);
  const mapping = current.write_requests.find(item => item.key === firstAttempt.key);
  assert.equal(mapping.operation, 'entry.create');
  assert.equal(mapping.record_id, committedBeforeLoss.id);
  assert.match(mapping.payload_hash, /^[0-9a-f]{64}$/i);
  for (const item of current.write_requests) {
    assert.match(item.key, /^[0-9a-f-]{36}$/i);
    const records = item.operation === 'entry.create' ? current.entries : current.payments;
    assert.ok(records.some(record => record.id === item.record_id));
  }
  const portable = JSON.parse(await downloadJson(page));
  assert.deepEqual(portable.entries, current.entries);
  assert.deepEqual(portable.payments, current.payments);
  assert.deepEqual(portable.write_requests, current.write_requests);

  const restoredBase = await start('daily-v02-restored');
  const restored = await open(restoredBase);
  await tab(restored, '导入与备份');
  await restored.getByLabel('选择 JSON 备份').setInputFiles({ name: 'daily-v02.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(current)) });
  await restored.getByRole('button', { name: '检查并恢复备份', exact: true }).click();
  await restored.getByRole('dialog').getByRole('button', { name: '确认恢复', exact: true }).click();
  await restored.getByRole('status').filter({ hasText: '已恢复 4 条业务和 2 条流水' }).waitFor();
  const replay = await fetch(`${restoredBase}/api/entries`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ledger-Request': '1', 'Idempotency-Key': firstAttempt.key }, body: firstAttempt.body });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).id, committedBeforeLoss.id);
  assert.equal((await (await fetch(`${restoredBase}/api/entries`)).json()).items.length, 4);
  const restoredBackup = JSON.parse(await downloadJson(restored));
  assert.deepEqual(restoredBackup.entries, current.entries);
  assert.deepEqual(restoredBackup.payments, current.payments);
  assert.deepEqual(restoredBackup.write_requests, current.write_requests);
  await restored.close();
  await page.close();
  console.log('PASS v0.2: customer/supplier and dual due dates, expense-only fields, cutoff totals equal summary, direction/overdue/search filters, full-cutoff CSV, future partial/final settlements with historical current-balance actions, mobile overflow, one committed lost-response retry with same UUID/body, distinct next operation, pre-change and current v2 snapshot downloads, metadata/request mappings and restored-key replay.');
}

try {
  const base = await start('workflow');
  const page = await open(base);
  await page.getByText(/还没有记录/).waitFor();
  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('日期', { exact: true }).fill('2026-10-01');
  await dialog.getByLabel('项目', { exact: true }).fill('帆布袋 <script>不是代码</script>');
  await dialog.getByLabel('数量', { exact: true }).fill('10');
  await dialog.getByLabel('单价（元）', { exact: true }).fill('100.00');
  await dialog.getByLabel('单位直接成本（元）', { exact: true }).fill('60.00');
  await dialog.getByRole('button', { name: '保存记录' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('帆布袋 <script>不是代码</script>', { exact: true }).first().waitFor();
  let report = await summary(base);
  assert.equal(report.revenue_cents, 100000);
  assert.equal(report.profit_cents, 40000);
  assert.equal(report.cash_in_cents, 0);

  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await dialog.getByRole('radio', { name: '费用', exact: true }).check();
  await dialog.getByLabel('日期', { exact: true }).fill('2026-10-02');
  await dialog.getByLabel('项目', { exact: true }).fill('摊位费');
  await dialog.getByLabel('金额（元）', { exact: true }).fill('100.00');
  await dialog.getByRole('button', { name: '保存记录' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await summary(base)).profit_cents, 30000);

  await tab(page, '收付款');
  await page.getByLabel('流水种类').selectOption('receipt');
  const entries = (await (await fetch(`${base}/api/entries`)).json()).items;
  const sale = entries.find(entry => entry.kind === 'sale');
  await page.getByLabel('关联单据').selectOption(sale.id);
  await page.getByLabel('实际收付日期').fill('2026-10-03');
  await page.getByLabel('金额（元）', { exact: true }).fill('600.00');
  const paymentSaved = page.waitForResponse(response => response.url() === `${base}/api/payments` && response.request().method() === 'POST' && response.status() === 201);
  await page.getByRole('button', { name: '保存流水' }).click();
  await paymentSaved;
  await page.getByLabel('金额（元）', { exact: true }).waitFor();
  await page.waitForFunction(async () => (await (await fetch('/api/payments')).json()).items.length === 1);
  report = await summary(base);
  assert.equal(report.receivable_cents, 40000);
  assert.equal(report.cash_in_cents, 60000);
  assert.equal(report.profit_cents, 30000);
  // The server commit precedes the page refresh. Exercise client validation
  // only after its displayed balance is current (API overpayment is tested too).
  await expect(page.getByText(/剩余可收/)).toContainText('¥400.00');
  await page.getByLabel('金额（元）', { exact: true }).fill('400.01');
  await page.getByRole('button', { name: '保存流水' }).click();
  await page.getByRole('alert').filter({ hasText: /超过/ }).waitFor();
  assert.equal((await (await fetch(`${base}/api/payments`)).json()).items.length, 1);

  await tab(page, '导入与备份');
  const csv = 'external_id,kind,date,description,category,quantity,unit_price,unit_cost,amount,note\nweb-import-1,expense,2026-10-04,快递费,物流,,,,12.30,\n';
  await page.getByLabel('选择 CSV 文件').setInputFiles({ name: 'entries.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: '预检文件' }).click();
  await page.getByRole('button', { name: '确认导入 1 条' }).click();
  await page.getByRole('status').filter({ hasText: '已导入 1 条' }).waitFor();
  assert.equal((await summary(base)).profit_cents, 28770);
  const backup = await downloadJson(page);
  assert.equal(JSON.parse(backup).entries.length, 3);
  await page.getByLabel('选择 CSV 文件').setInputFiles({ name: 'duplicate.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: '预检文件' }).click();
  await page.getByRole('alert').filter({ hasText: /重复/ }).waitFor();
  assert.equal((await (await fetch(`${base}/api/meta`)).json()).entry_count, 3);

  const restoredBase = await start('restored');
  const restored = await open(restoredBase);
  await tab(restored, '导入与备份');
  await restored.getByLabel('选择 JSON 备份').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await restored.getByRole('button', { name: '检查并恢复备份' }).click();
  await restored.getByRole('dialog').getByRole('button', { name: '确认恢复', exact: true }).click();
  await restored.getByRole('status').filter({ hasText: '已恢复 3 条业务和 1 条流水' }).waitFor();
  assert.deepEqual(await summary(restoredBase), await summary(base));
  await tab(restored, '销售与费用');
  await restored.getByRole('row').filter({ hasText: '快递费' }).getByRole('button', { name: '详情' }).click();
  await restored.getByRole('button', { name: '作废记录', exact: true }).click();
  await restored.getByRole('dialog').getByLabel('作废原因').fill('重复记入的快递费');
  await restored.getByRole('dialog').getByRole('button', { name: '确认作废' }).click();
  await restored.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await summary(restoredBase)).profit_cents, 30000);
  await restored.getByLabel('查看作废记录', { exact: true }).check();
  await restored.getByText('重复记入的快递费', { exact: true }).waitFor();
  await tab(restored, '收付款');
  await restored.getByRole('button', { name: '作废流水' }).click();
  await restored.getByRole('dialog').getByLabel('作废原因').fill('收款录入有误');
  await restored.getByRole('dialog').getByRole('button', { name: '确认作废' }).click();
  await restored.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await summary(restoredBase)).receivable_cents, 100000);
  await restored.reload();
  await restored.getByRole('heading', { name: '经营概览', exact: true }).waitFor();
  assert.equal((await summary(restoredBase)).profit_cents, 30000);
  await restored.close();

  const demoBase = await start('demo');
  const demo = await open(demoBase);
  await tab(demo, '导入与备份');
  await demo.getByRole('button', { name: '载入示例账本', exact: true }).click();
  await demo.getByRole('button', { name: '确认载入示例', exact: true }).click();
  await demo.getByRole('status').filter({ hasText: '已载入示例账本' }).waitFor();
  await tab(demo, '经营概览');
  await demo.getByText(/示例账本 · 以下为虚构数据/).waitFor();
  await demo.getByRole('heading', { name: '经营概览', exact: true }).click();
  await demo.screenshot({ path: path.join(screenshots, 'overview.png'), fullPage: true });
  await demo.setViewportSize({ width: 390, height: 844 });
  assert.equal(await demo.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await demo.screenshot({ path: path.join(screenshots, 'mobile.png'), fullPage: true });
  await demo.getByRole('button', { name: '记一笔', exact: true }).click();
  await demo.getByRole('dialog').waitFor();
  await demo.screenshot({ path: path.join(screenshots, 'mobile-form.png'), fullPage: false });
  const mobileSave = demo.getByRole('dialog').getByRole('button', { name: '保存记录', exact: true });
  await mobileSave.scrollIntoViewIfNeeded();
  await expect(mobileSave).toBeInViewport();
  await demo.screenshot({ path: path.join(screenshots, 'mobile-form-save.png'), fullPage: false });
  await demo.keyboard.press('Escape');
  await demo.getByRole('dialog').waitFor({ state: 'hidden' });
  await dailyUseFlow();
  assert.deepEqual(errors, []);
  assert.equal(expectedNetworkErrors.length, 1);
  assert.equal(expectedNetworkErrors[0].observed, 1);
  console.log('PASS: empty ledger, sales, expenses, partial payment, overpayment rejection, XSS text, CSV preview/import/duplicate, JSON download/restore, entry/payment void, persistence, demo, mobile dialog scroll to save, no page errors or unexpected console errors (one exact injected failed-response network error verified).');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  for (const child of servers) {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
  // Delete only our validated mkdtemp directory; explicit screenshot destinations remain.
  const resolved = path.resolve(work);
  if (resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('small-ledger-smoke-')) {
    if (process.env.LEDGER_SCREENSHOT_DIR) await rm(resolved, { recursive: true, force: true });
  }
}
