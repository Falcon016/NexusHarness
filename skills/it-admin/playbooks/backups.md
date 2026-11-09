# Backups

A backup is only real once a restore has been tested. Know what is backed up, where to, how often, and how long
it is kept: and that at least one copy is off the machine (3-2-1: three copies, two kinds of storage, one
off-site).

## Find what exists

```sh
crontab -l; sudo ls /etc/cron.*; systemctl list-timers --all --no-pager | head -30   # scheduled jobs
command -v restic borg rsync rclone duplicity 2>/dev/null
```

- Proxmox: Datacenter → Backup jobs, or `cat /etc/pve/jobs.cfg`; `pvesm status` for storages; Proxmox Backup
  Server datastores and their verify jobs.
- Windows: `wbadmin get versions` (elevated), File History, or the vendor tool's own status.
- macOS: `tmutil latestbackup`, `tmutil destinationinfo`.

## Check the backups are healthy

- restic: `restic snapshots`, `restic check` (add `--read-data-subset=5%` occasionally).
- borg: `borg list <repo>`, `borg check <repo>`.
- Look at the date of the newest backup: older than the schedule says = the job is failing. Read its log.

## Test a restore

Restore one file or folder to a _different_ place and compare:

```sh
restic restore latest --target /tmp/restore-test --include /etc/nginx
diff -r /etc/nginx /tmp/restore-test/etc/nginx && echo identical
```

For databases, restore the dump into a scratch database and run a query against it. For VMs, restore to a new
VM id without network and boot it.

## Set one up (when asked)

Prefer what the user already uses. A minimal restic job:

```sh
export RESTIC_REPOSITORY=/mnt/backup/restic      # or sftp:, s3:, b2:, rclone:
export RESTIC_PASSWORD_FILE=~/.config/restic/pass # mode 600; the user keeps a copy elsewhere
restic init
restic backup ~/Documents /etc --exclude-caches
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

Schedule it with a systemd timer or cron, log the output, and alert on failure. Back up database dumps, not live
database files. Never put the repository password in a script that others can read.

## Report

What is backed up and where, the newest good backup, the restore test result, and the gaps (no off-site copy,
untested, missing folders, no alerting).
