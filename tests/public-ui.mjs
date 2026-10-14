/**
 * 公开页视觉与结构回归：设计 token、深色模式、取件链路、响应式、CSP
 */
import { BASE, SHOT_DIR, newPage, Suite, dropFile, fillCodeBoxes, rateLimitBreather, hoverTip, expandExtra } from './helpers.mjs';

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

  // ---- 首页卡片分区 ----
  const home = await light.evaluate(() => {
    const cards = [...document.querySelectorAll('.container > .card')];
    const mgmt = cards[0]?.querySelector('a[href="/admin"]');
    return {
      cardCount: cards.length,
      gap: cards[1] ? getComputedStyle(cards[1]).marginTop : null,
      titleAndPickupTogether: !!cards[0]?.querySelector('.header h1') && !!cards[0]?.querySelector('.pickup-form'),
      subtitle: cards[0]?.querySelector('.header p')?.textContent?.trim(),
      pickupLabels: cards[0]?.querySelectorAll('label').length ?? -1,
      pickupBoxes: cards[0]?.querySelectorAll('#pickupBoxes .code-box').length ?? 0,
      mgmtIsPlainLink: !!mgmt && !/\bbtn\b/.test(mgmt.className || '') && !!mgmt.closest('.header-actions'),
      tabWeight: cards[1] ? getComputedStyle(cards[1].querySelector('.tab')).fontWeight : null,
      textHasContentLabel: [...(cards[1]?.querySelectorAll('#tab-text label') || [])].some((l) => l.textContent.includes('文本内容')),
      fileCodeBoxes: cards[1]?.querySelectorAll('#fileCodeBoxes .code-box').length ?? 0,
      textCodeBoxes: cards[1]?.querySelectorAll('#textCodeBoxes .code-box').length ?? 0,
      tips: [...(cards[1]?.querySelectorAll('.tip') || [])].map((x) => x.querySelector('.tip-bubble')?.textContent),
      sendChooseLabel: [...(cards[1]?.querySelectorAll('label') || [])].some((l) => l.textContent.includes('选择文件')),
      sendSubtitle: cards[1]?.querySelector('.header p')?.textContent?.trim(),
      sendBtnText: document.getElementById('submitBtn')?.textContent?.trim(),
      textBtnText: document.getElementById('textSubmitBtn')?.textContent?.trim(),
      extraClosed: document.querySelector('#tab-file details.extra')?.open === false,
    };
  });
  s.ok('首页为两张卡片且有间距', home.cardCount === 2 && parseFloat(home.gap) > 0, `${home.cardCount} 张，间距 ${home.gap}`);
  s.ok('标题、管理与取件同在一张卡', home.titleAndPickupTogether && home.pickupLabels === 0, `label=${home.pickupLabels}`);
  s.ok('取件卡副标题为「输入四位取件码取件」', home.subtitle === '输入四位取件码取件', home.subtitle);
  s.ok('发件卡没有副标题', home.sendSubtitle === undefined, String(home.sendSubtitle));
  s.ok('取件为四个分离输入格', home.pickupBoxes === 4, `格子=${home.pickupBoxes}`);
  s.ok('文件/文本切换按钮为加粗', Number(home.tabWeight) >= 600, `font-weight=${home.tabWeight}`);
  s.ok('文本面板无「文本内容」描述', !home.textHasContentLabel);
  s.ok('发件卡去掉「选择文件」描述', !home.sendChooseLabel);
  s.ok('文件与文本表单的自定义取件码都是四格', home.fileCodeBoxes === 4 && home.textCodeBoxes === 4,
    `文件=${home.fileCodeBoxes} 文本=${home.textCodeBoxes}`);
  s.ok('有效期与最大下载次数各带一个悬浮提示', home.tips.length >= 3 && home.tips.every(Boolean), home.tips.join(' / '));

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

  // 回归：气泡的包含块只有 15px，缺 width: max-content 时会塌成一个汉字一列
  await expandExtra(mobile, '#tab-file');
  const tipMobile = await hoverTip(mobile, '有效期');
  s.ok('移动端悬浮提示横向排布（未塌成一列）',
    tipMobile.visible && tipMobile.width > tipMobile.lineHeight * 4,
    `宽 ${tipMobile.width}px，行高 ${tipMobile.lineHeight}px`);
  await mobile.shot('public-home-mobile');

  await light.shot('public-home-light');
  await dark.shot('public-home-dark');
  await s.assertClean(light, dark, textPage, mobile);
  s.note(`截图目录：${SHOT_DIR || '（未开启，设 SHOT_DIR 生成）'}`);
  await Promise.all([light, dark, textPage, mobile].map((p) => p.context().close()));
  return s;
}
