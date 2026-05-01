import path from "node:path";

/**
 * 上传配置 + 图片格式守门员（pure JS magic-byte sniff，不依赖 sharp / file-type）。
 *
 * 设计取舍：
 * - 不在 web 容器里给图片做 EXIF/resize/quality 处理：那是 akapen 的活
 *   （core/imageproc.standardize_jpeg_bytes）。web 只负责存原图。
 *   这样 web 镜像不用塞 sharp / libvips / libheif，省 50MB+。
 * - 拒绝 HEIC：iPhone 默认输出 HEIC，但 PIL 不解（除非装 pillow-heif）。
 *   提示老师把相机设置改 "兼容性最好" / "JPEG"，比工程消化它便宜。
 *   后续若要支持 HEIC，可以在前端浏览器侧用 heic2any 转，再上传。
 */

export const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT ?? path.resolve(process.cwd(), "data/uploads");

export const MAX_UPLOAD_BYTES = parseInt(
  process.env.MAX_UPLOAD_BYTES ?? "8388608",
  10,
);

export const MAX_IMAGES_PER_SUBMISSION = parseInt(
  process.env.MAX_IMAGES_PER_SUBMISSION ?? "8",
  10,
);

export type ImageType = "jpeg" | "png" | "webp";

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
  return null;
}

export function extOf(t: ImageType): string {
  return t === "jpeg" ? "jpg" : t;
}

export function mimeOf(t: ImageType): string {
  return t === "jpeg" ? "image/jpeg" : `image/${t}`;
}

/** 反推：从文件名（带扩展）猜 MIME，给 /u/[token] 输出 Content-Type 用 */
export function mimeFromFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}
