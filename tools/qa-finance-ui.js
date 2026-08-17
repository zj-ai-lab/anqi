// v1.7.2 资金 UI 本地真实 Chrome QA：
// 费用页 1440/390 × pro/paper/jade + 2.1–2.6 关键交互 + 既有案件资金区回归。
// 只连接 tools/seed-finance-qa.js 生成的全新临时库；不接生产库。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = String(process.env.PLAYWRIGHT_PATH || '').trim();
if (!playwrightPath) throw new Error('PLAYWRIGHT_PATH required（须指向可 require 的 playwright 包）');
const { chromium } = require(playwrightPath);

const fixturePath = String(process.env.QA_FIXTURE_PATH || '').trim();
if (!fixturePath) throw new Error('QA_FIXTURE_PATH required（由 seed-finance-qa.js 生成）');
const fixture = JSON.parse(fs.readFileSync(path.resolve(fixturePath), 'utf8'));
if (fixture.schema_version !== 1 || !fixture.qa_token || !fixture.cases || !fixture.fees) {
  throw new Error('unsupported or incomplete finance QA fixture');
}

const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:39880';
const outputDir = path.resolve(process.env.QA_OUTPUT_DIR || path.join('tmp', 'finance-ui-qa'));
const appVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const headless = process.env.QA_HEADFUL !== '1';
fs.mkdirSync(outputDir, { recursive: true });

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const SKINS = ['pro', 'paper', 'jade'];
const failures = [];
const diagnostics = [];
const consoleErrors = [];
const networkErrors = [];
const layouts = new Map();
const screenshots = [];

function recordFailure(message) {
  failures.push(message);
}

function recordDiagnostic(message) {
  diagnostics.push(message);
}

function screenshotPath(name) {
  const target = path.join(outputDir, `${name}.png`);
  screenshots.push(target);
  return target;
}

async function guarded(name, work) {
  try {
    await work();
  } catch (error) {
    recordFailure(`${name}: ${error.stack || error.message}`);
  }
}

