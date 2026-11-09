# Slow or freezing system

Find which resource is exhausted (CPU, memory, disk I/O, or something waiting on the network) and which process
uses it. Measure for a little while: one reading can mislead.

## Linux

```sh
uptime                                   # load average vs CPU count (nproc): load well above it = saturated
free -h                                  # "available" is what matters; swap in use + low available = memory pressure
vmstat 1 5                               # si/so > 0: swapping; wa high: waiting on disk; us+sy high: CPU
ps -eo pid,user,%cpu,%mem,rss,etime,comm --sort=-%cpu | head -15
ps -eo pid,user,%cpu,%mem,rss,etime,comm --sort=-rss | head -15
iostat -xz 1 3                           # (sysstat) %util near 100 or high await: a slow or busy disk
dmesg -T | tail -30                      # OOM kills, disk errors, thermal throttling (may need sudo)
journalctl -k -p warning -b --no-pager | tail -30
cat /sys/fs/cgroup/memory.max 2>/dev/null   # inside a container or LXC: its own memory limit
```

- **Memory:** a process growing over time (check `rss` twice, minutes apart) is a leak; restart it as a stopgap and
  report it. `journalctl -k | grep -i 'out of memory'` shows what the OOM killer took.
- **CPU:** one process at 100% per core it uses. `top -H -p <pid>` shows its threads. A runaway can be stopped with
  `kill <pid>` (ask first), `kill -9` only if it ignores that.
- **Disk I/O:** `iotop -o` (root) shows who writes. Also check free space: a nearly full disk is slow.
- **Many small processes:** `ps -e --no-headers | wc -l`; zombies: `ps -eo stat | grep -c Z`.

## Windows (PowerShell)

```powershell
Get-CimInstance Win32_Processor | Select-Object LoadPercentage
Get-CimInstance Win32_OperatingSystem | Select-Object @{n='FreeGB';e={[math]::Round($_.FreePhysicalMemory/1MB,1)}}, @{n='TotalGB';e={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}}
Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Id, ProcessName, CPU, @{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB)}}
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Id, ProcessName, @{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB)}}
Get-Counter '\Processor(_Total)\% Processor Time','\Memory\Available MBytes','\PhysicalDisk(_Total)\% Disk Time' -SampleInterval 2 -MaxSamples 3
Get-WinEvent -FilterHashtable @{LogName='System'; Id=2004} -MaxEvents 5 -ErrorAction SilentlyContinue   # low memory warnings
```

- `CPU` in Get-Process is total seconds used since start; sample twice to see who is busy _now_, or use the
  counters above.
- Startup programs: `Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location`.
- Antivirus scans, Windows Update and search indexing are common temporary causes; check their processes
  (`MsMpEng`, `TiWorker`, `SearchIndexer`) before blaming anything else.

## macOS

```sh
uptime; sysctl -n hw.ncpu
vm_stat; memory_pressure
ps -Ao pid,user,%cpu,%mem,rss,etime,comm -r | head -15      # -r: sort by CPU
ps -Ao pid,user,%cpu,%mem,rss,etime,comm -m | head -15      # -m: sort by memory
```

## Report

Which resource is short, which process uses it, since when if you can tell, and the fix: stop or restart it,
change its limits, add memory or swap, or follow up with its owner.
