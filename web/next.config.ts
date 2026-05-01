import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 多阶段 Docker 镜像用 standalone：build 后只 COPY .next/standalone + .next/static + public
  // 镜像 ~200MB，cold start 1-2 秒。
  output: "standalone",

  // /uploads 下都是用户上传的图片，next 不要预优化（直接用 sharp 即可）
  images: {
    unoptimized: true,
  },

  // 给 akapen 容器用 service 名拉图时，next.js dev 也得允许 host header = "web"
  // production 下 next 不校验 Host，本身没问题；dev 模式才相关。
  async headers() {
    return [
      {
        source: "/u/:path*",
        headers: [
          { key: "Cache-Control", value: "private, max-age=600" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
    ];
  },

  // upload 大体积请求体（一次拍多页可能 8MB+）
  experimental: {
    serverActions: {
      bodySizeLimit: "16mb",
    },
  },
};

export default nextConfig;
