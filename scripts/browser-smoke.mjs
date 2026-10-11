// Real-browser workflow against a temporary SQLite ledger. No mocked API responses.
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
    if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
  });
  await page.goto(base);
  await page.getByRole('heading', { name: '经营概览', exact: true }).waitFor();
  assert.match(await page.title(), /小本账/);
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
  await page.getByRole('button', { name: '保存流水' }).click();
  await page.getByLabel('金额（元）', { exact: true }).waitFor();
  await page.waitForFunction(async () => (await (await fetch('/api/payments')).json()).items.length === 1);
  report = await summary(base);
  assert.equal(report.receivable_cents, 40000);
  assert.equal(report.cash_in_cents, 60000);
  assert.equal(report.profit_cents, 30000);
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
  await demo.screenshot({ path: path.join(screenshots, 'overview.png'), fullPage: true });
  await demo.setViewportSize({ width: 390, height: 844 });
  assert.equal(await demo.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await demo.screenshot({ path: path.join(screenshots, 'mobile.png'), fullPage: true });
  await demo.getByRole('button', { name: '记一笔', exact: true }).click();
  await demo.getByRole('dialog').waitFor();
  await demo.screenshot({ path: path.join(screenshots, 'mobile-form.png'), fullPage: true });
  await demo.keyboard.press('Escape');
  await demo.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('PASS: empty ledger, sales, expenses, partial payment, overpayment rejection, XSS text, CSV preview/import/duplicate, JSON download/restore, entry/payment void, persistence, demo, mobile dialog, no page/console errors.');
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
