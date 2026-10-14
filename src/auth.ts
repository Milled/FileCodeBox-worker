import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './types';
import { hashPassword } from './utils';
import { getSetting, setSetting, checkRateLimit } from './db';

/** 启动时计算一次管理员密码哈希，避免每次登录重复 PBKDF2 */
let cachedSecretHash: string | null = null;
async function getSecretHash(env: Env): Promise<string> {
  // 密码未配置时不缓存，避免缓存空字符串哈希导致后续登录误判
  if (!env.ADMIN_PASSWORD) {
    return await hashPassword('');
  }
  if (!cachedSecretHash) {
    cachedSecretHash = await hashPassword(env.ADMIN_PASSWORD);
  }
  return cachedSecretHash;
}

/**
 * 常数时间字符串比较，防止时序攻击。
 * 注意：crypto.subtle.timingSafeEqual 在 workers-types 中尚未声明，此处手动实现。
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < ab.length; i++) {
    result |= ab[i] ^ bb[i];
  }
  return result === 0;
}

/**
 * 验证管理员是否已登录。
 * 返回 true 表示已认证，false 需要登录。
 * 使用常数时间比较防止时序攻击。
 */
export async function adminAuth(c: Context<{ Bindings: Env }>, env: Env): Promise<boolean> {
  const token =
    getCookie(c, 'admin_token') ??
    c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return false;

  try {
    const stored = await getSetting(env.DB, 'admin_token');
    return timingSafeCompare(token, stored ?? '');
  } catch {
    return false;
  }
}

/**
 * 管理员登录处理。
 * 密码只存在 Cloudflare Secret（ADMIN_PASSWORD），不落盘、不写 DB。
 */
export async function handleAdminLogin(
  c: Context<{ Bindings: Env }>,
  env: Env,
  inputPassword: string,
): Promise<{ success: true; token: string } | { success: false; error: string }> {
  if (!env.ADMIN_PASSWORD) {
    return { success: false, error: '未配置管理员密码，请运行 wrangler secret put ADMIN_PASSWORD 设置' };
  }

  // 登录速率限制：60 秒内最多 5 次尝试（按客户端 IP）
  const ip =
    c.req.header('CF-Connecting-IP') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';
  if (!(await checkRateLimit(env.DB, 'login_ratelimit', ip, 5))) {
    return { success: false, error: '尝试次数过多，请稍后再试' };
  }

  const inputHash = await hashPassword(inputPassword);
  const secretHash = await getSecretHash(env);
  if (inputHash !== secretHash) {
    return { success: false, error: '密码错误' };
  }

  const token = crypto.randomUUID();
  await setSetting(env.DB, 'admin_token', token);

  setCookie(c, 'admin_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: 86400,
    path: '/',
  });

  return { success: true, token };
}

/** 管理员登出 */
export async function handleAdminLogout(c: Context, env: Env): Promise<void> {
  deleteCookie(c, 'admin_token', { path: '/' });
  // 同时清除 DB 中的 token，防止已泄露的 token 仍可登录
  await setSetting(env.DB, 'admin_token', '').catch(() => {});
}
