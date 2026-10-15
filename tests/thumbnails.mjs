/**
 * 图片缩略图回归：浏览器端生成 → 两个落地页渲染 → 体积/尺寸上限 → 隐私边界 → 回退
 *
 * 缩略图是文件内容的第二份副本，所以除了「有没有显示」，更要紧的是
 * 「不该显示的时候确实取不到」（额度耗尽、非图片、伪造请求）。
 */
import { BASE, newPage, Suite, dropFile, dropImage, apiJson, expandExtra, fmtBytes, rateLimitBreather } from './helpers.mjs';

const THUMB_CAP = 96 * 1024;
const EDGE = 480;

export async function thumbnailSuite(browser) {
  const s = new Suite('图片缩略图回归');
  const page = await newPage(browser, { tag: 'thumb' });
  const info = async (code) => (await apiJson(page, `/api/info/${code}`)).json;
  const codeOf = (url) => url.match(/\/r\/(\d{4})/)[1];

  // 上传桶 10 次/60s，本套件共 8 次上传 + 7 次缩略图写入；
  // 若两者共用一个桶，中途必然 429，因此后面的「全部成功」本身就是分离限流的证据
  await rateLimitBreather();

  // ---- 主路径：大图上传后落在成功视图，并带出缩略图 ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dropImage(page, { name: 'photo.png', width: 900, height: 600 });
  const [navPhoto] = await Promise.all([
    page.waitForNavigation({ url: /\/r\/\d{4}/, timeout: 60000 }),
    page.click('#submitBtn'),
  ]);
  const photo = codeOf(navPhoto.url());

  s.ok('上传成功页显示图片缩略图', (await page.locator('img.file-thumb').count()) === 1, `code=${photo}`);
  await page.waitForFunction(() => {
    const i = document.querySelector('img.file-thumb');
    return !!i && i.complete && i.naturalWidth > 0;
  }, null, { timeout: 10000 }).catch(() => {});

  const rendered = await page.evaluate(() => {
    const img = document.querySelector('img.file-thumb');
    if (!img) return null;
    const box = img.getBoundingClientRect();
    const card = img.closest('.card').getBoundingClientRect();
    return {
      w: Math.round(box.width), h: Math.round(box.height),
      natural: [img.naturalWidth, img.naturalHeight],
      cardW: Math.round(card.width), loaded: img.complete && img.naturalWidth > 0,
    };
  });
  s.ok('浏览器端已按 480px 长边缩放',
    rendered && rendered.natural[0] > 0 && rendered.natural[0] <= EDGE && rendered.natural[1] <= EDGE,
    rendered && `${rendered.natural.join('x')}`);
  s.ok('缩略图实际加载成功（非破图）', rendered && rendered.loaded);
  // 备用图标靠 hidden 属性收起，而 .file-icon 的 display:inline-flex 会盖掉 UA 规则
  s.ok('缩略图可用时不重复显示文件图标',
    await page.evaluate(() => getComputedStyle(document.querySelector('.file-icon')).display === 'none'));
  s.ok('缩略图宽度不超过卡片', rendered && rendered.w <= rendered.cardW, rendered && `${rendered.w} <= ${rendered.cardW}`);
  s.ok('缩略图高度封顶在 260px 内', rendered && rendered.h <= 260, rendered && `${rendered.h}px`);

  const thumb = await page.request.get(`${BASE}/api/thumb/${photo}`);
  const thumbBytes = await thumb.body();
  const thumbType = thumb.headers()['content-type'];
  s.ok('缩略图可取回且体积受限（≤96KB）',
    thumb.status() === 200 && /^image\/(webp|jpeg|png)$/.test(thumbType) && thumbBytes.length > 0 && thumbBytes.length <= THUMB_CAP,
    `${thumbType} / ${fmtBytes(thumbBytes.length)}`);
  s.ok('缩略图禁止缓存（可见性随下载次数变化）', thumb.headers()['cache-control'] === 'no-store',
    thumb.headers()['cache-control']);
  s.note(`原图 900x600 噪声 PNG → 缩略图 ${fmtBytes(thumbBytes.length)}`);

  // ---- 收件人页面同样预览 ----
  await page.goto(`${BASE}/r/${photo}`, { waitUntil: 'networkidle' });
  s.ok('收件人取件页显示缩略图', (await page.locator('img.file-thumb').count()) === 1);
  s.ok('取件页仍可下载（缩略图不顶替下载入口）',
    (await page.locator('a:has-text("下载文件")').count()) === 1);

  // ---- 取不到图时回退图标，而不是留破图 ----
  // 用 404 而不是 5xx：newPage 会把 5xx 记成服务端异常，而这里要模拟的只是「对象没了」
  await page.route('**/api/thumb/*', (r) => r.fulfill({ status: 404, body: 'Not found' }));
  await page.goto(`${BASE}/r/${photo}`, { waitUntil: 'networkidle' });
  s.ok('缩略图请求失败时回退文件图标',
    (await page.locator('img.file-thumb').count()) === 1
      && await page.locator('img.file-thumb').isHidden()
      && await page.locator('.file-icon').first().isVisible());
  await page.unroute('**/api/thumb/*');

  // ---- 非图片：不产出、不渲染、不可伪造 ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dropFile(page, { name: 'plain.txt', content: '非图片文件' });
  const [navTxt] = await Promise.all([
    page.waitForNavigation({ url: /\/r\/\d{4}/, timeout: 60000 }),
    page.click('#submitBtn'),
  ]);
  const txt = codeOf(navTxt.url());
  s.ok('非图片成功页不出现缩略图', (await page.locator('img.file-thumb').count()) === 0, `code=${txt}`);

  await page.goto(`${BASE}/r/${txt}`, { waitUntil: 'networkidle' });
  s.ok('非图片取件页仍是文件图标',
    (await page.locator('img.file-thumb').count()) === 0 && (await page.locator('.file-icon').count()) === 1);
  s.ok('非图片没有缩略图对象（404）', (await page.request.get(`${BASE}/api/thumb/${txt}`)).status() === 404);

  // 合法 PNG 头 + 不存在的记录：两条边界都必须拒
  const spoof = await page.evaluate(async (c) => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    const post = (code) => fetch('/api/thumb/' + code, { method: 'POST', body: new Blob([png], { type: 'image/png' }) })
      .then((r) => r.status);
    return { onText: await post(c), ghost: await post('zzzz') };
  }, txt);
  s.ok('给非图片记录塞缩略图被拒（415）', spoof.onText === 415, String(spoof.onText));
  s.ok('给不存在的取件码塞缩略图被拒（404）', spoof.ghost === 404, String(spoof.ghost));

  // ---- 隐私边界：额度用完后缩略图必须一起消失 ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dropImage(page, { name: 'limited.png', width: 800, height: 500 });
  await expandExtra(page, '#tab-file');
  await page.fill('#fileMaxDownloads', '1');
  await page.dispatchEvent('#fileMaxDownloads', 'input');
  const [navLimit] = await Promise.all([
    page.waitForNavigation({ url: /\/r\/\d{4}/, timeout: 60000 }),
    page.click('#submitBtn'),
  ]);
  const limited = codeOf(navLimit.url());
  s.ok('限 1 次的图片先能预览', (await page.locator('img.file-thumb').count()) === 1, `code=${limited}`);

  await page.request.get(`${BASE}/api/download/${limited}`);
  s.ok('一次下载后额度耗尽', (await info(limited)).download_count === 1);
  s.ok('额度耗尽后缩略图返回 404', (await page.request.get(`${BASE}/api/thumb/${limited}`)).status() === 404);
  await page.goto(`${BASE}/r/${limited}`, { waitUntil: 'networkidle' });
  s.ok('额度耗尽后取件页回退文件图标',
    (await page.locator('img.file-thumb').count()) === 0 && (await page.locator('.file-icon').count()) === 1);

  // ---- 多文件：每个取件码各自带图 ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await dropImage(page, { name: 'pair-a.png', width: 700, height: 700 });
  await dropImage(page, { name: 'pair-b.png', width: 500, height: 900 });
  await Promise.all([
    page.waitForFunction(() => document.querySelectorAll('.result-item').length === 2, null, { timeout: 60000 }),
    page.click('#submitBtn'),
  ]);
  const pair = (await page.locator('.result-item .rcode').allTextContents());
  const pairStatuses = [];
  for (const c of pair) pairStatuses.push((await page.request.get(`${BASE}/api/thumb/${c}`)).status());
  s.ok('多文件逐个上传各自生成缩略图', pair.length === 2 && pairStatuses.every((x) => x === 200), pair.join(',') + ' → ' + pairStatuses.join(','));

  // ---- 三次小图上传：证明缩略图写入不占用上传额度 ----
  for (let i = 0; i < 3; i++) {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await dropImage(page, { name: `tiny-${i}.png`, width: 40, height: 40 });
    const nav = await Promise.all([
      page.waitForNavigation({ url: /\/r\/\d{4}/, timeout: 60000 }),
      page.click('#submitBtn'),
    ]);
    if (nav[0].url().indexOf('/r/') < 0) break;
  }
  s.ok('8 次上传 + 7 次缩略图写入未被限流（两桶独立）',
    page.url().includes('?sent=1'), page.url());

  await s.assertClean(page);
  await page.close();
  return s;
}
