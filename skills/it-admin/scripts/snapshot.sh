#!/usr/bin/env bash
# Read-only health snapshot of this Linux or macOS machine, for the it-admin skill.
# Changes nothing, needs no root (sections that need it say so), and keeps each section short.
set -u
LC_ALL=C
export LC_ALL

have() { command -v "$1" >/dev/null 2>&1; }
section() { printf '\n== %s ==\n' "$1"; }
OS=$(uname -s)

section "Machine"
echo "host: $(hostname)  user: $(id -un)  kernel: $(uname -sr)  arch: $(uname -m)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os: ${PRETTY_NAME:-$NAME}"; fi
[ "$OS" = Darwin ] && echo "os: macOS $(sw_vers -productVersion 2>/dev/null)"
if have systemd-detect-virt; then echo "virtualisation: $(systemd-detect-virt 2>/dev/null || echo none)"; fi
[ -f /.dockerenv ] && echo "note: running inside a Docker container (this is not the host)"
echo "uptime: $(uptime | sed 's/^ *//')"

section "CPU and memory"
if [ "$OS" = Darwin ]; then
  echo "cpus: $(sysctl -n hw.ncpu)  memory: $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
  memory_pressure 2>/dev/null | tail -1
else
  echo "cpus: $(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
  free -h 2>/dev/null
  if [ -r /sys/fs/cgroup/memory.max ] && [ "$(cat /sys/fs/cgroup/memory.max)" != max ]; then
    echo "container memory limit: $(( $(cat /sys/fs/cgroup/memory.max) / 1048576 )) MB"
  fi
fi

section "Busiest processes (CPU)"
if [ "$OS" = Darwin ]; then ps -Ao pid,user,%cpu,%mem,comm -r | head -8
else ps -eo pid,user,%cpu,%mem,rss,etime,comm --sort=-%cpu | head -8; fi

section "Largest processes (memory)"
if [ "$OS" = Darwin ]; then ps -Ao pid,user,%cpu,%mem,rss,comm -m | head -8
else ps -eo pid,user,%cpu,%mem,rss,etime,comm --sort=-rss | head -8; fi

section "Disks"
if [ "$OS" = Darwin ]; then df -h | grep -vE '^(devfs|map )'
else
  df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -h
  df -i -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | awk 'NR>1 && $5+0 >= 80 {print "inodes " $5 " used on " $6; n++} END {if (!n) print "inodes: all below 80%"}'
fi

section "Listening ports"
if have ss && ss -tuln >/dev/null 2>&1; then ss -tuln 2>/dev/null | awk 'NR==1 || /LISTEN|UNCONN/' | head -30
  echo "(process names need root: sudo ss -tulpn)"
elif have lsof; then lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -30
elif have netstat; then netstat -an | grep -i listen | head -30; fi

section "Network"
if have ip; then ip -br addr 2>/dev/null; ip route 2>/dev/null | head -5
elif [ "$OS" = Darwin ]; then ifconfig | awk '/^[a-z]/{i=$1} /inet /{print i, $2}'; netstat -rn | awk '/default/{print; exit}'; fi
if [ -r /etc/resolv.conf ]; then echo "dns: $(awk '/^nameserver/{printf "%s ", $2}' /etc/resolv.conf)"; fi

if have systemctl && [ -d /run/systemd/system ]; then
  section "Failed services"
  failed=$(systemctl --failed --no-legend --no-pager 2>/dev/null)
  if [ -n "$failed" ]; then printf '%s\n' "$failed" | head -20; else echo "none"; fi

  section "Errors this boot (last 15)"
  if errs=$(journalctl -p err -b --no-pager -q 2>/dev/null); then
    if [ -n "$errs" ]; then printf '%s\n' "$errs" | tail -15; else echo "none"; fi
  else
    echo "(journal not readable by $(id -un): add the user to the systemd-journal or adm group, or use sudo)"
  fi
fi

section "Updates"
if have apt-get; then
  n=$(apt list --upgradable 2>/dev/null | grep -c upgradable)
  echo "apt: $n upgradable (as of the last apt update)"
  [ -f /var/run/reboot-required ] && echo "reboot required"
elif have dnf; then
  echo "dnf: $(dnf -q check-update 2>/dev/null | grep -c '^[[:alnum:]]') upgradable"
elif have pacman; then
  echo "pacman: run 'checkupdates' (pacman-contrib) to list pending updates"
elif [ "$OS" = Darwin ]; then
  echo "run 'softwareupdate -l' to list updates (slow, so not done here)"
fi

if have docker; then
  section "Docker"
  if dps=$(docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null); then
    if [ -n "$dps" ]; then printf '%s\n' "$dps" | head -20; else echo "no containers"; fi
  else
    echo "(no access to the Docker daemon: not running, or $(id -un) is not in the docker group)"
  fi
fi
if have pct || have qm; then
  section "Proxmox"
  pveversion 2>/dev/null
  qm list 2>/dev/null | head -20; pct list 2>/dev/null | head -20
fi

section "Time"
if have timedatectl && [ -d /run/systemd/system ]; then timedatectl 2>/dev/null | grep -E 'Local time|synchronized|NTP service'
else date; fi
