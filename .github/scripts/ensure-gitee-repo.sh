#!/usr/bin/env bash
# 确保 Gitee 侧存在同名仓库，并把可见性对齐 GitHub。
#
# 用法:  bash ensure-gitee-repo.sh <gh_owner> <gitee_owner> <repo>
# 需要:  GITEE_TOKEN（建仓/改设置的是 Gitee 私人令牌）
#        GITHUB_TOKEN（runner 自带，用来读 GitHub 侧可见性；已认证，不吃匿名限流）
#
# 设计要点：
#   * 可见性不写死，而是读 GitHub 的 private 字段 —— GitHub 上是公开的，
#     Gitee 上就公开，不靠人工同步。
#   * 已存在时，只在可见性不一致时才 PATCH，避免无谓地把描述/主页等设置覆盖掉。
#   * 结尾一定复验，对不上就 exit 1（不允许"看着像成功"）。

set -euo pipefail

GH_OWNER="$1"
GITEE_OWNER="$2"
REPO="$3"
API="https://gitee.com/api/v5"
UA="User-Agent: gitee-sync"

# 从 stdin 的 JSON 里取字段并转成小写字符串（缺字段时返回 "none"）
json_get() {
  python3 -c "import sys,json;print(str(json.load(sys.stdin).get('$1')).lower())"
}

# 1) 读 GitHub 侧可见性
GH_PRIVATE=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/${GH_OWNER}/${REPO}" | json_get private)
echo "GitHub ${GH_OWNER}/${REPO} → private=${GH_PRIVATE}"
if [ "${GH_PRIVATE}" = "none" ] || [ -z "${GH_PRIVATE}" ]; then
  echo "::error::读不到 GitHub 仓库信息（仓库不存在或令牌无 metadata:read）"
  exit 1
fi

# 2) Gitee 侧是否存在
code=$(curl -s -o /dev/null -w '%{http_code}' -H "${UA}" \
  "${API}/repos/${GITEE_OWNER}/${REPO}?access_token=${GITEE_TOKEN}")
echo "Gitee ${GITEE_OWNER}/${REPO} → 探测 HTTP ${code}"

if [ "${code}" != "200" ]; then
  echo "  不存在 → 创建（private=${GH_PRIVATE}）"
  curl -sS -X POST "${API}/user/repos" -H "${UA}" \
    --data-urlencode "access_token=${GITEE_TOKEN}" \
    --data-urlencode "name=${REPO}" \
    --data-urlencode "path=${REPO}" \
    --data-urlencode "private=${GH_PRIVATE}" \
    --data-urlencode "auto_init=false" \
    --data-urlencode "description=Mirror of GitHub ${GH_OWNER}/${REPO}" \
    -o /tmp/gi_create.json -w '  create → HTTP %{http_code}\n'
  head -c 300 /tmp/gi_create.json; echo
else
  cur=$(curl -s -H "${UA}" \
    "${API}/repos/${GITEE_OWNER}/${REPO}?access_token=${GITEE_TOKEN}" | json_get private)
  echo "  已存在 → 当前 private=${cur}"
  if [ "${cur}" != "${GH_PRIVATE}" ]; then
    echo "  可见性与 GitHub 不一致 → 对齐为 private=${GH_PRIVATE}"
    curl -sS -X PATCH "${API}/repos/${GITEE_OWNER}/${REPO}" -H "${UA}" \
      --data-urlencode "access_token=${GITEE_TOKEN}" \
      --data-urlencode "name=${REPO}" \
      --data-urlencode "path=${REPO}" \
      --data-urlencode "private=${GH_PRIVATE}" \
      -o /tmp/gi_patch.json -w '  patch → HTTP %{http_code}\n'
    head -c 300 /tmp/gi_patch.json; echo
  fi
fi

# 3) 复验
final=$(curl -s -H "${UA}" \
  "${API}/repos/${GITEE_OWNER}/${REPO}?access_token=${GITEE_TOKEN}" | json_get private)
echo "复验 private=${final}（期望 ${GH_PRIVATE}）"
if [ "${final}" != "${GH_PRIVATE}" ]; then
  echo "::error::可见性仍不一致 —— 检查 GITEE_TOKEN 是否具备 projects 权限"
  exit 1
fi
echo "✅ ${GITEE_OWNER}/${REPO} 已就绪（private=${final}）"
