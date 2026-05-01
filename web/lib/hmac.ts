import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 三种 HMAC 用法集中在这里：
 *   1. signImageToken / verifyImageToken: 给 akapen 容器拉图的签名 URL
 *      → 用 IMAGE_URL_SECRET，仅 web 自家用，akapen 不需要知道
 *   2. verifyWebhookSignature: 校验来自 akapen 的回调
 *      → 用 WEBHOOK_SECRET，必须与 akapen-backend 的同名 env 一致
 *   3. signOutboundWebhook: 我们没有反向回调 akapen，留空（akapen 是发起方）
 *
 * 都是 HMAC-SHA256 + timingSafeEqual 防止时序泄漏。
 */

const IMAGE_SECRET = process.env.IMAGE_URL_SECRET ?? "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

if (process.env.NODE_ENV === "production") {
  if (IMAGE_SECRET.length < 32) {
    console.warn("[hmac] 警告：IMAGE_URL_SECRET 长度 < 32，签名 URL 不够强");
  }
  if (WEBHOOK_SECRET.length < 16) {
    console.warn("[hmac] 警告：WEBHOOK_SECRET 长度 < 16，与 akapen 同步前请补强");
  }
}

// ───── base64url 编解码（不依赖外部库） ─────

function b64urlEncode(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  let p = s.replace(/-/g, "+").replace(/_/g, "/");
  while (p.length % 4) p += "=";
  return Buffer.from(p, "base64");
}

// ───── 图片签名 token ─────

export type ImageTokenPayload = {
  /** 相对 UPLOAD_ROOT 的路径，形如 batchId/studentId/questionId/file.jpg */
  p: string;
  /** 过期时间（unix 秒） */
  e: number;
};

/**
 * 把 (rel_path, expiry) 一起签：
 *   token = base64url(JSON(payload)) + "." + base64url(HMAC-SHA256)
 * 与 JWT 思路一致但去掉 alg negotiation —— 我们俩端都自己写，没必要协商。
 */
export function signImageToken(relPath: string, ttlSec = 1800): string {
  if (!IMAGE_SECRET) throw new Error("IMAGE_URL_SECRET 未配置");
  const payload: ImageTokenPayload = {
    p: relPath,
    e: Math.floor(Date.now() / 1000) + ttlSec,
  };
  const head = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(
    createHmac("sha256", IMAGE_SECRET).update(head).digest(),
  );
  return `${head}.${sig}`;
}

export function verifyImageToken(token: string): ImageTokenPayload | null {
  if (!IMAGE_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [head, sig] = parts;
  const expected = createHmac("sha256", IMAGE_SECRET).update(head).digest();
  const got = b64urlDecode(sig);
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;
  let payload: ImageTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(head).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.p !== "string" || typeof payload?.e !== "number")
    return null;
  if (payload.e < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/**
 * 给 akapen 用的完整签名 URL，base = WEB_PUBLIC_BASE_URL（必须 backend 容器能解析）。
 *
 * 同机 docker-compose 推荐：WEB_PUBLIC_BASE_URL=http://web:3000
 *   - 容器互联，内核 bridge 转发，零公网带宽（与 docs §〇 容量预算契合）
 *   - 注意千万别填公网域名（hairpin trap），见 plan §八
 *
 * 选 .jpg 装饰扩展是为了让某些 LLM SDK 在解析 URL 时确认 "嗯这是图片"，
 * 真实 Content-Type 由 /u/[token] route 根据原始文件名决定。
 */
export function buildSignedImageUrl(relPath: string, ttlSec = 1800): string {
  const base = (process.env.WEB_PUBLIC_BASE_URL ?? "http://web:3000").replace(
    /\/+$/,
    "",
  );
  const token = signImageToken(relPath, ttlSec);
  return `${base}/u/${token}.jpg`;
}

// ───── webhook 验签 ─────

/**
 * 校验 akapen-backend 发来的 X-Akapen-Signature。
 *
 * 格式（与 backend/webhook.py 严格对齐）：
 *
 *     X-Akapen-Signature: t=<unix_ts>,v1=<hex>
 *
 * 其中 v1 = `hmac_sha256(secret, f"{t}.{body}")`
 *
 * IMPORTANT:
 *   - rawBody 必须是 *未经* JSON.parse 的原始字符串/bytes，否则 key 顺序差异会让签名永远对不上。
 *   - 强制 |now - t| < 5min 防重放（同 backend 设计意图）。
 */
const WEBHOOK_REPLAY_WINDOW_SEC = 300;

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null,
): boolean {
  if (!WEBHOOK_SECRET || !signatureHeader) return false;

  // 解析 t=<...>,v1=<hex>
  const parts = signatureHeader.split(",").map((p) => p.trim());
  let t: number | null = null;
  let v1: string | null = null;
  for (const p of parts) {
    if (p.startsWith("t=")) t = parseInt(p.slice(2), 10);
    else if (p.startsWith("v1=")) v1 = p.slice(3);
    // 容忍未来加新版本：v2= 等被忽略
  }
  if (t === null || Number.isNaN(t) || !v1) return false;

  // 重放窗口
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > WEBHOOK_REPLAY_WINDOW_SEC) return false;

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const expectedHex = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${t}.${bodyStr}`, "utf8")
    .digest("hex");
  if (v1.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(v1, "hex"),
      Buffer.from(expectedHex, "hex"),
    );
  } catch {
    return false;
  }
}
