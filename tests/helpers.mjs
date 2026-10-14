/**
 * UI 测试套件共享夹具
 *
 * 环境变量：
 *   BASE_URL        被测地址，默认 http://127.0.0.1:8790（wrangler dev 默认端口是 8787）
 *   ADMIN_PASSWORD  后台口令，默认 test-admin-pw（对应本地 .dev.vars）
 *   SHOT_DIR        设置后才输出全页截图，默认不写文件
 *   ALLOW_REMOTE    设为 1 才允许对非本机地址跑套件
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

export const BASE = process.env.BASE_URL || 'http://127.0.0.1:8790';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-pw';
export const SHOT_DIR = process.env.SHOT_DIR || '';

/**
 * 这些用例会真实上传文件、改后台设置。曾经有过默认值指向他人线上站点的事故，
 * 因此对非本机地址直接拒绝，除非显式 ALLOW_REMOTE=1。
 */
export function guardTarget() {
  const local = /(localhost|127\.0\.0\.1|\[::1\])/.test(BASE);
  if (local || process.env.ALLOW_REMOTE === '1') return;
  throw new Error(
    `拒绝对非本机地址运行：${BASE}\n这些用例会写入文件并修改后台设置。` +
      `确认目标是你自己的环境后再加 ALLOW_REMOTE=1 执行。`,
  );
}

export async function launchBrowser() {
  guardTarget();
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
  return chromium.launch({ headless: true });
}

/** 记录控制台错误、页面异常、失败请求与 CSP 违规；wrangler dev 的 live-reload socket 不算错误 */
export async function newPage(browser, { scheme = 'light', tag = 'page', viewport } = {}) {
  const ctx = await browser.newContext({
    colorScheme: scheme,
    viewport: viewport || { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  const problems = [];

  await page.addInitScript(() => {
    window.__cspViolations = [];
    window.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(`${e.blockedURI} (${e.violatedDirective})`);
    });
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('/signal')) return;
    problems.push(`console: ${t}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  page.problems = problems;
  page.tag = tag;
  page.csp = () => page.evaluate(() => window.__cspViolations || []);
  page.shot = async (name) => {
    if (!SHOT_DIR) return;
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
  };
  return page;
}

export class Suite {
  constructor(name) {
    this.name = name;
    this.lines = [];
    this.failed = [];
  }

  ok(title, condition, extra = '') {
    this.lines.push(`${condition ? '✓' : '✗'} ${title}${extra ? ` — ${extra}` : ''}`);
    if (!condition) this.failed.push(title);
    return condition;
  }

  /** 断言之外也记录一条观察值，便于回归时看数字 */
  note(text) {
    this.lines.push(`  · ${text}`);
  }

  /** 顺带把页面错误与 CSP 违规计入失败 */
  async assertClean(...pages) {
    const problems = [];
    for (const p of pages) {
      for (const x of p.problems) problems.push(`[${p.tag}] ${x}`);
      for (const x of await p.csp()) problems.push(`[${p.tag}] CSP ${x}`);
    }
    return this.ok('无控制台错误 / CSP 违规', problems.length === 0, problems.join(' | '));
  }

  report() {
    console.log(`\n=== ${this.name} ===`);
    console.log(this.lines.join('\n'));
    return this.failed.length === 0;
  }
}

export const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${Math.round(n)} B`);

/** 构造一个内存文件并触发 dropzone 的 drop 事件（Playwright 没有原生拖文件 API） */
export async function dropFile(page, { name, type = 'text/plain', content = 'ui test payload' }) {
  await page.evaluate(
    ([n, t, c]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([c], n, { type: t }));
      document
        .getElementById('dropZone')
        .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [name, type, content],
  );
}

/** 触发 window paste 上传（模拟 Ctrl+V 带文件） */
export async function pasteFile(page, { name, type = 'text/plain', content = 'pasted payload' }) {
  await page.evaluate(
    ([n, t, c]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([c], n, { type: t }));
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [name, type, content],
  );
}

/** 在页面上下文里请求 JSON（必须走页面，admin_token 是 httpOnly，外部 request 上下文不带） */
export async function apiJson(page, path, init) {
  const res = await page.evaluate(
    ([p, i]) =>
      fetch(p, i).then(async (r) => ({ status: r.status, body: await r.text() })),
    [path, init || null],
  );
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* 保留原文 */
  }
  return { status: res.status, body: res.body, json };
}

export const randomCode = () => String(1000 + Math.floor(Math.random() * 8999));
