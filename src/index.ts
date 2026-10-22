/**
 * FileCodeBox - Cloudflare Worker 重写版
 * 像取快递一样取文件
 */
import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Env, FileRecord } from './types';

import {
  initDB,
  getFileByCode,
  getFileById,
  deleteFileRecord,
  listFilesAdvanced,
  cleanupExpired,
  cleanupUsedCodes,
  cleanupOrphanedR2Objects,
  cleanupRateLimitEntries,
  incrementDownload,
  getDashboardStats,
  listChunkTasks,
  getSettings,
  checkRateLimit,
  setSetting,
  setStorageUsed,
} from './db';
import { adminAuth, handleAdminLogin, handleAdminLogout, hasAdminCredential, verifyAdminToken } from './auth';
import api from './api';
import {
  uploadFile,
  uploadText,
  downloadFile,
  saveThumb,
  readThumb,
  allocateCodeRun,
  loadHomePolicy,
  limitsFromValues,
  registerLookupFailure,
  displayFilename,
  assertBodyWithinLimit,
  LOOKUP_RATE_MESSAGE,
  FALLBACK_MAX_FILE_SIZE,
} from './shared';
import type { RuntimeLimits } from './shared';
import { generateQRCodeGIF } from './qr';
import { chunkInit, chunkPut, chunkStatus, chunkComplete, chunkAbort, abortChunkSession, abortAllChunkSessions, cleanupStaleChunkUploads } from './chunk';
import { STYLE } from './templates/style';
import { encodeFilename, getClientIp, parseIntParam, toPublicError } from './utils';
import {
  TURNSTILE_SETTING_KEY,
  turnstileConfigured,
  verifyTurnstileToken,
  issueGuestVerifiedCookie,
  verifyGuestVerifiedCookie,
} from './turnstile';
import type { HomeOptions } from './templates/pages';
import type { AdminConfig } from './templates/pages';
import {
  homePage,
  retrievePage,
  resultPage,
  filePage,
  errorPage,
  adminLoginPage,
  adminPanel,
  adminSettingsPage,
} from './templates/pages';

// ===================== 应用初始化 =====================

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  // Content-Security-Policy：限制资源加载来源，降低 XSS 影响面
  c.res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; " +
      "connect-src 'self' https://challenges.cloudflare.com; " +
      "frame-src https://challenges.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' https: data:; " +
      "object-src 'none'; " +
      "frame-ancestors 'none';",
  );
});

// ===================== 助手函数 =====================

