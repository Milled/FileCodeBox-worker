/**
 * 上传交互回归：拖拽 / 粘贴 / 多文件 / 进度明细 / 有效期方式 / 前端限额 / 取件码作用域
 */
import { BASE, newPage, Suite, dropFile, pasteFile, apiJson, randomCode, expandExtra, fillCodeBoxes, rateLimitBreather } from './helpers.mjs';

export async function uploadInteractionsSuite(browser) {
  const s = new Suite('上传交互回归');
  const page = await newPage(browser, { tag: 'upload' });
  const info = async (code) => (await apiJson(page, `/api/info/${code}`)).json;

  // ---- 文件选择 ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await rateLimitBreather();
  await dropFile(page, { name: 'dropped-a.txt', content: '拖拽上传的内容' });
  s.ok('拖拽 drop 生成文件 chip', (await page.locator('.file-chip').count()) === 1,
    (await page.locator('.chip-name').first().textContent()) || '');

  await pasteFile(page, { name: 'pasted-b.txt', content: '粘贴上传的内容' });
  s.ok('全局 paste 追加文件', (await page.locator('.file-chip').count()) === 2);

  await page.locator('.chip-remove').last().click();
  s.ok('chip 移除按钮生效', (await page.locator('.file-chip').count()) === 1);

  await dropFile(page, { name: 'second-c.txt', content: '第二个文件' });
  s.ok('重复文件名不会互相吞掉', (await page.locator('.file-chip').count()) === 2);

  s.ok('额外发件设置默认折叠',
    await page.evaluate(() => document.querySelector('#tab-file details.extra')?.open === false));

  // ---- 有效期：按次数（字段在「额外发件设置」里，默认折叠） ----
  await expandExtra(page, '#tab-file');
  await page.selectOption('#fileExpireStyle', 'count');
  await page.fill('#fileExpireValue', '3');
  await page.dispatchEvent('#fileExpireValue', 'input');
  const linked = await page.evaluate(() => {
    const m = document.getElementById('fileMaxDownloads');
    return { disabled: m.disabled, value: m.value };
  });
  s.ok('选「次后失效」时最大下载次数被联动锁定', linked.disabled && linked.value === '3', JSON.stringify(linked));

  // ---- 步进器 ----
  await page.selectOption('#fileExpireStyle', 'day');
  await page.fill('#fileExpireValue', '5');
  await page.dispatchEvent('#fileExpireValue', 'input');
  await page.locator('#tab-file .stepper button[data-step="1"]').click();
  s.ok('stepper +1 生效', (await page.inputValue('#fileExpireValue')) === '6');

  // ---- 多文件顺序上传 ----
  // 两个文件时自定义码字段必须已被禁用（一个码只能对应一个文件），改用服务端连号
  const batchField = await page.evaluate(() => {
    const g = document.getElementById('fileCodeBoxes');
    return {
      disabled: [...g.querySelectorAll('input')].every((b) => b.disabled),
      dimmed: g.classList.contains('is-disabled'),
      hint: document.getElementById('fileCodeHint').textContent,
    };
  });
  s.ok('多文件时自定义取件码字段被禁用并说明连号',
    batchField.disabled && batchField.dimmed && /连号/.test(batchField.hint), batchField.hint);

  await Promise.all([
    page.waitForFunction(() => document.querySelectorAll('.result-item').length === 2, null, { timeout: 30000 }),
    page.click('#submitBtn'),
  ]);
  const codes = await page.locator('.result-item .rcode').allTextContents();
  s.ok('多文件逐个上传并返回多个取件码', codes.length === 2 && codes.every((c) => /^\d{4}$/.test(c)), codes.join(','));
  // 连号按环形判定：9999 后面接 0000 也算连续
  const step = (parseInt(codes[1], 10) - parseInt(codes[0], 10) + 10000) % 10000;
  s.ok('多文件的取件码是服务端分配的连号且未被占用', step === 1, codes.join(' → '));

  const status = await page.textContent('#uploadStatus');
  s.ok('完成态显示文件数与耗时', /全部完成 · 2 个文件/.test(status || ''), status);

  const meta = await page.textContent('#uploadMeta');
  s.ok('进度明细含字节与速率', /\/.* · .*(B|KB|MB)\/s/.test(meta || ''), meta);

  // ---- 有效期语义真的落到后端 ----
  const i0 = await info(codes[0]);
  s.ok('expire_style=count 写入 max_downloads', i0?.max_downloads === 3, `max_downloads=${i0?.max_downloads}`);

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dropFile(page, { name: 'hour.txt', content: '小时有效期' });
  await expandExtra(page, '#tab-file');
  await page.selectOption('#fileExpireStyle', 'hour');
  await page.fill('#fileExpireValue', '2');
  await page.dispatchEvent('#fileExpireValue', 'input');
  const [navHour] = await Promise.all([page.waitForNavigation({ url: /\/r\/\d{4}/ }), page.click('#submitBtn')]);
  const hourCode = navHour.url().match(/\/r\/(\d{4})/)[1];
  const hours = (new Date((await info(hourCode)).expire_at).getTime() - Date.now()) / 3600000;
  s.ok('expire_style=hour 过期时间约 2 小时后', hours > 1.9 && hours < 2.1, `${hours.toFixed(3)}h`);

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dropFile(page, { name: 'forever.txt', content: '永久有效期' });
  await expandExtra(page, '#tab-file');
  await page.selectOption('#fileExpireStyle', 'forever');
  s.ok('选「永久」时数值输入被禁用', await page.evaluate(() => document.getElementById('fileExpireValue').disabled));
  const [navF] = await Promise.all([page.waitForNavigation({ url: /\/r\/\d{4}/ }), page.click('#submitBtn')]);
  const fCode = navF.url().match(/\/r\/(\d{4})/)[1];
  const years = (new Date((await info(fCode)).expire_at).getTime() - Date.now()) / (365 * 86400000);
  s.ok('expire_style=forever 落到约 100 年后', years > 95 && years < 105, `${years.toFixed(1)} 年`);
  // 上传后落在成功视图（?sent=1），有效期只在收件人页面呈现
  await page.goto(`${BASE}/r/${fCode}`, { waitUntil: 'networkidle' });
  s.ok('取件页把永久显示为「永久有效」', /永久有效/.test((await page.textContent('.meta-row')) || ''));

  // ---- 文本字节与 512KB 前端拦截 ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.click('.tab[data-tab="text"]');
  await page.fill('#textInput', '一二三四五');
  s.ok('文本字节计数按 UTF-8 计算', (await page.textContent('#textBytes')) === '15 B', await page.textContent('#textBytes'));

  await page.fill('#textInput', 'x'.repeat(600 * 1024));
  let dialogText = '';
  page.on('dialog', async (d) => {
    dialogText = d.message();
    await d.dismiss();
  });
  await page.click('#textSubmitBtn');
  await page.waitForTimeout(500);
  s.ok('超过 512KB 时前端拦截提交', /512KB/.test(dialogText) && page.url() === `${BASE}/`, dialogText);

  // ---- 发件体积上限的前端拦截 ----
  // 上限值由服务端渲染进 data-max-bytes；这里改小该属性来模拟小上限，
  // 避免为了造一个 25MB 文件而真上传一次（服务端 413 由后台套件覆盖）
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('dropZone').setAttribute('data-max-bytes', '100'));
  await dropFile(page, { name: 'big.bin', content: 'x'.repeat(200) });
  await dropFile(page, { name: 'small.txt', content: 'tiny' });
  const over = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('.file-chip')].map((c) => ({
      n: c.querySelector('.chip-name').textContent,
      over: c.classList.contains('chip-over'),
    })),
    notice: document.getElementById('uploadNotice').hidden ? '' : document.getElementById('uploadNotice').textContent,
  }));
  s.ok('超限文件仍进列表但被标红，正常文件不受影响',
    over.chips.length === 2 && over.chips[0].over && !over.chips[1].over, JSON.stringify(over.chips));
  s.ok('行内提示条点名超限文件（不用 alert 阻断）', /big\.bin/.test(over.notice) && /100 B/.test(over.notice), over.notice);

  await page.click('#submitBtn');
  await page.waitForTimeout(1200);
  const blocked = await page.evaluate(() => ({
    url: location.href,
    status: document.getElementById('uploadStatus').textContent,
    shown: getComputedStyle(document.getElementById('uploadStatus')).display !== 'none',
    disabled: document.getElementById('submitBtn').disabled,
  }));
  s.ok('存在超限文件时提交被整批拦下',
    blocked.url === `${BASE}/` && blocked.shown && /未开始上传/.test(blocked.status) && !blocked.disabled, blocked.status);

  // ---- 多文件批次：单个失败不中断其余 ----
  // 连号方案下两个文件不可能再撞码，所以改用请求拦截让第一个文件被服务端拒绝
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  let uploadReqs = 0;
  await page.route((u) => u.pathname === '/api/upload', async (route) => {
    uploadReqs += 1;
    if (uploadReqs === 1) {
      await route.fulfill({
        status: 413,
        contentType: 'application/json',
        body: JSON.stringify({ error: '文件过大，最大 25MB' }),
      });
      return;
    }
    await route.continue();
  });
  await dropFile(page, { name: 'first.txt', content: '第一个文件' });
  await dropFile(page, { name: 'second.txt', content: '第二个文件' });
  await Promise.all([
    page.waitForFunction(() => document.querySelectorAll('.result-item').length === 2, null, { timeout: 30000 }),
    page.click('#submitBtn'),
  ]);
  await page.unroute((u) => u.pathname === '/api/upload');
  const batch = await page.evaluate(() => ({
    status: document.getElementById('uploadStatus').textContent,
    ok: document.querySelectorAll('.result-item:not(.result-failed) .rcode').length,
    fail: [...document.querySelectorAll('.result-failed .rfail')].map((e) => e.textContent),
    kept: [...document.querySelectorAll('.file-chip .chip-name')].map((e) => e.textContent),
  }));
  s.ok('单个文件失败不中断整批，并汇总成败',
    /成功 1 个 · 失败 1 个/.test(batch.status) && batch.ok === 1 && batch.fail.length === 1 && /25MB/.test(batch.fail[0]),
    `${batch.status} | ${batch.fail.join(',')}`);
  s.ok('失败的那个保留在待传列表里', batch.kept.length === 1 && batch.kept[0] === 'first.txt', batch.kept.join(','));

  // ---- 连号分配端点的边界 ----
  const badCounts = [];
  for (const n of [1, 21, 999, 'abc']) {
    badCounts.push(`${n}→${(await apiJson(page, `/api/codes/${n}`)).status}`);
  }
  s.ok('count 越界或非数字被拒（422）', badCounts.every((x) => /→422$/.test(x)), badCounts.join(' '));

  const four = (await apiJson(page, '/api/codes/4')).json?.codes || [];
  const fourStep = four.length === 4 && four.slice(1).every((c, i) => (Number(c) - Number(four[i]) + 10000) % 10000 === 1);
  const freeStatuses = [];
  for (const c of four) freeStatuses.push((await apiJson(page, `/api/info/${c}`)).status);
  s.ok('返回 4 个连号且都未被占用', fourStep && freeStatuses.every((x) => x === 404), `${four.join(',')} info=${freeStatuses.join(',')}`);

  // ---- 自定义取件码作用域（历史 bug：会误读页顶取件框） ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  // 页顶取件框只填三位：不足四位不会自动跳转，才能继续验证后面的发件表单
  await fillCodeBoxes(page, '999');
  await dropFile(page, { name: 'custom.txt', content: '自定义码' });
  await expandExtra(page, '#tab-file');
  const want = randomCode();
  await fillCodeBoxes(page, want, 'fileCodeBoxes');
  const [navC] = await Promise.all([page.waitForNavigation({ url: /\/r\/\d{4}/ }), page.click('#submitBtn')]);
  // 回跳带 ?sent=1 成功视图标识，取件码本身仍须来自上传表单
  s.ok('自定义取件码取自上传表单而非页顶取件框',
    navC.url().startsWith(`${BASE}/r/${want}?`), navC.url());

  // ---- 文本分享达到最大查看次数后，标题必须遮蔽 ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.click('.tab[data-tab="text"]');
  await expandExtra(page, '#tab-text');
  const secret = '绝密内容不该出现在标题 ' + Date.now();
  await page.fill('#textInput', secret);
  await page.selectOption('#textExpireStyle', 'count');
  await page.fill('#textExpireValue', '1');
  await page.dispatchEvent('#textExpireValue', 'input');
  await Promise.all([page.waitForNavigation({ timeout: 30000 }), page.click('#textSubmitBtn')]);
  const limitCode = (await page.locator('.code-value').first().textContent() || '').trim();
  await page.goto(`${BASE}/r/${limitCode}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const firstTitle = ((await page.textContent('.share-title')) || '').trim();
  s.ok('未耗尽时标题照常显示', firstTitle.startsWith('绝密内容不该出现在标题'), firstTitle.slice(0, 14));

  await page.goto(`${BASE}/r/${limitCode}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const secondTitle = ((await page.textContent('.share-title')) || '').trim();
  const secondBody = ((await page.textContent('#textContent')) || '').trim();
  s.ok('达到最大查看次数后标题遮蔽为 ***', secondTitle === '***', secondTitle);
  s.ok('遮蔽后正文提示已达上限', /最大查看次数/.test(secondBody), secondBody.slice(0, 20));

  await s.assertClean(page);
  await page.context().close();
  return s;
}
