#!/usr/bin/env bash
# 本地目录安装（开发/单机）。分发推荐 pi install npm:pi-provider-litellm-oidc 或 git 源，见 README。
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"

command -v pi >/dev/null 2>&1 || { echo "错误: 未找到 pi 命令，请先安装: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"; exit 1; }

pi install "$PKG_DIR"
echo "已通过 pi install 安装（写入 ~/.pi/agent/settings.json packages）"
echo "登录: /login ${LITELLM_OIDC_PROVIDER_ID:?请先设置 LITELLM_OIDC_PROVIDER_ID 或配置 litellm-oidc.json}"
