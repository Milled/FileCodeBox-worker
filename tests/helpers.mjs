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
    // 「Failed to load resource: ... 403/401/413」是浏览器对服务端状态码的转述，
    // 而这些状态码本身就是被测试的预期行为；真正的服务端错误由下面的 5xx 监听兜住
    if (/^Failed to load resource/.test(t)) return;
    problems.push(`console: ${t}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });

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

/**
 * 画一张真实可解码的噪声 PNG 再 drop。
 * 噪声是无损压缩的最坏情况（900x600 约 1.6MB），才能验证缩略图确实被缩小了；
 * 用字符串喂 dropFile 是造不出图片的。
 */
export async function dropImage(page, { name = 'photo.png', width = 900, height = 600 } = {}) {
  await page.evaluate(
    ([n, w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h);
      let seed = 20261015;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 16807) % 2147483647; // Lehmer 同余，整数范围内可复现
        img.data[i] = seed % 256;
        img.data[i + 1] = (seed >> 8) % 256;
        img.data[i + 2] = (seed >> 16) % 256;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const url = canvas.toDataURL('image/png');
      const bin = atob(url.slice(url.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], n, { type: 'image/png' }));
      document
        .getElementById('dropZone')
        .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [name, width, height],
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

/**
 * 展开「额外发件设置」。这些字段默认折叠，折叠状态下 Playwright 无法 fill / select，
 * 但表单值仍会正常提交，所以折叠只影响测试操作路径，不影响功能。
 */
export async function expandExtra(page, tab = '#tab-file') {
  const sel = `${tab} details.extra`;
  const open = await page.evaluate((s) => !!document.querySelector(s)?.open, sel);
  if (!open) await page.click(`${sel} > summary`);
  await page.waitForFunction((s) => !!document.querySelector(s)?.open, sel, { timeout: 5000 });
}

/**
 * 逐位写入某一组四格取件码，并等待其同步进对应的隐藏字段。
 * groupId 默认取件那组；发件表单里是 fileCodeBoxes / textCodeBoxes。
 */
export async function fillCodeBoxes(page, code, groupId = 'pickupBoxes') {
  const hiddenId = await page.evaluate((g) => document.getElementById(g)?.dataset.codeTarget, groupId);
  const boxes = page.locator(`#${groupId} .code-box`);
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).fill(code[i] ?? '');
  await page.waitForFunction(
    ([id, c]) => document.getElementById(id)?.value === c,
    [hiddenId, code],
    { timeout: 5000 },
  );
}

/** 悬浮圆圈问号，返回提示气泡是否可见 */
export async function hoverTip(page, label) {
  const tip = page.locator(`label:has-text("${label}") .tip`).first();
  await tip.hover();
  await page.waitForTimeout(250);
  return page.evaluate(
    (l) => {
      const el = [...document.querySelectorAll('label')]
        .find((x) => x.textContent.includes(l))
        ?.querySelector('.tip-bubble');
      if (!el) return { found: false };
      const st = getComputedStyle(el);
      return {
        found: true,
        visible: st.visibility === 'visible' && Number(st.opacity) > 0.5,
        text: el.textContent,
        width: Math.round(el.getBoundingClientRect().width),
        lineHeight: parseFloat(st.lineHeight) || Number(st.fontSize),
      };
    },
    label,
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

const RATE_WINDOW_MS = 60_000;
let lastBreatherAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 上传接口有 10 次 / 60 秒 / IP 的限流（src/shared.ts checkRateLimit），
 * 而每个套件最多用 6 次额度。为保证整段用例都在一个干净窗口里跑：
 *   · 首个套件无条件等满一个窗口（可能是紧接 npm test 之后跑的，预算已被吃掉一部分）
 *   · 后续套件只补齐「距上次开跑不足一个窗口」的差额
 * 只想快速跑一轮且确认额度充足时，用 SKIP_RATE_WAIT=1 跳过。
 */
export async function rateLimitBreather() {
  if (process.env.SKIP_RATE_WAIT === '1') return;
  const wait = lastBreatherAt === 0 ? RATE_WINDOW_MS : RATE_WINDOW_MS - (Date.now() - lastBreatherAt);
  if (wait > 0) {
    console.log(`  · 等待 ${Math.ceil(wait / 1000)}s 让上传限流窗口滚新（SKIP_RATE_WAIT=1 可跳过）`);
    await sleep(wait + 1000);
  }
  lastBreatherAt = Date.now();
}

/**
 * 撞限流时等窗口滚过再重试一次，避免把应用自身的正确限流行为判成用例失败。
 */
export async function postWithinRateLimit(request, url, options, { waitMs = 61_000 } = {}) {
  let res = await request.post(url, options);
  if (res.status() === 429) {
    console.log(`  · 命中上传限流，等待 ${waitMs / 1000}s 后重试`);
    await new Promise((r) => setTimeout(r, waitMs));
    res = await request.post(url, options);
  }
  return res;
}