function getBaseUrl(c: Context<{ Bindings: Env }>): string {
  const host = c.req.header('host') || '';
  // 仅接受合法主机名（字母数字和连字符，多级域名），拒绝 IP 地址和异常值，防止开放重定向
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/.test(host)) {
    return new URL(c.req.url).origin;
  }
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${host}`;
}

/**
 * 首页所需的生效设置：token 校验 + 开放开关 + 三个上限一次查完。
 * 全新数据库尚未建表时必须降级为默认值，否则首页会从「可用静态页」退化成 500。
 */
async function homeOptions(c: Context<{ Bindings: Env }>): Promise<HomeOptions> {
  try {
    const policy = await loadHomePolicy(c, c.env);
    return {
      // 管理员始终保留上传区：后端 loadUploadPolicy 本来就允许管理员上传
      uploadAllowed: policy.uploadAllowed,
      defaultExpireDays: policy.limits.defaultExpireDays,
      maxFileSize: policy.limits.maxSize,
      turnstileRequired: policy.turnstileRequired,
      turnstileSiteKey: policy.turnstileRequired ? (c.env.TURNSTILE_SITE_KEY ?? '') : undefined,
    };
  } catch {
    return { uploadAllowed: true, defaultExpireDays: 7, maxFileSize: FALLBACK_MAX_FILE_SIZE };
  }
}

/** 后台表单在 parseBody 之前限长；超限直接回错误页，别抛到 Hono 变成 500 */
function guardFormBody(c: Context<{ Bindings: Env }>, maxBytes: number): Response | null {
  try {
    assertBodyWithinLimit(c, maxBytes);
    return null;
  } catch (e: any) {
    return c.html(errorPage('请求无效', e?.message ?? '请求体过大'), e?.status ?? 413);
  }
}

const ADMIN_SETTING_KEYS = [
  'admin_token', 'open_upload', 'max_file_size', 'default_expire_days', 'max_total_storage',
  'storage_used', TURNSTILE_SETTING_KEY,
];

interface AdminState {
  openUpload: string;
  limits: RuntimeLimits;
  storageUsed: number;
  turnstileEnabled: string;
}

/**
 * 后台首屏一次查询完成「token 校验 + 生效设置 + 用量」。
 * 无凭据时不打 DB；带凭据才读 admin_token 合并校验。
 */
async function readAdminState(c: Context<{ Bindings: Env }>): Promise<AdminState | null> {
  if (!hasAdminCredential(c)) return null;
  const settings = await getSettings(c.env.DB, ADMIN_SETTING_KEYS);
  if (!verifyAdminToken(c, settings['admin_token'] ?? null)) return null;
  const used = parseInt(settings['storage_used'] ?? '', 10);
  return {
    openUpload: settings['open_upload'] ?? '1',
    limits: limitsFromValues(settings, c.env),
    storageUsed: Number.isFinite(used) && used > 0 ? used : 0,
    turnstileEnabled: settings[TURNSTILE_SETTING_KEY] === '1' ? '1' : '0',
  };
}

/** 后台设置页所需的当前值（生效值 + vars 回退值） */
function adminConfigFromState(state: AdminState, env: Env): AdminConfig {
  const toInt = (v: string | undefined, fallback: number) => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    openUpload: state.openUpload,
    maxFileSize: state.limits.maxSize,
    defaultExpireDays: state.limits.defaultExpireDays,
    maxTotalStorage: state.limits.maxTotalStorage,
    storageUsed: state.storageUsed,
    varsMaxFileSize: toInt(env.MAX_FILE_SIZE, 104857600),
    varsDefaultExpireDays: toInt(env.DEFAULT_EXPIRE_DAYS, 7),
    turnstileEnabled: state.turnstileEnabled,
    turnstileConfigured: turnstileConfigured(env),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? '',
  };
}

// ===================== 静态资源 =====================

// 样式表独立成文件 + immutable 长缓存（由 CDN/浏览器缓存，避免每次页面内联 ~10KB CSS）
app.get('/static/style.css', (c) => {
  const res = new Response(STYLE, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
  res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res;
});

// 背景图本地提供：固定 URL + 长缓存，替代外部随机图源（每次 301 跳转 + 1.2MB 8K 图）
app.get('/static/bg.webp', async (c) => {
  const obj = await c.env.FILE_STORE.get('bg.webp');
  if (!obj) return new Response('Not Found', { status: 404 });
  const res = new Response(obj.body, { headers: { 'Content-Type': 'image/webp' } });
  res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res;
});

// ===================== 页面路由 =====================

// 首页（需读一次生效设置，决定上传区还是登录引导；DB 未就绪时降级为默认可上传）
app.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.html(homePage(await homeOptions(c)));
});

// 取件页（静态，但需避免错误响应被 CDN 缓存，使用 no-store）
app.get('/r', (c) => {
  const code = (c.req.query('code') || '').trim();
  if (code) return c.redirect(`/r/${code}`);
  c.header('Cache-Control', 'no-store');
  return c.html(retrievePage());
});

app.get('/r/:code', async (c) => {
  c.header('Cache-Control', 'no-store');
  const code = c.req.param('code').trim();
  const file = await getFileByCode(c.env.DB, code);
  if (!file) {
    if (!(await registerLookupFailure(c, c.env))) {
      return c.html(errorPage('访问过于频繁', LOOKUP_RATE_MESSAGE), 429);
    }
    return c.html(retrievePage());
  }
  // 上传成功后的回跳视图：与文本分享一致，只给取件码与「继续上传」，
  // 不提供下载入口。收件人拿到的 /r/{code}（无 sent）仍是下载页。
  if (c.req.query('sent') === '1') {
    return c.html(resultPage({
      code: file.code, title: displayFilename(file), baseUrl: getBaseUrl(c),
      hasThumb: file.has_thumb === 1, meta: file,
    }));
  }
  return c.html(filePage(file, getBaseUrl(c)));
});

// ===================== 文件上传 =====================

app.post('/api/upload', async (c) => {
  try {
    const result = await uploadFile(c, c.env);
    return c.json(result);
  } catch (e: any) {
    const { status, message } = toPublicError(e);
    return c.json({ error: message }, status as any);
  }
});

// ===================== 分片上传（大文件） =====================
// 单次请求体受套餐上限约束（Free/Pro 100MB），大文件只能拆成多个请求。
// 每片直接流进同一个 R2 multipart 会话，complete 时由 R2 合成一个对象：
// 一个文件仍然只有一个取件码，后台仍然只是一行记录。

app.post('/api/upload/chunk/init', async (c) => {
  try {
    return c.json(await chunkInit(c, c.env));
  } catch (e: any) {
    const { status, message } = toPublicError(e, '初始化失败');
    return c.json({ error: message }, status as any);
  }
});

app.put('/api/upload/chunk/:session/:part', async (c) => {
  try {
    return c.json(await chunkPut(c, c.env));
  } catch (e: any) {
    const { status, message } = toPublicError(e, '分片保存失败');
    return c.json({ error: message }, status as any);
  }
});

app.get('/api/upload/chunk/status/:session', async (c) => {
  try {
    return c.json(await chunkStatus(c, c.env));
  } catch (e: any) {
    const { status, message } = toPublicError(e, '查询失败');
    return c.json({ error: message }, status as any);
  }
});

app.post('/api/upload/chunk/complete/:session', async (c) => {
  try {
    return c.json(await chunkComplete(c, c.env));
  } catch (e: any) {
    const { status, message } = toPublicError(e, '合并失败');
    return c.json({ error: message }, status as any);
  }
});

app.post('/api/upload/chunk/abort/:session', async (c) => {
  try {
    return c.json(await chunkAbort(c, c.env));
  } catch (e: any) {
    const { status, message } = toPublicError(e, '放弃失败');
    return c.json({ error: message }, status as any);
  }
});

// ===================== Turnstile =====================

// 首页在服务端已确认需要验证时才调用；cookie 有效就不重复出题
app.get('/api/turnstile/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const settings = await getSettings(c.env.DB, [TURNSTILE_SETTING_KEY]);
    if (settings[TURNSTILE_SETTING_KEY] !== '1' || !turnstileConfigured(c.env)) {
      return c.json({ verified: false });
    }
    return c.json({ verified: await verifyGuestVerifiedCookie(c, c.env) });
  } catch {
    return c.json({ verified: false });
  }
});

app.post('/api/turnstile/verify', async (c) => {
  try {
    assertBodyWithinLimit(c, 8 * 1024);
    const ip = getClientIp(c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'turnstile_ratelimit', ip, 10))) {
      return c.json({ error: '验证过于频繁，请稍后再试' }, 429);
    }
    const settings = await getSettings(c.env.DB, [TURNSTILE_SETTING_KEY]);
    if (settings[TURNSTILE_SETTING_KEY] !== '1') {
      return c.json({ error: '人机验证未开启' }, 404);
    }
    if (!turnstileConfigured(c.env)) {
      return c.json({ error: '人机验证未配置完整' }, 503);
    }
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!token) return c.json({ error: '缺少验证 token' }, 422);
    if (!(await verifyTurnstileToken(c.env, token, ip))) {
      return c.json({ error: '人机验证失败，请重试' }, 403);
    }
    await issueGuestVerifiedCookie(c, c.env);
    return c.json({ ok: true });
  } catch (e: any) {
    const { status, message } = toPublicError(e, '人机验证失败');
    return c.json({ error: message }, status as any);
  }
});

// ===================== 文本分享 =====================

app.post('/api/upload/text', async (c) => {
  try {
    const result = await uploadText(c, c.env);
    // 结果页现在含分享正文，禁止缓存，避免 CDN 把私密内容留在边缘节点
    c.header('Cache-Control', 'no-store');
    return c.html(resultPage({
      code: result.code, title: result.title, baseUrl: getBaseUrl(c), text: result.text,
      meta: { size: result.textSize, download_count: 0, max_downloads: result.maxDownloads, expire_at: result.expireAt },
    }));
  } catch (e: any) {
    const { status, message } = toPublicError(e, '保存失败');
    return c.html(errorPage(message, ''), status as any);
  }
});

app.get('/api/text/:code', async (c) => {
  // 查看次数决定可见性，不能被浏览器/边缘缓存留在额度用完之后
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  const code = c.req.param('code').trim();
  const file = await getFileByCode(c.env.DB, code);
  if (!file || file.is_text !== 1) {
    if (!(await registerLookupFailure(c, c.env))) return c.text(LOOKUP_RATE_MESSAGE, 429);
    return c.text('Not found', 404);
  }

  if (c.req.method !== 'HEAD' && !(await incrementDownload(c.env.DB, code))) {
    return c.text('Max downloads exceeded', 403);
  }
  const textObj = await c.env.FILE_STORE.get(`file:${code}`);
  if (!textObj) return c.text('Not found', 404);
  return c.text(await textObj.text());
});

// ===================== 下载 =====================

app.get('/api/download/:code', async (c) => {
  // 下载次数是配额，任何缓存命中都等于绕过计数
  c.header('Cache-Control', 'no-store');
  try {
    const result = await downloadFile(c, c.env);
    if (result.notFound) return c.html(errorPage('文件不存在', '该文件可能已被清理'), 404);
    if (result.maxExceeded) return c.html(errorPage('已达最大下载次数', '该文件的下载次数已用完'), 403);

    const headers: Record<string, string> = {
      'Content-Type': result.file!.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeFilename(result.file!.filename)}`,
      'Content-Length': String(result.obj?.size ?? 0),
      'X-Content-Type-Options': 'nosniff',
    };
    return new Response(result.isHead ? null : result.obj?.body, { headers });
  } catch (e: any) {
    const { status, message } = toPublicError(e, '服务器内部错误');
    return c.html(errorPage(message, ''), status as any);
  }
});

