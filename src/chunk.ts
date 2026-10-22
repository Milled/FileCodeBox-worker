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
import { getClientIp, sanitizeFilename } from './utils';
import {
  assertBodyWithinLimit,
  assertUploadAllowed,
  consumeUploadQuota,
  ensureCodeAvailable,
  loadUploadPolicy,
  quotaMessage,
  remainingQuota,
  resolveExpire,
} from './shared';
import {
  countActiveChunkSessions,
  checkRateLimit,
  deleteChunkTask,
  getFileByCode,
  getChunkReceipt,
  getChunkTask,
  getChunkTaskBySession,
  getChunkTaskStatement,
  hasFileRecord,
  insertChunkTask,
  insertFile,
  listChunkParts,
  listChunkTasks,
  listStaleChunkTasks,
  rateLimitAllowed,
  rateLimitStatementFor,
  releaseCode,
  saveChunkPartStatement,
  saveChunkReceipt,
} from './db';

/** 分片自己的限流额度（每 60 秒）：一次会话可能有上百片，共用上传桶会把自己掐死 */
const CHUNK_RATE_MAX = 300;
/** 同一 IP 同时挂起的未完成会话上限（管理员不受限），防止只 init 不传就刷码 */
const CHUNK_MAX_ACTIVE_PER_IP = 5;
/** status/complete/abort 的独立桶：状态轮询不能吃分片额度，也不能无限读 D1 */
const CHUNK_META_RATE_MAX = 120;
/** init 的 JSON 只有几个字段，超过这个大小直接 413 */
const MAX_CHUNK_INIT_BYTES = 64 * 1024;

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

/** status/complete/abort 的独立限流：这些接口会读 D1，不能让未知句柄无限刷 */
async function assertChunkMetaRate(c: Context<{ Bindings: Env }>, env: Env): Promise<void> {
  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'chunk_meta_ratelimit', ip, CHUNK_META_RATE_MAX))) {
    throw { status: 429 as const, message: '操作过于频繁，请稍后再试' };
  }
}

/** 与 uploadFile 一致的过期参数解析（兼容旧参数名 expire_days） */
function expireFrom(body: Record<string, unknown>, defaultExpireDays: number): { expireAt: string; maxDownloads: number } {
  return resolveExpire({
    value: body['expire_value'] ?? body['expire_days'],
    style: body['expire_style'],
    maxDownloads: body['max_downloads'],
    defaultDays: defaultExpireDays,
  });
}

/** 预创建会话：校验大小与配额、抢占取件码、开 R2 multipart 会话 */
export async function chunkInit(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ session: string; code: string; part_size: number; total_parts: number }> {
  assertBodyWithinLimit(c, MAX_CHUNK_INIT_BYTES);
  const { isAdmin, limits } = await loadUploadPolicy(c, env);

  const ip = getClientIp(c.req.raw.headers);
  if (!(await checkRateLimit(env.DB, 'upload_ratelimit', ip, 10))) {
    throw { status: 429 as const, message: '上传过于频繁，请稍后再试' };
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw { status: 422 as const, message: '请求体不能为空' };

  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) throw { status: 422 as const, message: '无效的文件大小' };

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
  filename = sanitizeFilename(filename || '未命名', 200);
  const mimeType = (typeof body.content_type === 'string' && body.content_type) || 'application/octet-stream';
  const { expireAt, maxDownloads } = expireFrom(body, limits.defaultExpireDays);

  if (!isAdmin) {
    const active = await countActiveChunkSessions(env.DB, ip, CHUNK_STALE_MS);
    if (active >= CHUNK_MAX_ACTIVE_PER_IP) {
      throw {
        status: 429 as const,
        message: `同时进行的上传会话过多（最多 ${CHUNK_MAX_ACTIVE_PER_IP} 个），请先完成或放弃已有上传`,
      };
    }
  }
  await consumeUploadQuota(c, env, isAdmin);

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
  const ip = getClientIp(c.req.raw.headers);

  // 限流 UPSERT 与取会话合成一个 batch：每片仍只付一趟读往返。
  // 计数在 UPSERT 里原子递增，失败片（片长不对、会话不存在）也会计入，
  // 不会留下“拿到句柄就能无限刷无效片”的缺口。
  // 「这片是不是已经传过」的预查仍然不做：重复片由 R2 覆盖语义接住，
  // 真正省带宽的跳过在 status 接口那边。
  const [rateRes, taskRes] = await env.DB.batch([
    rateLimitStatementFor(env.DB, 'chunk_ratelimit', ip),
    getChunkTaskStatement(env.DB, session),
  ]);
  const rateRow = (rateRes.results as Array<{ value?: string } | undefined> | undefined)?.[0];
  if (!rateLimitAllowed(rateRow, CHUNK_RATE_MAX)) {
    throw { status: 429 as const, message: '分片上传过于频繁，请稍后再试' };
  }

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

  await saveChunkPartStatement(env.DB, task.upload_id, part, etag).run();
  return { ok: true, part };
}

