#!/bin/bash
# bench-4q.sh — 阶段0基线问题集计时（同一脚本测 Hermes 与 DSH，口径一致）
# 用法：bash bench-4q.sh [BASE_URL] [MODEL] [API_KEY]
#   Hermes: bash bench-4q.sh http://127.0.0.1:8642 hermes-agent $API_SERVER_KEY
#   DSH:    bash bench-4q.sh http://127.0.0.1:3080 i2stream-ops

BASE="${1:-http://127.0.0.1:3080}"
MODEL="${2:-i2stream-ops}"
KEY="${3:-}"
AUTH=()
[ -n "$KEY" ] && AUTH=(-H "Authorization: Bearer $KEY")
URL="$BASE/v1/chat/completions"

QS=(
  "如何创建一条 Oracle 到 MySQL 的增量同步规则？"
  "增量同步卡住不动了，怎么排查？"
  "什么情况下禁止删除同步规则？"
  "YAS-01001 错误是什么原因？"
)

echo "# bench-4q → $BASE (model=$MODEL) $(date '+%F %T')"
for i in "${!QS[@]}"; do
  q="${QS[$i]}"
  body=$(python3 -c "
import json,sys
print(json.dumps({'model':sys.argv[2],'messages':[{'role':'user','content':sys.argv[1]}],'stream':False}))
" "$q" "$MODEL")
  start=$(date +%s.%N)
  resp=$(curl -s -m 300 -w '\n%{http_code}' -X POST "$URL" "${AUTH[@]}" -H "Content-Type: application/json" -d "$body")
  end=$(date +%s.%N)
  code=$(echo "$resp" | tail -1)
  content=$(echo "$resp" | head -n -1)
  dur=$(echo "$end $start" | awk '{printf "%.1f", $1-$2}')
  info=$(echo "$content" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  c=d.get('choices',[{}])[0].get('message',{}).get('content','') or ''
  u=d.get('usage',{})
  print(f'len={len(c)} tokens={u.get(\"total_tokens\",\"?\")}')
except Exception as e:
  print('parse-fail:'+str(e)[:60])
" 2>/dev/null)
  echo "Q$((i+1)) [${dur}s] http=$code $info :: $q"
done