function watchPage(page, name) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    consoleErrors.push(`${name}: ${message.text()}${location?.url ? ` @ ${location.url}` : ''}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(`${name}: ${error.message}`));
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(`${baseUrl}/api/`)) {
      networkErrors.push(`${name}: request failed ${request.method()} ${request.url()} · ${request.failure()?.errorText || ''}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().startsWith(`${baseUrl}/api/`) && response.status() >= 400) {
      networkErrors.push(`${name}: HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
}

async function openPage({ name, url, viewport, skin }) {
  const context = await browser.newContext({
    viewport,
    colorScheme: skin === 'jade' ? 'dark' : 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  watchPage(page, name);
  await page.addInitScript((value) => localStorage.setItem('anjian-skin', value), skin);
  await page.goto(`${baseUrl}${url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (version) => document.querySelector('.brand .ver')?.textContent === `v${version}`,
    appVersion
  );
  const appliedSkin = await page.evaluate(() => document.documentElement.dataset.skin || 'auto');
  assert.equal(appliedSkin, skin, `${name}: requested skin ${skin}, rendered ${appliedSkin}`);
  return { context, page };
}

async function openFees(name, viewport, skin) {
  const opened = await openPage({ name, url: '/fees.html', viewport, skin });
  await opened.page.locator('.fee-ledger').waitFor();
  return opened;
}

// 任何会写数据的浏览器动作之前，先用随机 marker + 完整记录集合证明目标服务
// 正在使用本次 seed 的隔离库。指错 URL 时直接终止，绝不尝试“清理”或触碰该库。
async function assertFixtureServer() {
  const { context, page } = await openFees('fixture-preflight', DESKTOP, 'pro');
  try {
    const served = await page.evaluate(async () => {
      const [casesResponse, feesResponse] = await Promise.all([
        fetch('/api/cases'),
        fetch('/api/fees/overview'),
      ]);
      if (!casesResponse.ok || !feesResponse.ok) {
        throw new Error(`fixture preflight API failure: cases=${casesResponse.status}, fees=${feesResponse.status}`);
      }
      return { cases: await casesResponse.json(), fees: await feesResponse.json() };
    });

    const expectedCases = Object.values(fixture.cases)
      .map(({ id, name }) => `${id}:${name}`).sort();
    const actualCases = served.cases.map(({ id, name }) => `${id}:${name}`).sort();
    assert.deepEqual(actualCases, expectedCases,
      'refusing QA: target service case set does not exactly match the isolated fixture');

    const expectedFees = Object.values(fixture.fees)
      .map(({ id, label }) => `${id}:${label}`).sort();
    const servedFees = served.fees.cases.flatMap((caseRow) => caseRow.items || []);
    const actualFees = servedFees.map(({ id, label }) => `${id}:${label}`).sort();
    assert.deepEqual(actualFees, expectedFees,
      'refusing QA: target service fee set does not exactly match the isolated fixture');

    const clean = servedFees.find((fee) => fee.id === fixture.fees.clean.id);
    assert.equal(clean?.note, `finance-qa:${fixture.qa_token}`,
      'refusing QA: random fixture marker is absent; target may be a real database');
  } finally {
    await context.close();
  }
}

async function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function assertNoOverflow(page, name) {
  const overflow = await horizontalOverflow(page);
  if (overflow > 2) recordFailure(`${name}: horizontal overflow ${overflow}px`);
}

async function assertMobileButtons(page, name, scope = [
  'main button', 'main a.btn', 'main details > summary',
  '.dmodal-overlay button', '.dmodal-overlay a.btn', '.dmodal-overlay details > summary',
  '.dmodal-overlay input:not([type="checkbox"]):not([type="radio"]):not([type="range"])',
  '.dmodal-overlay select', '.dmodal-overlay textarea',
].join(', ')) {
  const undersized = await page.locator(scope).evaluateAll((targets) => targets
    .filter((target) => target.getClientRects().length && target.getBoundingClientRect().height < 43.5)
    .map((target) => `${target.textContent.trim() || target.getAttribute('aria-label') || '<unnamed>'}: ${target.getBoundingClientRect().height}px`));
  if (undersized.length) recordFailure(`${name}: undersized touch targets ${undersized.join(', ')}`);
}

async function assertDatePromptA11y(page, modal, trigger, name) {
  assert.equal(await modal.getAttribute('role'), 'dialog', `${name}: modal role must be dialog`);
  assert.equal(await modal.getAttribute('aria-modal'), 'true', `${name}: aria-modal must be true`);
  const labelledBy = await modal.getAttribute('aria-labelledby');
  assert(labelledBy, `${name}: dialog must have aria-labelledby`);
  assert.equal(await page.locator(`#${labelledBy}`).count(), 1, `${name}: labelled title target missing`);
  assert.equal(await modal.evaluate((element) => element.contains(document.activeElement)), true,
    `${name}: initial focus must move inside dialog`);
  assert.equal(await page.evaluate(() => [...document.body.children]
    .filter((node) => !node.classList.contains('dmodal-overlay'))
    .every((node) => node.inert)), true, `${name}: page background must be inert while dialog is open`);

  const focusables = modal.locator(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  const first = focusables.first();
  const last = focusables.last();
  assert(await focusables.count() >= 2, `${name}: expected at least two focusable controls`);
  await last.focus();
  await page.keyboard.press('Tab');
  assert.equal(await first.evaluate((element) => document.activeElement === element), true,
    `${name}: Tab must wrap from last to first control`);
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await last.evaluate((element) => document.activeElement === element), true,
    `${name}: Shift+Tab must wrap from first to last control`);

  assert.equal(await trigger.evaluate((element) => element.isConnected), true,
    `${name}: opener unexpectedly disconnected before dialog close`);
}

async function assertSettlementDialogA11y(page, modal, trigger, name) {
  assert.equal(await modal.getAttribute('role'), 'dialog', `${name}: modal role must be dialog`);
  assert.equal(await modal.getAttribute('aria-modal'), 'true', `${name}: aria-modal must be true`);
  assert(await modal.getAttribute('aria-label'), `${name}: settlement dialog must have an accessible name`);
  assert.equal(await modal.evaluate((element) => element.contains(document.activeElement)), true,
    `${name}: focus must remain inside settlement dialog`);
  assert.equal(await page.evaluate(() => [...document.body.children]
    .filter((node) => !node.classList.contains('dmodal-overlay'))
    .every((node) => node.inert)), true, `${name}: page background must be inert while dialog is open`);

  const focusableCount = await modal.evaluate((dialog) => {
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )].filter((node) => node.getClientRects().length && node.getAttribute('aria-hidden') !== 'true');
    for (const node of dialog.querySelectorAll('[data-qa-focus-edge]')) node.removeAttribute('data-qa-focus-edge');
    focusable[0]?.setAttribute('data-qa-focus-edge', 'first');
    focusable.at(-1)?.setAttribute('data-qa-focus-edge', 'last');
    return focusable.length;
  });
  assert(focusableCount >= 2, `${name}: expected at least two focusable controls`);
  const first = modal.locator('[data-qa-focus-edge="first"]');
  const last = modal.locator('[data-qa-focus-edge="last"]');
  await last.focus();
  await page.keyboard.press('Tab');
  assert.equal(await first.evaluate((element) => document.activeElement === element), true,
    `${name}: Tab must wrap from last to first control`);
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await last.evaluate((element) => document.activeElement === element), true,
    `${name}: Shift+Tab must wrap from first to last control`);
  assert.equal(await trigger.evaluate((element) => element.isConnected), true,
    `${name}: opener unexpectedly disconnected before dialog close`);
}

