// Tailwind v4 不再用 tailwind.config.ts；所有 token 在 globals.css 里通过
// @theme inline 配（见 app/globals.css）。这里只挂 PostCSS 插件即可。
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