/** 已传哪些片（供断点续传跳过）。句柄是随机的，这里只暴露片号，不暴露内容 */
export async function chunkStatus(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ session: string; total_parts: number; done: number[] }> {
  await assertChunkMetaRate(c, env);
  const task = await resolveTask(c, env);
  const parts = await listChunkParts(env.DB, task.upload_id);
  return { session: task.session_id, total_parts: task.total_parts, done: parts.map((p) => p.part_number) };
}

/** 合并收尾：片齐了才 complete，记账一律用 R2 合成后的真实大小 */
export async function chunkComplete(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<{ code: string; filename: string; size: number }> {
  await assertChunkMetaRate(c, env);
  const sessionId = sessionIdOf(c);
  const task = await getChunkTaskBySession(env.DB, sessionId);
  if (!task) {
    // complete 成功但响应丢失/收尾失败：用短期回执返回同一结果，而不是 404
    const receipt = await getChunkReceipt(env.DB, sessionId);
    const file = receipt ? await getFileByCode(env.DB, receipt.code) : null;
    if (receipt && file) {
      return { code: file.code, filename: file.filename, size: file.size };
    }
    throw { status: 404 as const, message: '上传会话不存在或已结束' };
  }

  // 文件已经落库但会话行还在（上次收尾/删行失败）：直接补收尾并返回已有结果
  if (await hasFileRecord(env.DB, task.code)) {
    const file = await getFileByCode(env.DB, task.code);
    const result = {
      code: task.code,
      filename: file?.filename ?? task.filename,
      size: file?.size ?? task.size,
    };
    let receiptSaved = false;
    try {
      await saveChunkReceipt(env.DB, task.session_id, result);
      receiptSaved = true;
    } catch (e) {
      console.error('[chunk] receipt save failed:', String((e as any)?.message ?? e));
    }
    if (receiptSaved) await deleteChunkTask(env.DB, task.upload_id);
    return result;
  }

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

  const result = { code: task.code, filename: task.filename, size };
  let receiptSaved = false;
  try {
    await saveChunkReceipt(env.DB, task.session_id, result);
    receiptSaved = true;
  } catch (e) {
    // 回执只是幂等缓存；写失败不能把已经成功的文件判成失败
    console.error('[chunk] receipt save failed:', String((e as any)?.message ?? e));
  }
  // 回执没写成时保留会话行：重试会走“已有文件记录”分支补回执
  if (receiptSaved) await deleteChunkTask(env.DB, uploadId);
  return result;
}

/** 客户端主动放弃：清会话、释放取件码。已经结束的会话重复放弃也返回成功（页面卸载会兜底再发一次） */
export async function chunkAbort(c: Context<{ Bindings: Env }>, env: Env): Promise<{ ok: true }> {
  await assertChunkMetaRate(c, env);
  const task = await getChunkTaskBySession(env.DB, sessionIdOf(c));
  if (task && !(await forceAbort(env, task))) {
    throw { status: 502 as const, message: '会话清理失败，请稍后重试' };
  }
  return { ok: true };
}

const NO_SUCH_UPLOAD_RE = /no such upload|nosuchupload|does not exist|not found/i;

/**
 * 关掉一个会话，返回是否已真正结束（可以安全删除记录）。
 * 只 abort multipart（未 complete 时不会留下对象），**绝不删 file:{code}** ——
 * 万一 complete 成功而清理行失败，删对象就会把用户的真文件抹掉。
 * 释放取件码之前也要确认没有对应文件记录，同理。
 *
 * abort 失败时保留会话行：一删行就再没有 API 能列出这个 multipart，
 * 它会永久计费且 R2 面板/孤儿扫描都看不见。保留后 Cron/管理员可以重试。
 */
async function forceAbort(env: Env, task: ChunkTask): Promise<boolean> {
  // 已有同名文件记录：complete 已经成功，multipart 已结束，只清理会话行，绝不能 abort 对象。
  // 顺便留一份回执，客户端丢响应后重试 complete 仍能拿到结果
  if (await hasFileRecord(env.DB, task.code)) {
    try {
      await saveChunkReceipt(env.DB, task.session_id, {
        code: task.code,
        filename: task.filename,
        size: task.size,
      });
    } catch (e) {
      console.error('[chunk] receipt save failed:', String((e as any)?.message ?? e));
    }
    await deleteChunkTask(env.DB, task.upload_id);
    return true;
  }

  let closed = false;
  try {
    await env.FILE_STORE.resumeMultipartUpload(`file:${task.code}`, task.upload_id).abort();
    closed = true;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // 已完成或本就不存在：multipart 不在计费了，可以安全删行
    if (NO_SUCH_UPLOAD_RE.test(msg)) closed = true;
    else console.error(`分片 abort 失败，保留会话待重试 code=${task.code} size=${task.size}: ${msg}`);
  }
  if (!closed) return false;

  await deleteChunkTask(env.DB, task.upload_id);
  if (!(await hasFileRecord(env.DB, task.code))) {
    await releaseCode(env.DB, task.code);
  }
  return true;
}

/** 超时未完成的会话：abort 掉，否则已传的分片会一直计费 */
export async function cleanupStaleChunkUploads(env: Env): Promise<number> {
  const stale = await listStaleChunkTasks(env.DB, CHUNK_STALE_MS);
  let closed = 0;
  for (const task of stale) {
    try {
      if (await forceAbort(env, task)) closed++;
    } catch (e) {
      // 单个会话失败不影响其余会话；保留行下次重试
      console.error(`清理过期分片会话失败 code=${task.code}: ${String((e as any)?.message ?? e)}`);
    }
  }
  return closed;
}

/**
 * 后台手动放弃单个会话。
 * 未完成的 multipart 不是对象 —— R2 面板删不掉、bucket.delete 也无效，只能走 abort，
 * 所以必须给管理员一个立刻执行的入口，而不是让他等 6 小时超时。
 */
export async function abortChunkSession(env: Env, uploadId: string): Promise<boolean> {
  const task = await getChunkTask(env.DB, uploadId);
  if (!task) return false;
  return forceAbort(env, task);
}

/** 后台「放弃全部进行中会话」：每次最多 8 个，剩余的再点一次（每个 abort 都要花子请求） */
export async function abortAllChunkSessions(env: Env): Promise<number> {
  const tasks = (await listChunkTasks(env.DB)).slice(0, 8);
  let closed = 0;
  for (const task of tasks) {
    try {
      if (await forceAbort(env, task)) closed++;
    } catch (e) {
      console.error(`放弃分片会话失败 code=${task.code}: ${String((e as any)?.message ?? e)}`);
    }
  }
  return closed;
}
