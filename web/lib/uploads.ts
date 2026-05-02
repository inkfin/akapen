import path from "node:path";

/**
 * 上传 server-only 配置。
 *
 * 设计取舍：
 * - 不在 web 容器里给图片做 EXIF/resize/quality 处理：那是 akapen 的活
 *   （core/imageproc.standardize_jpeg_bytes）。web 只负责存原图。
 *   这样 web 镜像不用塞 sharp / libvips / libheif，省 50MB+。
 * - **接收 HEIC**：iPhone 老师从相册里选已存照片（AirDrop / 微信存的题目图）
 *   大概率是 HEIC。backend 侧 `core/imageproc.py` 已经注册了 `pillow-heif`
 *   解码器（依赖 Dockerfile 装的 `libheif1 + libde265-0`），下游 grading /
 *   agent 全程透明转 JPEG。web 这边只负责识别 + 落盘原始 HEIC 字节，不做
 *   格式转换 —— 把"重编码 / 质量"统一交给 backend 的 standardize_jpeg_bytes，
 *   省得 web 也装一份 libheif。
 * - 前端图片**压缩**走 `web/lib/image-compress.ts`，不走这里。这里只管
 *   "服务端目录、上限、文件落盘"几件事。
 *
 * 文件拆分约定：
 * - `uploads-shared.ts` —— 客户端 + 服务端共用的纯逻辑（detectImageType /
 *   mimeOf / UPLOAD_ACCEPT 等）。client component 必须从那里 import；从
 *   本文件 import 会因为顶部的 `node:path` / `process.env` 在 client bundle
 *   中报错。
 * - 本文件 —— server-only：UPLOAD_ROOT / 上传上限等需要 fs / env 的常量。
 *   保留对 shared 模块的 re-export，让既有 server 端 `import { detectImageType
 *   } from "@/lib/uploads"` 不破坏。
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

// Re-export client-safe API：让既有 server 端 import { detectImageType, ... }
// from "@/lib/uploads" 继续生效。新写 client component 直接 import from
// "@/lib/uploads-shared"。
export {
  type ImageType,
  detectImageType,
  extOf,
  mimeOf,
  mimeFromFilename,
  UPLOAD_ACCEPT,
} from "./uploads-shared";
