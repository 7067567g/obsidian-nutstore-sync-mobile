#!/usr/bin/env bash
# S1：本地构建 / 安装 / 回滚封装。
#
# 用法：
#   ./构建与安装.sh check            类型检查 + ESLint + Vitest
#   ./构建与安装.sh build            真实端点构建 main.js + SHA-256
#   ./构建与安装.sh install          备份手机当前插件 → 推送新构建
#   ./构建与安装.sh rollback [目录]  回滚到最近一次（或指定）安装前备份
#
# 默认端点（可用环境变量覆盖）：
#   NS_NSDAV_ENDPOINT、NS_DAV_ENDPOINT、LLM_GATEWAY_CLIENT_ID
# ADB / 设备 / Vault：
#   ADB、DEVICE、VAULT、PLUGIN、BACKUP_ROOT
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

export NS_NSDAV_ENDPOINT="${NS_NSDAV_ENDPOINT:-https://dav.jianguoyun.com/nsdav}"
export NS_DAV_ENDPOINT="${NS_DAV_ENDPOINT:-https://dav.jianguoyun.com/dav}"
export LLM_GATEWAY_CLIENT_ID="${LLM_GATEWAY_CLIENT_ID:-dc_obsidian_dp0gymrn}"

ADB="${ADB:-/mnt/c/Users/Administrator/Desktop/Deepseek_python/归档/旧源-20260904/03_库与工具环境/platform-tools/adb.exe}"
DEVICE="${DEVICE:-ZXQOKRQ8GMQ4UGRW}"
VAULT="${VAULT:-/sdcard/Documents/Obsidian-期以岁月/期以岁月}"
PLUGIN="${PLUGIN:-$VAULT/.obsidian/plugins/nutstore-sync}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.cache/nutstore-sync-install-backups}"

log() { printf '[构建与安装] %s\n' "$*"; }
die() { printf '[构建与安装] 错误：%s\n' "$*" >&2; exit 1; }

need_adb() {
[ -x "$ADB" ] || die "ADB 不可执行：$ADB（可用 ADB 环境变量覆盖）"
"$ADB" -s "$DEVICE" get-state >/dev/null 2>&1 || die "设备未连接/未授权：$DEVICE"
}

ensure_deps() {
if [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/esbuild ]; then
log 'node_modules 不完整，执行 bootstrap-deps.mjs'
node scripts/bootstrap-deps.mjs
fi
[ -x node_modules/.bin/tsc ] || die 'bootstrap 后仍缺少 node_modules/.bin/tsc'
[ -x node_modules/.bin/esbuild ] || die 'bootstrap 后仍缺少 node_modules/.bin/esbuild'
}

check() {
ensure_deps
log 'tsc -noEmit -skipLibCheck'
node node_modules/typescript/bin/tsc -noEmit -skipLibCheck
log 'eslint . --max-warnings=0'
node node_modules/eslint/bin/eslint.js . --max-warnings=0
log 'vitest run'
node node_modules/vitest/vitest.mjs run
}

scan_bundle() {
local failed=0
for value in \
"$NS_NSDAV_ENDPOINT" \
"$NS_DAV_ENDPOINT" \
"$LLM_GATEWAY_CLIENT_ID"; do
if ! grep -qF -- "$value" main.js; then
printf '[构建与安装] 缺少内联值：%s\n' "$value" >&2
failed=1
fi
done
if grep -qF 'example.invalid' main.js; then
printf '[构建与安装] main.js 仍含 example.invalid 占位端点\n' >&2
failed=1
fi
if ! grep -qF 'Nutstore AI gateway is unavailable' main.js; then
printf '[构建与安装] main.js 缺少网关 stub 的用户可见错误\n' >&2
failed=1
fi
[ "$failed" -eq 0 ] || die 'main.js 内容门控失败'
}

build() {
ensure_deps
rm -rf dist
log 'esbuild production'
node esbuild.config.mjs production
[ -s dist/main.js ] || die 'esbuild 未产出 dist/main.js'
log 'swc dist/main.js -> main.js'
node_modules/.bin/swc ./dist/main.js -o main.js
[ -s main.js ] || die 'swc 未产出 main.js'
scan_bundle
sha256sum main.js manifest.json styles.css > main.js.sha256
log "构建完成：$(cat main.js.sha256 | tr '\n' ' ')"
}

install_to_phone() {
need_adb
build
local stamp backup_dir
stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$BACKUP_ROOT/$stamp"
mkdir -p "$backup_dir"
log "备份手机当前插件到 $backup_dir/plugin"
(
cd "$backup_dir"
"$ADB" -s "$DEVICE" pull "$PLUGIN" plugin
) || die '手机插件备份失败，拒绝安装'
[ -s "$backup_dir/plugin/main.js" ] || die '手机插件备份不完整'
log '停止 Obsidian 并推送新构建'
"$ADB" -s "$DEVICE" shell am force-stop md.obsidian >/dev/null 2>&1 || true
"$ADB" -s "$DEVICE" push main.js "$PLUGIN/main.js"
"$ADB" -s "$DEVICE" push manifest.json "$PLUGIN/manifest.json"
"$ADB" -s "$DEVICE" push styles.css "$PLUGIN/styles.css"
local remote_sha
remote_sha="$("$ADB" -s "$DEVICE" shell "sha256sum '$PLUGIN/main.js'" | awk '{print $1}' | tr -d '\r')"
local local_sha
local_sha="$(sha256sum main.js | awk '{print $1}')"
[ "$remote_sha" = "$local_sha" ] || die "推送后 SHA-256 不一致：remote=$remote_sha local=$local_sha"
log "安装完成：$local_sha（回滚目录：$backup_dir/plugin）"
}

rollback_phone() {
need_adb
local target="${1:-}"
if [ -z "$target" ]; then
target="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1 || true)"
fi
[ -n "$target" ] || die "没有可用回滚目录（$BACKUP_ROOT）"
[ -s "$target/plugin/main.js" ] || target="$target/plugin"
[ -s "$target/main.js" ] || die "回滚目录缺少 main.js：$target"
log "回滚插件到 $target"
(
cd "$target"
"$ADB" -s "$DEVICE" shell am force-stop md.obsidian >/dev/null 2>&1 || true
"$ADB" -s "$DEVICE" push main.js "$PLUGIN/main.js"
[ -f manifest.json ] && "$ADB" -s "$DEVICE" push manifest.json "$PLUGIN/manifest.json"
[ -f styles.css ] && "$ADB" -s "$DEVICE" push styles.css "$PLUGIN/styles.css"
)
local local_sha remote_sha
local_sha="$(sha256sum "$target/main.js" | awk '{print $1}')"
remote_sha="$("$ADB" -s "$DEVICE" shell "sha256sum '$PLUGIN/main.js'" | awk '{print $1}' | tr -d '\r')"
[ "$remote_sha" = "$local_sha" ] || die "回滚后 SHA-256 不一致：remote=$remote_sha local=$local_sha"
log "回滚完成：$local_sha"
}

usage() {
cat <<'USAGE'
用法：./构建与安装.sh <命令> [参数]
  check             类型检查 + ESLint + Vitest
  build             真实端点构建 main.js（含 SHA-256）
  install           构建 → 备份手机插件 → 推送（需 ADB/真机）
  rollback [目录]   回滚到最近一次或指定安装前备份
  help              本帮助
USAGE
}

case "${1:-help}" in
check) check ;;
build) build ;;
install) install_to_phone ;;
rollback) rollback_phone "${2:-}" ;;
help | --help | -h) usage ;;
*) usage; die "未知命令：$1" ;;
esac
