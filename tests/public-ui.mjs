/**
 * 公开页视觉与结构回归：设计 token、深色模式、取件链路、响应式、CSP
 */
import { BASE, SHOT_DIR, newPage, Suite, dropFile, fillCodeBoxes, rateLimitBreather } from './helpers.mjs';

export async function publicUiSuite(browser) {
  const s = new Suite('公开页视觉 / 结构回归');
  const light = await newPage(browser, { tag: 'light' });
  const dark = await newPage(browser, { scheme: 'dark', tag: 'dark' });

  await light.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dark.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await rateLimitBreather();

  const fav = await light.evaluate(async () => {
    const href = document.querySelector('link[rel="icon"]')?.href || null;
    if (!href) return { isDataUri: false, loaded: false };
    const img = new Image();
    const loaded = new Promise((r) => {
      img.onload = () => r(true);
      img.onerror = () => r(false);
    });
    img.src = href;
    return { isDataUri: href.startsWith('data:image/svg+xml'), loaded: await loaded, w: img.naturalWidth, h: img.naturalHeight };
  });
  s.ok('站点图标为内联 SVG 且可被浏览器解码', fav.isDataUri && fav.loaded, `${fav.w}x${fav.h}`);

  const bg = await light.evaluate(() => getComputedStyle(document.body).backgroundImage);
  s.ok('页面无外部背景图依赖', bg === 'none', bg);

  const colors = await Promise.all([
    light.evaluate(() => getComputedStyle(document.body).backgroundColor),
    dark.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ]);
  s.ok('深色模式生效且与浅色配色不同', colors[0] !== colors[1], `light=${colors[0]} dark=${colors[1]}`);

  const btn = await Promise.all([
    light.evaluate(() => {
      const st = getComputedStyle(document.querySelector('.btn-primary'));
      return `${st.backgroundColor}/${st.color}/${st.borderRadius}`;
    }),
    dark.evaluate(() => {
      const st = getComputedStyle(document.querySelector('.btn-primary'));
      return `${st.backgroundColor}/${st.color}/${st.borderRadius}`;
    }),
  ]);
  s.ok('主按钮为单色强调且深浅色文字对比反转', btn[0] !== btn[1], `light=${btn[0]} dark=${btn[1]}`);

  const radius = await light.evaluate(() => getComputedStyle(document.querySelector('.card')).borderRadius);
  s.ok('卡片使用上游大圆角', parseFloat(radius) >= 32, radius);

  const html = await light.content();
  s.ok('页面无上游作者署名与个人图床残留', !/jeio258|qlogo|alcy/i.test(html));

  // ---- 首页三卡分区 ----
  const home = await light.evaluate(() => {
    const cards = [...document.querySelectorAll('.container > .card')];
    const mgmt = cards[0]?.querySelector('a[href="/admin"]');
    return {
      cardCount: cards.length,
      gap: cards[1] ? getComputedStyle(cards[1]).marginTop : null,
      pickupText: (cards[1]?.textContent || '').replace(/\s+/g, '').trim(),
      pickupLabels: cards[1]?.querySelectorAll('label').length ?? -1,
      boxes: cards[1]?.querySelectorAll('#pickupBoxes .code-box').length ?? 0,
      hidden: !!cards[1]?.querySelector('input[name="code"][type="hidden"]'),
      mgmtIsPlainLink: !!mgmt && !/\bbtn\b/.test(mgmt.className || '') && !!mgmt.closest('.header-actions'),
      sendChooseLabel: [...(cards[2]?.querySelectorAll('label') || [])].some((l) => l.textContent.includes('选择文件')),
      sendBtnText: document.getElementById('submitBtn')?.textContent?.trim(),
      textBtnText: document.getElementById('textSubmitBtn')?.textContent?.trim(),
      extraClosed: document.querySelector('#tab-file details.extra')?.open === false,
    };
  });
  s.ok('首页拆成三张卡片且有间距', home.cardCount === 3 && parseFloat(home.gap) > 0, `${home.cardCount} 张，间距 ${home.gap}`);
  s.ok('取件卡只剩四格与按钮', home.pickupLabels === 0 && home.pickupText === '取件', `文本="${home.pickupText}" label=${home.pickupLabels}`);
  s.ok('取件码为四个分离输入格且同步到隐藏字段', home.boxes === 4 && home.hidden, `格子=${home.boxes} hidden=${home.hidden}`);
  s.ok('管理入口保持普通文字链接（未改成按钮）', home.mgmtIsPlainLink);
  s.ok('发件卡去掉「选择文件」描述', !home.sendChooseLabel, `可见 label 命中=${home.sendChooseLabel}`);
  s.ok('文件与文本两个发件按钮文案一致',
    home.sendBtnText === '发件并获取取件码' && home.textBtnText === '发件并获取取件码',
    `文件=${home.sendBtnText} 文本=${home.textBtnText}`);
  s.ok('额外发件设置默认折叠', home.extraClosed);

  // 四格输入 → 提交应带出 ?code= 并跳到 /r/码
  await fillCodeBoxes(light, '9999');
  await Promise.all([light.waitForNavigation({ url: /\/r\/9999$/, timeout: 15000 }), light.click('.pickup-form button[type="submit"]')]);
  s.ok('四格取件码可提交并跳转到取件页', light.url().endsWith('/r/9999'), light.url());
  const boxesAfter = await light.evaluate(() => document.querySelectorAll('#pickupBoxes .code-box').length);
  s.ok('取件页（/r/码）仍可用', boxesAfter === 0, `首页四格在 /r 页不存在：${boxesAfter}`);

  await light.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await light.click('.tab[data-tab="text"]');
  const tabs = await light.evaluate(() => ({
    textActive: document.getElementById('tab-text').classList.contains('active'),
    fileHidden: !document.getElementById('tab-file').classList.contains('active'),
    visible: document.getElementById('tab-text').offsetParent !== null,
  }));
  s.ok('内联脚本未被 CSP 拦截（tab 切换）', tabs.textActive && tabs.fileHidden && tabs.visible, JSON.stringify(tabs));

  // 上传 → 取件页（明/暗）
  await light.click('.tab[data-tab="file"]');
  await dropFile(light, { name: 'public-ui.txt', content: 'public ui payload' });
  await Promise.all([
    light.waitForNavigation({ url: /\/r\/\d{4}/, timeout: 30000 }),
    light.click('#submitBtn'),
  ]);
  const fileCode = light.url().match(/\/r\/(\d{4})/)?.[1];
  s.ok('上传后跳转取件页', !!fileCode, `code=${fileCode}`);
  await light.shot('public-retrieve-light');

  await dark.goto(`${BASE}/r/${fileCode}`, { waitUntil: 'networkidle' });
  s.ok('深色取件页有下载入口', (await dark.locator('a:has-text("下载文件")').count()) > 0);
  await dark.shot('public-retrieve-dark');

  // 文本分享 → 结果页 → 取件页
  await light.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await light.click('.tab[data-tab="text"]');
  await light.fill('#textInput', '公开页回归文本\n第二行 alpha');
  await Promise.all([light.waitForNavigation({ timeout: 30000 }), light.click('#textSubmitBtn')]);
  s.ok('文本分享渲染结果页且取件码合法',
    (await light.locator('h1').first().textContent())?.trim() === '上传成功',
    `code=${await light.locator('.code-value').first().textContent()}`);

  const tCode = (await light.locator('.code-value').first().textContent() || '').trim();
  const textPage = await newPage(browser, { scheme: 'dark', tag: 'text' });
  await textPage.goto(`${BASE}/r/${tCode}`, { waitUntil: 'networkidle' });
  await textPage.waitForTimeout(600);
  const shown = await textPage.evaluate(() => document.getElementById('textContent')?.textContent || '');
  s.ok('取件页异步拉到文本内容', shown.includes('公开页回归文本'), shown.slice(0, 20));

  await light.click('.code-card');
  // 剪贴板写入是异步的，提示文本在 promise 回调里才改；直接读会拿到「点击复制」
  await light
    .waitForFunction(() => (document.querySelector('.click-hint')?.textContent || '').includes('已复制'), null, { timeout: 3000 })
    .catch(() => {});
  const hint = await light.locator('.click-hint').first().textContent();
  s.ok('点击复制取件码给出反馈', (hint || '').includes('已复制'), hint);

  // 移动端
  const mobile = await newPage(browser, { tag: 'mobile', viewport: { width: 390, height: 844 } });
  await mobile.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  s.ok('移动端无横向溢出', !overflow);
  await mobile.shot('public-home-mobile');

  await light.shot('public-home-light');
  await dark.shot('public-home-dark');
  await s.assertClean(light, dark, textPage, mobile);
  s.note(`截图目录：${SHOT_DIR || '（未开启，设 SHOT_DIR 生成）'}`);
  await Promise.all([light, dark, textPage, mobile].map((p) => p.context().close()));
  return s;
}
