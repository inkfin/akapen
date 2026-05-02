/**
 * 客户端 + 服务端共用的"图片格式"常量与纯函数。
 *
 * 为什么单独拆一个文件：`web/lib/uploads.ts` 顶部用了 `node:path` + `process.env`
 * 计算 `UPLOAD_ROOT`，那是 server-only。如果 client component 直接 import
 * `@/lib/uploads` 触发整个文件进 client bundle，next.js 会报 `node:path`
 * 不能用。所以把"既能 server 又能 client"的纯逻辑（magic-byte 嗅探 / MIME
 * 计算 / `<input accept>` 字面值）剥到这里；server 端的 `uploads.ts` 仍
 * re-export 这些，老代码 `import { detectImageType } from "@/lib/uploads"`
 * 继续生效，client 组件直接从本文件 import 即可。
 *
 * 改动这里时记得保持纯：禁止 import node 模块、禁止读 process.env、禁止
 * 动 fs。
 */

export type ImageType = "jpeg" | "png" | "webp" | "heic";

/**
 * HEIC/HEIF 容器（ISO BMFF）的 magic：第 4~12 字节是 "ftyp" + brand。
 * iPhone 拍出来的 brand 一般是这几个：
 *   - heic   : 单图 HEIC
 *   - heix   : 单图 HEIC（10-bit）
 *   - mif1   : iPhone 11+ 默认（mif1 = MIAF v1，HEIF 子集）
 *   - msf1   : 序列 / live photo 主帧
 *   - heim/heis/hevc : 视频帧抽出来的图（少见）
 * 我们一律收，让 backend 的 pillow-heif 决定能不能解。
 */
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "mif1",
  "msf1",
  "heim",
  "heis",
  "hevc",
]);

export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "png";
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "webp";
  // HEIC/HEIF: bytes[4..8] = "ftyp", bytes[8..12] = brand
  if (
    bytes[4] === 0x66 && // f
    bytes[5] === 0x74 && // t
    bytes[6] === 0x79 && // y
    bytes[7] === 0x70 // p
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (HEIC_BRANDS.has(brand)) return "heic";
  }
  return null;
}

export function extOf(t: ImageType): string {
  if (t === "jpeg") return "jpg";
  if (t === "heic") return "heic";
  return t;
}

export function mimeOf(t: ImageType): string {
  if (t === "jpeg") return "image/jpeg";
  if (t === "heic") return "image/heic";
  return `image/${t}`;
}

/** 反推：从文件名（带扩展）猜 MIME，给 /u/[token] 输出 Content-Type 用 */
export function mimeFromFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) return "image/heic";
  return "application/octet-stream";
}

/**
 * `<input accept="...">` 的标准值。集中在这里，让所有上传入口（grading 上传、
 * 后续 agent 拍题目 / 拍名单）拿到的 accept 字符串完全一致。
 *
 * 包含 image/heic + image/heif 是为了让 iPhone 从相册选 HEIC 时**不被浏览器灰
 * 掉文件**（默认 image/* 在 iOS Safari 上对 HEIC 行为不一致）。
 */
export const UPLOAD_ACCEPT =
  "image/jpeg,image/png,image/webp,image/heic,image/heif";
