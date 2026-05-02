/**
 * 浏览器内图片压缩 helper —— 上传前把手机直拍 3~5 MB 大图缩到 ~300 KB。
 *
 * 为什么需要：iPhone 相机默认 4032×3024 ≈ 12 MP，单张 JPEG 3~5 MB；老师在
 * 4G 网络下传一张要 30~60 秒。而我们 backend `core/imageproc` 接到后又会
 * 再缩到 1600px 长边丢掉九成像素 —— 等于在网络上白付带宽。前端先压到
 * 1280px / JPEG 70% 后只剩 ~300 KB，4G 上传降到 3~5 秒，体验差距巨大。
 *
 * 关键设计：
 * - **格式按输入保留**（默认 `mimeType: "auto"`）：JPEG → JPEG、PNG → PNG、
 *   WebP → WebP；只有 HEIC/HEIF 因为浏览器 `canvas.toBlob` 不能输出
 *   `image/heic`，被强制转 JPEG。这样老师传 PNG 截图（线条图 / 网页截图）
 *   不会被有损 JPEG 重编码毁掉，透明度也保留。
 * - **HEIC 严格解码**：HEIC/HEIF 输入必须 `createImageBitmap` 成功 →
 *   throw `HeicUnsupportedError`。原因：如果 fallback 让 `.heic` 原文件
 *   落盘，`<img src="...heic">` 在 Android Chrome / 桌面 Chrome 上无法
 *   decode → 缩略图全是 broken icon。客户端转 JPEG 是唯一能保证 preview
 *   正常的路径。代价：iOS 17- / Android 浏览器无法 select HEIC 上传，
 *   但这部分用户可以让手机改成"自动转换"或截图后上传 PNG。
 * - **非 HEIC 失败永远回退原 file**：旧手机 / OOM / canvas 被安全策略
 *   拒绝（极少数 enterprise MDM）任意一种异常都会 catch 并返回原 file，
 *   绝不阻塞上传。
 * - **EXIF 旋转用 createImageBitmap 的 native 能力**（`imageOrientation:
 *   "from-image"`），不手动解 EXIF。Safari / Chrome / Firefox 都支持。
 * - **大图 step-down 缩放**：一次性把 12MP 图丢进 canvas 在低内存设备会 OOM。
 *   按步长（每次 ÷2）逐步缩到目标尺寸，每步释放上一个 bitmap，内存占用恒定。
 * - **早跳过**：< 200 KB 的非 HEIC 图直接返回原 file，不浪费 cpu/电池。
 *   HEIC 不享受早跳过：必须走 decode 路径转成 JPEG。
 *
 * 不支持的事：
 * - 不裁剪、不旋转（只做 EXIF auto orient）；
 * - 不输出 webp / avif（默认按输入保留，HEIC 转 JPEG）；
 * - 不返回 EXIF（压缩后的 JPEG 不带 EXIF，因为我们后端只关心像素，不关心
 *   拍摄时间/GPS）。
 */

export type CompressOptions = {
  /** 长边目标像素，默认 1280 —— 跟 backend OCR 档对齐（再大 vision model 也吃不到） */
  maxLongSide?: number;
  /** JPEG/WebP 质量 0~1，默认 0.7 —— 中文手写 70 已经看得清，再高带宽白涨 */
  quality?: number;
  /**
   * 输出 MIME。默认 "auto"：
   * - JPEG/PNG/WebP 输入 → 输出同格式（PNG/WebP 不丢失透明度）；
   * - HEIC/HEIF 输入 → 强制 JPEG（浏览器不能输出 HEIC）；
   * - 未知类型 → fallback JPEG。
   * 想强制统一格式可显式传 "image/jpeg" 等。
   */
  mimeType?: string;
  /** 早跳过阈值（bytes），小于这个值直接返原 file。默认 200 KB。HEIC 不受此约束。 */
  skipBelowBytes?: number;
};

const DEFAULT_OPTS: Required<CompressOptions> = {
  maxLongSide: 1280,
  quality: 0.7,
  mimeType: "auto",
  skipBelowBytes: 200 * 1024,
};

