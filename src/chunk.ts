/**
 * 分片上传（R2 原生 multipart）
 *
 * 为什么需要：Cloudflare 对单次请求体有硬上限（Free/Pro 100 MB、Business 200 MB），
 * 一个 300 MB 的文件不可能作为一个 POST 请求进来 —— 它在边缘就被拒了，
 * 连我们的代码都执行不到，用户拿到的也不是友好的「文件过大」提示。
 * 分片把「一个文件」变成「若干个小请求」，每片直接流进同一个 multipart 会话，
 * 由 R2 合成一个对象 —— 所以一个文件仍然只有一个取件码、后台仍然只是一行记录。
 *
 * 没有采用上游那种「每片先存成独立对象、complete 时读回拼接」的做法：
 * 那样存储峰值翻倍、每片多两次 R2 请求，客户端中途放弃还会在桶里留下一堆 chunk:* 对象计费。
 */
import type { Context } from 'hono';
import type { ChunkTask, Env } from './types';
import { getClientIp } from './utils';
import {
  assertUploadAllowed,
  ensureCodeAvailable,
  parseExpire,
  quotaMessage,
  remainingQuota,
  resolveLimits,
} from './shared';
import {
  deleteChunkTask,
  getChunkTask,
  getChunkTaskBySession,
  getChunkTaskStatement,
  hasFileRecord,
  insertChunkTask,
  insertFile,
  listChunkParts,
  listChunkTasks,
  listStaleChunkTasks,
  rateVerdict,
  releaseCode,
  saveChunkPartStatement,
  setSettingStatement,
  checkRateLimit,
} from './db';

/** 分片自己的限流额度（每 60 秒）：一次会话可能有上百片，共用上传桶会把自己掐死 */
const CHUNK_RATE_MAX = 300;

/**
 * 每片 16 MiB。
 * 片大小的真实成本不是带宽而是每片的固定开销（一次取会话 + 一次记账的 D1 往返，
 * 在你这档账号上一趟就是百来毫秒），所以片越大越省；代价是一片失败要重传整片，
 * 以及 `分片 x/N` 的计数变粗。16 MiB 同时满足 R2「非末片 ≥5 MiB」并远离 100 MB 请求体上限。
 */
export const CHUNK_PART_SIZE = 16 * 1024 * 1024;
/**
 * 超过这个大小才走分片。
 * 小于它的文件仍是单次请求：零拷贝之后 Worker 不再逐块搬字节，单请求既不吃 CPU 也不吃内存，
 * 64 MiB 距离套餐的 100 MB 请求体上限还有余量，不值得为它多付两次往返。
 */
export const CHUNK_THRESHOLD = 64 * 1024 * 1024;
/** R2 单次会话允许 10,000 片，这里收紧到 1000（≈ 16 GiB），越界直接拒绝而不是静默截断 */
const MAX_PARTS = 1000;
/** 未完成会话的保留时长。超时必须 abort —— 已上传但未 complete 的分片会持续计费 */
export const CHUNK_STALE_MS = 6 * 3600_000;

// 客户端句柄：我们自己生成的 32 位十六进制，绝不使用 R2 的 uploadId。
// 后者是 base64 家族的任意字符串，长度和字符集都不归我们管 —— 放进 URL 路径早晚被某一环
// （转义、二次解码、按 / 切段）改写，症状是每片都 422、进度永远 0/N，而会话已经在桶里计费
const SESSION_RE = /^[0-9a-f]{32}$/;

function newSessionId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 从路径句柄取回会话行。404 与 422 分开：前者是会话已结束，后者是句柄格式不对 */
async function resolveTask(c: Context<{ Bindings: Env }>, env: Env): Promise<ChunkTask> {
  const task = await getChunkTaskBySession(env.DB, sessionIdOf(c));
  if (!task) throw { status: 404 as const, message: '上传会话不存在或已结束' };
  return task;
}

function sessionIdOf(c: Context<{ Bindings: Env }>): string {
  const session = c.req.param('session') ?? '';
  if (!SESSION_RE.test(session)) throw { status: 422 as const, message: '无效的上传会话标识' };
  return session;
}