async function assertDialogClosed(page, trigger, name) {
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true,
    `${name}: closing dialog must restore focus to opener`);
  assert.equal(await page.evaluate(() => [...document.body.children].every((node) => !node.inert)), true,
    `${name}: closing dialog must clear background inert state`);
}

async function assertModalFits(page, name) {
  const modal = page.locator('.dmodal-overlay .dmodal').last();
  if (!await modal.count()) {
    recordFailure(`${name}: modal not found`);
    return;
  }
  const result = await modal.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      ownOverflow: element.scrollWidth - element.clientWidth,
    };
  });
  if (result.left < -2 || result.top < -2 || result.right > result.viewportWidth + 2
      || result.bottom > result.viewportHeight + 2 || result.ownOverflow > 2) {
    recordFailure(`${name}: modal exceeds viewport ${JSON.stringify(result)}`);
  }
  await assertNoOverflow(page, name);
}

async function layoutSnapshot(page) {
  return page.evaluate(() => {
    const containers = [...document.querySelectorAll('main div, main section, main article, main details, main li, main table')]
      .filter((element) => element.getClientRects().length && getComputedStyle(element).display !== 'none')
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        return {
          index,
          signature: `${element.tagName.toLowerCase()}#${element.id || ''}.${[...element.classList].slice(0, 3).join('.')}`,
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        };
      });
    return { height: document.documentElement.scrollHeight, containers };
  });
}

function compareLayouts(viewportName) {
  const baseline = layouts.get(`${viewportName}:pro`);
  if (!baseline) return;
  for (const skin of ['paper', 'jade']) {
    const candidate = layouts.get(`${viewportName}:${skin}`);
    if (!candidate) continue;
    if (candidate.height !== baseline.height) {
      recordFailure(`${viewportName}:${skin}: page height ${candidate.height}px != pro ${baseline.height}px`);
    }
    if (candidate.containers.length !== baseline.containers.length) {
      recordFailure(`${viewportName}:${skin}: visible container count ${candidate.containers.length} != pro ${baseline.containers.length}`);
      continue;
    }
    const displaced = [];
    const resized = [];
    for (let index = 0; index < baseline.containers.length; index += 1) {
      const a = baseline.containers[index];
      const b = candidate.containers[index];
      const sizeDelta = Math.max(Math.abs(a.width - b.width), Math.abs(a.height - b.height));
      const delta = Math.max(
        Math.abs(a.x - b.x), Math.abs(a.y - b.y),
        sizeDelta
      );
      if (sizeDelta > 2) {
        resized.push(`${a.signature} ${a.width.toFixed(1)}×${a.height.toFixed(1)}→${b.width.toFixed(1)}×${b.height.toFixed(1)}`);
      }
      if (delta > 2) displaced.push(`${a.signature} Δ${delta.toFixed(2)}px`);
    }
    if (resized.length) {
      recordFailure(`${viewportName}:${skin}: ${resized.length} containers resized >2px; ${resized.slice(0, 12).join(' | ')}`);
    }
    if (displaced.length) {
      recordFailure(`${viewportName}:${skin}: ${displaced.length} containers displaced >2px; ${displaced.slice(0, 8).join(' | ')}`);
    }
  }
}

function feeBlock(page, label) {
  return page.locator('.fee-item-block').filter({
    has: page.getByText(label, { exact: true }),
  }).first();
}

async function caseDisclosureState(page, caseName) {
  const title = page.locator('#detail').getByText(caseName, { exact: true }).first();
  if (!await title.count()) return { found: false };
  return title.evaluate((element) => {
    const details = element.closest('details');
    return { found: true, tag: details?.tagName || '', open: details?.open ?? null };
  });
}

