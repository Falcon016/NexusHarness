# Services and logs

A failing service almost always says why in its log, a few lines before it stops. Read that before restarting
anything.

## Linux (systemd)

```sh
systemctl --failed
systemctl status <unit> --no-pager -l              # state, last lines of its log, the main PID
journalctl -u <unit> -b --no-pager | tail -60      # this boot; -f to follow; --since "1 hour ago"
journalctl -p err -b --no-pager | tail -40         # every error this boot
systemctl cat <unit>                               # the unit file and its overrides
systemctl show <unit> -p ExecStart,User,WorkingDirectory,Restart,NRestarts
```

Common causes: the config file has an error (validate it: `nginx -t`, `apachectl configtest`, `sshd -t`, the
app's own check), the port is taken (`ss -tlpn | grep :<port>`), a file or folder it needs is missing or has the
wrong owner (`namei -l <path>`), a dependency is not up (`systemctl list-dependencies <unit>`), or it runs out of
memory.

Changing a unit: use `sudo systemctl edit <unit>` (an override; the package's file stays untouched), then
`sudo systemctl daemon-reload` and `sudo systemctl restart <unit>`; check `status` afterwards. Enable at boot:
`systemctl enable --now <unit>`.

Other logs: `/var/log/syslog` or `/var/log/messages`, `/var/log/auth.log` or `/var/log/secure`, the app's own
folder under `/var/log`. Search: `grep -iE 'error|fail|denied' <file> | tail -40`.

## Windows (PowerShell)

```powershell
Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } | Format-Table Name, DisplayName, Status
Get-Service <name> | Format-List *
Get-CimInstance Win32_Service -Filter "Name='<name>'" | Format-List Name, State, StartMode, StartName, PathName, ExitCode
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Service Control Manager'; StartTime=(Get-Date).AddDays(-1)} -MaxEvents 30 | Format-Table TimeCreated, Id, Message -Wrap
Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2; StartTime=(Get-Date).AddDays(-1)} -MaxEvents 30 | Format-Table TimeCreated, ProviderName, Message -Wrap
```

Restart (ask first): `Restart-Service <name>`; in an elevated shell for system services. Event IDs worth knowing:
7000/7009/7011 (service failed to start or timed out), 7031/7034 (crashed), 1000 (application crash), 41 (unexpected
reboot), 6008 (dirty shutdown).

## macOS

```sh
launchctl list | grep -v '^-' | head      # loaded jobs; a non-zero status column = last exit code
log show --last 1h --predicate 'eventMessage CONTAINS[c] "error"' --style compact | tail -40
```

## Report

The service, its state, the log lines that explain the failure (quoted), the cause, the fix applied or proposed,
and whether it stays up afterwards (check again after a minute).
