#!/bin/bash
# llrun 验收矩阵 —— 长期回归脚本（缺目录的条目自动 SKIP）
# 用法：bash wsl/acceptance.sh            （在 WSL 里跑，需要 llrun 可执行）
#       LLRUN=/usr/local/bin/llrun bash wsl/acceptance.sh
# 只读检查，全部探针文件用完即删；每个断言末尾都会做磁盘复核。

HERE=$(cd "$(dirname "$0")" && pwd)
WS=$(cd "$HERE/.." && pwd)
LL=${LLRUN:-$HERE/llrun}

# 工作区所在的盘符挂载点，例如 /mnt/d
DRIVE=$(printf '%s' "$WS" | cut -d/ -f1-3)
PARENT=$(dirname "$WS")

# Windows 用户目录：取 /mnt/<盘符>/Users 下第一个真实用户目录。
WINHOME=
for candidate in /mnt/*/Users/*/; do
  case "$candidate" in
    */All\ Users/*|*/Default/*|*/Default\ User/*|*/Public/*) continue ;;
  esac
  WINHOME=${candidate%/}
  break
done

# 「工作区外」的目标：存在的才算，逐个验证写不进去。
OUTSIDE=()
for dir in "$PARENT" "$DRIVE" "$WINHOME" "$(dirname "$WINHOME")/Users"; do
  [ -n "$dir" ] && [ -d "$dir" ] && OUTSIDE+=("$dir")
done

pass=0; fail=0; skip=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (got=$2 want=$3)"; fail=$((fail+1)); fi; }

echo "llrun      = $LL"
echo "workspace  = $WS"
echo "drive root = $DRIVE"
echo "win home   = ${WINHOME:-<none>}"
echo

echo '== 写边界：工作区外一律拒绝 =='
i=0
for dir in "${OUTSIDE[@]}"; do
  i=$((i+1))
  target="$dir/_lacc_$i.txt"
  chk "写不进 $dir" "$($LL "$WS" /bin/bash -c "touch '$target' 2>/dev/null && echo W || echo D")" 'D'
done
chk '写不进 /var/tmp' "$($LL "$WS" /bin/bash -c 'touch /var/tmp/_lacc_v 2>/dev/null && echo W || echo D')" 'D'
chk '/var/tmp 可读' "$($LL "$WS" /bin/bash -c 'ls /var/tmp >/dev/null && echo R || echo N')" 'R'
chk '工作区内可写' "$(WSX="$WS" $LL "$WS" /bin/bash -c 'touch "$WSX"/_lacc_ws.txt 2>/dev/null && echo W || echo D; rm -f "$WSX"/_lacc_ws.txt')" 'W'
chk '/tmp 可写' "$($LL "$WS" /bin/bash -c 'touch /tmp/_lacc_t.txt 2>/dev/null && echo W || echo D; rm -f /tmp/_lacc_t.txt')" 'W'
chk '/home（本用户）可写' "$($LL "$WS" /bin/bash -c 'touch ~/_lacc_h.txt 2>/dev/null && echo W || echo D; rm -f ~/_lacc_h.txt')" 'W'
chk '工作区外可读' "$($LL "$WS" /bin/bash -c "ls '$PARENT' >/dev/null && echo R || echo N")" 'R'
chk '/dev/shm 默认可写' "$($LL "$WS" /bin/bash -c 'touch /dev/shm/_lacc_s 2>/dev/null && echo W || echo D; rm -f /dev/shm/_lacc_s')" 'W'

echo '== Windows exe 全封（landlock 白名单不含 /init）=='
chk 'cmd.exe' "$($LL "$WS" /bin/bash -c '/mnt/c/Windows/System32/cmd.exe /c echo x >/dev/null 2>&1 && echo RAN || echo BLOCKED')" 'BLOCKED'
chk 'powershell.exe' "$($LL "$WS" /bin/bash -c '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -c "echo x" >/dev/null 2>&1 && echo RAN || echo BLOCKED')" 'BLOCKED'
chk 'notepad.exe' "$($LL "$WS" /bin/bash -c '/mnt/c/Windows/System32/notepad.exe >/dev/null 2>&1 && echo RAN || echo BLOCKED')" 'BLOCKED'
chk '/init 直调' "$($LL "$WS" /bin/bash -c '/init /mnt/c/Windows/System32/cmd.exe /c echo x >/dev/null 2>&1 && echo RAN || echo BLOCKED')" 'BLOCKED'

echo '== docker 逃逸 =='
chk 'docker ps' "$($LL "$WS" /bin/bash -c 'timeout 6 docker ps >/dev/null 2>&1 && echo CONNECTED || echo BLOCKED')" 'BLOCKED'
chk '--no-isolate 时 docker（反向对照）' "$($LL --no-isolate "$WS" /bin/bash -c 'timeout 6 docker ps >/dev/null 2>&1 && echo CONNECTED || echo BLOCKED')" 'CONNECTED'
chk 'socket 直连' "$($LL "$WS" /bin/bash -c 'timeout 5 python3 -c "
import socket
try:
    socket.socket(socket.AF_UNIX).connect(chr(47)+chr(118)+chr(97)+chr(114)+chr(47)+chr(114)+chr(117)+chr(110)+chr(47)+chr(100)+chr(111)+chr(99)+chr(107)+chr(101)+chr(114)+chr(46)+chr(115)+chr(111)+chr(99)+chr(107))
    print(\"CONNECTED\")
except Exception:
    print(\"BLOCKED\")
"' | tail -1)" 'BLOCKED'

echo '== 开发者工具链 =='
chk 'git' "$($LL "$WS" /bin/bash -c 'git --version >/dev/null && echo OK')" 'OK'
chk 'node' "$($LL "$WS" /bin/bash -c 'node -e 1 && echo OK')" 'OK'
chk 'python3' "$($LL "$WS" /bin/bash -c 'python3 -c "print(7*6)"')" '42'
chk 'gcc' "$($LL "$WS" /bin/bash -c 'echo "int main(){return 0;}" > /tmp/_lacc.c && gcc -o /tmp/_lacc /tmp/_lacc.c && echo OK; rm -f /tmp/_lacc /tmp/_lacc.c')" 'OK'
HOST_PKG=$(dpkg -l 2>/dev/null | wc -l)
chk 'dpkg 只读查询' "$($LL "$WS" /bin/bash -c 'dpkg -l 2>/dev/null | wc -l')" "$HOST_PKG"
chk 'curl 网络' "$($LL "$WS" /bin/bash -c 'curl -s -o /dev/null -w "%{http_code}" https://www.bing.com')" '200'
chk 'ssh 不报属主错误' "$($LL "$WS" /bin/bash -c 'ssh -G github.com 2>&1 | grep -c "Bad owner"')" '0'

echo '== -r 严格只读：写入一律拒绝 =='
chk '-r 写工作区' "$(WSX="$WS" $LL -r "$WS" /bin/bash -c 'touch "$WSX"/_lacc_r0.txt 2>/dev/null && echo W || echo D')" 'D'
chk '-r 写 /tmp' "$($LL -r "$WS" /bin/bash -c 'touch /tmp/_lacc_r1 2>/dev/null && echo W || echo D')" 'D'
chk '-r 写 /home' "$($LL -r "$WS" /bin/bash -c 'touch ~/_lacc_r2 2>/dev/null && echo W || echo D')" 'D'
chk '-r 写 /dev/shm' "$($LL -r "$WS" /bin/bash -c 'touch /dev/shm/_lacc_r3 2>/dev/null && echo W || echo D')" 'D'
chk '-r 写 /var/tmp' "$($LL -r "$WS" /bin/bash -c 'touch /var/tmp/_lacc_r4 2>/dev/null && echo W || echo D')" 'D'
chk '-r 写 /etc' "$($LL -r "$WS" /bin/bash -c 'touch /etc/_lacc_r5 2>/dev/null && echo W || echo D')" 'D'
chk '-r 写 /var/log' "$($LL -r "$WS" /bin/bash -c 'touch /var/log/_lacc_r6 2>/dev/null && echo W || echo D')" 'D'
chk '-r mktemp' "$($LL -r "$WS" /bin/bash -c 'mktemp -d >/dev/null 2>&1 && echo OK || echo NO')" 'NO'

echo '== -r 严格只读：读取照常 =='
chk '-r 读工作区' "$(WSX="$WS" $LL -r "$WS" /bin/bash -c 'ls "$WSX" >/dev/null && echo R || echo N')" 'R'
chk '-r 读 /tmp' "$($LL -r "$WS" /bin/bash -c 'ls /tmp >/dev/null && echo R || echo N')" 'R'
chk '-r 读 /home' "$($LL -r "$WS" /bin/bash -c 'ls ~ >/dev/null && echo R || echo N')" 'R'
chk '-r 读 /etc' "$($LL -r "$WS" /bin/bash -c 'cat /etc/hostname >/dev/null && echo R || echo N')" 'R'
chk '-r 读工作区外' "$($LL -r "$WS" /bin/bash -c "ls '$PARENT' >/dev/null && echo R || echo N")" 'R'
chk '-r 写 /dev/null' "$($LL -r "$WS" /bin/bash -c 'echo x > /dev/null && echo OK')" 'OK'

echo '== -r 严格只读：工具链存活（无 /tmp 可写的代价见 README）=='
chk '-r python3' "$($LL -r "$WS" /bin/bash -c 'python3 -c "print(7*6)"')" '42'
chk '-r git' "$($LL -r "$WS" /bin/bash -c 'git --version >/dev/null && echo OK')" 'OK'
chk '-r curl' "$($LL -r "$WS" /bin/bash -c 'curl -s -o /dev/null -w "%{http_code}" https://www.bing.com')" '200'
chk '-r dpkg' "$($LL -r "$WS" /bin/bash -c 'dpkg -l 2>/dev/null | wc -l')" "$(dpkg -l 2>/dev/null | wc -l)"
chk '-r ssh' "$($LL -r "$WS" /bin/bash -c 'ssh -G github.com 2>&1 | grep -c "Bad owner"')" '0'
chk '-r gcc 不可用（/tmp 只读，符合预期）' "$($LL -r "$WS" /bin/bash -c 'gcc -x c -o /dev/null - <<< "int main(){return 0;}" >/dev/null 2>&1 && echo OK || echo NO')" 'NO'

echo '== -r 严格只读：删除/重命名同样拒绝 =='
# 先在工作区内建好目标文件（-r 档建不出来），再在 -r 档里删它
printf x > "$WS"/_lacc_rd
chk '-r 删工作区文件' "$(WSX="$WS" $LL -r "$WS" /bin/bash -c 'rm -f "$WSX"/_lacc_rd 2>/dev/null && echo DONE || echo D')" 'D'
chk '-r 删除后文件仍在' "$([ -e "$WS"/_lacc_rd ] && echo STILL || echo GONE)" 'STILL'
rm -f "$WS"/_lacc_rd
chk '-r 建目录' "$(WSX="$WS" $LL -r "$WS" /bin/bash -c 'mkdir -p "$WSX"/_lacc_md 2>/dev/null && echo MADE || echo D')" 'D'

echo '== 开关 =='
chk '-C /tmp' "$($LL -C /tmp - /bin/bash -c 'pwd')" '/tmp'
chk '--no-seal 放开 /var/tmp' "$($LL --no-seal "$WS" /bin/bash -c 'touch /var/tmp/_lacc_ns 2>/dev/null && echo W || echo D; rm -f /var/tmp/_lacc_ns')" 'W'
chk '--no-isolate 同时失去封印' "$($LL --no-isolate "$WS" /bin/bash -c 'touch /var/tmp/_lacc_ni 2>/dev/null && echo W || echo D; rm -f /var/tmp/_lacc_ni')" 'W'

echo '== 原样传递 =='
cat > /tmp/_lacc_sd.sh <<'OUTER'
cat <<'INNER'
lit $HOME $(cmd) 'single' "double" \ back
INNER
OUTER
chk 'stdin heredoc 字面量' "$($LL "$WS" /bin/bash -s < /tmp/_lacc_sd.sh)" 'lit $HOME $(cmd) '\''single'\'' "double" \ back'
rm -f /tmp/_lacc_sd.sh
chk '退出码 42' "$($LL "$WS" /bin/bash -c 'exit 42'; echo $?)" '42'
chk '中文' "$($LL "$WS" /bin/bash -c 'echo 你好世界')" '你好世界'
chk 'workspace=/' "$($LL / /bin/bash -c 'echo x' 2>/dev/null; echo $?)" '126'

echo
echo "TOTAL pass=$pass fail=$fail skip=$skip"
echo '--- 磁盘复核 ---'
leaks=0
for dir in "${OUTSIDE[@]}"; do
  for f in "$dir"/_lacc_*.txt; do
    [ -e "$f" ] || continue
    echo "  LEAK  $f"; leaks=$((leaks+1))
  done
done
for f in /var/tmp/_lacc_v /var/tmp/_lacc_r4 /tmp/_lacc_r1 /dev/shm/_lacc_r3 \
         /etc/_lacc_r5 /var/log/_lacc_r6 "$WS"/_lacc_md "$WS"/_lacc_rd \
         "$WS"/_lacc_r0.txt "$WS"/_lacc_ws.txt "$WS"/_lacc_t.txt; do
  [ -e "$f" ] && { echo "  LEAK  $f"; leaks=$((leaks+1)); }
done
echo "  leaks=$leaks"

# 已存在的属主/能力快照，便于发现回归
echo '--- 能力快照 ---'
$LL "$WS" /bin/bash -c 'printf "  sudo: %s\n" "$(sudo -n true 2>&1 | head -1)"; printf "  dbus: %s\n" "$(timeout 5 dbus-send --session --dest=org.freedesktop.DBus --type=method_call /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>&1 | grep -qi "Failed to open connection" && echo UNREACHABLE || echo OK)"'

exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