async function assertFeesContracts(page, name, viewport) {
  const text = await page.locator('body').innerText();
  if (!text.includes('应给我') && !text.includes('我应给')) {
    recordFailure(`${name}: missing human relation wording`);
  }
  for (const term of ['gross', 'remaining', 'assignment', 'revision', 'snapshot', 'preview hash', 'fee version', '方案已闭合', '纳管已收']) {
    if (text.toLowerCase().includes(term)) recordFailure(`${name}: leaked machine wording ${term}`);
  }

  const createButton = page.getByRole('button', { name: '记款项', exact: true });
  if (await createButton.count() !== 1) recordFailure(`${name}: expected one page-head “记款项” button`);

  const scaleHeading = page.getByRole('heading', { name: '按案收款规模', exact: true });
  if (await scaleHeading.count() !== 1) recordFailure(`${name}: missing “按案收款规模” heading`);
  const scaleSection = page.locator('section[aria-label="按案收款规模"]');
  if (await scaleSection.count() !== 1) recordFailure(`${name}: scale section aria-label not synchronized`);

  const hrefs = await page.locator(
    '#case-bars a[href*="/case.html?id="], #detail a[href*="/case.html?id="], #share-rows a[href*="/case.html?id="]'
  ).evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  const unanchored = hrefs.filter((href) => href && !href.includes('#case-money'));
  if (unanchored.length) recordFailure(`${name}: case money links missing #case-money: ${unanchored.join(', ')}`);

  for (const key of ['closed', 'shelved']) {
    const state = await caseDisclosureState(page, fixture.cases[key].name);
    if (!state.found) recordFailure(`${name}: missing ${key} case detail panel`);
    else if (state.tag !== 'DETAILS' || state.open !== false) {
      recordFailure(`${name}: ${key} case must be a closed <details>, got ${JSON.stringify(state)}`);
    }
  }
  const activeState = await caseDisclosureState(page, fixture.cases.unresolved.name);
  if (!activeState.found) recordFailure(`${name}: missing active case detail panel`);
  else if (activeState.tag === 'DETAILS' && activeState.open !== true) {
    recordFailure(`${name}: active case unexpectedly folded`);
  }

  const zeroPanelTitle = page.locator('#detail').getByText(fixture.cases.zero.name, { exact: true }).first();
  if (!await zeroPanelTitle.count()) {
    recordFailure(`${name}: zero-amount case detail panel missing`);
  } else {
    const zeroPanel = zeroPanelTitle.locator('xpath=ancestor::*[contains(@class,"fee-case-panel")][1]');
    const zeroText = await zeroPanel.innerText();
    if (!zeroText.includes(fixture.fees.zero.label)) recordFailure(`${name}: zero-amount fee detail missing`);
    if (zeroText.includes('还没有任何款项记录')) {
      recordFailure(`${name}: zero-amount fee was misreported as an empty case`);
    }
  }
  if (text.includes('暂无非零收款规模可比较')) {
    recordFailure(`${name}: all-zero scale message shown even though comprehensive fixture has non-zero fees`);
  }

  const unresolvedLabel = new RegExp(`先确认分成办法.*${fixture.fees.unresolved.unresolved_count} 条`);
  if (await page.getByRole('button', { name: unresolvedLabel }).count() !== 1) {
    recordFailure(`${name}: unresolved fee primary route label missing or duplicated`);
  }

  const trace = feeBlock(page, fixture.fees.trace.label);
  if (!await trace.count()) recordFailure(`${name}: formal trace fee block missing`);
  else if (await trace.getByRole('button', { name: /怎么算的/ }).count() < 1) {
    recordFailure(`${name}: formal snapshot share lacks “怎么算的”`);
  }
  const manual = feeBlock(page, fixture.fees.manual.label);
  if (!await manual.count()) recordFailure(`${name}: manual share fee block missing`);
  else if (await manual.getByRole('button', { name: /怎么算的/ }).count()) {
    recordFailure(`${name}: manual share misleadingly exposes “怎么算的”`);
  }
  const assignmentOnly = feeBlock(page, fixture.fees.assignment_only.label);
  if (!await assignmentOnly.count()) recordFailure(`${name}: assignment-only fee block missing`);
  else if (await assignmentOnly.getByRole('button', { name: '减免', exact: true }).count() !== 1) {
    recordFailure(`${name}: assignment-only unpaid fee must allow waiver before any settlement run/share exists`);
  }

  const historyDetails = page.locator('details').filter({ hasText: '本年已分正项' }).first();
  if (!await historyDetails.count()) {
    recordFailure(`${name}: current-year zero-sum settled disclosure missing`);
  } else if (await historyDetails.evaluate((element) => element.open)) {
    recordFailure(`${name}: settled history should be folded by default`);
  }

  const borderWidths = await page.locator('.fee-ledger-term').evaluateAll((elements) => elements.map((element) => ({
    label: element.textContent.trim(),
    width: Number.parseFloat(getComputedStyle(element).borderTopWidth),
  })));
  const thick = borderWidths.filter((item) => item.width > 1.01);
  if (thick.length) recordFailure(`${name}: ledger rules still look tab-like: ${JSON.stringify(thick)}`);

  const currencyGlyph = await page.locator('.fee-ledger-currency').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      text: element.textContent,
      width: rect.width,
      height: rect.height,
      visible: style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0,
    };
  });
  if (!currencyGlyph.text.includes('¥') || !currencyGlyph.visible
      || currencyGlyph.width < 3 || currencyGlyph.height < 3) {
    recordFailure(`${name}: total-ledger ¥ glyph is not visibly rendered (${JSON.stringify(currencyGlyph)})`);
  }

  await assertNoOverflow(page, name);
  if (viewport.width <= 420) await assertMobileButtons(page, name);
}

