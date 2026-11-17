#!/data/data/com.termux/files/usr/bin/bash
set -e

# 跟 start.sh 一致：以脚本所在目录为准，不写死路径
cd "$(dirname "$0")" || exit 1

pkill -f "node server.js" 2>/dev/null || true
sleep 1

rm -rf data/restore-extracted
mkdir -p data/restore-extracted

tar -xzf data/restore/backup.tar.gz -C data/restore-extracted

if [ ! -f data/restore-extracted/saudade.db ]; then
  echo "无效备份：没有 saudade.db"
  bash start.sh
  exit 1
fi

rm -f data/saudade.db-wal
rm -f data/saudade.db-shm

cp data/restore-extracted/saudade.db data/saudade.db

rm -rf data/uploads

if [ -d data/restore-extracted/uploads ]; then
  cp -r data/restore-extracted/uploads data/uploads
else
  mkdir -p data/uploads
fi

rm -rf data/restore-extracted

bash start.sh
