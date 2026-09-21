#!/bin/bash
# api-smoke.sh — ops-api 联调脚本（阶段2 W4.3）
# 前置：web 已重启加载 ops-api；调用 DSH 侧 /v1 面（默认 3080）
# 用法：bash api-smoke.sh [BASE_URL] [API_KEY]
#   BASE_URL 默认 http://127.0.0.1:3080；API_KEY 空则不带鉴权头

BASE="${1:-http://127.0.0.1:3080}"
KEY="${2:-}"
AUTH=()
[ -n "$KEY" ] && AUTH=(-H "Authorization: Bearer $KEY")

echo "== 1. /health =="
curl -s -m 10 "$BASE/health"; echo

echo "== 2. /v1/models =="
curl -s -m 10 "${AUTH[@]}" "$BASE/v1/models"; echo

echo "== 3. /v1/chat/completions 非流式（短问题，计时）=="
BODY='{"model":"i2stream-ops","messages":[{"role":"user","content":"i2Stream 是什么？一句话回答。"}],"stream":false}'
start=$(date +%s.%N)
resp=$(curl -s -m 180 -w '\n%{http_code}' -X POST "$BASE/v1/chat/completions" "${AUTH[@]}" -H "Content-Type: application/json" -d "$BODY")
end=$(date +%s.%N)
code=$(echo "$resp" | tail -1)
echo "http=$code 耗时=$(echo "$end $start" | awk '{printf "%.1f", $1-$2}')s"
echo "$resp" | head -n -1 | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    c=d.get('choices',[{}])[0].get('message',{}).get('content','')
    u=d.get('usage',{})
    print(f'content={c[:120]!r}')
    print(f'usage={u}')
except Exception as e:
    print('parse-fail:', sys.stdin.read()[:200] if False else e)
"

echo "== 4. /v1/chat/completions 流式（SSE 前 12 行）=="
BODY2='{"model":"i2stream-ops","messages":[{"role":"user","content":"用一句话说明什么是增量同步。"}],"stream":true}'
curl -s -m 180 -N -X POST "$BASE/v1/chat/completions" "${AUTH[@]}" -H "Content-Type: application/json" -d "$BODY2" | head -c 2000 | head -12

echo; echo "== 5. 错误 key 鉴权（应 401，仅在配置了 apiKey 时有效）=="
curl -s -m 10 -o /dev/null -w 'http=%{http_code}\n' -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer wrong-key" -H "Content-Type: application/json" -d "$BODY"
echo "== smoke done =="