async function inspectFeesMatrix({ viewportName, viewport, skin }) {
  const name = `fees-${viewportName}-${skin}`;
  const { context, page } = await openFees(name, viewport, skin);
  try {
    await assertFeesContracts(page, name, viewport);
    layouts.set(`${viewportName}:${skin}`, await layoutSnapshot(page));
    await page.screenshot({ path: screenshotPath(name), fullPage: true });
    if (viewport.width <= 420) {
      await page.screenshot({ path: screenshotPath(`${name}-viewport`), fullPage: false });
    }
  } finally {
    await context.close();
  }
}

async function testSettledDisclosure() {
  const name = 'fees-settled-readonly';
  const { context, page } = await openFees(name, DESKTOP, 'pro');
  try {
    const details = page.locator('details').filter({ hasText: '本年已分正项' }).first();
    assert.equal(await details.count(), 1, 'zero-sum settled disclosure should exist');
    const summary = details.locator('summary').first();
    await summary.click();
    assert.equal(await details.evaluate((element) => element.open), true, 'settled disclosure should open');
    const settledText = await details.innerText();
    assert.match(settledText, /本年已分正项/);
    assert.match(settledText, /本年冲抵负项/);
    assert(!settledText.includes('往年已结'), 'prior-year row leaked into current-year disclosure');
    assert.equal(await details.locator('button').count(), 0, 'settled rows must be read-only');
    await page.screenshot({ path: screenshotPath(name), fullPage: true });
  } finally {
    await context.close();
  }
}

async function testUnresolvedModal(skin) {
  const name = `fees-unresolved-mobile-${skin}`;
  const { context, page } = await openFees(name, MOBILE, skin);
  try {
    const label = new RegExp(`先确认分成办法.*${fixture.fees.unresolved.unresolved_count} 条`);
    const button = page.getByRole('button', { name: label });
    assert.equal(await button.count(), 1, 'unresolved primary route button missing');
    await button.click();
    const modal = page.locator('.settlement-modal');
    await modal.waitFor();
    await modal.getByText(new RegExp(`${fixture.fees.unresolved.unresolved_count} 条分成待确认`)).waitFor();
    const modalText = await modal.innerText();
    assert.match(modalText, /收到律师费并结算|确认收到律师费/);
    assert.match(modalText, /2 条分成待确认|还有 2 条分成没确认/);
    const preview = modal.getByRole('button', { name: '算一算', exact: true });
    assert.equal(await preview.isDisabled(), true, 'preview must stay disabled until plans are decided');
    await assertSettlementDialogA11y(page, modal, button, name);
    await assertModalFits(page, name);
    await assertMobileButtons(page, name);
    await modal.screenshot({ path: screenshotPath(name) });
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await assertDialogClosed(page, button, name);
  } finally {
    await context.close();
  }
}

