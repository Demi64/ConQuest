// 画面（web/）を1つのJSファイルにまとめて public/assets に出力する
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("public/assets", { recursive: true });
await build({
  entryPoints: ["web/main.tsx"],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  outfile: "public/assets/app.js",
});
copyFileSync("web/styles.css", "public/assets/app.css");
console.log("web build done");