// ===================== 图片缩略图 =====================

app.post('/api/thumb/:code', async (c) => {
  try {
    return c.json(await saveThumb(c, c.env));
  } catch (e: any) {
    const { status, message } = toPublicError(e, '保存失败');
    return c.json({ error: message }, status as any);
  }
});

app.get('/api/thumb/:code', async (c) => {
  try {
    const thumb = await readThumb(c, c.env);
    if (!thumb) return c.text('Not found', 404);
    // no-store：可见性取决于剩余下载次数，缓存会把它留在额度用完之后
    return new Response(thumb.body, {
      headers: {
        'Content-Type': thumb.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e: any) {
    if (e?.status === 429) return c.text(e.message, 429);
    throw e;
  }
});

// ===================== 连号取件码分配 =====================

app.get('/api/codes/:count', async (c) => {
  try {
    return c.json(await allocateCodeRun(c, c.env));
  } catch (e: any) {
    const { status, message } = toPublicError(e);
    return c.json({ error: message }, status as any);
  }
});

// ===================== QR 码生成 =====================

app.get('/qrcode/:code', async (c) => {
  try {
    const code = c.req.param('code').trim();
    if (!/^\d{4}$/.test(code)) {
      return c.text('Invalid code', 400);
    }
    const file = await getFileByCode(c.env.DB, code);
    if (!file) {
      if (!(await registerLookupFailure(c, c.env))) return c.text(LOOKUP_RATE_MESSAGE, 429);
      return c.text('File not found', 404);
    }
    const baseUrl = getBaseUrl(c);
    const url = `${baseUrl}/r/${code}`;
    const gif = generateQRCodeGIF(url, 200);
    // Uint8Array 运行时即合法 BodyInit，仅需绕开 TS 泛型数组限制
    return new Response(gif as unknown as BodyInit, {
      status: 200,
      headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  } catch (e) {
    console.error('[QR] Error:', e);
    const { status, message } = toPublicError(e, '二维码生成失败');
    return c.text(message, status as any);
  }
});

// ===================== 文件信息 API =====================

app.get('/api/info/:code', async (c) => {
  // 文本标题会随查看次数遮蔽，元信息同样不能缓存
  c.header('Cache-Control', 'no-store');
  const code = c.req.param('code').trim();
  const file = await getFileByCode(c.env.DB, code);
  if (!file) {
    if (!(await registerLookupFailure(c, c.env))) return c.json({ error: LOOKUP_RATE_MESSAGE }, 429);
    return c.json({ error: 'not found' }, 404);
  }
  return c.json({
    // 文本分享的 filename 是正文前 50 字，耗尽查看次数后与页面一样遮蔽
    filename: displayFilename(file),
    size: file.size,
    download_count: file.download_count,
    max_downloads: file.max_downloads,
    expire_at: file.expire_at,
  });
});

// ===================== 管理后台 =====================

// 管理首页（受保护，使用 /admin 路径）
app.get('/admin', async (c) => {
  c.header('Cache-Control', 'no-store');
  const env = c.env;
  // 一次查询同时完成 token 校验、上限与 storage_used 读取
  const state = await readAdminState(c);
  if (!state) return c.html(adminLoginPage());

  const page = parseIntParam(c.req.query('page'), 1, 1, 1_000_000);
  const keyword = (c.req.query('keyword') || '').trim();
  const dateFrom = c.req.query('date_from') || '';
  const dateTo = c.req.query('date_to') || '';
  const sort = c.req.query('sort') || 'newest';

  const [{ files, total }, stats, chunkTasks] = await Promise.all([
    listFilesAdvanced(env.DB, page, 50, keyword, dateFrom, dateTo, sort),
    getDashboardStats(env.DB),
    listChunkTasks(env.DB),
  ]);
  return c.html(adminPanel(files, total, page, undefined, { keyword, dateFrom, dateTo, sort }, stats,
    { used: state.storageUsed, limit: state.limits.maxTotalStorage, sessions: chunkTasks }));
});

// 后台设置页：写入 fc_settings 覆盖 wrangler vars（resolveLimits 中 DB 优先），保存即生效
app.get('/admin/settings', async (c) => {
  c.header('Cache-Control', 'no-store');
  const state = await readAdminState(c);
  if (!state) return c.redirect('/admin');
  const saved = c.req.query('saved') ? '设置已保存，立即生效' : undefined;
  return c.html(adminSettingsPage(adminConfigFromState(state, c.env), saved));
});

app.post('/admin/settings', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');
  const bad = guardFormBody(c, 64 * 1024);
  if (bad) return bad;
  const body = await c.req.parseBody();
  const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  // 表单以 MB 为单位（字节数对人不直观），落库仍是字节：
  // 服务端比较、fc_settings 与兼容 API 的语义都不变。
  // 留空 / 0 / 非法值统一写成空串，resolveLimits 会忽略它并回退到 wrangler vars
  const mbField = (k: string) => {
    const n = parseFloat(field(k));
    return Number.isFinite(n) && n > 0 ? String(Math.round(n * 1048576)) : '';
  };
  const defaultDays = parseInt(field('defaultExpireDays'), 10);
  await setSetting(env.DB, 'open_upload', field('openUpload') === '0' ? '0' : '1');
  await setSetting(env.DB, 'max_file_size', mbField('maxFileSizeMb'));
  // 留空/非法一律回退到 wrangler 变量；上限 3650 天，避免一个手滑值让所有上传构造日期越界
  await setSetting(
    env.DB,
    'default_expire_days',
    Number.isFinite(defaultDays) && defaultDays >= 1 && defaultDays <= 3650 ? String(defaultDays) : '',
  );
  await setSetting(env.DB, 'max_total_storage', mbField('maxTotalStorageMb'));
  // 密钥不全时强制保持关闭；开启后游客上传走 Turnstile cookie 校验
  await setSetting(
    env.DB,
    TURNSTILE_SETTING_KEY,
    field('turnstileEnabled') === '1' && turnstileConfigured(env) ? '1' : '0',
  );
  return c.redirect('/admin/settings?saved=1');
});

// 兼容旧路径 /console；尾斜杠统一跳到规范路径，避免落到兜底 404
app.get('/console', (c) => c.redirect('/admin'));
app.get('/admin/', (c) => c.redirect('/admin'));
app.get('/r/', (c) => c.redirect('/r'));

// Web 表单登录（HTML 页面）；JSON 登录见 /api/admin/login（兼容 API）
app.post('/admin/login', async (c) => {
  const env = c.env;
  const bad = guardFormBody(c, 8 * 1024);
  if (bad) return bad;
  const body = await c.req.parseBody();
  const password = typeof body['password'] === 'string' ? body['password'] : '';

  const result = await handleAdminLogin(c, env, password);
  if (!result.success) {
    return c.html(adminLoginPage(result.error));
  }
  return c.redirect('/admin');
});

// Web 登出（GET 链接点击即退出，并清除 DB token）
app.get('/admin/logout', async (c) => {
  await handleAdminLogout(c, c.env);
  return c.redirect('/');
});

// 兼容旧路径
app.get('/api/console/logout', (c) => c.redirect('/admin/logout'));

app.post('/admin/delete/:id', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');

  const id = parseInt(c.req.param('id'));
  if (!Number.isInteger(id)) return c.redirect('/admin');
  const file = await getFileById(env.DB, id);
  if (!file) return c.redirect('/admin');
  // 先删 R2，再删 DB（finally 保证 DB 清理），避免 R2 删除失败产生孤儿文件；
  // 缩略图与主文件一起删（R2 delete 接受键数组，一次批量请求）
  try {
    await env.FILE_STORE.delete([`file:${file.code}`, `thumb:${file.code}`]);
  } finally {
    await deleteFileRecord(env.DB, id, file);
  }
  return c.redirect('/admin');
});

/**
 * 未完成的 multipart 不是对象，R2 面板和孤儿扫描都清不掉，只能由管理员立刻 abort。
 * upload_id 走表单而不是路径：它是 R2 给的原始字符串，字符集不归我们管，
 * 放进 URL 迟早被某一环改写成一个查不到的键
 */
app.post('/admin/chunk/abort', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');
  const bad = guardFormBody(c, 4 * 1024);
  if (bad) return bad;
  const body = await c.req.parseBody();
  await abortChunkSession(env, typeof body['upload_id'] === 'string' ? body['upload_id'] : '');
  return c.redirect('/admin');
});

app.post('/admin/chunk/abort-all', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');
  await abortAllChunkSessions(env);
  return c.redirect('/admin');
});

app.post('/admin/cleanup', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');

  // 每个阶段独立 try/catch：任何一个撞上子请求上限/瞬时错误，
  // 都不能连带跳过后面更要紧的清理（例如正在计费的分片会话）
  const stages: Array<[string, () => Promise<unknown>]> = [
    ['expired', () => cleanupExpired(env.DB, env.FILE_STORE)],
    ['used_codes', () => cleanupUsedCodes(env.DB)],
    // 也要扫超时未完成的分片会话：它们不是对象，孤儿扫描看不见
    ['stale_chunks', () => cleanupStaleChunkUploads(env)],
    // 限流/配额行先清，成本低且不该被后面的全桶扫描拖累
    ['rate_limits', () => cleanupRateLimitEntries(env.DB)],
    // 与 Cron 同一条路径：顺带清孤儿对象并把 storage_used 对账成 R2 实测值。
    // 新部署或计数器漂移时，管理员点一次就能拿到准确数字，不必等半小时
    ['orphans', async () => {
      const { usedBytes, scanned } = await cleanupOrphanedR2Objects(env.DB, env.FILE_STORE);
      if (usedBytes > 0 || scanned === 0) await setStorageUsed(env.DB, usedBytes);
    }],
  ];
  let budgetExhausted = false;
  for (const [name, run] of stages) {
    if (budgetExhausted) break;
    try {
      await run();
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      if (/too many subrequests/i.test(msg)) budgetExhausted = true;
      console.error(`[admin/cleanup] ${name} failed: ${msg}`);
    }
  }
  return c.redirect('/admin');
});

