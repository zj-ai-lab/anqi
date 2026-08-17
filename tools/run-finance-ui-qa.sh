#!/usr/bin/env bash
set -euo pipefail

# 一键启动全新临时库 + 无鉴权本地服务 + 真实 Chrome QA。
# PLAYWRIGHT_PATH 必须指向可 require 的 playwright 包；目标浏览器固定为本机 Chrome。

qa_repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$qa_repo_dir"

: "${PLAYWRIGHT_PATH:?请设置 PLAYWRIGHT_PATH，指向可 require 的 playwright 包}"

qa_port="${QA_PORT:-39880}"
if [[ ! "$qa_port" =~ ^[0-9]+$ ]] || (( qa_port < 1024 || qa_port > 65535 )); then
  echo "QA_PORT 必须是 1024–65535 的整数" >&2
  exit 2
fi

qa_output_dir="${QA_OUTPUT_DIR:-$qa_repo_dir/tmp/finance-ui-qa}"
qa_work_dir="$(mktemp -d)"
qa_db_path="$qa_work_dir/finance-qa.db"
qa_files_root="$qa_work_dir/files"
qa_fixture_path="$qa_output_dir/fixture.json"
qa_server_log="$qa_output_dir/server.log"
qa_server_pid=""

cleanup() {
  if [[ -n "$qa_server_pid" ]] && kill -0 "$qa_server_pid" 2>/dev/null; then
    kill "$qa_server_pid" 2>/dev/null || true
    wait "$qa_server_pid" 2>/dev/null || true
  fi
  rm -rf "$qa_work_dir"
}
trap cleanup EXIT INT TERM

mkdir -p "$qa_output_dir" "$qa_files_root"

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$qa_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "拒绝运行：端口 $qa_port 已被占用，避免连接到错误服务。请设置其他 QA_PORT。" >&2
  exit 2
fi

DB_PATH="$qa_db_path" \
QA_FIXTURE_PATH="$qa_fixture_path" \
node tools/seed-finance-qa.js > "$qa_work_dir/fixture.stdout.json"

env \
  -u ANJIAN_USER \
  -u ANJIAN_PASS_HASH \
  -u ANJIAN_STATIC_TOKEN \
  -u ANJIAN_INTERNAL_KEY \
  -u LEGALRAG_URL \
  -u LEGALRAG_INTERNAL_KEY \
  NODE_ENV=test \
  HOST=127.0.0.1 \
  ANJIAN_UNSAFE_NO_AUTH=1 \
  ANJIAN_FILES_ROOT="$qa_files_root" \
  DB_PATH="$qa_db_path" \
  PORT="$qa_port" \
  node server.js > "$qa_server_log" 2>&1 &
qa_server_pid=$!

qa_ready=0
for _ in {1..80}; do
  if ! kill -0 "$qa_server_pid" 2>/dev/null; then
    echo "隔离 QA 服务启动失败：" >&2
    tail -80 "$qa_server_log" >&2 || true
    exit 1
  fi
  if grep -Fq "anjian listening on :$qa_port" "$qa_server_log" \
      && curl -sf "http://127.0.0.1:$qa_port/healthz" >/dev/null; then
    qa_ready=1
    break
  fi
  sleep 0.25
done
if [[ "$qa_ready" != 1 ]]; then
  echo "隔离 QA 服务未在预期时间内就绪：" >&2
  tail -80 "$qa_server_log" >&2 || true
  exit 1
fi

QA_BASE_URL="http://127.0.0.1:$qa_port" \
QA_FIXTURE_PATH="$qa_fixture_path" \
QA_OUTPUT_DIR="$qa_output_dir" \
PLAYWRIGHT_PATH="$PLAYWRIGHT_PATH" \
QA_HEADFUL="${QA_HEADFUL:-0}" \
node tools/qa-finance-ui.js

echo "QA 证据已写入：$qa_output_dir"
