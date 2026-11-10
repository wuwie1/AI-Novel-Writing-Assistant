#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
  echo "用法: check-upstream.sh [仓库目录]" >&2
  exit 2
fi
cd -- "${1:-.}"

verify_remote() {
  local remote=$1 owner=$2 address path
  if ! address=$(git remote get-url "$remote"); then
    echo "请按 skill_tools.md 核对并配置 $remote 远端。" >&2
    return 1
  fi
  path="$owner/AI-Novel-Writing-Assistant"
  case "${address%.git}" in
    "https://github.com/$path"|"git@github.com:$path"|"ssh://git@github.com/$path") ;;
    *) echo "$remote 与预期的 GitHub 仓库 $path 不一致，请核实配置。" >&2; return 1 ;;
  esac
}

if ! local_ref=$(git symbolic-ref --quiet HEAD); then
  echo "当前工作区处于 detached HEAD，无法确定要检查的本地分支。" >&2
  exit 1
fi
branch=${local_ref#refs/heads/}
local_sha=$(git rev-parse --verify "$local_ref^{commit}")
verify_remote origin wuwie1
verify_remote upstream ExplosiveCoderflome

upstream_head=$(git ls-remote --symref upstream HEAD)
upstream_ref=$(awk '$1 == "ref:" && $3 == "HEAD" { print $2 }' <<< "$upstream_head")
if [[ $upstream_ref != refs/heads/* ]]; then
  echo "upstream 没有公布默认分支，无法确定上游更新来源。" >&2
  exit 1
fi
upstream_branch=${upstream_ref#refs/heads/}
tracking_ref="refs/remotes/upstream/$upstream_branch"
git fetch --no-tags --refmap= upstream "+$upstream_ref:$tracking_ref"
upstream_sha=$(git rev-parse --verify "$tracking_ref^{commit}")

# A new local branch may have no fork counterpart. Only exit 2 means it is absent.
if git ls-remote --exit-code --heads origin "$local_ref" >/dev/null; then
  fork_ref="refs/remotes/origin/$branch"
  git fetch --no-tags --refmap= origin "+$local_ref:$fork_ref"
  fork_sha=$(git rev-parse --verify "$fork_ref^{commit}")
  counts=$(git rev-list --left-right --count "$local_sha...$fork_sha")
  read -r ahead behind <<< "$counts"
  printf 'origin/%s %s（本地领先 %s 个提交，落后 %s 个提交）\n' "$branch" "$fork_sha" "$ahead" "$behind"
else
  status=$?
  if (( status != 2 )); then exit "$status"; fi
  printf 'origin 尚无同名分支 %s。\n' "$branch"
fi

missing=$(git rev-list --count "$local_sha..$upstream_sha")
printf '当前分支 %s %s\n上游默认分支 %s %s\n待合入上游 %s 个提交。\n' \
  "$branch" "$local_sha" "$upstream_branch" "$upstream_sha" "$missing"
git status --short --branch
if (( missing > 0 )); then
  git log --oneline -8 "$local_sha..$upstream_sha"
fi
