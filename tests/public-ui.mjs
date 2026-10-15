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

  // 描边对比度回归：此前 1px + #e4e4e7 压在 #f5f5f7 页面上几乎不可见
  const boxStyle = await light.evaluate(() => {
    const st = getComputedStyle(document.querySelector('#pickupBoxes .code-box'));
    return {
      width: parseFloat(st.borderTopWidth),
      color: st.borderTopColor,
      fill: st.backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
    };
  });
  // Chrome 会把 1.5px 之类的非整数边框向下取整为 1px，所以加粗必须是 2px
  s.ok('四格描边为 2px（加粗已生效）', boxStyle.width >= 2, `${boxStyle.width}px`);
  s.ok('描边颜色与页面底色明显区分', boxStyle.color !== boxStyle.page, `描边 ${boxStyle.color} / 页面 ${boxStyle.page}`);
  s.ok('填充色保持卡片白底未改', boxStyle.fill === 'rgb(255, 255, 255)', boxStyle.fill);
  await light.locator('#pickupBoxes .code-box').first().focus();
  const ring = await light.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
  s.ok('聚焦态有明显外环', ring !== 'none' && /rgba?\(/.test(ring), ring);

  // 覆盖输入：maxlength=1 会让浏览器拒绝在已填格中再输入，必须由 keydown 接管
  await light.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const boxes = light.locator('#pickupBoxes .code-box');
  await boxes.nth(0).fill('1');
  await boxes.nth(1).fill('2');
  await boxes.nth(0).click();
  await light.keyboard.press('9');
  const vals = await light.evaluate(() => [...document.querySelectorAll('#pickupBoxes .code-box')].map((b) => b.value));
  s.ok('已填格直接输入数字即覆盖（无需先删除）', vals[0] === '9' && vals[1] === '2', vals.join(','));
  const focusAfter = await light.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  s.ok('覆盖后焦点继续前进', /第 2 位/.test(focusAfter || ''), focusAfter);
  s.ok('文件/文本切换按钮为加粗', Number(home.tabWeight) >= 600, `font-weight=${home.tabWeight}`);
  s.ok('文本面板无「文本内容」描述', !home.textHasContentLabel);
  s.ok('发件卡去掉「选择文件」描述', !home.sendChooseLabel);
  s.ok('文件与文本表单的自定义取件码都是四格', home.fileCodeBoxes === 4 && home.textCodeBoxes === 4,
    `文件=${home.fileCodeBoxes} 文本=${home.textCodeBoxes}`);
  s.ok('有效期与最大下载次数各带一个悬浮提示', home.tips.length >= 3 && home.tips.every(Boolean), home.tips.join(' / '));

  // 四格输入 → 提交应带出 ?code= 并跳到 /r/码
  // 只填码、不点按钮：四位填满即应自动跳转
  await Promise.all([
    light.waitForNavigation({ url: /\/r\/9999$/, timeout: 15000 }),
    fillCodeBoxes(light, '9999'),
  ]);
  s.ok('四位填满后自动触发取件（未点按钮）', light.url().endsWith('/r/9999'), light.url());

  // 查无此码落地的取件页：四格 + 放大居中的空码提示，且同样自动提交
  const retrieve = await light.evaluate(() => {
    const tip = document.querySelector('.code-empty-tip');
    const st = tip ? getComputedStyle(tip) : null;
    return {
      boxes: document.querySelectorAll('#pickupBoxes .code-box').length,
      form: !!document.querySelector('form[action="/r"]'),
      tipText: tip?.textContent?.trim(),
      align: st?.textAlign,
      size: st ? parseFloat(st.fontSize) : 0,
      prefilled: document.getElementById('pickupCode')?.value,
    };
  });
  s.ok('取件页同样是四格分离输入', retrieve.boxes === 4 && retrieve.form, `格子=${retrieve.boxes}`);
  s.ok('失败的码不回填，四格保持为空', retrieve.prefilled === '', `hidden="${retrieve.prefilled}"`);
  s.ok('空码提示文案正确且居中放大',
    retrieve.tipText === '此取件码为空，请检查后重新输入' && retrieve.align === 'center' && retrieve.size >= 16,
    `${retrieve.tipText}（${retrieve.align} ${retrieve.size}px）`);
  await Promise.all([
    light.waitForNavigation({ url: /\/r\/9998$/, timeout: 15000 }),
    fillCodeBoxes(light, '9998'),
  ]);
  s.ok('取件页重新输入四位后同样自动取件', light.url().endsWith('/r/9998'), light.url());

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

  // 成功视图：与文本一致（有「继续发件」、无下载入口），页头与元信息向取件页对齐
  const sentView = await light.evaluate(() => {
    const box = document.querySelector('.command-box');
    const btn = [...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === '继续发件');
    const b = btn?.getBoundingClientRect();
    const c = box?.getBoundingClientRect();
    const meta = box?.nextElementSibling;
    return {
      h1: document.querySelector('h1')?.textContent?.trim(),
      hasContinue: !!btn,
      continueCentered: !!b && !!c && Math.abs(b.left + b.width / 2 - (c.left + c.width / 2)) < 2,
      continueInBox: !!btn && !!box?.contains(btn),
      nav: [...document.querySelectorAll('.header-actions a')].map((a) => a.textContent?.trim()),
      metaClass: meta?.className,
      metaParts: [...(meta?.querySelectorAll('span') || [])].map((x) => x.textContent?.trim()),
      hasDownload: !!document.querySelector('a[href^="/api/download/"]'),
      url: location.href,
    };
  });
  s.ok('文件上传后落在成功视图（与文本一致，无下载入口）',
    /sent=1$/.test(sentView.url) && sentView.h1 === '发件成功' && sentView.hasContinue && !sentView.hasDownload,
    `h1=${sentView.h1} 继续发件=${sentView.hasContinue} 下载=${sentView.hasDownload}`);
  s.ok('「继续发件」在内容框内水平居中', sentView.continueInBox && sentView.continueCentered);
  s.ok('成功页页头为发件 / 取件 / 管理',
    JSON.stringify(sentView.nav) === JSON.stringify(['发件', '取件', '管理']), sentView.nav.join(' / '));
  s.ok('成功页元信息与取件页一致（大小 / 下载次数 / 过期时间）',
    sentView.metaClass === 'meta-row' && sentView.metaParts.length === 3
      && /B|KB|MB/.test(sentView.metaParts[0]) && /已下载/.test(sentView.metaParts[1]) && /过期|永久/.test(sentView.metaParts[2]),
    sentView.metaParts.join(' · '));

  // 非图片没有缩略图，但应与取件页一样有文件示意图，且居中
  const iconBox = await light.evaluate(() => {
    const icon = document.querySelector('.command-box .file-icon');
    if (!icon) return null;
    const b = icon.getBoundingClientRect();
    const c = icon.closest('.command-box').getBoundingClientRect();
    return { gapL: b.left - c.left, gapR: c.right - b.right, w: b.width, h: b.height };
  });
  s.ok('非图片成功页显示文件图标且居中（与取件页一致）',
    !!iconBox && iconBox.w === 56 && iconBox.h === 56 && Math.abs(iconBox.gapL - iconBox.gapR) < 2,
    iconBox ? `${iconBox.w}x${iconBox.h} 左右间距 ${Math.round(iconBox.gapL)}/${Math.round(iconBox.gapR)}` : '无图标');
  await light.shot('public-retrieve-light');

  await dark.goto(`${BASE}/r/${fileCode}`, { waitUntil: 'networkidle' });
  // 收件人视图（不带 sent）必须仍然可下载
  const dlHref = await dark.locator('a:has-text("下载文件")').first().getAttribute('href').catch(() => null);
  s.ok('收件人取件页仍可下载（未被 sent 视图影响）', /^\/api\/download\/\d{4}$/.test(dlHref || ''), String(dlHref));
  const recvNav = await dark.evaluate(() => [...document.querySelectorAll('.header-actions a')].map((a) => a.textContent?.trim()));
  s.ok('取件页页头同样为发件 / 取件 / 管理',
    JSON.stringify(recvNav) === JSON.stringify(['发件', '取件', '管理']), recvNav.join(' / '));
  await dark.shot('public-retrieve-dark');

  // 文本分享 → 结果页 → 取件页
  await light.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await light.click('.tab[data-tab="text"]');
  await light.fill('#textInput', '公开页回归文本\n第二行 alpha');
  await Promise.all([light.waitForNavigation({ timeout: 30000 }), light.click('#textSubmitBtn')]);
  s.ok('文本分享渲染结果页且取件码合法',
    (await light.locator('h1').first().textContent())?.trim() === '发件成功',
    `code=${await light.locator('.code-value').first().textContent()}`);

  // 结果页必须显示所发正文；此前只有字节数（如 "4 B"），会让人以为内容没传上去
  const shownOnResult = (await light.textContent('.command-text')) || '';
  s.ok('结果页显示所发文本正文',
    shownOnResult.includes('公开页回归文本') && shownOnResult.includes('第二行 alpha'),
    JSON.stringify(shownOnResult.slice(0, 24)));
  const sizeLine = (await light.textContent('.meta-row')) || '';
  s.ok('字节数仍作为元信息保留', /\d+(\.\d+)? (B|KB|MB)/.test(sizeLine), sizeLine.trim());
  s.ok('文本结果页以正文为预览，不叠文件图标',
    (await light.locator('.command-text').count()) === 1 && (await light.locator('.file-icon').count()) === 0);
  // 结果页现在带正文，必须 no-store，否则 CDN 可能把私密内容留在边缘节点
  const cacheProbe = await light.context().request.post(`${BASE}/api/upload/text`, {
    form: { text: 'cache header probe', expire_style: 'day', expire_value: '1', max_downloads: '-1' },
  });
  const cacheCtl = cacheProbe.headers()['cache-control'];
  s.ok('文本结果页禁止缓存（含正文）', cacheProbe.status() === 200 && cacheCtl === 'no-store', `${cacheProbe.status()} / ${cacheCtl}`);

  const tCode = (await light.locator('.code-value').first().textContent() || '').trim();

  // 正文按纯文本转义，不能执行内联标签
  await light.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await light.click('.tab[data-tab="text"]');
  await light.fill('#textInput', '前缀 <img src=x onerror="window.__xss=1"> 后缀');
  await Promise.all([light.waitForNavigation({ timeout: 30000 }), light.click('#textSubmitBtn')]);
  const xss = await light.evaluate(() => ({
    injected: window.__xss === 1,
    imgCount: document.querySelectorAll('.command-text img').length,
    text: document.querySelector('.command-text')?.textContent || '',
  }));

  s.ok('正文转义为纯文本，不执行内联标签',
    !xss.injected && xss.imgCount === 0 && xss.text.includes('<img src=x'),
    JSON.stringify(xss.text.slice(0, 30)));

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