/** 与 uploadFile 一致的过期参数解析（兼容旧参数名 expire_days） */
function expireFrom(body: Record<string, unknown>, defaultExpireDays: number): { expireAt: string; maxDownloads: number } {
  const rawValue = body['expire_value'] ?? body['expire_days'] ?? defaultExpireDays;
  const value = Number(rawValue);
  const style = typeof body['expire_style'] === 'string' ? (body['expire_style'] as string) : 'day';
  const maxRaw = Number(body['max_downloads']);
  const parsed = parseExpire(Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultExpireDays, style);
  return {
    expireAt: parsed.expireAt,
    maxDownloads: Number.isFinite(maxRaw) && maxRaw >= 0 ? Math.floor(maxRaw) : parsed.maxDownloads,
  };
}

/** 预创建会话：校验大小与配额、抢占取件码、开 R2 multipart 会话 */
export async function chunkInit(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ session: string; code: string; part_size: number; total_parts: number }> {
  await assertUploadAllowed(c, env);

  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'upload_ratelimit', ip, 10))) {
    throw { status: 429 as const, message: '上传过于频繁，请稍后再试' };
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw { status: 422 as const, message: '请求体不能为空' };

  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) throw { status: 422 as const, message: '无效的文件大小' };

  const limits = await resolveLimits(env);
  if (size > limits.maxSize) {
    throw { status: 413 as const, message: `文件过大，最大 ${Math.floor(limits.maxSize / 1048576)}MB` };
  }
  const totalParts = Math.ceil(size / CHUNK_PART_SIZE);
  if (totalParts > MAX_PARTS) throw { status: 413 as const, message: '文件超出单次分片会话支持的范围' };
  if (size > await remainingQuota(env, limits.maxTotalStorage)) {
    throw { status: 507 as const, message: quotaMessage(limits) };
  }

  let filename = typeof body.filename === 'string' ? body.filename : '';
  try {
    filename = decodeURIComponent(filename);
  } catch {
    /* 保留原始值 */
  }
  filename = (filename || '未命名').slice(0, 200);
  const mimeType = (typeof body.content_type === 'string' && body.content_type) || 'application/octet-stream';
  const { expireAt, maxDownloads } = expireFrom(body, limits.defaultExpireDays);

  const code = await ensureCodeAvailable(String(body.code ?? '').trim(), env);
  const key = `file:${code}`;
  const sessionId = newSessionId();
  let uploadId = '';
  try {
    const mp = await env.FILE_STORE.createMultipartUpload(key, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { filename },
    });
    uploadId = mp.uploadId;
    const task: ChunkTask = {
      upload_id: uploadId, session_id: sessionId, code, filename, size, part_size: CHUNK_PART_SIZE, total_parts: totalParts,
      mime_type: mimeType, expire_at: expireAt, max_downloads: maxDownloads,
      created_at: new Date().toISOString(), ip,
    };
    await insertChunkTask(env.DB, task);
  } catch (e) {
    // 建了会话但没落成 D1 行，必须就地 abort：Workers API 列举不到 multipart 会话，
    // 没有记录的会话谁都清不掉，只能等它一直计费（R2 面板既看不见也删不掉）
    if (uploadId) await env.FILE_STORE.resumeMultipartUpload(key, uploadId).abort().catch(() => {});
    // 会话没建成就把码还回去，否则一次失败的 init 会白占一个码
    await releaseCode(env.DB, code).catch(() => {});
    throw e;
  }

  return { session: sessionId, code, part_size: CHUNK_PART_SIZE, total_parts: totalParts };
}

/**
 * 收一片：请求体原样交给 R2，字节不进 JS。
 * R2 接受带 Content-Length 的 request.body（长度已知），转发在平台内部完成；
 * 自己 read/write 搬运会把整片跑成一段不中断的执行，撞上免费计划 10ms 的连续 CPU 上限。
 */
