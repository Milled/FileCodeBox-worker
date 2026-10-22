/**
 * Turnstile 人机验证。
 *
 * 设计成「页面验证一次，短期签名 cookie 复用」：
 * Turnstile token 一次性且有效期很短，多文件/多片会话逐请求拿 token 既慢又容易失败；
 * 这里在 /api/turnstile/verify 验证一次后，发一个绑定 IP、1 小时有效的 HMAC cookie。
 * 上传路径只校验 cookie，不再访问外部 siteverify，也不增加 D1 往返。
 */
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from './types';
import { getClientIp } from './utils';

export const TURNSTILE_SETTING_KEY = 'turnstile_enabled';
export const GUEST_VERIFIED_COOKIE = 'guest_verified';
const COOKIE_TTL_SECONDS = 3600;
const TEXT = new TextEncoder();

export function turnstileConfigured(env: Env): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', TEXT.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

async function signGuestPayload(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, TEXT.encode(payload)));
}

async function verifyGuestPayload(secret: string, payload: string, signature: string): Promise<boolean> {
  const bytes = fromHex(signature);
  if (!bytes) return false;
  const key = await hmacKey(secret, ['verify']);
  return crypto.subtle.verify('HMAC', key, bytes.buffer as ArrayBuffer, TEXT.encode(payload));
}

/** 调 Cloudflare siteverify；只在 /api/turnstile/verify 里执行一次 */
export async function verifyTurnstileToken(env: Env, token: string, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY || !token || token.length > 4096) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) form.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { success?: boolean; action?: string } | null;
    if (!data || data.success !== true) return false;
    // widget 用 action=upload；测试/旧 widget 可能没有 action，此时只校验 success
    return !data.action || data.action === 'upload';
  } catch (e) {
    console.error('[turnstile] siteverify failed:', String((e as any)?.message ?? e));
    return false;
  }
}

/** 验证成功后发签名 cookie；不落库，上传时只做 HMAC 校验 */
export async function issueGuestVerifiedCookie(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY) return;
  const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS;
  const ip = getClientIp(c.req.raw.headers);
  const sig = await signGuestPayload(env.TURNSTILE_SECRET_KEY, `${ip}|${exp}`);
  setCookie(c, GUEST_VERIFIED_COOKIE, `${exp}.${sig}`, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: COOKIE_TTL_SECONDS,
  });
}

/** 上传门控：cookie 必须签名有效、未过期，且与当前 IP 一致 */
export async function verifyGuestVerifiedCookie(
  c: Context<{ Bindings: Env }>,
  env: Env,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return false;
  const raw = getCookie(c, GUEST_VERIFIED_COOKIE);
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const expRaw = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const ip = getClientIp(c.req.raw.headers);
  return verifyGuestPayload(env.TURNSTILE_SECRET_KEY, `${ip}|${expRaw}`, sig);
}
