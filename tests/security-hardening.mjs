/**
 * 安全回归：文本查看次数、参数校验、清理竞态、查询失败限流
 *
 * 每个页面上下文会拿到独立的伪 CF-Connecting-IP，与其它套件的限流桶隔离；
 * 需要额外上传额度的场景（如并发会话上限）单独开新页面。
 * 注意：这组 header 只在本地 Miniflare 生效；线上 Cloudflare 会覆盖它。
 */
import { BASE, ADMIN_PASSWORD, newPage, Suite, apiJson } from './helpers.mjs';

export async function securityHardeningSuite(browser) {
  const s = new Suite('安全加固回归');
  const page = await newPage(browser, { tag: 'security' });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const tag = 100 + Math.floor(Math.random() * 150);
  const ip = (n) => `198.18.${tag}.${n}`;
  const textIp = ip(11);
  const uploadIp = ip(12);
  const chunkIp = ip(13);
  const limitIp = ip(14);
  const adminIp = ip(15);
  const bodyIp = ip(16);
  const thumbIp = ip(17);

  const call = (path, init = {}, who = textIp) =>
    apiJson(page, path, {
      ...init,
      headers: { 'CF-Connecting-IP': who, ...(init.headers || {}) },
    });

  const adminHeaders = {};
  const capSessions = [];
  let capPage = null;
  let textCode = '';
  let hugeCode = '';
  let weirdCode = '';
  let session = '';

  try {
    // ---- 1. POST select 不再返回正文；耗尽后标题遮蔽 ----
    const textForm = new URLSearchParams({
      text: 'SECURITY-TEXT-BODY-9f3a',
      max_downloads: '1',
      expire_value: '1',
      expire_style: 'day',
    }).toString();
    const created = await call('/api/share/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: textForm,
    }, textIp);
    textCode = created.json?.detail?.code || '';
    s.ok('测试文本分享创建成功', created.status === 200 && /^\d{4}$/.test(textCode), `${created.status} ${textCode}`);

    const p1 = await call(`/api/share/select?code=${textCode}`, { method: 'POST' }, textIp);
    const p2 = await call(`/api/share/select?code=${textCode}`, { method: 'POST' }, textIp);
    s.ok('POST select 只查状态，不返回正文',
      p1.status === 200 && p1.json?.detail?.text === undefined && p2.json?.detail?.text === undefined,
      p1.body.slice(0, 120));

    const g1 = await call(`/api/share/select?code=${textCode}`, {}, textIp);
    s.ok('GET select 仍返回正文并计数', g1.status === 200 && g1.json?.detail?.text === 'SECURITY-TEXT-BODY-9f3a', g1.body);
    const g2 = await call(`/api/share/select?code=${textCode}`, {}, textIp);
    s.ok('次数耗尽后 GET select 403', g2.status === 403, `${g2.status} ${g2.body}`);

    const p3 = await call(`/api/share/select?code=${textCode}`, { method: 'POST' }, textIp);
    const inf = await call(`/api/info/${textCode}`, {}, textIp);
    s.ok('耗尽后 POST select 与 /api/info 都不再泄露正文标题',
      p3.status === 200 && p3.json?.detail?.text === undefined
      && p3.json?.detail?.name === '***' && inf.json?.filename === '***',
      `${p3.body} | ${inf.body}`);

    // ---- 2. 超出范围的有效期/次数必须在抢码前被拒，且不烧码 ----
    const codes = (await call('/api/codes/2', {}, uploadIp)).json?.codes || [];
    hugeCode = codes[0] || '';
    const huge = await call(`/api/upload?code=${hugeCode}&expire_style=day&expire_value=999999999`, {
      method: 'POST',
      headers: { 'X-Filename': 'huge.bin' },
      body: 'x',
    }, uploadIp);
    s.ok('超大 expire_value 返回 422 而不是 500',
      huge.status === 422 && /有效期数值/.test(huge.json?.error || ''), `${huge.status} ${huge.body}`);

    const retry = await call(`/api/upload?code=${hugeCode}&expire_style=day&expire_value=1`, {
      method: 'POST',
      headers: { 'X-Filename': 'ok.bin' },
      body: 'x',
    }, uploadIp);
    s.ok('失败请求没有留下取件码占用，同码可正常重试',
      retry.status === 200 && retry.json?.code === hugeCode, `${retry.status} ${retry.body}`);

    const zero = await call('/api/upload?expire_style=day&expire_value=1&max_downloads=0', {
      method: 'POST',
      headers: { 'X-Filename': 'zero.bin' },
      body: 'x',
    }, uploadIp);
    s.ok('max_downloads=0 被拒（不再生成永远打不开的文件）', zero.status === 422, `${zero.status} ${zero.body}`);

    // ---- 3. 清理不能腾走进行中的分片会话取件码 ----
    const chunkCodes = (await call('/api/codes/2', {}, chunkIp)).json?.codes || [];
    const chunkCode = chunkCodes[0] || '';
    const init = await call('/api/upload/chunk/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'cleanup-race.bin', size: 73400320, code: chunkCode, expire_value: '1' }),
    }, chunkIp);
    session = init.json?.session || '';
    s.ok('分片会话创建并抢占取件码', init.status === 200 && /^[0-9a-f]{32}$/.test(session), `${init.status} ${init.body}`);

    const login = await call('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    }, adminIp);
    const token = login.json?.detail?.token || '';
    Object.assign(adminHeaders, token ? { Authorization: `Bearer ${token}` } : {});

    await call('/admin/cleanup', { method: 'POST' }, adminIp);
    const status = await call(`/api/upload/chunk/status/${session}`, {}, chunkIp);
    s.ok('清理后会话仍然有效', status.status === 200, `${status.status} ${status.body}`);

    const steal = await call(`/api/upload?code=${chunkCode}&expire_style=day&expire_value=1`, {
      method: 'POST',
      headers: { 'X-Filename': 'steal.bin' },
      body: 'x',
    }, chunkIp);
    s.ok('清理后同一取件码仍被分片会话占用（单文件上传 409）', steal.status === 409, `${steal.status} ${steal.body}`);

    // ---- 4. 整体缓冲接口在读取 body 前限长 ----
    const bigJson = await call('/api/upload/chunk/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'x'.repeat(70 * 1024), size: 73400320, expire_value: '1' }),
    }, bodyIp);
    s.ok('超大 JSON init 在解析前 413',
      bigJson.status === 413 && /请求体过大/.test(bigJson.body), `${bigJson.status} ${bigJson.body.slice(0, 50)}`);

    const thumbNoCl = await fetch(`${BASE}/api/thumb/9999`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': thumbIp, 'Content-Type': 'image/png' },
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16)); c.close(); } }),
      duplex: 'half',
    });
    const thumbNoClText = await thumbNoCl.text();
    s.ok('无 Content-Length 的缩略图请求 411',
      thumbNoCl.status === 411 && /Content-Length/.test(thumbNoClText), `${thumbNoCl.status} ${thumbNoClText.slice(0, 50)}`);

    const bigText = await fetch(`${BASE}/api/share/text`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': bodyIp, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'text=' + 'a'.repeat(1100 * 1024),
    });
    const bigTextBody = await bigText.text();
    s.ok('超大文本表单 413',
      bigText.status === 413 && /请求体过大/.test(bigTextBody), `${bigText.status} ${bigTextBody.slice(0, 50)}`);

    const longPw = await call('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(300) }),
    }, bodyIp);
    s.ok('超长密码 401 密码过长',
      longPw.status === 401 && /密码过长/.test(longPw.body), `${longPw.status} ${longPw.body.slice(0, 50)}`);

    // ---- 5. 同一 IP 最多 5 个并发分片会话 ----
    // Playwright 的 context 级 CF-Connecting-IP 会覆盖页面内 fetch 的同名头，
    // 因此这里单独开一个页面上下文，确保它有独立的上传/分片桶
    capPage = await newPage(browser, { tag: 'cap' });
    await capPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const capCall = (path, init = {}) => apiJson(capPage, path, init);
    for (let i = 0; i < 5; i++) {
      const r = await capCall('/api/upload/chunk/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: `cap-${i}.bin`, size: 73400320, expire_value: '1' }),
      });
      if (r.status === 200 && r.json?.session) capSessions.push(r.json.session);
    }
    const sixth = await capCall('/api/upload/chunk/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'cap-6.bin', size: 73400320, expire_value: '1' }),
    });
    s.ok('同一 IP 前 5 个分片会话允许', capSessions.length === 5, `sessions=${capSessions.length}`);
    s.ok('第 6 个并发分片会话被 429',
      sixth.status === 429 && /最多 5 个/.test(sixth.body), `${sixth.status} ${sixth.body}`);
    while (capSessions.length) {
      const sid = capSessions.pop();
      await capCall(`/api/upload/chunk/abort/${sid}`, { method: 'POST' }).catch(() => {});
    }
    await capPage.close();
    capPage = null;

    // ---- 6. 失败查询 5 次/分钟；成功查询不受影响 ----
    const freeCodes = (await call('/api/codes/6', {}, limitIp)).json?.codes || [];
    const failures = [];
    for (const c of freeCodes) failures.push((await call(`/api/info/${c}`, {}, limitIp)).status);
    s.ok('前 5 次失败查询正常返回 404', failures.slice(0, 5).every((x) => x === 404), failures.join(','));
    s.ok('第 6 次失败查询被 429 拦截', failures[5] === 429, `${failures.join(',')} ${failures.length}`);

    const validAfterBlock = await call(`/api/info/${textCode}`, {}, limitIp);
    const validAfterBlock2 = await call(`/api/info/${hugeCode}`, {}, limitIp);
    s.ok('被限流期间，有效取件码仍可正常查询',
      validAfterBlock.status === 200 && validAfterBlock2.status === 200,
      `${validAfterBlock.status}/${validAfterBlock2.status}`);

    // ---- 7. openUpload 布尔值与后台非法分页 ----
    const setFalse = await call('/api/admin/config/update', {
      method: 'PATCH',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ openUpload: false }),
    }, adminIp);
    // 安全套件的页面在登录接口后已经带上 admin cookie，必须用无 Cookie 的 Node 请求验证游客视角
    const blocked = await fetch(`${BASE}/api/upload?expire_value=1`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': bodyIp, 'X-Filename': 'blocked.txt' },
      body: 'x',
    });
    const blockedBody = await blocked.text();
    const setTrue = await call('/api/admin/config/update', {
      method: 'PATCH',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ openUpload: true }),
    }, adminIp);
    s.ok('布尔 false 真正关闭游客上传',
      setFalse.status === 200 && setFalse.json?.detail?.openUpload === '0'
      && blocked.status === 401 && /游客上传已关闭/.test(blockedBody),
      `${setFalse.status}/${blocked.status} ${blockedBody.slice(0, 50)}`);
    s.ok('布尔 true 恢复游客上传',
      setTrue.status === 200 && setTrue.json?.detail?.openUpload === '1', setTrue.body.slice(0, 80));

    const badPage = await call('/api/admin/file/list?page=abc&size=abc', { headers: adminHeaders }, adminIp);
    const adminPageRes = await fetch(`${BASE}/admin?page=abc`, {
      headers: { 'CF-Connecting-IP': adminIp, ...adminHeaders },
    });
    await adminPageRes.text();
    s.ok('非法分页参数回退而不是 500',
      badPage.status === 200 && badPage.json?.detail?.page === 1 && badPage.json?.detail?.size === 10,
      `${badPage.status} ${badPage.body.slice(0, 80)}`);
    s.ok('后台非法分页参数返回 200', adminPageRes.status === 200, String(adminPageRes.status));

    // ---- 8. 孤立代理文件名不能把下载变成 500 ----
    const weird = await call('/api/upload?expire_value=1', {
      method: 'POST',
      headers: { 'X-Filename': '%ED%A0%80evil.bin' },
      body: 'x',
    }, bodyIp);
    weirdCode = weird.json?.code || '';
    let weirdDownload = { status: 0, disposition: '' };
    if (weirdCode) {
      const dl = await fetch(`${BASE}/api/download/${weirdCode}`, { headers: { 'CF-Connecting-IP': bodyIp } });
      weirdDownload.status = dl.status;
      weirdDownload.disposition = dl.headers.get('content-disposition') || '';
      await dl.arrayBuffer();
    }
    s.ok('孤立代理文件名的文件仍可下载',
      weird.status === 200 && weirdDownload.status === 200 && /filename\*=UTF-8''/.test(weirdDownload.disposition),
      `${weird.status}/${weirdDownload.status} ${weirdDownload.disposition}`);

    await s.assertClean(page);
  } finally {
    if (session) await call(`/api/upload/chunk/abort/${session}`, { method: 'POST' }, chunkIp).catch(() => {});
    if (capPage) {
      while (capSessions.length) {
        const sid = capSessions.pop();
        await apiJson(capPage, `/api/upload/chunk/abort/${sid}`, { method: 'POST' }).catch(() => {});
      }
      await capPage.close().catch(() => {});
    }
    if (Object.keys(adminHeaders).length) {
      // 若前面的断言中途失败，确保不把本地环境留在“关闭游客上传”状态
      await call('/api/admin/config/update', {
        method: 'PATCH',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ openUpload: true }),
      }, adminIp).catch(() => {});
      const list = await call('/api/admin/file/list?size=100', { headers: adminHeaders }, adminIp).catch(() => null);
      for (const code of [textCode, hugeCode, weirdCode]) {
        const row = (list?.json?.detail?.data || []).find((f) => f.code === code);
        if (row) {
          await call(`/api/admin/file/delete?id=${row.id}`, { method: 'DELETE', headers: adminHeaders }, adminIp).catch(() => {});
        }
      }
    }
    await page.close();
  }

  return s;
}
