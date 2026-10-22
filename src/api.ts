/**
 * FileCodeBox 兼容 API（v2.1.0）
 * 标准响应格式: { code, msg, detail }
 * 文档: https://fcb-docs.aiuo.net/api/
 *
 * 业务逻辑由 src/shared.ts 统一实现，本文件仅负责路由注册与响应格式转换。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from './types';
import { formatFileSize } from './utils';
import { getFileById, deleteFileRecord, listFilesAdvanced, getDashboardStats, getSetting, getStorageUsed, setSetting } from './db';
import { adminAuth, handleAdminLogin } from './auth';
import { uploadFile, uploadText, selectFile as sharedSelectFile, downloadFile as sharedDownloadFile, resolveLimits, displayFilename, assertBodyWithinLimit } from './shared';

type Bindings = { Bindings: Env };

// ===================== 响应助手 =====================

function ok(c: Context<Bindings>, detail: unknown, msg = 'success') {
  return c.json({ code: 200, msg, detail });
}

function fail(c: Context<Bindings>, status: ContentfulStatusCode, msg: string) {
  return c.json({ code: status, msg }, status);
}

/**
 * 当前实际生效的配置。maxFileSize / defaultExpireDays 走 resolveLimits，
 * 保证接口回报的值与上传时真正使用的值一致（DB 设置优先于 wrangler vars）。
 */
async function effectiveConfig(c: Context<Bindings>) {
  const limits = await resolveLimits(c.env);
  return {
    openUpload: (await getSetting(c.env.DB, 'open_upload')) ?? '1',
    maxFileSize: String(limits.maxSize),
    defaultExpireDays: String(limits.defaultExpireDays),
    // '0' = 不限制总占用
    maxTotalStorage: String(limits.maxTotalStorage),
    storageUsed: String(await getStorageUsed(c.env.DB)),
  };
}

// ===================== 路由 =====================
// 游客上传开关（open_upload）已下沉到 shared.ts 的 assertUploadAllowed，
// 由 uploadFile / uploadText 统一拦截，兼容 API 与首页表单共用同一道闸。

const api = new Hono<Bindings>();

// ---- 认证（公开） ----
api.post('/admin/login', async (c) => {
  try {
    const env = c.env;
    assertBodyWithinLimit(c, 4 * 1024);
    const body = await c.req.json().catch(() => null);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password) return fail(c, 422, '密码不能为空');

    const result = await handleAdminLogin(c, env, password);
    if (!result.success) return fail(c, 401, result.error);

    return ok(c, { token: result.token, token_type: 'Bearer' });
  } catch (e: any) {
    const status = e?.status ?? 500;
    return fail(c, status, status === 500 ? '服务器内部错误' : e?.message ?? '请求失败');
  }
});

// ---- 分享文本 ----
const shareText = async (c: Context<Bindings>) => {
  try {
    const result = await uploadText(c, c.env);
    return ok(c, { code: result.code });
  } catch (e: any) {
    return fail(c, e?.status ?? 500, e?.message ?? '服务器内部错误');
  }
};
api.post('/share/text/', shareText);
api.post('/share/text', shareText);

// ---- 分享文件 ----
const shareFile = async (c: Context<Bindings>) => {
  try {
    const result = await uploadFile(c, c.env);
    return ok(c, { code: result.code, name: result.filename });
  } catch (e: any) {
    return fail(c, e?.status ?? 500, e?.message ?? '服务器内部错误');
  }
};
api.post('/share/file/', shareFile);
api.post('/share/file', shareFile);

// ---- 获取/选择文件信息 ----
async function selectFile(c: Context<Bindings>, countAsDownload: boolean) {
  // GET 会计数、POST 会随查看次数遮蔽标题，两者都不能被缓存
  c.header('Cache-Control', 'no-store');
  try {
    const result = await sharedSelectFile(c, c.env, countAsDownload);
    if (result.notFound) return fail(c, 404, '文件不存在或已过期');
    if (result.maxExceeded) return fail(c, 403, '已达最大下载次数');
    const file = result.file!;
    return ok(c, {
      code: file.code,
      // POST select 只查状态，不返回正文；文本标题在查看次数耗尽后同样遮蔽
      name: displayFilename(file),
      size: file.size,
      text: result.text,
    });
  } catch (e: any) {
    return fail(c, e?.status ?? 500, e?.message ?? '服务器内部错误');
  }
}

api.get('/share/select/', (c) => selectFile(c, true));
api.post('/share/select/', (c) => selectFile(c, false));
api.get('/share/select', (c) => selectFile(c, true));
api.post('/share/select', (c) => selectFile(c, false));

