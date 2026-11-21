// 仅在修改了 index.html / assets/js 里的 Tailwind 类名后，需要重新生成 assets/css/tailwind.css 时使用：
//   npm i -D tailwindcss@3 && npx tailwindcss -c tailwind.config.js -i tailwind.input.css -o assets/css/tailwind.css --minify
module.exports = { content: ['./index.html', './assets/js/*.js'], theme: { extend: {} }, plugins: [] };
