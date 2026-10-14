/**
 * 后台回归：统计卡、设置页、openUpload 全局生效、上限覆盖与回退
 *
 * 注意：本套件会修改 fc_settings（结束时恢复默认值），只应对本地或你自己的环境运行。
 */
import { BASE, ADMIN_PASSWORD, SHOT_DIR, newPage, Suite, apiJson, postWithinRateLimit, rateLimitBreather } from './helpers.mjs';

const TWO_MB = Buffer.alloc(2 * 1024 * 1024, 'x');
const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
};

export async function adminSettingsSuite(browser) {
  const s = new Suite('后台设置与统计回归');
  const admin = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const anon = await browser.newContext();
  const page = await admin.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const save = async () => {
    await Promise.all([page.waitForNavigation({ timeout: 30000 }), page.click('form[action="/admin/settings"] button[type="submit"]')]);
  };

  try {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await rateLimitBreather();
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    s.ok('表单登录进入面板', page.url().endsWith('/admin'), page.url());

    const cards = await page.locator('.stat-card').count();
    const values = await page.locator('.stat-value').allTextContents();
    const header = (await page.textContent('.header p')) || '';
    s.ok('仪表盘渲染 4 张统计卡', cards === 4, values.join(' / '));
    s.ok('统计卡总数与列表总数一致', values[0] === header.replace(/\D/g, ''), `卡片=${values[0]} 头部=${header.trim()}`);
    await shot(page, 'admin-dashboard');

    const row = page.locator('.file-list-item').first();
    s.ok('文件行带类型标签', (await row.locator('.tag').count()) === 1, (await row.locator('.tag').textContent())?.trim());
    const href = await row.locator('a.fname').getAttribute('href');
    s.ok('文件行可点进取件页', /^\/r\/\d{4}$/.test(href || ''), href || 'null');

    await page.click('.header-actions a[href="/admin/settings"]');
    await page.waitForLoadState('networkidle');
    s.ok('导航进入设置页', page.url().endsWith('/admin/settings'), page.url());
    const before = await apiJson(page, '/api/admin/config/get');
    const varsMax = before.json?.detail?.maxFileSize;
    s.ok('设置页显示当前生效值', (await page.inputValue('input[name="maxFileSize"]')) === varsMax, `maxFileSize=${varsMax}`);

    // ---- 关闭游客上传 ----
    await page.selectOption('select[name="openUpload"]', '0');
    await save();
    s.ok('保存后回显成功提示', /设置已保存/.test((await page.textContent('body')) || ''));

    const anonPage = await newPage(browser, { tag: 'anon' });
    await anonPage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    s.ok('关闭后首页显示游客受限空态',
      (await anonPage.locator('.empty-state').count()) === 1 &&
        /游客上传已关闭/.test((await anonPage.textContent('.empty-title')) || ''));
    await shot(anonPage, 'home-guest-blocked');
    await anonPage.close();

    const rHome = await anon.request.post(`${BASE}/api/upload`, { data: 'x', headers: { 'X-Filename': 'a.txt' } });
    s.ok('首页 /api/upload 被拦（此前不受该开关控制）', rHome.status() === 401, `${rHome.status()} ${await rHome.text()}`);
    const rShare = await anon.request.post(`${BASE}/api/share/file`, { data: 'x' });
    s.ok('兼容 API /api/share/file 同样被拦', (await rShare.json())?.code === 401, await rShare.text());

    const asAdmin = await apiJson(page, '/api/upload', { method: 'POST', body: '管理员内容', headers: { 'X-Filename': 'admin.txt' } });
    s.ok('管理员会话仍可上传', asAdmin.status === 200 && /^\d{4}$/.test(asAdmin.json?.code || ''), asAdmin.body);

    // ---- 上限覆盖与回退（先恢复游客上传，否则匿名请求会先撞上 openUpload 的 401） ----
    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
    await page.selectOption('select[name="openUpload"]', '1');
    await page.fill('input[name="maxFileSize"]', '1048576');
    await save();
    const rBig = await postWithinRateLimit(anon.request, `${BASE}/api/upload`, { data: TWO_MB, headers: { 'X-Filename': 'big2m.bin' } });
    const bigText = await rBig.text();
    s.ok('上限改 1MB 后 2MB 立即被拒（无需重新部署）', rBig.status() === 413 && /最大 1MB/.test(bigText), `${rBig.status()} ${bigText}`);

    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
    await page.fill('input[name="maxFileSize"]', '');
    await save();
    const rBack = await postWithinRateLimit(anon.request, `${BASE}/api/upload`, { data: TWO_MB, headers: { 'X-Filename': 'big2m-again.bin' } });
    s.ok('清空设置后回退到 wrangler vars', rBack.status() === 200, await rBack.text());

    const after = await apiJson(page, '/api/admin/config/get');
    s.ok('config/get 回报实际生效值', after.json?.detail?.maxFileSize === varsMax, after.body);
  } finally {
    // 无论如何都恢复默认，避免污染后续套件
    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.selectOption('select[name="openUpload"]', '1').catch(() => {});
    await page.fill('input[name="maxFileSize"]', '').catch(() => {});
    await page.fill('input[name="defaultExpireDays"]', '').catch(() => {});
    await save().catch(() => {});
    s.note('已恢复 openUpload=1 并清空大小/过期覆盖');
  }

  s.ok('无页面异常', problems.length === 0, problems.join(' | '));
  await admin.close();
  await anon.close();
  return s;
}
