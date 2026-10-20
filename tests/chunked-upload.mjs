/**
 * 分片上传回归：完整链路、逐片校验、断点信息、放弃与配额联动
 *
 * 分片存在的理由有两条：Cloudflare 的单次请求体上限（Free/Pro 100MB），以及慢上行下
 * 一个大 PUT 拖太久会被半途掐断。所以这里用 70 MiB 的文件（阈值 16 MiB）走真实链路，
 * 而不是拿小文件模拟 —— 小文件根本不会进这条通道。
 */
import { BASE, ADMIN_PASSWORD, newPage, Suite, dropImage, rateLimitBreather, apiJson } from './helpers.mjs';

const PART = 16 * 1024 * 1024;
const BIG = 70 * 1024 * 1024; // → 5 片（4 满片 + 1 个 6 MiB 尾片），也刚好越过 64 MiB 的分片阈值
const MB100 = 100 * 1024 * 1024;

export async function chunkedSuite(browser) {
  const s = new Suite('分片上传回归');
  const admin = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await admin.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // 后台的放弃/删除都是 confirm 表单，不接住对话框 Playwright 会自动取消
  page.on('dialog', (d) => d.accept().catch(() => {}));

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

    // 崩溃的历史跑测会留下未完成会话（cron 要 6 小时才清），它们的声明大小一直占着
    // 配额预检，会让本套件的断言从「因为这个会话才超」变成「本来就已超」。开局先全放弃
    await call('/admin/chunk/abort-all', { method: 'POST' });

    // 上限要高于 70 MiB，否则分片通道自己就会被拦（默认 100MB 已够，这里显式确认）
    const cap = await apiJson(page, '/api/admin/config/get');
    s.ok('默认单文件上限已提到 100MB', Number(cap.json?.detail?.maxFileSize) >= MB100, cap.json?.detail?.maxFileSize);

    // ---- 完整链路 ----
    const init = await call('/api/upload/chunk/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'big.bin', size: BIG, content_type: 'application/octet-stream', expire_style: 'day', expire_value: '1' }),
    });
    const sess = init.json || {};
    s.ok('init 返回会话与片数', init.status === 200 && sess.total_parts === 5 && sess.part_size === PART,
      `${init.status} parts=${sess.total_parts}`);
    // 句柄必须是服务端自生成的 32 位十六进制：拿 R2 的原始 uploadId 当句柄，
    // 它的字符集不归我们管，放进路径早晚被某一环改写成一个查不到的键
    s.ok('会话句柄是自己生成的定长十六进制，不回传 R2 的 uploadId',
      /^[0-9a-f]{32}$/.test(sess.session || '') && !('upload_id' in sess),
      `session=${sess.session}`);

    const partSizes = [];
    for (let n = 1; n <= sess.total_parts; n++) partSizes.push(Math.min(PART, BIG - (n - 1) * PART));
    const putResults = [];
    for (let n = 1; n <= sess.total_parts; n++) {
      const r = await putPart(`/api/upload/chunk/${sess.session}/${n}`, partSizes[n - 1], n);
      putResults.push(r.status);
    }
    s.ok('5 片全部接收', putResults.every((x) => x === 200), putResults.join(','));

    const status = await call(`/api/upload/chunk/status/${sess.session}`, {});
    s.ok('status 列出已传片号', status.json?.done?.length === 5 && status.json.done[0] === 1, JSON.stringify(status.json?.done));

    const again = await putPart(`/api/upload/chunk/${sess.session}/3`, partSizes[2], 3);
    s.ok('重复上传同一片不报错（预查已去掉，靠 R2 覆盖语义兜住）',
      again.status === 200 && again.json?.ok === true, JSON.stringify(again.json));

    const done = await call(`/api/upload/chunk/complete/${sess.session}`, { method: 'POST' });
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
    // 每片填充值就是片号：0 / 1MiB 落在第 1 片，69MiB 落在第 5 片（64MiB 之后）
    s.ok('下载回来字节数与各片内容一致',
      back.status === 200 && back.len === BIG && back.first === 1 && back.mid === 1 && back.tail === 5,
      `${back.len} B 首片=${back.first} 尾区=${back.tail}`);

    const afterDone = await call(`/api/upload/chunk/status/${sess.session}`, {});
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
    // 未知但格式合法的句柄 → 404；格式不对（比如直接把 R2 的 uploadId 塞进路径）→ 422
    const ghostPut = await putPart(`/api/upload/chunk/${'0'.repeat(32)}/1`, PART, 1);
    const rawIdPut = await putPart('/api/upload/chunk/x1YCI03jBLfGrU8O-yQ_3fZr/1', PART, 1);
    s.ok('未知会话 404 与非法句柄 422 分得开',
      ghostPut.status === 404 && rawIdPut.status === 422 && /无效的上传会话标识/.test(rawIdPut.json?.error || ''),
      `${ghostPut.status}/${rawIdPut.status} ${rawIdPut.json?.error}`);
    s.ok('无效大小 422 / 超上限 413', badSize.status === 422 && overCap.status === 413,
      `${badSize.status}/${overCap.status}`);

    // 拿不到 Content-Length 就必须在碰 body 之前拒绝：老代码在这里退化成 arrayBuffer()
    // 全量缓冲，那是同一枚 1102 的内存版（isolate 只有 128MB）。
    // 从 node 侧发 chunked 请求 —— 浏览器侧的 stream body 会被 Chromium 直接掐掉连接
    const chunkedRes = await fetch(`${BASE}/api/upload?expire_value=1`, {
      method: 'POST',
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4096)); c.close(); } }),
      duplex: 'half',
      headers: { 'X-Filename': 'chunked.bin' },
    });
    const chunkedBody = await chunkedRes.text();
    s.ok('缺 Content-Length 在碰 body 之前就 411，不缓冲整个请求',
      chunkedRes.status === 411 && /Content-Length/.test(chunkedBody),
      `${chunkedRes.status} ${chunkedBody.slice(0, 60)}`);

    // 零字节文件仍然是合法上传（Content-Length: 0），记账也必须是真的 0
    const emptyRes = await fetch(`${BASE}/api/upload?expire_value=1`, {
      method: 'POST', body: new Uint8Array(0), headers: { 'X-Filename': 'empty.bin' },
    });
    const emptyJson = await emptyRes.json().catch(() => null);
    const emptyList = await apiJson(page, '/api/admin/file/list?size=50');
    const emptyRow = (emptyList.json?.detail?.data || []).find((f) => f.code === emptyJson?.code);
    if (emptyRow) await call(`/api/admin/file/delete?id=${emptyRow.id}`, { method: 'DELETE' });
    s.ok('零字节文件按 0 记账且可正常删除',
      emptyRes.status === 200 && emptyJson?.size === 0 && emptyRow?.size === 0,
      `${emptyRes.status} size=${emptyJson?.size}`);

    // ---- 缺片不能 complete；未完成的会话要占配额 ----
    const half = await call('/api/upload/chunk/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'half.bin', size: BIG, expire_value: '1' }),
    });

    // 片长由服务端从会话行算出（第 1..N-1 片 = part_size，末片 = 余数），Content-Length 只用来
    // 一次性对账 —— 字节不再逐块搬运，否则一片 16MiB 会跑成一段不中断的 JS，撞上免费计划
    // 10ms 的连续 CPU 上限（线上 1102）。这里借 half 的会话试，不必再多占一次 init
    const halfPart = await putPart(`/api/upload/chunk/${half.json.session}/1`, PART / 2, 1);
    const lastPart = await putPart(`/api/upload/chunk/${half.json.session}/5`, PART, 1);
    s.ok('片长与账面对不上就 422（首片少送、末片多送都拦得住）',
      halfPart.status === 422 && /分片长度应为 16777216/.test(halfPart.json?.error || '')
      && lastPart.status === 422 && /分片长度应为 6291456/.test(lastPart.json?.error || ''),
      `${halfPart.json?.error} | ${lastPart.json?.error}`);

    await putPart(`/api/upload/chunk/${half.json.session}/1`, PART, 1);
    const miss = await call(`/api/upload/chunk/complete/${half.json.session}`, { method: 'POST' });
    s.ok('缺片时 complete 被拒并列出缺哪些',
      miss.status === 422 && /缺少分片/.test(miss.json?.error || ''), miss.json?.error);

    // 配额取「当前已用 + 8MB」：单独已用不超过，但加上那个未完成的 70MiB 会话就一定超。
    // 不能写死数字 —— 本地桶会随反复跑测累积，写死会让拒绝原因变成"本来就已超"
    const used = Number((await apiJson(page, '/api/admin/config/get')).json?.detail?.storageUsed || '0');
    const quotaMb = Math.ceil(used / 1048576) + 8;
    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
    await page.fill('input[name="maxTotalStorageMb"]', String(quotaMb));
    await Promise.all([page.waitForNavigation(), page.click('form[action="/admin/settings"] button[type="submit"]')]);
    const blocked = await postSmall('/api/upload?expire_value=1', 2 * 1024 * 1024);
    s.ok('未完成会话的声明大小计入配额预检',
      used + BIG > quotaMb * 1048576 && blocked.status === 507,
      `used=${used} 配额=${quotaMb}MB → ${blocked.status}`);

    const abort = await call(`/api/upload/chunk/abort/${half.json.session}`, { method: 'POST' });
    const released = await postSmall('/api/upload?expire_value=1', 2 * 1024 * 1024);
    s.ok('abort 释放预留空间与取件码', abort.status === 200 && released.status === 200, `${abort.status}/${released.status}`);

    await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
    await page.fill('input[name="maxTotalStorageMb"]', '');
    await Promise.all([page.waitForNavigation(), page.click('form[action="/admin/settings"] button[type="submit"]')]);

    // ---- 后台必须能立刻放弃未完成的分片 ----
    // 上面已经把这一分钟的 10 次上传额度用掉大半（411、零字节那两条也各算一次），
    // 不等窗口滚新的话这里的两次 init 会撞 429，表现为「后台列表是空的」这种假失败
    await rateLimitBreather();
    // multipart 会话不是一个对象：不在 bucket.list() 里，R2 面板删不掉、bucket.delete 无效，
    // 「清理过期文件」的孤儿扫描同样看不见，只有 abort 能释放它的存储
    const mkOrphan = (name) => call('/api/upload/chunk/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: name, size: BIG, expire_value: '1' }),
    }).then((r) => r.json?.session || '');
    const orphanA = await mkOrphan('orphan-a.bin');
    await putPart(`/api/upload/chunk/${orphanA}/1`, PART, 1);
    const orphanB = await mkOrphan('orphan-b.bin');

    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    const blockText = ((await page.locator('.chunk-sessions').textContent()) || '').replace(/\s+/g, ' ');
    s.ok('后台列出进行中的分片会话及其片数',
      /进行中的分片上传 2 个/.test(blockText) && /1\/5 片/.test(blockText) && /0\/5 片/.test(blockText),
      blockText.slice(0, 150));

    await Promise.all([
      page.waitForNavigation(),
      page.locator('.chunk-sessions .file-list-item', { hasText: 'orphan-a.bin' })
        .locator('button[type="submit"]').click(),
    ]);
    const aGone = await call(`/api/upload/chunk/status/${orphanA}`, {});
    const rowText = ((await page.locator('.chunk-sessions').textContent()) || '').replace(/\s+/g, ' ');
    s.ok('单条「放弃」立即 abort 并从列表消失',
      aGone.status === 404 && !/orphan-a\.bin/.test(rowText) && /orphan-b\.bin/.test(rowText),
      `${aGone.status} ${rowText.slice(0, 90)}`);

    await Promise.all([
      page.waitForNavigation(),
      page.click('.chunk-sessions .cs-head button[type="submit"]'),
    ]);
    const bGone = await call(`/api/upload/chunk/status/${orphanB}`, {});
    s.ok('「全部放弃」清空所有会话（0 片的也清）',
      bGone.status === 404 && (await page.locator('.chunk-sessions').count()) === 0, String(bGone.status));

    // ---- 前端会自动选对通道 ----
    // 上面为了造会话、试参数已经用掉了十次上传额度（422/413 的 init 也各算一次），
    // 不等窗口滚新的话这里的真实上传会撞 429，看起来像「小文件传不上去」
    await rateLimitBreather();
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
    s.ok('大文件由前端自动切到分片通道',
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

    // ---- 阈值 64MiB 的边界 ----
    // 这里把分片请求全部在本地应答，只观察前端选了哪条通道，不真占带宽和存储
    const sid = 'f'.repeat(32);
    await ui.route('**/api/upload/chunk/**', (route) => {
      const u = route.request().url();
      const body = u.includes('/init') ? { session: sid, code: '9999', part_size: PART, total_parts: 5 }
        : u.includes('/status/') ? { session: sid, total_parts: 5, done: [] }
        : u.includes('/complete/') ? { code: '9999', filename: 'ui-66.bin', size: 66 * 1024 * 1024 }
        : { ok: true, part: Number(u.split('/').pop()) };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const midUrls = [];
    const onMid = (r) => { if (r.url().includes('/api/upload/chunk/')) midUrls.push(r.url()); };
    ui.on('request', onMid);
    await ui.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await ui.evaluate(async () => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(66 * 1024 * 1024)], 'ui-66.bin', { type: 'application/octet-stream' }));
      document.getElementById('dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await Promise.all([ui.waitForNavigation({ url: /\/r\/9999/, timeout: 30000 }), ui.click('#submitBtn')]);
    ui.off('request', onMid);
    await ui.unroute('**/api/upload/chunk/**');
    s.ok('66MiB（>64MiB 阈值）切到分片通道：init + status + 5 片 + complete',
      midUrls.filter((u) => u.includes('/init')).length === 1
      && midUrls.filter((u) => u.includes('/complete/')).length === 1
      && midUrls.length === 8,
      midUrls.map((u) => u.split('/chunk/')[1]).join(' → '));

    // ---- 分片传败了，前端必须自己 abort ----
    // 用户报的「三个删不掉的部分文件」就是这么攒出来的：传一半断掉，会话既不在文件列表
    // 也不在 R2 面板里，不清就会一直占存储直到 6 小时超时
    const failUrls = [];
    const onFailReq = (r) => { if (r.url().includes('/api/upload/chunk/')) failUrls.push(r.url()); };
    ui.on('request', onFailReq);
    await ui.route('**/api/upload/chunk/**', (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"模拟断线"}' });
    });
    await ui.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await ui.evaluate(async () => {
      const big = new Uint8Array(70 * 1024 * 1024);
      const dt = new DataTransfer();
      dt.items.add(new File([big], 'chunk-fail.bin', { type: 'application/octet-stream' }));
      document.getElementById('dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await ui.click('#submitBtn');
    await ui.waitForFunction(() => document.getElementById('uploadStatus')?.textContent.includes('失败'), { timeout: 60000 });
    await ui.unroute('**/api/upload/chunk/**');
    ui.off('request', onFailReq);
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    s.ok('分片失败后前端自动 abort，不留下清不掉的会话',
      failUrls.some((u) => /\/abort\//.test(u)) && (await page.locator('.chunk-sessions').count()) === 0,
      `分片请求 ${failUrls.length} 个，其中 abort ${failUrls.filter((u) => /\/abort\//.test(u)).length} 个`);
    await ui.close();

    // 收尾把 UI 造出来的 70MiB 删掉，否则每跑一次本地桶就多 70MiB
    if (uiCode) {
      const uiList = await apiJson(page, '/api/admin/file/list?size=50');
      const uiRow = (uiList.json?.detail?.data || []).find((f) => f.code === uiCode);
      if (uiRow) await call(`/api/admin/file/delete?id=${uiRow.id}`, { method: 'DELETE' });
    }

    s.ok('无页面异常', problems.length === 0 && ui.problems.length === 0,
      [...problems, ...ui.problems.map((x) => `[chunk-ui] ${x}`)].join(' | '));
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
