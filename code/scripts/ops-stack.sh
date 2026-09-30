#!/bin/bash
# ops-stack.sh — ops 工作台一键起停（dshctl GUI :8780）
#
# 边界（实例自治）：DSH 试验实例（:8643）不归本脚本管——它是独立 systemd 单元，
# 用实例自己的 runner（$DSH_HOME/run-<domain>.sh，dshctl apply 生成）起停。
#
# 用法：bash code/scripts/ops-stack.sh {start|stop|restart|status}
# 退出码：0=就绪；1=未就绪；2=用法错误
set -uo pipefail

H=/hdd/demo/public/dsh-info/.dsh-home
REPO=/hdd/demo/public/dsh-info
GUI_PORT=8780
GUI_PID="$H/gui.pid"
GUI_LOG="$H/logs/gui-8780.log"

c_green='\033[32m'; c_red='\033[31m'; c_dim='\033[2m'; c_off='\033[0m'
say() { printf '%b\n' "$1"; }

gui_up() { ss -ltn 2>/dev/null | grep -q ":$GUI_PORT "; }
gui_pid_alive() { [[ -f "$GUI_PID" ]] && kill -0 "$(cat "$GUI_PID")" 2>/dev/null; }

gui_start() {
  if gui_up; then say "  gui  : ${c_green}already-running${c_off} (:${GUI_PORT})"; return 0; fi
  gui_pid_alive && kill "$(cat "$GUI_PID")" 2>/dev/null && sleep 1
  [[ -f "$H/gui.env" ]] || { say "  gui  : ${c_red}缺失 $H/gui.env（DSHCTL_GUI_KEY）——非回环绑定拒绝启动${c_off}"; return 1; }
  mkdir -p "$H/logs"
  setsid nohup bash -c "
    set -a; . '$H/gui.env'; set +a
    cd '$REPO/code/dshctl'
    exec node --import file://'$REPO/code/dshctl/node_modules/tsx/dist/esm/index.mjs' '$REPO/code/dshctl/gui/server.ts' --host 0.0.0.0 --port $GUI_PORT
  " > "$GUI_LOG" 2>&1 < /dev/null &
  echo $! > "$GUI_PID"
  for _ in $(seq 1 20); do
    gui_up && { say "  gui  : ${c_green}started${c_off} (:${GUI_PORT}，pid $(cat "$GUI_PID")，log $GUI_LOG)"; return 0; }
    sleep 0.5
  done
  say "  gui  : ${c_red}start failed${c_off}（log $GUI_LOG）"
  return 1
}

gui_stop() {
  if ! gui_up && ! gui_pid_alive; then say "  gui  : ${c_dim}stopped（本就未运行）${c_off}"; return 0; fi
  gui_pid_alive && kill "$(cat "$GUI_PID")" 2>/dev/null
  for _ in $(seq 1 10); do gui_up || break; sleep 0.5; done
  gui_up && pkill -f "gui/server.ts --host 0.0.0.0 --port $GUI_PORT" 2>/dev/null && sleep 1
  rm -f "$GUI_PID"
  if gui_up; then say "  gui  : ${c_red}stop failed${c_off}（:${GUI_PORT} 仍在监听）"; return 1
  else say "  gui  : ${c_green}stopped${c_off}"; return 0; fi
}

gui_status() {
  if gui_up; then
    local health; health=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GUI_PORT/" 2>/dev/null)
    say "  gui  : ${c_green}● running${c_off} (:${GUI_PORT}，页面 HTTP $health，pid $(pgrep -f "gui/server.ts" | head -1))"
  else
    say "  gui  : ${c_red}○ down${c_off} (:${GUI_PORT} 无监听)"
  fi
}

main() {
  local action="${1:-status}"
  case "$action" in
    start|stop|restart|status) ;;
    *) say "用法: bash $REPO/code/scripts/ops-stack.sh {start|stop|restart|status}"; return 2;;
  esac
  say "== ops stack: $action =="
  if [[ "$action" == "restart" ]]; then gui_stop; gui_start; else "gui_$action"; fi
  gui_up
}

main "$@"
