#!/data/data/com.termux/files/usr/bin/bash
# 一次性配置：让手机开机后自动启动 Nocturne。
#
# 前提（缺一不可）：
#   1. Termux 是从 F-Droid 或 GitHub 安装的（Google Play 那版太旧，不支持）
#   2. 装了 Termux:Boot 插件，并且打开过它一次
set -u

BOOT_DIR="$HOME/.termux/boot"
TARGET="$BOOT_DIR/start-rolephone.sh"

if [ ! -d "$HOME/.termux" ]; then
  echo "没找到 ~/.termux 目录，请确认用的是 Termux 官方版本。"
  exit 1
fi

mkdir -p "$BOOT_DIR"

cat > "$TARGET" <<'BOOTEOF'
#!/data/data/com.termux/files/usr/bin/sh
# 开机自动启动 Nocturne
# 先申请唤醒锁，避免息屏后系统把 Termux 挂起
termux-wake-lock 2>/dev/null || true
# 等系统启动完成、外部存储就绪
sleep 8
cd "$HOME/rolephone" || exit 1
bash start.sh >> logs/boot.log 2>&1
BOOTEOF

chmod +x "$TARGET"

echo "已写入开机启动脚本："
echo "  $TARGET"
echo ""
echo "还剩三件事要确认："
echo "  1. 是否装了 Termux:Boot（和 Termux 同一个来源，F-Droid 里搜）"
echo "  2. 装完后有没有打开过一次 Termux:Boot 的界面"
echo "  3. 手机设置里给 Termux 关掉「电池优化」，否则后台会被系统杀掉"
echo ""
echo "都确认后重启手机测试：开机大约 10 秒后能打开网址即可。"