/** 浏览器 canvas.toBlob 能直接吐出的 MIME 集合（其余都得 fallback 到 JPEG）。 */
const CANVAS_OUTPUTS = new Set(["image/jpeg", "image/png", "image/webp"]);

/** HEIC / HEIF 输入：MIME + 文件名 endsWith 双重判断（iOS 选择器有时不带 type）。 */
const HEIC_MIMES = new Set(["image/heic", "image/heif"]);
const HEIC_NAME_RE = /\.(heic|heif)$/i;

function isHeicInput(file: File): boolean {
  return HEIC_MIMES.has(file.type) || HEIC_NAME_RE.test(file.name);
}

/**
 * HEIC 解码失败时抛这个异常，调用方应该 catch 之后给用户一个清晰的引导
 * （"请用 iPhone Safari 17+ 上传"）而不是静默 fallback 原 .heic 文件。
 */
export class HeicUnsupportedError extends Error {
  readonly code = "HEIC_UNSUPPORTED" as const;
  constructor(message = "当前浏览器无法解 HEIC/HEIF 图片") {
    super(message);
    this.name = "HeicUnsupportedError";
  }
}

/** 根据输入 MIME + 选项决定输出 MIME。 */
function pickOutputMime(inputMime: string, requested: string): string {
  if (requested !== "auto") return requested;
  if (HEIC_MIMES.has(inputMime)) return "image/jpeg";
  if (CANVAS_OUTPUTS.has(inputMime)) return inputMime;
  return "image/jpeg";
}

/**
 * 压缩入口。
 *
 * 返回值：
 * - 成功 → 新的 `File`（保留原 lastModified，扩展名跟新 MIME 对得上）
 * - 不需要压缩 / 非 HEIC 失败 → 原 `File`
 * - HEIC/HEIF 输入但浏览器不能解 → throw `HeicUnsupportedError`
 */
export async function compressImage(
  file: File,
  options: CompressOptions = {},
): Promise<File | Blob> {
  const opts = { ...DEFAULT_OPTS, ...options };
  const heic = isHeicInput(file);

  // 1) 早跳过：已经够小且不是 HEIC（HEIC 必须重编码为 JPEG 以保证可预览）
  if (!heic && file.size < opts.skipBelowBytes) return file;

  // 2) 非图片：直接放行（防御性，UI 应该已经过滤了）
  if (!heic && !file.type.startsWith("image/")) return file;

  // 3) 解码 + EXIF 自动旋正
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
  } catch (err) {
    // HEIC 解不了 → 拒绝（避免 .heic 落盘后 <img> 标签在大多数浏览器里破图）
    if (heic) {
      throw new HeicUnsupportedError(
        "当前浏览器无法解 HEIC/HEIF 图片，请用 iPhone Safari（iOS 17+）选图，或在 iPhone「设置 > 相机 > 格式」改成「兼容性最高」后再拍。",
      );
    }
    return file;
  }

  try {
    const inputMime = file.type || (heic ? "image/heic" : "");
    const outputMime = pickOutputMime(inputMime, opts.mimeType);

    // 4) 计算目标尺寸
    const longSide = Math.max(bitmap.width, bitmap.height);
    const needResize = longSide > opts.maxLongSide;
    const needReencode = heic || outputMime !== inputMime;

    // 已经够小且不需要换格式 → 跳过 re-encode 直接返原 file
    if (!needResize && !needReencode) return file;

    const scale = needResize ? opts.maxLongSide / longSide : 1;
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));

    // 5) Step-down 缩放：避免一次性 12MP → 1MP 过度内存压力
    const blob = await encodeWithStepDown(bitmap, targetW, targetH, {
      ...opts,
      mimeType: outputMime,
    });

    // 6) 防退化：压完反而更大就放弃（HEIC 例外，必须输出 JPEG 否则没法预览）
    if (!heic && blob.size >= file.size) return file;

    // 7) 包装成 File，保留原文件名 + 替换扩展名（让后端落盘时扩展名对得上 MIME）
    const newName = renameExt(file.name, outputMime);
    return new File([blob], newName, {
      type: outputMime,
      lastModified: file.lastModified,
    });
  } catch (err) {
    if (heic) {
      throw new HeicUnsupportedError(
        "当前浏览器无法转换 HEIC/HEIF 图片，请用 iPhone Safari 上传，或先把 HEIC 转成 JPEG/PNG。",
      );
    }
    return file;
  } finally {
    bitmap.close();
  }
}

