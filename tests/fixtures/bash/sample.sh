#!/usr/bin/env bash
# 演示：shell 脚本（没有类型，只有函数 → 落到 module 节点上）

set -euo pipefail

source ./lib/common.sh

greet() {
  local name="${1:-world}"
  if [ -n "$name" ]; then
    echo "hi $name"
  fi
}

count_lines() {
  local f="$1"
  for i in $(seq 1 3); do
    wc -l "$f" && break
  done
}

greet "atlas"