// ===================== 初始化 =====================

app.get('/api/init', async (c) => {
  // 需管理员登录，避免公开触发数据库初始化
  if (!(await adminAuth(c, c.env))) return c.json({ error: 'unauthorized' }, 401);
  try {
    await initDB(c.env.DB);
    return c.json({ ok: true });
  } catch (e: any) {
    console.error('init error:', e);
    return c.json({ error: '服务器内部错误' }, 500);
  }
});

// ===================== FileCodeBox 兼容 API =====================
// 挂载在 /api 前缀，路径与 FileCodeBox v2.1.0 文档一致（如 /api/share/file）
app.route('/api', api);

// 未知 API 路径返回 404 JSON，不落入首页兜底
app.all('/api/*', (c) => c.json({ code: 404, msg: 'Not Found' }, 404));

// wrangler dev 的 live-reload WebSocket 端点：兜底路由会把它当未知页面返回整张首页 HTML，
// 对开发者是误导。生产环境不存在该路径，直接 404。
// （注：dev 进程偶发整体退出是 wrangler 4.114 本地 proxy 的问题，与此无关，见 README 已知问题）
app.all('/signal', (c) => new Response(null, { status: 404 }));

// ===================== 兜底 =====================

// 未知路径返回真正的 404，而不是 200 首页；否则拼错的地址/静态路径会伪装成正常页面
app.all('*', (c) => c.html(errorPage('页面不存在', '请检查地址是否正确'), 404));