/**
 * 批量压缩。串行而不是 Promise.all 是有意为之 —— 老手机一次只能扛一个 bitmap，
 * 并发会 OOM。串行总耗时 N × 单张时间，但稳定不崩。
 *
 * HEIC 解码失败：第一张抛 `HeicUnsupportedError` 时立刻终止（避免老师等半天
 * 才发现整批都不能上传），调用方 catch 后给清晰错误。
 */
export async function compressImages(
  files: File[],
  options: CompressOptions = {},
): Promise<Array<File | Blob>> {
  const out: Array<File | Blob> = [];
  for (const f of files) {
    out.push(await compressImage(f, options));
  }
  return out;
}

// ──────────────────── 内部实现 ────────────────────

/**
 * 多步缩放：每次 ÷2 或 ÷1.5，直到接近目标尺寸再做最后一次 lanczos-ish 缩放。
 *
 * 为什么不直接一次缩到 target：浏览器 canvas drawImage 的缩放算法是 bilinear，
 * 一次大幅缩小（比如 12MP → 1MP, 4×）质量会糊。step-down 等于人造 mipmap，
 * 每步缩一半，最终 quality 显著优于一次到位。代价是 N 次 createImageBitmap
 * 的 cpu，对 1280px 目标来说一般 1~3 步够。
 */
async function encodeWithStepDown(
  bitmap: ImageBitmap,
  targetW: number,
  targetH: number,
  opts: Required<CompressOptions>,
): Promise<Blob> {
  let curW = bitmap.width;
  let curH = bitmap.height;
  let curBitmap: ImageBitmap = bitmap;
  let createdInLoop = false;

  while (curW > targetW * 2 || curH > targetH * 2) {
    const nextW = Math.max(targetW, Math.floor(curW / 2));
    const nextH = Math.max(targetH, Math.floor(curH / 2));
    const intermediate = await drawToCanvasBitmap(curBitmap, nextW, nextH);
    if (createdInLoop) curBitmap.close();
    curBitmap = intermediate;
    createdInLoop = true;
    curW = nextW;
    curH = nextH;
  }

  const blob = await drawToBlob(curBitmap, targetW, targetH, opts);
  if (createdInLoop) curBitmap.close();
  return blob;
}

/** 把 source 缩到 (w, h) 返回新 ImageBitmap（中间步骤用） */
async function drawToCanvasBitmap(
  source: ImageBitmap,
  w: number,
  h: number,
): Promise<ImageBitmap> {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  if (canvas instanceof OffscreenCanvas) {
    return canvas.transferToImageBitmap();
  }
  return await createImageBitmap(canvas);
}

/** 把 source 缩到 (w, h) 编码成 Blob（最后一步） */
async function drawToBlob(
  source: ImageBitmap,
  w: number,
  h: number,
  opts: Required<CompressOptions>,
): Promise<Blob> {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);

  // PNG 是无损，传 quality 没意义；JPEG/WebP 才用得上
  const useQuality = opts.mimeType !== "image/png";

  if (canvas instanceof OffscreenCanvas) {
    return await canvas.convertToBlob(
      useQuality
        ? { type: opts.mimeType, quality: opts.quality }
        : { type: opts.mimeType },
    );
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob 返 null"))),
      opts.mimeType,
      useQuality ? opts.quality : undefined,
    );
  });
}

/** 优先用 OffscreenCanvas（不阻塞主线程）；不支持就用 DOM canvas */
function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(w, h);
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * 替换文件扩展名让它跟新的 MIME 对得上。例如 "IMG_1234.heic" + image/jpeg →
 * "IMG_1234.jpg"，避免后端按扩展名做 magic-byte 双重校验时打架。
 */
function renameExt(name: string, mime: string): string {
  const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1] ?? "bin";
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${ext}`;
}
