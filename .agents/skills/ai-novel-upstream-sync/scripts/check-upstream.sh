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

verify_remote origin wuwie1
verify_remote upstream ExplosiveCoderflome
git fetch --no-tags upstream refs/heads/main:refs/remotes/upstream/main
git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main refs/heads/ai:refs/remotes/origin/ai

upstream_ref=refs/remotes/upstream/main
printf '上游 main %s\n' "$(git rev-parse "$upstream_ref")"
git status --short --branch
for branch in main ai; do
  local_ref="refs/heads/$branch"
  fork_ref="refs/remotes/origin/$branch"
  if git show-ref --verify --quiet "$local_ref"; then
    compare_ref=$local_ref
    fork_counts=$(git rev-list --left-right --count "$local_ref...$fork_ref")
    read -r local_only fork_only <<< "$fork_counts"
    position="本地比 fork 领先 $local_only 个提交，落后 $fork_only 个提交"
  else
    compare_ref=$fork_ref
    position="本地分支尚未建立，按 origin/$branch 计算"
  fi
  missing=$(git rev-list --count "$compare_ref..$upstream_ref")
  printf '%s (%s)：待合入上游 %s 个提交。%s。\n' \
    "$branch" "$(git rev-parse --short "$compare_ref")" "$missing" "$position"
  if (( missing > 0 )); then
    git log --oneline -8 "$compare_ref..$upstream_ref"
  fi
done
