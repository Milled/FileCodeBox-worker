/**
 * 分片上传回归：完整链路、逐片校验、断点信息、放弃与配额联动
 *
 * 分片存在的唯一理由是 Cloudflare 的单次请求体上限（Free/Pro 100MB），
 * 所以这里用 70 MiB 的文件（阈值 64 MiB）走真实链路，而不是拿小文件模拟 ——
 * 小文件根本不会进这条通道。
 */
import { BASE, ADMIN_PASSWORD, newPage, Suite, dropImage, rateLimitBreather, apiJson } from './helpers.mjs';

const PART = 8 * 1024 * 1024;
const BIG = 70 * 1024 * 1024; // → 9 片（8 满片 + 1 个 6 MiB 尾片）
const MB100 = 100 * 1024 * 1024;

export async function chunkedSuite(browser) {
  const s = new Suite('分片上传回归');
  const admin = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await admin.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  // JSON 请求可以直接发；二进制 body 必须在页面里构造（evaluate 的参数会被序列化掉）
  const call = (path, init) => page.evaluate(async ([p, i]) => {
    const r = await fetch(p, i);
    let j = null;
    try { j = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, json: j };
  }, [path, init]);

  /** 一片：填充固定字节值，便于下载后抽样核对是哪一片 */
  const putPart = (path, bytes, fill) => page.evaluate(async ([p, n, v]) => {
    const r = await fetch(p, { method: 'PUT', body: new Uint8Array(n).fill(v) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, bytes, fill]);

  const postSmall = (path, bytes) => page.evaluate(async ([p, n]) => {
    const r = await fetch(p, { method: 'POST', headers: { 'X-Filename': 'quota.bin' }, body: new Uint8Array(n) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, bytes]);

  try {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await rateLimitBreather();
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

    // 上限要高于 70 MiB，否则分片通道自己就会被拦（默认 100MB 已够，这里显式确认）
    const cap = await apiJson(page, '/api/admin/config/get');
    s.ok('默认单文件上限已提到 100MB', Number(cap.json?.detail?.maxFileSize) >= MB100, cap.json?.detail?.maxFileSize);

    // ---- 完整链路 ----
    const init = await call('/api/upload/chunk/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'big.bin', size: BIG, content_type: 'application/octet-stream', expire_style: 'day', expire_value: '1' }),
    });
    const sess = init.json || {};
    s.ok('init 返回会话与片数', init.status === 200 && sess.total_parts === 9 && sess.part_size === PART,
      `${init.status} parts=${sess.total_parts}`);

    const partSizes = [];
    for (let n = 1; n <= sess.total_parts; n++) partSizes.push(Math.min(PART, BIG - (n - 1) * PART));
    const putResults = [];
    for (let n = 1; n <= sess.total_parts; n++) {
      const r = await putPart(`/api/upload/chunk/${sess.upload_id}/${n}`, partSizes[n - 1], n);
      putResults.push(r.status);
    }
    s.ok('9 片全部接收', putResults.every((x) => x === 200), putResults.join(','));

    const status = await call(`/api/upload/chunk/status/${sess.upload_id}`, {});
    s.ok('status 列出已传片号', status.json?.done?.length === 9 && status.json.done[0] === 1, JSON.stringify(status.json?.done));

    const again = await putPart(`/api/upload/chunk/${sess.upload_id}/3`, partSizes[2], 3);
    s.ok('重复上传同一片幂等跳过', again.status === 200 && again.json?.skipped === true, JSON.stringify(again.json));

    const done = await call(`/api/upload/chunk/complete/${sess.upload_id}`, { method: 'POST' });
    s.ok('complete 合成一个对象并返回取件码',
      done.status === 200 && /^\d{4}$/.test(done.json?.code || '') && done.json?.size === BIG,
      `${done.status} code=${done.json?.code} size=${done.json?.size}`);
    const code = done.json?.code;

    const info = await apiJson(page, `/api/info/${code}`);
    s.ok('70MiB 文件在后台是一个文件、一个码', info.json?.size === BIG, `size=${info.json?.size} name=${info.json?.filename}`);

    const back = await page.evaluate(async (c) => {
      const r = await fetch('/api/download/' + c);
      const buf = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, len: buf.length, first: buf[0], mid: buf[1048576], tail: buf[69 * 1048576] };
    }, code);
    // 每片填充值就是片号：0 / 1MiB 落在第 1 片，69MiB 落在第 9 片
    s.ok('下载回来字节数与各片内容一致',
      back.status === 200 && back.len === BIG && back.first === 1 && back.mid === 1 && back.tail === 9,
      `${back.len} B 首片=${back.first} 尾区=${back.tail}`);

    const afterDone = await call(`/api/upload/chunk/status/${sess.upload_id}`, {});
    s.ok('complete 后会话即结束（不残留）', afterDone.status === 404, String(afterDone.status));

    // 分片合成的文件必须和普通文件一样可删：走后台删除接口，顺带验证配额被释放
    const before = Number((await apiJson(page, '/api/admin/config/get')).json?.detail?.storageUsed || '0');
    const list = await apiJson(page, '/api/admin/file/list?size=50');
    const row = (list.json?.detail?.data || []).find((f) => f.code === code);
    const del = row
      ? await call(`/api/admin/file/delete?id=${row.id}`, { method: 'DELETE' })
      : { status: 0 };
    const after = Number((await apiJson(page, '/api/admin/config/get')).json?.detail?.storageUsed || '0');
    s.ok('分片文件可删除且释放配额',
      del.status === 200 && (before - after) === BIG,
      `${del.status} ${before} → ${after}`);

    // ---- 参数与越界校验 ----
    const badSize = await call('/api/upload/chunk/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'x', size: 0 }),
    });
    const overCap = await call('/api/upload/chunk/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'x', size: 4 * 1024 * 1024 * 1024 }),
    });
    const ghostPut = await putPart('/api/upload/chunk/notarealid1/1', PART, 1);
    s.ok('无效大小 422 / 超上限 413 / 未知会话 404',
      badSize.status === 422 && overCap.status === 413 && ghostPut.status === 404,
      `${badSize.status}/${overCap.status}/${ghostPut.status}`);

    // ---- 缺片不能 complete；未完成的会话要占配额 ----
    const half = await call('/api/upload/chunk/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'half.bin', size: BIG, expire_value: '1' }),
    });
    await putPart(`/api/upload/chunk/${half.json.upload_id}/1`, PART, 1);
    const miss = await call(`/api/upload/chunk/complete/${half.json.upload_id}`, { method: 'POST' });
    s.ok('缺片时 complete 被拒并列出缺哪些',
      miss.status === 422 && /缺少分片/.test(miss.json?.error || ''), miss.json?.error);

    // 配额取「当前已用 + 8MB」：单独已用不超过，但加上那个未完成的 70MiB 会话就一定超。
    // 不能写死数字 —— 本地桶会随反复跑测累积，写死会让拒绝原因变成"本来就已超"。
    // 前提是库里没有别的未完成会话：崩溃的跑测会留下会话（cron 6 小时才清），
    // 那些 pending 会让 abort 之后的重试仍然 507，表现为本条断言失败
    const used = Number((await apiJson(page, '/api/admin/config/get')).json?.detail?.storageUsed || '0');
    const quotaMb = Math.ceil(used / 1048576) + 8;
    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
    await page.fill('input[name="maxTotalStorageMb"]', String(quotaMb));
    await Promise.all([page.waitForNavigation(), page.click('form[action="/admin/settings"] button[type="submit"]')]);
    const blocked = await postSmall('/api/upload?expire_value=1', 2 * 1024 * 1024);
    s.ok('未完成会话的声明大小计入配额预检',
      used + BIG > quotaMb * 1048576 && blocked.status === 507,
      `used=${used} 配额=${quotaMb}MB → ${blocked.status}`);

    const abort = await call(`/api/upload/chunk/abort/${half.json.upload_id}`, { method: 'POST' });
    const released = await postSmall('/api/upload?expire_value=1', 2 * 1024 * 1024);
    s.ok('abort 释放预留空间与取件码', abort.status === 200 && released.status === 200, `${abort.status}/${released.status}`);

    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
    await page.fill('input[name="maxTotalStorageMb"]', '');
    await Promise.all([page.waitForNavigation(), page.click('form[action="/admin/settings"] button[type="submit"]')]);

    // ---- 前端会自动选对通道 ----
    const ui = await newPage(browser, { tag: 'chunk-ui' });
    const chunkUrls = [];
    ui.on('request', (r) => { if (r.url().includes('/api/upload/chunk/')) chunkUrls.push(r.url()); });
    // 限速到 10MB/s：不节流的话 loopback 两秒传完，采不到中间进度
    const cdp = await ui.context().newCDPSession(ui);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 10 * 1024 * 1024,
    });
    await ui.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await ui.evaluate(async () => {
      const big = new Uint8Array(70 * 1024 * 1024);
      const dt = new DataTransfer();
      dt.items.add(new File([big], 'ui-big.bin', { type: 'application/octet-stream' }));
      document.getElementById('dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    ui.click('#submitBtn').catch(() => {});
    // 分片路径以前只在整片传完时更新一次进度，慢上行下会长时间显示 0 B/s，
    // 用户分不清是慢还是卡死；这里断言进度确实在中间值上连续爬过
    const samples = new Set();
    for (let i = 0; i < 60; i++) {
      await ui.waitForTimeout(250);
      const m = ((await ui.textContent('#uploadMeta').catch(() => '')) || '').trim();
      const sent = m.split(' / ')[0];
      if (sent && sent !== '0 B') samples.add(sent);
      if (/\/r\/\d{4}/.test(ui.url())) break;
    }
    s.ok('分片上传过程中进度连续累加（不是停在 0）', samples.size >= 3, [...samples].slice(0, 4).join(' → '));
    // 采样循环本身就在等跳转，这里读最终 URL，不再重复 waitForNavigation
    const uiCode = /\/r\/(\d{4})/.exec(ui.url())?.[1] || '';
    s.ok('>64MiB 的文件由前端自动切到分片通道',
      !!uiCode && chunkUrls.some((u) => u.includes('/init')) && chunkUrls.some((u) => u.includes('/complete')),
      `${chunkUrls.length} 个分片请求`);
    const uiInfo = uiCode ? await apiJson(ui, `/api/info/${uiCode}`) : { json: null };
    s.ok('分片上传后仍落在成功视图且大小正确',
      ui.url().includes('?sent=1') && uiInfo.json?.size === 70 * 1024 * 1024,
      `code=${uiCode} size=${uiInfo.json?.size}`);

    // 小文件必须继续走原来的单请求路径
    chunkUrls.length = 0;
    await ui.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await dropImage(ui, { name: 'ui-small.png', width: 300, height: 200 });
    await Promise.all([ui.waitForNavigation({ url: /\/r\/\d{4}/, timeout: 60000 }), ui.click('#submitBtn')]);
    s.ok('小文件仍走单请求，不多付往返', chunkUrls.length === 0, `${chunkUrls.length}`);
    await ui.close();

    // 收尾把 UI 造出来的 70MiB 删掉，否则每跑一次本地桶就多 70MiB
    if (uiCode) {
      const uiList = await apiJson(page, '/api/admin/file/list?size=50');
      const uiRow = (uiList.json?.detail?.data || []).find((f) => f.code === uiCode);
      if (uiRow) await call(`/api/admin/file/delete?id=${uiRow.id}`, { method: 'DELETE' });
    }

    s.ok('无页面异常', problems.length === 0, problems.join(' | '));
  } finally {
    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.fill('input[name="maxTotalStorageMb"]', '').catch(() => {});
    await page.fill('input[name="maxFileSizeMb"]', '').catch(() => {});
    await Promise.all([
      page.waitForNavigation().catch(() => {}),
      page.click('form[action="/admin/settings"] button[type="submit"]').catch(() => {}),
    ]);
    s.note('已清空大小与总占用覆盖');
    await admin.close();
  }
  return s;
}