export async function chunkPut(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ ok: true; part: number }> {
  const part = parseInt(c.req.param('part') ?? '');
  const session = sessionIdOf(c);
  const rateKey = `chunk_ratelimit:${getClientIp(c.req.raw.headers)}`;

  // 每片的成本主要是串行往返次数（这一档账号上一趟 D1 就是百来毫秒），所以：
  // 读限流窗口与取会话行合成一次 batch；写限流与记账再合成一次 batch —— 每片两趟往返顶天。
  // 「这片是不是已经传过」的预查直接去掉：它只能省一次冗余写，却要在每片的路上多插一趟往返，
  // 而重复片由 R2 的覆盖语义接住（同内容同 etag），真正省带宽的跳过在 status 接口那边。
  // 代价要说清楚：限流计数因此在 R2 写成功之后才累加，所以反复失败（比如片长不对）的请求
  // 不会把桶填满 —— 挡住无限刷片靠的是句柄本身（128 位随机），每次尝试仍要付一趟读的成本
  const [rateRes, taskRes] = await env.DB.batch([
    env.DB.prepare('SELECT value FROM fc_settings WHERE key = ?').bind(rateKey),
    getChunkTaskStatement(env.DB, session),
  ]);

  const raw = (rateRes.results as Array<{ value?: string } | undefined> | undefined)?.[0]?.value ?? null;
  const verdict = rateVerdict(raw, CHUNK_RATE_MAX);
  // 限流用独立桶：一次会话可能有上百片，共用上传桶会把自己掐死；
  // 反过来没有它，拿到会话句柄的人就能无限刷片
  if (!verdict.allowed) throw { status: 429 as const, message: '分片上传过于频繁，请稍后再试' };

  const task = (taskRes.results as ChunkTask[] | undefined)?.[0];
  if (!task) throw { status: 404 as const, message: '上传会话不存在或已结束' };
  if (!Number.isInteger(part) || part < 1 || part > task.total_parts) {
    throw { status: 422 as const, message: '分片序号超出范围' };
  }

  // 片长由会话行算出来，不信任客户端：第 1..N-1 片恒等于 part_size，末片是余数
  const expected = part < task.total_parts ? task.part_size : task.size - task.part_size * (task.total_parts - 1);
  const declared = Number(c.req.header('Content-Length'));
  if (declared !== expected) {
    throw { status: 422 as const, message: `分片长度应为 ${expected} 字节（第 ${part}/${task.total_parts} 片）` };
  }
  if (!c.req.raw.body) throw { status: 422 as const, message: '分片内容为空' };

  const mp = env.FILE_STORE.resumeMultipartUpload(`file:${task.code}`, task.upload_id);
  let etag = '';
  try {
    ({ etag } = await mp.uploadPart(part, c.req.raw.body));
  } catch (e: any) {
    // 长度对不上账（声明了却少送/多送）是唯一能确定属于客户端的失败，其余原样抛出
    if (e instanceof Error && /allotted size|known length/i.test(e.message)) {
      throw { status: 422 as const, message: '分片实际大小与 Content-Length 不符' };
    }
    throw e;
  }

  await env.DB.batch([
    setSettingStatement(env.DB, rateKey, verdict.value),
    saveChunkPartStatement(env.DB, task.upload_id, part, etag),
  ]);
  return { ok: true, part };
}

/** 已传哪些片（供断点续传跳过）。句柄是随机的，这里只暴露片号，不暴露内容 */
export async function chunkStatus(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ session: string; total_parts: number; done: number[] }> {
  const task = await resolveTask(c, env);
  const parts = await listChunkParts(env.DB, task.upload_id);
  return { session: task.session_id, total_parts: task.total_parts, done: parts.map((p) => p.part_number) };
}

