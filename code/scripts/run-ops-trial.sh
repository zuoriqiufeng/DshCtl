#!/bin/bash
# run-ops-trial.sh — i2Stream Ops 试验实例（双实例并存方案 a）启停管理
#
# 实例由宿主 systemd transient unit `dsh-ops-trial.service` 托管（PID 1 拉起，
# Restart=on-failure，脱离 DSH 会话与沙箱持久运行）。与现网实例（/root/.dsh，:3080）
# 完全隔离：独立 DSH_HOME、独立端口、独立进程。
#
# 前置依赖（外部托管，不随本单元启停）：
#   MemoryCore Gateway :8420（现网 supervisor）/ i2agent MCP :8090
#
# 用法：bash run-ops-trial.sh {start|stop|status|restart|logs}
# 注意：start/stop 需要宿主 dbus 访问（本沙箱内需一次全权限）；status/logs 无需。

set -u
UNIT=dsh-ops-trial
H=/hdd/demo/public/dsh-info/.dsh-home
REPO=/hdd/demo/public/dsh-info/deepseek-harness
BOOTLOG=$H/logs/trial-boot.log

case "${1:-status}" in
  start)
    if systemctl is-active --quiet "$UNIT" 2>/dev/null; then echo already-running; exit 0; fi
    mkdir -p "$H/logs"
    # C2：密钥经 EnvironmentFile 注入（ops.env，权限 600）；C5：不再回显明文 key。
    # headless：无 --port/--no-open（E5 后 web 面下线，:3081 不监听）。
    systemd-run --unit="$UNIT" \
      --property=Restart=on-failure \
      --property=WorkingDirectory="$REPO" \
      --property=EnvironmentFile="$H/ops.env" \
      --setenv=DSH_HOME="$H" \
      /usr/bin/env pnpm dsh --profile ops || exit 1
    sleep 8
    echo started
    echo "API:   http://127.0.0.1:8643/v1  (Bearer \$OPS_API_KEY，见 $H/ops.env)"
    echo "Admin: http://127.0.0.1:8643/admin  (\$OPS_ADMIN_KEY，见 $H/ops.env)"
    ;;
  stop) systemctl stop "$UNIT" 2>/dev/null; echo stopped ;;
  restart) systemctl restart "$UNIT" 2>/dev/null && echo restarted ;;
  status)
    systemctl is-active "$UNIT" 2>/dev/null
    curl -s -m 3 -o /dev/null -w '  api  :8643/health -> %{http_code}\n' http://127.0.0.1:8643/health
    curl -s -m 3 -o /dev/null -w '  admin state -> %{http_code} (expect 401 w/o key)\n' http://127.0.0.1:8643/admin/api/state
    ;;
  logs) journalctl -u "$UNIT" -f ;;
  *) echo "usage: $0 {start|stop|status|restart|logs}"; exit 1 ;;
esac
