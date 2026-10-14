/**
 * FileCodeBox - Cloudflare Worker 重写版
 * 像取快递一样取文件
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';

import type { Env, FileRecord } from './types';

import {
  initDB,
  getFileByCode,
  getFileById,
  deleteFileRecord,
  listFilesAdvanced,
  cleanupExpired,
  cleanupOrphanedR2Objects,
  cleanupRateLimitEntries,
  incrementDownload,
  getDashboardStats,
  getSetting,
  setSetting,
} from './db';
import { adminAuth, handleAdminLogin, handleAdminLogout } from './auth';
import api from './api';
import { uploadFile, uploadText, downloadFile, resolveLimits } from './shared';
import { generateQRCodeGIF } from './qr';
import { STYLE } from './templates/style';
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

app.use('*', cors({ origin: 'self', allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD'] }));
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  // Content-Security-Policy：限制资源加载来源，降低 XSS 影响面
  c.res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
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
 * 首页所需的生效设置。
 * 全新数据库尚未建表时（initDB 由 Cron 或 provision 完成）必须降级为默认值，
 * 否则首页会从「可用静态页」退化成 500。
 */
async function homeOptions(env: Env): Promise<HomeOptions> {
  try {
    const [openUpload, limits] = await Promise.all([getSetting(env.DB, 'open_upload'), resolveLimits(env)]);
    return { uploadAllowed: (openUpload ?? '1') !== '0', defaultExpireDays: limits.defaultExpireDays };
  } catch {
    return { uploadAllowed: true, defaultExpireDays: 7 };
  }
}

/** 后台设置页所需的当前值（生效值 + vars 回退值） */
async function adminConfig(env: Env): Promise<AdminConfig> {
  const [openUpload, limits] = await Promise.all([getSetting(env.DB, 'open_upload'), resolveLimits(env)]);
  const toInt = (v: string | undefined, fallback: number) => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    openUpload: openUpload ?? '1',
    maxFileSize: limits.maxSize,
    defaultExpireDays: limits.defaultExpireDays,
    varsMaxFileSize: toInt(env.MAX_FILE_SIZE, 26214400),
    varsDefaultExpireDays: toInt(env.DEFAULT_EXPIRE_DAYS, 7),
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
  return c.html(homePage(await homeOptions(c.env)));
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
  if (!file) return c.html(retrievePage(code));
  return c.html(filePage(file, getBaseUrl(c)));
});

// ===================== 文件上传 =====================

app.post('/api/upload', async (c) => {
  try {
    const result = await uploadFile(c, c.env);
    return c.json(result);
  } catch (e: any) {
    const status = e?.status ?? 500;
    return c.json({ error: e?.message ?? '服务器内部错误' }, status);
  }
});

// ===================== 文本分享 =====================

app.post('/api/upload/text', async (c) => {
  try {
    const result = await uploadText(c, c.env);
    return c.html(resultPage(result.code, result.title, result.textSize, getBaseUrl(c)));
  } catch (e: any) {
    return c.html(errorPage(e?.message ?? '保存失败', '服务器内部错误'), e?.status ?? 500);
  }
});

app.get('/api/text/:code', async (c) => {
  const code = c.req.param('code').trim();
  const file = await getFileByCode(c.env.DB, code);
  if (!file || file.is_text !== 1) return c.text('Not found', 404);

  if (c.req.method !== 'HEAD' && !(await incrementDownload(c.env.DB, code))) {
    return c.text('Max downloads exceeded', 403);
  }
  const textObj = await c.env.FILE_STORE.get(`file:${code}`);
  if (!textObj) return c.text('Not found', 404);
  return c.text(await textObj.text());
});

// ===================== 下载 =====================