async function testCreateFee() {
  const name = 'fees-create-desktop-pro';
  const { context, page } = await openFees(name, DESKTOP, 'pro');
  try {
    await page.getByRole('button', { name: '记款项', exact: true }).click();
    const modal = page.locator('.dmodal-overlay .dmodal').last();
    await modal.waitFor();
    await assertModalFits(page, name);

    const caseSelect = modal.getByLabel(/案件|案名/).first();
    const options = await caseSelect.locator('option').allTextContents();
    assert(options.some((value) => value.includes(fixture.cases.empty_active.name)), 'active empty case missing from selector');
    assert(!options.some((value) => value.includes(fixture.cases.closed.name)), 'closed case leaked into active selector');
    assert(!options.some((value) => value.includes(fixture.cases.shelved.name)), 'shelved case leaked into active selector');

    await caseSelect.selectOption(String(fixture.cases.empty_active.id));
    await modal.getByLabel(/款项名称|期名/).fill('QA 新增验收款');
    await modal.getByLabel(/金额/).fill('1234.56');
    await modal.getByLabel(/到期日/).fill('2099-12-31');
    await modal.getByLabel(/收款条件|程序节点/).fill('QA 验收节点明确后支付');

    const responsePromise = page.waitForResponse((response) => response.url().endsWith(
      `/api/cases/${fixture.cases.empty_active.id}/fees`
    ) && response.request().method() === 'POST');
    await modal.getByRole('button', { name: /确认|记录/ }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const created = await response.json();
    assert.equal(created.case_id, fixture.cases.empty_active.id);
    assert.equal(created.amount_fen, 123456, 'browser must submit yuan, server must store fen');
    assert.equal(created.node, 'QA 验收节点明确后支付');
    await page.locator('#detail').getByText('QA 新增验收款', { exact: true }).waitFor();
    await page.screenshot({ path: screenshotPath(name), fullPage: true });

    const cleanupStatus = await page.evaluate(async (feeId) => {
      const result = await fetch(`/api/fees/${feeId}`, { method: 'DELETE' });
      return result.status;
    }, created.id);
    assert.equal(cleanupStatus, 200, 'QA-created fee cleanup failed');
  } finally {
    await context.close();
  }
}

async function testCreateFeeMobile(skin) {
  const name = `fees-create-mobile-${skin}`;
  const { context, page } = await openFees(name, MOBILE, skin);
  try {
    const trigger = page.getByRole('button', { name: '记款项', exact: true });
    await trigger.click();
    const modal = page.locator('.dmodal-overlay .dmodal').last();
    await modal.waitFor();
    const options = await modal.getByLabel(/案件|案名/).first().locator('option').allTextContents();
    assert(options.some((value) => value.includes(fixture.cases.empty_active.name)),
      'active empty case missing from mobile selector');
    await assertDatePromptA11y(page, modal, trigger, name);
    await assertModalFits(page, name);
    await assertMobileButtons(page, name);
    await modal.screenshot({ path: screenshotPath(name) });
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    await assertDialogClosed(page, trigger, name);
  } finally {
    await context.close();
  }
}

async function readFeeFromOverview(page, caseId, feeId) {
  return page.evaluate(async ({ selectedCaseId, selectedFeeId }) => {
    const response = await fetch('/api/fees/overview');
    const overview = await response.json();
    const selectedCase = overview.cases.find((item) => item.case_id === selectedCaseId);
    const fee = selectedCase?.items.find((item) => item.id === selectedFeeId) || null;
    return { fee, totals: overview.totals };
  }, { selectedCaseId: caseId, selectedFeeId: feeId });
}

async function clickWithConfirm(page, button, feeId, expectedStatus) {
  let dialogSeen = false;
  page.once('dialog', async (dialog) => {
    dialogSeen = true;
    await dialog.accept();
  });
  const responsePromise = page.waitForResponse((response) => response.url().endsWith(
    `/api/fees/${feeId}`
  ) && response.request().method() === 'PATCH');
  await button.click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  const result = await response.json();
  assert.equal(result.status, expectedStatus);
  assert.equal(dialogSeen, true, `${expectedStatus} action must require confirm`);
}

function assignedPlan(fee, assignmentId) {
  return fee?.share_plans?.map((agreement) => agreement.plan)
    .find((plan) => plan?.id === assignmentId) || null;
}

async function waiverCycle(page, {
  caseFixture, feeFixture, name, preserveAssignment = false, unresolvedCount = 0,
}) {
  const planBefore = preserveAssignment
    ? assignedPlan(
      (await readFeeFromOverview(page, caseFixture.id, feeFixture.id)).fee,
      feeFixture.assignment_id
    )
    : null;
  if (preserveAssignment) assert(planBefore, 'assignment-only fixture lost its saved plan before waiver');

  let block = feeBlock(page, feeFixture.label);
  const waive = block.getByRole('button', { name: '减免', exact: true });
  assert.equal(await waive.count(), 1, `${name}: unpaid fee lacks waive action`);
  await clickWithConfirm(page, waive, feeFixture.id, 'waived');

  block = feeBlock(page, feeFixture.label);
  await block.getByText(/放弃 \/ 减免|已减免/).waitFor();
  const waived = await readFeeFromOverview(page, caseFixture.id, feeFixture.id);
  assert.equal(waived.fee?.status, 'waived');
  assert.equal(waived.fee?.settlement_runs?.length, 0, `${name}: waive created a settlement run`);
  assert.equal(waived.fee?.shares?.length, 0, `${name}: waive created a share row`);
  if (unresolvedCount) {
    assert.equal(await block.getByText(new RegExp(`${unresolvedCount} 条分成待确认`)).count(), 0,
      `${name}: waived fee must not expose an unavailable unresolved-plan task`);
  }
  if (preserveAssignment) {
    const planAfterWaive = assignedPlan(waived.fee, feeFixture.assignment_id);
    assert(planAfterWaive, `${name}: waiver deleted the saved assignment`);
    assert.equal(planAfterWaive.status, 'assigned');
    assert.equal(planAfterWaive.formula_revision_id, planBefore.formula_revision_id);
  }
  await page.screenshot({ path: screenshotPath(`${name}-waived`), fullPage: true });
  await assertMobileButtons(page, `${name}-waived`);

  const restore = block.getByRole('button', { name: /恢复/ });
  assert.equal(await restore.count(), 1, `${name}: waived fee lacks restore action`);
  await clickWithConfirm(page, restore, feeFixture.id, 'unpaid');
  block = feeBlock(page, feeFixture.label);
  await block.getByText(/待收/).first().waitFor();
  const restored = await readFeeFromOverview(page, caseFixture.id, feeFixture.id);
  assert.equal(restored.fee?.status, 'unpaid');
  assert.equal(restored.fee?.settlement_runs?.length, 0);
  assert.equal(restored.fee?.shares?.length, 0);
  if (unresolvedCount) {
    assert.equal(await block.getByRole('button', {
      name: new RegExp(`先确认分成办法.*${unresolvedCount} 条`),
    }).count(), 1, `${name}: restored fee must expose unresolved-plan route again`);
  }
  if (preserveAssignment) {
    const planAfterRestore = assignedPlan(restored.fee, feeFixture.assignment_id);
    assert(planAfterRestore, `${name}: restore deleted the saved assignment`);
    assert.equal(planAfterRestore.status, 'assigned');
    assert.equal(planAfterRestore.formula_revision_id, planBefore.formula_revision_id);
  }
}

async function testWaiveRestore() {
  const name = 'fees-waive-restore-mobile-pro';
  const { context, page } = await openFees(name, MOBILE, 'pro');
  try {
    await waiverCycle(page, {
      caseFixture: fixture.cases.clean,
      feeFixture: fixture.fees.clean,
      name: `${name}-clean`,
    });
    await waiverCycle(page, {
      caseFixture: fixture.cases.assignment_only,
      feeFixture: fixture.fees.assignment_only,
      name: `${name}-assignment-only`,
      preserveAssignment: true,
    });
    await waiverCycle(page, {
      caseFixture: fixture.cases.unresolved,
      feeFixture: fixture.fees.unresolved,
      name: `${name}-unresolved`,
      unresolvedCount: fixture.fees.unresolved.unresolved_count,
    });
  } finally {
    await context.close();
  }
}

async function testHistoryDirect(skin) {
  const name = `fees-history-mobile-${skin}`;
  const { context, page } = await openFees(name, MOBILE, skin);
  try {
    const block = feeBlock(page, fixture.fees.trace.label);
    const explain = block.getByRole('button', { name: /怎么算的/ }).first();
    assert.equal(await explain.count(), 1, 'formal share explain action missing');
    await explain.click();
    const modal = page.locator('.settlement-modal');
    await modal.waitFor();
    await modal.getByText('历史与高级', { exact: true }).waitFor();
    const outerHistory = modal.locator('details.money-advanced').filter({ hasText: '历史与高级' }).first();
    assert.equal(await outerHistory.evaluate((element) => element.open), true, 'history outer disclosure not auto-opened');
    const targetSnapshot = outerHistory.locator(
      `[data-settlement-snapshot-id="${fixture.settlement.snapshot_id}"]`
    );
    assert.equal(await targetSnapshot.count(), 1, 'target settlement snapshot not found');
    await page.waitForFunction((snapshotId) => (
      document.activeElement?.dataset?.settlementSnapshotId === String(snapshotId)
    ), fixture.settlement.snapshot_id);
    assert.equal(await targetSnapshot.getAttribute('role'), 'group', 'target snapshot needs a focused group role');
    assert.match(await targetSnapshot.getAttribute('aria-label'), /当前查看的分成计算/);
    const targetRun = targetSnapshot.locator('xpath=ancestor::details[contains(@class,"settlement-history-item")]');
    assert.equal(await targetRun.evaluate((element) => element.open), true, 'target settlement run not auto-opened');
    const visibleText = await targetRun.innerText();
    assert.match(visibleText, new RegExp(fixture.settlement.counterpart));
    assert.match(visibleText, /平台费用/);
    assert.match(visibleText, /最终分成/);
    for (const term of ['gross', 'remaining', 'assignment', 'revision', 'snapshot', 'preview hash', 'fee version']) {
      assert(!visibleText.toLowerCase().includes(term), `history target leaked machine wording ${term}`);
    }
    await assertSettlementDialogA11y(page, modal, explain, name);
    await assertModalFits(page, name);
    await assertMobileButtons(page, name);
    await modal.screenshot({ path: screenshotPath(name) });
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await assertDialogClosed(page, explain, name);
  } finally {
    await context.close();
  }
}

async function inspectExistingCaseQa() {
  for (const skin of SKINS) {
    const name = `case-provisional-desktop-${skin}`;
    const { context, page } = await openPage({
      name,
      url: `/case.html?id=${fixture.cases.provisional.id}#case-money`,
      viewport: DESKTOP,
      skin,
    });
    try {
      await page.locator('#case-money .money-card').first().waitFor();
      const text = await page.locator('#case-money').innerText();
      assert(text.includes('律师费与分成'));
      assert(!text.includes('本笔律师费\n金额待定'), 'receivable agreement confused with case fee');
      await assertNoOverflow(page, name);
      await page.locator('#case-money').screenshot({ path: screenshotPath(name) });
    } finally {
      await context.close();
    }
  }

  const name = 'case-agreement-modal-desktop-pro';
  const { context, page } = await openPage({
    name,
    url: `/case.html?id=${fixture.cases.provisional.id}#case-money`,
    viewport: DESKTOP,
    skin: 'pro',
  });
  try {
    await page.locator('#case-money .money-card').first().waitFor();
    await page.getByText('新增分成约定', { exact: true }).click();
    await page.getByRole('button', { name: '别人应给我' }).click();
    const modal = page.locator('.settlement-modal');
    await modal.waitFor();
    const modalText = await modal.innerText();
    for (const expected of ['主办律师 / 应付款方', '我的比例', '什么时候结算', '扣税或律所费用还没定']) {
      if (!modalText.includes(expected)) recordFailure(`${name}: missing ${expected}`);
    }
    for (const hiddenByDefault of ['版本标签', '生效日', '最终比例基数']) {
      const visible = await modal.getByText(hiddenByDefault, { exact: true }).isVisible().catch(() => false);
      if (visible) recordFailure(`${name}: ${hiddenByDefault} should be folded`);
    }
    await modal.screenshot({ path: screenshotPath(name) });
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless });
try {
  await assertFixtureServer();
  for (const [viewportName, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
    for (const skin of SKINS) {
      await guarded(`matrix ${viewportName}/${skin}`, () => inspectFeesMatrix({ viewportName, viewport, skin }));
    }
    compareLayouts(viewportName);
  }

  await guarded('settled read-only disclosure', testSettledDisclosure);
  for (const skin of SKINS) {
    await guarded(`unresolved modal ${skin}`, () => testUnresolvedModal(skin));
    await guarded(`history direct ${skin}`, () => testHistoryDirect(skin));
    await guarded(`create fee mobile ${skin}`, () => testCreateFeeMobile(skin));
  }
  await guarded('create fee', testCreateFee);
  await guarded('waive and restore', testWaiveRestore);
  await guarded('existing case finance QA', inspectExistingCaseQa);
} finally {
  await browser.close();
}

const result = {
  generated_at: new Date().toISOString(),
  app_version: appVersion,
  fixture: path.resolve(fixturePath),
  base_url: baseUrl,
  headless,
  screenshots,
  failures,
  diagnostics,
  console_errors: consoleErrors,
  network_errors: networkErrors,
};
fs.writeFileSync(path.join(outputDir, 'qa-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');

assert.deepEqual(consoleErrors, [], `browser console errors:\n${consoleErrors.join('\n')}`);
assert.deepEqual(networkErrors, [], `browser network errors:\n${networkErrors.join('\n')}`);
assert.deepEqual(failures, [], `finance UI QA failures:\n${failures.join('\n\n')}`);
console.log(`finance UI QA passed; ${screenshots.length} screenshots: ${outputDir}`);