// ===================== 导出 =====================
// fetch: Hono 处理所有 HTTP 请求
// scheduled: Cloudflare Cron 触发器自动清理过期文件
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        // Free 计划每次调用只有 50 个子请求。每个阶段独立 try/catch：
        // 一个阶段失败不能连带跳过后面的清理；一旦确认撞上子请求上限，
        // 后面的调用也只会继续报错，直接停止并留日志
        const summary: Record<string, unknown> = { event: 'scheduled_cleanup' };
        let budgetExhausted = false;
        const stage = async (name: string, fn: () => Promise<void>): Promise<void> => {
          if (budgetExhausted) return;
          try {
            await fn();
          } catch (e) {
            const msg = String((e as any)?.message ?? e);
            if (/too many subrequests/i.test(msg)) budgetExhausted = true;
            console.error(JSON.stringify({ event: 'scheduled_cleanup_error', stage: name, error: msg }));
          }
        };

        // 幂等初始化：确保首次部署后表结构自动就绪（/api/init 已需鉴权）
        await stage('init', async () => {
          await initDB(env.DB);
        });
        await stage('expired', async () => {
          summary.expiredCount = (await cleanupExpired(env.DB, env.FILE_STORE)).expiredCount;
        });
        // 无条件下执行：修复“没有过期文件就永远不清理 used_codes”的漏洞
        await stage('used_codes', async () => {
          summary.cleanedCodes = await cleanupUsedCodes(env.DB);
        });
        // 超时未完成的分片会话必须 abort：已上传但未合并的分片会一直计费。
        // 放在全桶扫描之前，先释放正在计费的部分
        await stage('stale_chunks', async () => {
          summary.staleChunks = await cleanupStaleChunkUploads(env);
        });
        // 限流/配额行先清，成本低且不该被后面的全桶扫描拖累
        await stage('rate_limits', async () => {
          summary.rateLimitCleaned = await cleanupRateLimitEntries(env.DB);
        });
        // 对账：孤儿扫描已经逐页累加了实测占用，直接改写计数器，
        // 修掉增量计数器在异常路径上可能攒出的漂移（0 表示桶确实空了，不是"没扫到"）。
        // 放在最后：10,000 个对象时 list 页数最多，若撞到子请求上限也只影响对账
        await stage('orphans', async () => {
          const { scanned, removed, usedBytes } = await cleanupOrphanedR2Objects(env.DB, env.FILE_STORE);
          summary.r2Scanned = scanned;
          summary.r2Removed = removed;
          summary.storageUsed = usedBytes;
          if (usedBytes > 0 || scanned === 0) await setStorageUsed(env.DB, usedBytes);
        });
        console.log(JSON.stringify(summary));
      })(),
    );
  },
};
