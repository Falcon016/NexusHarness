# Users, groups and access

Access changes are security changes: confirm the exact account and permission with the user before any change,
and prefer the narrowest access that does the job.

## Linux

```sh
id <user>; groups <user>
getent passwd <user>; getent group sudo wheel docker
sudo chage -l <user>                     # password age and expiry
last -n 20; lastb -n 20 2>/dev/null      # recent logins; failed logins (root)
sudo grep -E '^[^#].*ALL' /etc/sudoers /etc/sudoers.d/* 2>/dev/null   # who can sudo
ls -la ~<user>/.ssh; cat ~<user>/.ssh/authorized_keys                 # whose keys can log in as them
```

Changes (ask first, then verify with `id` / a test login):

- Add a user: `sudo adduser <user>` (Debian) or `sudo useradd -m -s /bin/bash <user> && sudo passwd <user>`.
- Add to a group: `sudo usermod -aG <group> <user>` (the `-a` matters: without it, other groups are removed). The
  user must log in again.
- sudo rights: a file in `/etc/sudoers.d/` edited with `sudo visudo -f /etc/sudoers.d/<name>`, never by
  `echo >>`; a syntax error there can lock everyone out.
- Lock an account: `sudo usermod -L <user>` and `sudo chage -E 0 <user>`; remove later with `userdel -r` only once
  their files are dealt with.
- SSH keys: append the user's _public_ key to `~/.ssh/authorized_keys` (mode 600, folder 700, owned by the user).
  Never handle private keys.
- `docker` group membership is root-equivalent; say so before adding anyone.

## Windows (PowerShell, elevated for changes)

```powershell
Get-LocalUser | Format-Table Name, Enabled, LastLogon, PasswordExpires
Get-LocalGroupMember Administrators
whoami /groups
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625; StartTime=(Get-Date).AddDays(-1)} -MaxEvents 20   # failed logons (admin)
```

Changes: `New-LocalUser`, `Add-LocalGroupMember -Group <group> -Member <user>`, `Disable-LocalUser <user>`. In a
domain, use the AD tools (`Get-ADUser`, `Add-ADGroupMember`) and the organisation's process.

## Report

Who has which access now, what changed (with the command used and how to undo it), and anything risky you saw:
accounts without passwords, unknown admins, stale accounts, keys nobody can explain.
