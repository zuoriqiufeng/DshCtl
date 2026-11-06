#!/usr/bin/env bash
# dshctl CI 一键：纯逻辑自测 + 契约对账（只读，供流水线/周检调用）
# 退出码：0=全绿；非 0=任一环节失败（各环节已自打印原因）
set -uo pipefail
H=/hdd/demo/public/dsh-info/deepseek-harness
D=/hdd/demo/public/dsh-info/code/dshctl
B=$D/bin
# dshctl 环节用自带 tsx（$B/*）；dsh-plugin/ops-api/intent-router 沿用 harness 惯例（cd $H 仅服务它们）
cd "$H" || exit 2
fail=0
echo "== [1/9] dshctl self-test =="
"$B/dshctl-selftest" || fail=1
echo "== [2/9] dsh-plugin self-test =="
node --import tsx/esm /hdd/demo/public/dsh-info/code/dsh-plugin/self-test.ts || fail=1
echo "== [3/9] ops-api self-test =="
node --import tsx/esm /hdd/demo/public/dsh-info/code/ops-api/self-test.ts || fail=1
echo "== [4/9] intent-router self-test（分层意图识别 + 标定集分离度）=="
node --import tsx/esm /hdd/demo/public/dsh-info/code/intent-router/self-test.ts || fail=1
echo "== [5/9] upgrade-check（全领域上游对账）=="
"$B/dshctl" upgrade-check || fail=1
echo "== [6/9] check ops --ci =="
"$B/dshctl" check ops --ci || fail=1
echo "== [7/9] ops-skill-manager self-test =="
node --import tsx/esm /hdd/demo/public/dsh-info/code/ops-skill-manager/self-test.ts || fail=1
echo "== [8/9] dsh-observability self-test（P1a 观测插件）=="
node --import tsx/esm /hdd/demo/public/dsh-info/code/dsh-observability/self-test.ts || fail=1
echo "== [9/9] bkn-feedback self-test（P1b 反馈回流插件）=="
node --import tsx/esm /hdd/demo/public/dsh-info/code/bkn-feedback/self-test.ts || fail=1
echo "== ci: $([ $fail -eq 0 ] && echo ALL GREEN || echo FAILED) =="
exit $fail
