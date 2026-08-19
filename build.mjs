#!/usr/bin/env node
// 将 extension/*.ts 打包为单文件 minified ESM 产物 dist/index.js。
// 这是发布物：git/npm 安装只读取文件不执行脚本，故 dist 必须提交进仓库，
// 改动 extension/ 后运行 npm run build 并提交 dist。
import { build } from "esbuild";

const result = await build({
  entryPoints: ["extension/index.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "dist/index.js",
  // 对 peerDependencies（pi 内置包）只擦除类型导入，值导入若有会报错提醒
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
  logLevel: "info",
});

process.exit(result.errors.length > 0 ? 1 : 0);
