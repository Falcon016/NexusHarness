# Security check-up

A read-only review of one machine. Report findings with a severity; change nothing unless the user asks.

## What to check (Linux)

```sh
# Exposure: what listens, and on which addresses (0.0.0.0 / :: = every interface)
sudo ss -tulpn
# Firewall
sudo ufw status verbose 2>/dev/null; sudo firewall-cmd --list-all 2>/dev/null; sudo nft list ruleset 2>/dev/null | head -40
# SSH
sudo sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|port|maxauthtries) '
# Logins
sudo grep -cE 'Failed password|Invalid user' /var/log/auth.log /var/log/secure 2>/dev/null
last -n 15
# Accounts: uid 0 besides root, empty passwords, sudoers
awk -F: '$3==0{print $1}' /etc/passwd
sudo awk -F: '$2==""{print $1}' /etc/shadow
# Updates pending (see updates.md), unattended upgrades on?
# World-writable files in system paths, SUID binaries that are unusual
sudo find /etc /usr/local -xdev -type f -perm -0002 2>/dev/null | head
sudo find / -xdev -perm -4000 -type f 2>/dev/null | grep -vE '^/(usr/)?(s?bin|lib)' | head
# Intrusion signs: unknown cron jobs, startup units, keys
sudo ls -la /etc/cron.* /var/spool/cron/crontabs 2>/dev/null; systemctl list-unit-files --state=enabled --no-pager | head -60
```

If Wazuh, CrowdSec, fail2ban or an EDR agent is installed, check it is running (`systemctl status wazuh-agent`
and so on) and look at its recent alerts.

## Windows

```powershell
Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Format-Table LocalAddress, LocalPort, OwningProcess
Get-NetFirewallProfile | Format-Table Name, Enabled, DefaultInboundAction, DefaultOutboundAction
Get-MpComputerStatus | Format-List AMServiceEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated, QuickScanEndTime
Get-LocalGroupMember Administrators
Get-LocalUser | Where-Object Enabled | Format-Table Name, PasswordRequired, PasswordLastSet, LastLogon
Get-BitLockerVolume -ErrorAction SilentlyContinue | Format-Table MountPoint, ProtectionStatus
Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 3
Get-CimInstance Win32_StartupCommand | Format-Table Name, Command
Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' -and $_.State -ne 'Disabled' } | Format-Table TaskName, TaskPath
```

## Severity

- **High:** a remote login with a password exposed to the internet, root login over SSH, no firewall on a public
  host, an unknown admin account, antivirus off, months of missing security updates, signs of compromise.
- **Medium:** services listening on all interfaces that only need localhost, no disk encryption on a laptop,
  stale accounts, SMBv1 or other old protocols enabled.
- **Low:** hygiene: unused packages, verbose banners, missing log rotation.

## Report

Findings by severity, each with the evidence and the fix. Hand off to the `security-review` skill for code.