app.get('/api/download/:code', async (c) => {
  try {
    const result = await downloadFile(c, c.env);
    if (result.notFound) return c.html(errorPage('文件不存在', '该文件可能已被清理'), 404);
    if (result.maxExceeded) return c.html(errorPage('已达最大下载次数', '该文件的下载次数已用完'), 403);

    const headers: Record<string, string> = {
      'Content-Type': result.file!.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.file!.filename)}`,
      'Content-Length': String(result.obj?.size ?? 0),
    };
    return new Response(result.isHead ? null : result.obj?.body, { headers });
  } catch (e: any) {
    return c.html(errorPage(e?.message ?? '未找到文件', ''), e?.status ?? 404);
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
    if (!file) return c.text('File not found', 404);
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
    return c.text(`QR Error: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});

// ===================== 文件信息 API =====================

app.get('/api/info/:code', async (c) => {
  const code = c.req.param('code').trim();
  const file = await getFileByCode(c.env.DB, code);
  if (!file) return c.json({ error: 'not found' }, 404);
  return c.json({
    filename: file.filename,
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
  if (!(await adminAuth(c, env))) return c.html(adminLoginPage());

  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const keyword = (c.req.query('keyword') || '').trim();
  const dateFrom = c.req.query('date_from') || '';
  const dateTo = c.req.query('date_to') || '';
  const sort = c.req.query('sort') || 'newest';

  const [{ files, total }, stats] = await Promise.all([
    listFilesAdvanced(env.DB, page, 50, keyword, dateFrom, dateTo, sort),
    getDashboardStats(env.DB),
  ]);
  return c.html(adminPanel(files, total, page, undefined, { keyword, dateFrom, dateTo, sort }, stats));
});

// 后台设置页：写入 fc_settings 覆盖 wrangler vars（resolveLimits 中 DB 优先），保存即生效
app.get('/admin/settings', async (c) => {
  c.header('Cache-Control', 'no-store');
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');
  const saved = c.req.query('saved') ? '设置已保存，立即生效' : undefined;
  return c.html(adminSettingsPage(await adminConfig(env), saved));
});

app.post('/admin/settings', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');
  const body = await c.req.parseBody();
  const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  await setSetting(env.DB, 'open_upload', field('openUpload') === '0' ? '0' : '1');
  // 清空即回退到 wrangler vars：resolveLimits 会忽略空值与非法值
  await setSetting(env.DB, 'max_file_size', field('maxFileSize'));
  await setSetting(env.DB, 'default_expire_days', field('defaultExpireDays'));
  return c.redirect('/admin/settings?saved=1');
});

// 兼容旧路径 /console
app.get('/console', (c) => c.redirect('/admin'));

// Web 表单登录（HTML 页面）；JSON 登录见 /api/admin/login（兼容 API）
app.post('/admin/login', async (c) => {
  const env = c.env;
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
  // 先删 R2，再删 DB（finally 保证 DB 清理），避免 R2 删除失败产生孤儿文件
  try {
    await env.FILE_STORE.delete(`file:${file.code}`);
  } finally {
    await deleteFileRecord(env.DB, id);
  }
  return c.redirect('/admin');
});

app.post('/admin/cleanup', async (c) => {
  const env = c.env;
  if (!(await adminAuth(c, env))) return c.redirect('/admin');

  await cleanupExpired(env.DB, env.FILE_STORE);
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

app.all('*', async (c) => c.html(homePage(await homeOptions(c.env))));

// ===================== 导出 =====================
// fetch: Hono 处理所有 HTTP 请求
// scheduled: Cloudflare Cron 触发器自动清理过期文件
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          // 幂等初始化：确保首次部署后表结构自动就绪（/api/init 已需鉴权）
          await initDB(env.DB);
          const { expiredCount, cleanedCodes } = await cleanupExpired(env.DB, env.FILE_STORE);
          const { scanned, removed } = await cleanupOrphanedR2Objects(env.DB, env.FILE_STORE);
          const rateLimitCleaned = await cleanupRateLimitEntries(env.DB);
          console.log(JSON.stringify({
            event: 'scheduled_cleanup',
            expiredCount,
            cleanedCodes,
            r2Scanned: scanned,
            r2Removed: removed,
            rateLimitCleaned,
          }));
        } catch (e) {
          console.error(JSON.stringify({ event: 'scheduled_cleanup_error', error: String(e) }));
        }
      })(),
    );
  },
};
