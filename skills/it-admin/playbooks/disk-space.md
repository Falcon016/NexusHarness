# Disk full or filling up

Find where the space went before deleting anything, and delete only what is safe to lose. Ask before deleting
anything that is not a cache or a log the user agreed to clean.

## Linux / macOS

```sh
df -hT -x tmpfs -x devtmpfs              # which filesystem is full (macOS: df -h)
df -i -x tmpfs -x devtmpfs               # inodes: "full" with free space usually means millions of small files
sudo du -xh --max-depth=1 / 2>/dev/null | sort -h | tail -15      # biggest top-level folders on that filesystem
du -xh --max-depth=1 ~ 2>/dev/null | sort -h | tail -15
find / -xdev -type f -size +500M -printf '%s\t%p\n' 2>/dev/null | sort -n | tail -20   # big single files
sudo lsof +L1 2>/dev/null | head         # deleted files still held open: space comes back when the process restarts
```

On macOS use `du -xhd 1` and `find / -xdev -size +500M` (no `-printf`).

Usual suspects and the safe way to clean them:

| What                        | Check                                     | Clean                                                                                                                |
| --------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| systemd journal             | `journalctl --disk-usage`                 | `sudo journalctl --vacuum-size=500M`                                                                                 |
| Old logs                    | `du -sh /var/log/*`                       | fix the rotation (`/etc/logrotate.d`), then remove old `.gz`                                                         |
| Package caches              | `du -sh /var/cache/apt /var/cache/dnf`    | `sudo apt clean` / `sudo dnf clean all`                                                                              |
| Old kernels (Debian/Ubuntu) | `dpkg -l 'linux-image*'`                  | `sudo apt autoremove --purge`                                                                                        |
| Docker                      | `docker system df`                        | `docker system prune` (ask: removes stopped containers and unused images); `-a --volumes` only with explicit consent |
| Snap revisions              | `snap list --all`                         | remove `disabled` revisions                                                                                          |
| Core dumps                  | `coredumpctl list`, `/var/crash`          | delete after the crash is understood                                                                                 |
| User caches                 | `du -sh ~/.cache/*`                       | safe to delete; they rebuild                                                                                         |
| Build output                | `node_modules`, `target`, `dist`, `.venv` | delete in projects not being worked on                                                                               |

Never delete from `/var/lib` (databases, containers, packages) by hand, and never remove a log a process still
writes to: truncate it (`: > file`) if you must.

## Windows (PowerShell)

```powershell
Get-Volume | Where-Object DriveLetter | Sort-Object DriveLetter | Format-Table DriveLetter, FileSystemLabel, @{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}}, @{n='FreeGB';e={[math]::Round($_.SizeRemaining/1GB,1)}}
Get-ChildItem C:\Users\$env:USERNAME -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ GB = [math]::Round((Get-ChildItem $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1GB,2); Path = $_.FullName } } | Sort-Object GB -Descending | Select-Object -First 15
Get-ChildItem C:\ -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object Length -gt 1GB | Sort-Object Length -Descending | Select-Object -First 20 FullName, @{n='GB';e={[math]::Round($_.Length/1GB,1)}}
```

Safe cleanups: `%TEMP%` contents, the Recycle Bin (`Clear-RecycleBin`, ask first), Disk Cleanup or Storage Sense
for Windows Update leftovers (`cleanmgr /sageset:1`, `Dism /Online /Cleanup-Image /StartComponentCleanup`).
Leave `C:\Windows\WinSxS`, `Installer` and `System Volume Information` to those tools.

## Report

Which filesystem, how full it was and is now, what took the space, what you removed (and that it was safe), and
what keeps filling it so it does not happen again.
