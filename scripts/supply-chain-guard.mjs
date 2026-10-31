#!/usr/bin/env node
// 发布物结构不变量检查：
// 禁安装期脚本（prepare 例外——git 源安装的生命线）、强制零运行时依赖、
// 禁非 registry 依赖 spec、lockfile resolved 域名白名单、npm pack 文件白名单。
// CI verify/publish 均执行；本地需先 npm run build 再运行本脚本。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

// 1. 禁安装期脚本（安装该包时客户端零代码执行；prepare 保留）
for (const hook of ["preinstall", "install", "postinstall"]) {
  check(!pkg.scripts?.[hook], `禁止安装期脚本 scripts.${hook}`);
}

// 2. 零运行时依赖（CLAUDE.md 约定由此升级为强制）
for (const field of ["dependencies", "optionalDependencies", "bundleDependencies"]) {
  const v = pkg[field];
  const empty = !v || (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
  check(empty, `${field} 必须为空（零运行时依赖）`);
}

// 3. 依赖 spec 只允许 registry 版本号（overrides 支持嵌套对象，递归检查）
const BAD_SPEC = /^(git:|git\+|github:|gitlab:|bitbucket:|https?:|file:|link:|workspace:|npm:|\.|\/)/;
const scanSpecs = (deps, where) => {
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (typeof spec === "string") {
      check(!BAD_SPEC.test(spec), `${where}.${name} 使用非 registry spec: ${spec}`);
    } else if (spec && typeof spec === "object") {
      scanSpecs(spec, `${where}.${name}`);
    }
  }
};
for (const field of ["dependencies", "devDependencies", "peerDependencies", "overrides"]) {
  scanSpecs(pkg[field], field);
}

// 4. lockfile resolved 域名白名单（只允许官方 npm registry：零运行时依赖意味着
//    lockfile 仅含 devDependency，任何其他来源都是可疑注入）
const ALLOWED_HOSTS = ["https://registry.npmjs.org/"];
let lock = null;
try {
  lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
} catch {
  failures.push("package-lock.json 缺失或不可解析");
}
if (lock) {
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry.resolved) continue;
    check(
      ALLOWED_HOSTS.some((h) => entry.resolved.startsWith(h)),
      `lockfile ${path || "."} 的 resolved 非白名单来源: ${entry.resolved}`,
    );
  }
}

// 5. tarball 文件白名单（精确到文件名）
// 注意：npm 10 实测 pack --ignore-scripts 仍会执行 prepare（idempotent 重建 dist，无害）
const ALLOWED_FILES = new Set(["LICENSE", "README.md", "README.zh-cn.md", "dist/index.js", "package.json"]);
const packOut = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const files = JSON.parse(packOut)[0].files.map((f) => f.path);
for (const f of files) {
  check(ALLOWED_FILES.has(f), `tarball 含白名单外文件: ${f}`);
}
check(files.includes("dist/index.js"), "tarball 缺少 dist/index.js（先运行 npm run build）");

if (failures.length > 0) {
  console.error("supply-chain guard 未通过：");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`supply-chain guard 通过（${files.length} 个发布文件：${files.join(", ")}）`);
