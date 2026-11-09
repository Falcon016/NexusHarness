---
name: it-admin
description: IT administration toolkit for Linux, Windows and macOS machines, servers and homelabs: health snapshot, slow systems, full disks, network and DNS problems, services and logs, users and access, patching, security baseline, backups, Docker and Proxmox. Use for any sysadmin, troubleshooting or maintenance task on a computer or server.
---

This skill is a set of playbooks and two read-only scripts (listed at the end). Read the playbook that fits the
task with the skill tool (`file: "playbooks/<name>.md"`) before running anything.

## Ground rules

1. **Know which machine you are on.** Run `hostname` and `uname -a` (Linux/macOS) or `$PSVersionTable;
hostname` (Windows) first. In the container sandbox, commands see the container, not the host: say so and stop
   if the user meant the host. For another machine, use `ssh host 'command'` with the user's existing access;
   never copy keys or store passwords.
2. **Look before you touch.** Start with read-only commands (the snapshot script, then the playbook's checks).
   Find the cause before changing anything.
3. **Every change is explicit.** Before a command that changes the system (install, delete, restart, edit a
   config, change a user or a firewall rule), tell the user what it does and how to undo it. Wait for their go-ahead
   unless they already asked for exactly that change. `sudo` always goes through approval.
4. **Back up what you edit.** `cp -a file file.bak.$(date +%Y%m%d%H%M)` (PowerShell: `Copy-Item file
"file.bak.$(Get-Date -f yyyyMMddHHmm)"`) before editing a config, and validate it before reloading
   (`nginx -t`, `sshd -t`, `visudo -c`, `named-checkconf`, `systemd-analyze verify`).
5. **Reversible first, one step at a time.** Restart one service, not the machine; one host, not the fleet. Check
   the result after each step.
6. **Never** run `rm -rf` on paths built from variables, `chmod -R 777`, disable a firewall or SELinux to "test",
   or pipe a downloaded script into a shell. Find the narrow fix.
7. **Keep a change log** in your final report: what changed, when, why, and how to undo it.

## Start here

Run the snapshot for an overview of any machine; it changes nothing and needs no root:

- Linux / macOS: `bash "<skill folder>/scripts/snapshot.sh"`
- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File "<skill folder>\scripts\snapshot.ps1"`
  (the bypass applies to this one process only)

Then pick the playbook:

| Problem or task                                       | Playbook                         |
| ----------------------------------------------------- | -------------------------------- |
| Slow, freezing, high CPU or memory, swapping          | `playbooks/performance.md`       |
| Disk full, large folders, inode exhaustion            | `playbooks/disk-space.md`        |
| No internet, DNS, can't reach a host or port, Wi-Fi   | `playbooks/network.md`           |
| A service won't start or keeps crashing, reading logs | `playbooks/services-and-logs.md` |
| Users, groups, sudo/admin rights, SSH keys, passwords | `playbooks/accounts.md`          |
| Updates and patching, reboots needed                  | `playbooks/updates.md`           |
| Security check-up: open ports, logins, firewall, AV   | `playbooks/security-baseline.md` |
| Backups: set up, verify, restore                      | `playbooks/backups.md`           |
| Docker containers, Proxmox VMs and LXC containers     | `playbooks/containers.md`        |

## Report

- **Machine:** host name and OS.
- **Findings:** what you checked and what you found, most important first, with the evidence (command output,
  trimmed).
- **Changes:** each change with how to undo it, or "none".
- **Recommendations:** what the user should do next, in order of priority.
