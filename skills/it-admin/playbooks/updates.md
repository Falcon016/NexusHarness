# Updates and patching

Patch regularly, but in a controlled way: see what will change, have a way back, update, then check that things
still work.

## Before

- What is pending, and is any of it a security fix?
- Is there a recent backup or snapshot (VM/LXC snapshot, filesystem snapshot)? For a server, take one first.
- What runs on this machine, and how will you check it afterwards (a URL, a service status, a test)?
- Is now a good time (a reboot may be needed)?

## Debian / Ubuntu

```sh
sudo apt update
apt list --upgradable
sudo apt upgrade              # ask first; full-upgrade only when you understand what it removes
[ -f /var/run/reboot-required ] && cat /var/run/reboot-required.pkgs
```

Unattended security updates: `sudo apt install unattended-upgrades && sudo dpkg-reconfigure unattended-upgrades`.

## Fedora / RHEL / Rocky / Alma

```sh
sudo dnf check-update
sudo dnf updateinfo list --security
sudo dnf upgrade              # ask first
sudo dnf needs-restarting -r  # reboot needed?
```

## Arch: `sudo pacman -Syu` (read the news at archlinux.org first). Alpine: `apk update && apk upgrade`.

## Proxmox VE

`apt update && apt dist-upgrade` on the host, one node at a time, with VMs migrated or shut down; check the
release notes for major versions. Use the enterprise or no-subscription repository that is configured; don't mix.

## Windows

```powershell
Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 10
# With the PSWindowsUpdate module (Install-Module PSWindowsUpdate; ask first):
Get-WindowsUpdate
Install-WindowsUpdate -AcceptAll -IgnoreReboot
# Pending reboot?
Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
```

Without the module, use Settings → Windows Update, or `UsoClient StartScan` to trigger a scan. Third-party apps:
`winget upgrade` lists them, `winget upgrade --all` updates them (ask first).

## macOS

`softwareupdate -l`, then `sudo softwareupdate -ia` (ask first). Homebrew: `brew update && brew outdated`, then
`brew upgrade`.

## Containers

Update images, not packages inside running containers: `docker compose pull && docker compose up -d`, then
`docker image prune`. See `containers.md`.

## After

- Reboot if required (ask first), then check the services you listed and the snapshot script for errors.
- Note what was updated (`/var/log/apt/history.log`, `dnf history`, `Get-HotFix`).

## Report

What was pending, what you updated, whether a reboot is needed or was done, and the post-update checks.
