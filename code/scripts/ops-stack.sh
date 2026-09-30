#!/bin/bash
# ops-stack.sh — ops 项目一键起停（dshctl GUI :8780 + DSH 试验实例 :8643）
#
# 用法：bash code/scripts/ops-stack.sh {start|stop|restart|status} [gui|trial|all]
#   目标缺省 all（两台一起）。trial 走 systemd transient unit（run-ops-trial.sh 同款），
#   gui 以 nohup + pidfile 托管（key 经 .dsh-home/gui.env 注入，非回环绑定 fail-loud）。
#
# 退出码：0=全部就绪；1=有服务未就绪；2=用法错误
set -uo pipefail

H=/hdd/demo/public/dsh-info/.dsh-home
REPO=/hdd/demo/public/dsh-info
GUI_PORT=8780
GUI_PID="$H/gui.pid"
GUI_LOG="$H/logs/gui-8780.log"
TRIAL_SH="$REPO/code/scripts/run-ops-trial.sh"

c_green='\033[32m'; c_red='\033[31m'; c_yellow='\033[33m'; c_dim='\033[2m'; c_off='\033[0m'
say() { printf '%b\n' "$1"; }

# ── GUI（dshctl GUI :8780，nohup + pidfile）─────────────────────────────

gui_pid_alive() { [[ -f "$GUI_PID" ]] && kill -0 "$(cat "$GUI_PID")" 2>/dev/null; }

gui_up() { ss -ltn 2>/dev/null | grep -q ":$GUI_PORT "; }

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
    say "  gui  : ${c_red}○ down${c_off} (:${GUI_PORT} 无监听 —— bash $TRIAL_SH 不含 GUI，用本脚本 start)"
  fi
}

# ── TRIAL（DSH 试验实例 :8643，systemd transient unit）──────────────────

trial_up() { systemctl is-active --quiet dsh-ops-trial.service 2>/dev/null; }

trial_start() {
  trial_up && { say "  trial: ${c_green}already-running${c_off} (:8643)"; return 0; }
  bash "$TRIAL_SH" start >/dev/null 2>&1
  for _ in $(seq 1 30); do
    trial_up && { say "  trial: ${c_green}started${c_off} (:8643，health $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8643/health 2>/dev/null))"; return 0; }
    sleep 1
  done
  say "  trial: ${c_red}start failed${c_off}（journalctl -u dsh-ops-trial 查日志）"
  return 1
}

trial_stop() {
  trial_up || { say "  trial: ${c_dim}stopped（本就未运行）${c_off}"; return 0; }
  bash "$TRIAL_SH" stop >/dev/null 2>&1
  if trial_up; then say "  trial: ${c_red}stop failed${c_off}"; return 1
  else say "  trial: ${c_green}stopped${c_off}"; return 0; fi
}

trial_status() {
  if trial_up; then
    local health; health=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8643/health 2>/dev/null)
    say "  trial: ${c_green}● running${c_off} (:8643，health HTTP $health，unit dsh-ops-trial.service)"
  else
    say "  trial: ${c_red}○ down${c_off} (:8643 无进程 —— bash $TRIAL_SH start)"
  fi
}

# ── 编排 ────────────────────────────────────────────────────────────────

run_for() {
  local action="$1" target="$2" rc=0
  case "$target" in
    gui)   "gui_$action";;
    trial) "trial_$action";;
    all)   "gui_$action"; "trial_$action";;
    *)     say "未知目标: $target（gui | trial | all）"; return 2;;
  esac
}

main() {
  local action="${1:-status}" target="${2:-all}"
  case "$action" in
    start|stop|restart|status) ;;
    *) say "用法: bash $REPO/code/scripts/ops-stack.sh {start|stop|restart|status} [gui|trial|all]"; return 2;;
  esac
  [[ "$action" == "restart" ]] && action="stop_start"
  if [[ "$action" == "stop_start" ]]; then
    local rc=0
    run_for stop "$target" || rc=1
    run_for start "$target" || rc=1
    return $rc
  fi
  say "== ops stack: $action =="
  run_for "$action" "$target"
}

main "$@"
