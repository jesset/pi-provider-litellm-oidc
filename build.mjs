#!/usr/bin/env node
// 将 extension/*.ts 打包为单文件 minified ESM 产物 dist/index.js。
// dist 不进仓库：npm 发布由 CI 构建后 npm publish（tag 触发）；
// git 源安装经 prepare 钩子在本机构建（npm install --omit=dev 会运行 prepare，
// 此时 devDependencies 未装，prepare 的 fallback 以 --include=dev 临时装 pinned
// 版本 esbuild——npm 会把 npm_config_omit=dev 传给内层 install，必须显式覆盖）。
// 注意：git 源安装路径客户端拿到的仍是完整源码仓库，防改保护只存在于 npm 通道。
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
