#!/data/data/com.termux/files/usr/bin/bash
# Nocturne 启动脚本
# ---------------------------------------------------------------
# 修复三件事：
#   1. 原先没有这个文件，restore.sh 却调用它 -> 恢复备份后直接失败
#   2. logs/ 不存在就重定向会报 "No such file or directory" 并静默退出
#   3. 不在项目目录启动时，data/ 与 logs/ 会散落到别处
set -u

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"
mkdir -p logs data backups

# 数据库备份统一由 backup-worker.js 负责（服务启动 20 秒后自动检查），
# 这里不再重复做，避免两套命名、两套清理规则。

# 停掉旧进程（避免端口占用导致新进程静默退出）
if pgrep -f "node server.js" > /dev/null 2>&1; then
  echo "停止旧进程..."
  pkill -f "node server.js" 2>/dev/null || true
  sleep 1
fi

echo "启动 Nocturne..."
nohup node server.js >> logs/server.log 2>&1 &
PID=$!

sleep 2

if kill -0 "$PID" 2>/dev/null; then
  echo "已启动: http://127.0.0.1:${PORT}"
  echo "PID: $PID"
  echo "日志: $(pwd)/logs/server.log"
  echo "停止: pkill -f 'node server.js'"
else
  echo "启动失败，最近日志："
  tail -20 logs/server.log
  exit 1
fi
