/**
 * 浏览器内图片压缩 helper —— 上传前把手机直拍 3~5 MB 大图缩到 ~300 KB。
 *
 * 为什么需要：iPhone 相机默认 4032×3024 ≈ 12 MP，单张 JPEG 3~5 MB；老师在
 * 4G 网络下传一张要 30~60 秒。而我们 backend `core/imageproc` 接到后又会
 * 再缩到 1600px 长边丢掉九成像素 —— 等于在网络上白付带宽。前端先压到
 * 1280px / JPEG 70% 后只剩 ~300 KB，4G 上传降到 3~5 秒，体验差距巨大。
 *
 * 关键设计：
 * - **失败永远回退原 file**：旧手机 / OOM / 浏览器不支持 HEIC 解码 / canvas
 *   被安全策略拒绝（极少数 enterprise MDM 配置会触发）任意一种异常都会 catch
 *   并返回原 file，绝不阻塞上传。
 * - **HEIC 不强求解**：浏览器侧 `createImageBitmap` 通常不解 HEIC（iOS Safari
 *   17+ 支持，其他不支持）。解不了就直接返原 HEIC 文件，让 backend 的
 *   `pillow-heif` 接锅。这样手机所有人都能上传，区别只在带宽/速度。
 * - **EXIF 旋转用 createImageBitmap 的 native 能力**（`imageOrientation:
 *   "from-image"`），不手动解 EXIF。Safari / Chrome / Firefox 都支持。
 * - **大图 step-down 缩放**：一次性把 12MP 图丢进 canvas 在低内存设备会 OOM。
 *   按步长（每次 ÷2）逐步缩到目标尺寸，每步释放上一个 bitmap，内存占用恒定。
 * - **早跳过**：< 200KB 的图直接返回原 file，不浪费 cpu/电池。
 *
 * 不支持的事：
 * - 不裁剪、不旋转（只做 EXIF auto orient）；
 * - 不输出 webp / avif（默认 JPEG，兼容性最广，省得 backend 又要管编解码）；
 * - 不返回 EXIF（压缩后的 JPEG 不带 EXIF，因为我们后端只关心像素，不关心
 *   拍摄时间/GPS）。
 */

export type CompressOptions = {
  /** 长边目标像素，默认 1280 —— 跟 backend OCR 档对齐（再大 vision model 也吃不到） */
  maxLongSide?: number;
  /** JPEG 质量 0~1，默认 0.7 —— 中文手写 70 已经看得清，再高带宽白涨 */
  quality?: number;
  /** 输出 MIME，默认 image/jpeg；想用原格式时可传 image/png / image/webp */
  mimeType?: string;
  /** 早跳过阈值（bytes），小于这个值直接返原 file。默认 200 KB */
  skipBelowBytes?: number;
};

const DEFAULT_OPTS: Required<CompressOptions> = {
  maxLongSide: 1280,
  quality: 0.7,
  mimeType: "image/jpeg",
  skipBelowBytes: 200 * 1024,
};

/**
 * 压缩入口。**永远返回一个能塞进 FormData 的对象**——成功时是新的 Blob/File，
 * 失败时是原 File，调用方不需要关心分支。
 */
export async function compressImage(
  file: File,
  options: CompressOptions = {},
): Promise<File | Blob> {
  const opts = { ...DEFAULT_OPTS, ...options };

  // 1) 早跳过：已经够小了
  if (file.size < opts.skipBelowBytes) return file;

  // 2) 非图片：直接放行（防御性，UI 应该已经过滤了）
  if (!file.type.startsWith("image/")) return file;

  try {
    // 3) 解码 + EXIF 自动旋正。HEIC 在大多数浏览器会 throw，被外层 catch 接住返原图。
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });

    try {
      // 4) 计算目标尺寸
      const longSide = Math.max(bitmap.width, bitmap.height);
      if (longSide <= opts.maxLongSide) {
        // 已经在尺寸内：仍可能值得 re-encode（比如 PNG 转 JPEG），但
        // 重编码收益不确定，先按"原图够小就跳"省事。
        bitmap.close();
        return file;
      }
      const scale = opts.maxLongSide / longSide;
      const targetW = Math.max(1, Math.round(bitmap.width * scale));
      const targetH = Math.max(1, Math.round(bitmap.height * scale));

      // 5) Step-down 缩放：避免一次性 12MP → 1MP 过度内存压力
      const blob = await encodeWithStepDown(bitmap, targetW, targetH, opts);
      bitmap.close();

      // 6) 防退化：压完反而更大就放弃（小概率，几百 KB JPEG 二压可能膨胀）
      if (blob.size >= file.size) return file;

      // 7) 包装成 File，保留原文件名 + 替换扩展名（让后端落盘时扩展名对得上 MIME）
      const newName = renameExt(file.name, opts.mimeType);
      return new File([blob], newName, {
        type: opts.mimeType,
        lastModified: file.lastModified,
      });
    } finally {
      bitmap.close();
    }
  } catch {
    // 任何分支失败（HEIC 解不了 / OOM / 浏览器不支持 OffscreenCanvas）都 fallback
    return file;
  }
}

/**
 * 批量压缩。串行而不是 Promise.all 是有意为之 —— 老手机一次只能扛一个 bitmap，
 * 并发会 OOM。串行总耗时 N × 单张时间，但稳定不崩。
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

  // 最后一步：缩到精确目标尺寸 + 编码
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
  // smoothing 高质量：缩小阶段帮助平均像素
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  // 如果是 OffscreenCanvas 直接 transferToImageBitmap；否则用 createImageBitmap
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

  if (canvas instanceof OffscreenCanvas) {
    return await canvas.convertToBlob({
      type: opts.mimeType,
      quality: opts.quality,
    });
  }
  // HTMLCanvasElement.toBlob 是 callback 风格，包成 promise
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob 返 null"))),
      opts.mimeType,
      opts.quality,
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