// ---- 下载 ----
api.get('/share/download', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const result = await sharedDownloadFile(c, c.env);
    if (result.notFound) return fail(c, 404, '文件不存在或已过期');
    if (result.maxExceeded) return fail(c, 403, '已达最大下载次数');

    return new Response(result.isHead ? null : result.obj?.body, {
      headers: {
        'Content-Type': result.file!.mime_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.file!.filename)}`,
        'Content-Length': String(result.obj?.size ?? 0),
      },
    });
  } catch (e: any) {
    return fail(c, e?.status ?? 500, e?.message ?? '服务器内部错误');
  }
});

// ---- 管理（受保护） ----

const adminApi = new Hono<Bindings>();

adminApi.use('*', async (c, next) => {
  if (!(await adminAuth(c, c.env))) {
    return c.json({ code: 401, msg: '未授权' }, 401);
  }
  await next();
});

adminApi.get('/dashboard', async (c) => {
  // storageUsed 用配额计数器而不是 D1 求和：两者会因缩略图与对账而不同，
  // 而管理员拿这个数字是为了判断"还剩多少能传"，必须与拒绝上传时用的是同一个值
  const [stats, used] = await Promise.all([getDashboardStats(c.env.DB), getStorageUsed(c.env.DB)]);
  return ok(c, {
    totalFiles: stats.totalFiles,
    storageUsed: formatFileSize(used),
    todayCount: stats.todayCount,
    todaySize: formatFileSize(stats.todaySize),
    yesterdayCount: stats.yesterdayCount,
    yesterdaySize: formatFileSize(stats.yesterdaySize),
  });
});

adminApi.get('/file/list', async (c) => {
  const env = c.env;
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const size = Math.min(100, Math.max(1, parseInt(c.req.query('size') || '10')));
  const keyword = c.req.query('keyword') || '';
  const dateFrom = c.req.query('date_from') || '';
  const dateTo = c.req.query('date_to') || '';
  const sort = c.req.query('sort') || 'newest';
  const { files, total } = await listFilesAdvanced(env.DB, page, size, keyword, dateFrom, dateTo, sort);
  return ok(c, {
    page,
    size,
    total,
    data: files.map((f) => ({
      id: f.id,
      name: f.filename,
      size: f.size,
      code: f.code,
      download_count: f.download_count,
      expire_at: f.expire_at,
      created_at: f.created_at,
    })),
  });
});

adminApi.delete('/file/delete', async (c) => {
  const env = c.env;
  const id = parseInt(c.req.query('id') || '');
  if (!id) return fail(c, 422, '缺少文件 ID');

  const file = await getFileById(env.DB, id);
  if (!file) return fail(c, 404, '文件不存在');
  // 先删 R2，再删 DB（finally 保证 DB 清理），避免 R2 删除失败产生孤儿文件；
  // 缩略图是内容的第二份副本，随主文件一起删
  try {
    await env.FILE_STORE.delete([`file:${file.code}`, `thumb:${file.code}`]);
  } finally {
    await deleteFileRecord(env.DB, id);
  }
  return ok(c, { id });
});

adminApi.get('/config/get', async (c) => {
  return ok(c, await effectiveConfig(c));
});

adminApi.patch('/config/update', async (c) => {
  try {
    const env = c.env;
    assertBodyWithinLimit(c, 64 * 1024);
    const body = await c.req.json().catch(() => null);
    if (!body) return fail(c, 422, '请求体不能为空');

    if (body.openUpload !== undefined) await setSetting(env.DB, 'open_upload', String(body.openUpload));
    if (body.maxFileSize !== undefined) await setSetting(env.DB, 'max_file_size', String(body.maxFileSize));
    if (body.defaultExpireDays !== undefined) {
      // 非法值写空串回退到 vars；上限 3650 天，避免一个值让全站上传构造日期越界
      const days = parseInt(String(body.defaultExpireDays), 10);
      await setSetting(
        env.DB,
        'default_expire_days',
        Number.isFinite(days) && days >= 1 && days <= 3650 ? String(days) : '',
      );
    }
    if (body.maxTotalStorage !== undefined) await setSetting(env.DB, 'max_total_storage', String(body.maxTotalStorage));

    return ok(c, await effectiveConfig(c));
  } catch (e: any) {
    const status = e?.status ?? 500;
    return fail(c, status, status === 500 ? '服务器内部错误' : e?.message ?? '请求失败');
  }
});

api.route('/admin', adminApi);

export default api;