/** 合并收尾：片齐了才 complete，记账一律用 R2 合成后的真实大小 */
export async function chunkComplete(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ code: string; filename: string; size: number }> {
  const task = await resolveTask(c, env);
  const uploadId = task.upload_id;

  const parts = await listChunkParts(env.DB, uploadId);
  const have = new Set(parts.map((p) => p.part_number));
  const missing: number[] = [];
  for (let i = 1; i <= task.total_parts; i++) if (!have.has(i)) missing.push(i);
  if (missing.length) {
    throw {
      status: 422 as const,
      message: `缺少分片：${missing.slice(0, 8).join(',')}${missing.length > 8 ? ` 等 ${missing.length} 片` : ''}`,
    };
  }

  const key = `file:${task.code}`;
  let size = 0;
  try {
    const mp = env.FILE_STORE.resumeMultipartUpload(key, uploadId);
    const obj = await mp.complete(parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
    size = obj.size;
  } catch (e) {
    // 单片与总大小的上限在 init / put 两处都已经拦过了，走到这里就是真的合并失败，
    // 一律 502 并清掉会话，不按错误消息猜成「文件过大」
    await forceAbort(env, task);
    console.error('[chunk] complete failed:', e instanceof Error ? e.message : String(e));
    throw { status: 502 as const, message: '分片合并失败，请重新上传' };
  }

  try {
    await insertFile(env.DB, {
      code: task.code, filename: task.filename, size, mimeType: task.mime_type,
      expireAt: task.expire_at, maxDownloads: task.max_downloads, clientIp: task.ip,
    });
  } catch (e) {
    await env.FILE_STORE.delete(key).catch(() => {});
    await releaseCode(env.DB, task.code);
    await deleteChunkTask(env.DB, uploadId);
    throw e;
  }

  await deleteChunkTask(env.DB, uploadId);
  return { code: task.code, filename: task.filename, size };
}

/** 客户端主动放弃：清会话、释放取件码。已经结束的会话重复放弃也返回成功（页面卸载会兜底再发一次） */
export async function chunkAbort(c: Context<{ Bindings: Env }>, env: Env): Promise<{ ok: true }> {
  const task = await getChunkTaskBySession(env.DB, sessionIdOf(c));
  if (task) await forceAbort(env, task);
  return { ok: true };
}

/**
 * 关掉一个会话。
 * 只 abort multipart（未 complete 时不会留下对象），**绝不删 file:{code}** ——
 * 万一 complete 成功而清理行失败，删对象就会把用户的真文件抹掉。
 * 释放取件码之前也要确认没有对应文件记录，同理。
 */
async function forceAbort(env: Env, task: ChunkTask): Promise<void> {
  try {
    await env.FILE_STORE.resumeMultipartUpload(`file:${task.code}`, task.upload_id).abort();
  } catch (e: any) {
    // 会话可能已完成或本就不存在；但行一删就再没有 API 能列出它，所以失败必须留痕
    console.error(`分片 abort 失败 code=${task.code} size=${task.size}: ${e?.message || e}`);
  }
  await deleteChunkTask(env.DB, task.upload_id);
  if (!(await hasFileRecord(env.DB, task.code))) {
    await releaseCode(env.DB, task.code);
  }
}

/** 超时未完成的会话：abort 掉，否则已传的分片会一直计费 */
export async function cleanupStaleChunkUploads(env: Env): Promise<number> {
  const stale = await listStaleChunkTasks(env.DB, CHUNK_STALE_MS);
  for (const task of stale) {
    await forceAbort(env, task);
  }
  return stale.length;
}

/**
 * 后台手动放弃单个会话。
 * 未完成的 multipart 不是对象 —— R2 面板删不掉、bucket.delete 也无效，只能走 abort，
 * 所以必须给管理员一个立刻执行的入口，而不是让他等 6 小时超时。
 */
export async function abortChunkSession(env: Env, uploadId: string): Promise<boolean> {
  const task = await getChunkTask(env.DB, uploadId);
  if (!task) return false;
  await forceAbort(env, task);
  return true;
}

/** 后台「放弃全部进行中会话」 */
export async function abortAllChunkSessions(env: Env): Promise<number> {
  const tasks = await listChunkTasks(env.DB);
  for (const task of tasks) {
    await forceAbort(env, task);
  }
  return tasks.length;
}
