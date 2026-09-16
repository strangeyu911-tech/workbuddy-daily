#!/usr/bin/env bash
# 确保 Gitee 侧存在同名仓库，并把可见性对齐 GitHub。
#
# 用法:
#   bash ensure-gitee-repo.sh ensure <gh_owner> <gitee_owner> <repo>   # 推送前：只保证仓库存在
#   bash ensure-gitee-repo.sh align  <gh_owner> <gitee_owner> <repo>   # 推送后：对齐可见性
# 需要:  GITEE_TOKEN（建仓/改设置）、GITHUB_TOKEN（runner 自带，读 GitHub 可见性）
#
# ── 为什么要分两阶段 ────────────────────────────────────────────────────────
# Gitee 拒绝把「空仓库」设为公开：
#   PATCH /repos/{owner}/{repo} → 422 {"error":{"base":["空仓库不支持设置为公开仓库"]}}
# 所以顺序必须是「先建（一律私有）→ 推送内容 → 再改可见性」。
# 实测 2026-09-16：wx-assist 就卡在这里，先改可见性会整个 job 失败。
#
# ── 其他设计要点 ────────────────────────────────────────────────────────────
#   * 可见性不写死，读 GitHub 的 private 字段 —— 期望值从别处读出来，不靠人工同步。
#   * 已存在且可见性已一致时不发任何写请求，避免无谓覆盖描述/主页等设置。
#   * 结尾一定复验，对不上就 exit 1（不允许「看着像成功」）。

set -euo pipefail

PHASE="${1:-}"
GH_OWNER="${2:-}"
GITEE_OWNER="${3:-}"
REPO="${4:-}"
if [ -z "${PHASE}" ] || [ -z "${GH_OWNER}" ] || [ -z "${GITEE_OWNER}" ] || [ -z "${REPO}" ]; then
  echo "::error::用法: ensure-gitee-repo.sh <ensure|align> <gh_owner> <gitee_owner> <repo>"
  exit 2
fi

API="https://gitee.com/api/v5"
UA="User-Agent: gitee-sync"

# 从 stdin 的 JSON 取字段并转小写字符串（缺字段时返回 "none"）
json_get() {
  python3 -c "import sys,json;print(str(json.load(sys.stdin).get('$1')).lower())"
}

gh_field() {
  curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${GH_OWNER}/${REPO}" | json_get "$1"
}

gitee_field() {
  curl -s -H "${UA}" \
    "${API}/repos/${GITEE_OWNER}/${REPO}?access_token=${GITEE_TOKEN}" | json_get "$1"
}

gitee_http() {
  curl -s -o /dev/null -w '%{http_code}' -H "${UA}" \
    "${API}/repos/${GITEE_OWNER}/${REPO}?access_token=${GITEE_TOKEN}"
}

# 目标可见性（来自 GitHub）
WANT=$(gh_field private)
if [ "${WANT}" != "true" ] && [ "${WANT}" != "false" ]; then
  echo "::error::读不到 GitHub 仓库信息（仓库不存在，或令牌无 metadata:read）"
  exit 1
fi
echo "GitHub ${GH_OWNER}/${REPO} → private=${WANT}（目标）"

case "${PHASE}" in
  ensure)
    code=$(gitee_http)
    echo "Gitee 侧探测 → HTTP ${code}"
    if [ "${code}" != "200" ]; then
      echo "  不存在 → 先建成私有（空仓库不能设为公开，可见性留到推送后 align）"
      curl -sS -X POST "${API}/user/repos" -H "${UA}" \
        --data-urlencode "access_token=${GITEE_TOKEN}" \
        --data-urlencode "name=${REPO}" \
        --data-urlencode "path=${REPO}" \
        --data-urlencode "private=true" \
        --data-urlencode "auto_init=false" \
        --data-urlencode "description=Mirror of GitHub ${GH_OWNER}/${REPO}" \
        -o /tmp/gi_create.json -w '  create → HTTP %{http_code}\n'
      head -c 300 /tmp/gi_create.json; echo
      code2=$(gitee_http)
      if [ "${code2}" != "200" ]; then
        echo "::error::Gitee 建仓失败（复验 HTTP ${code2}）"
        exit 1
      fi
    fi
    echo "✅ ${GITEE_OWNER}/${REPO} 已就绪，可以推送"
    ;;

  align)
    cur=$(gitee_field private)
    echo "Gitee 当前 private=${cur}（期望 ${WANT}）"
    if [ "${cur}" = "${WANT}" ]; then
      echo "✅ 已一致，不发写请求"
      exit 0
    fi
    echo "  不一致 → 对齐为 private=${WANT}"
    pcode=$(curl -s -X PATCH "${API}/repos/${GITEE_OWNER}/${REPO}" -H "${UA}" \
      --data-urlencode "access_token=${GITEE_TOKEN}" \
      --data-urlencode "name=${REPO}" \
      --data-urlencode "path=${REPO}" \
      --data-urlencode "private=${WANT}" \
      -o /tmp/gi_patch.json -w '%{http_code}')
    echo "  patch → HTTP ${pcode}"
    head -c 300 /tmp/gi_patch.json; echo
    final=$(gitee_field private)
    echo "复验 private=${final}"
    if [ "${final}" != "${WANT}" ]; then
      if [ "${pcode}" = "422" ]; then
        echo "::error::Gitee 拒绝修改可见性（422）—— 最常见原因是仓库仍是空的（推送步骤没成功？）"
      else
        echo "::error::可见性仍不一致 —— 检查 GITEE_TOKEN 是否具备 projects 权限"
      fi
      exit 1
    fi
    echo "✅ ${GITEE_OWNER}/${REPO} 可见性已对齐（private=${final}）"
    ;;

  *)
    echo "::error::未知阶段: ${PHASE}（应为 ensure 或 align）"
    exit 2
    ;;
esac
