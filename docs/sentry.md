# Sentry mode

`/sentry` turns the agent into a defender for the machine it runs on and your LAN. Sentry watches for the changes an intruder makes, raises the alarm, has a sentry agent look into them, and puts up narrow, reversible **shields**. The idea comes from Shirudo (OpenAI and Cisco's eBPF shields): agents do the legwork, people keep the keys, protections are temporary and reversible, and every change goes on a record that shows tampering. Sentry needs no special kernel.

Sentry is off until you turn it on, and it only runs while the harness is open. It watches Linux machines.

## Turning it on

```
/sentry             turn it on (or off, when it is on)
/sentry status      open findings, shields up, last and next sweep, ledger check
/sentry sweep       look now instead of waiting for the next sweep
/sentry shields     the shields that are up
/sentry lift <id>   take a shield down
/sentry accept <id|all>   make a change the new normal
/sentry dismiss <id>      stop showing a finding (it is still a change from the baseline)
/sentry ledger      check the signed record and show its latest entries
/sentry rebaseline  everything as it is now becomes normal
```

The footer shows `sentry` while it is on, or `sentry 3 open` when findings are waiting. The web dashboard's side panel has a **Sentry** card that can turn it on and off, sweep, accept or dismiss findings, and lift shields.

The first time you turn it on, sentry takes a **baseline**, a record of what normal looks like. After that it sweeps every `intervalMinutes` (10 by default) and compares.

## What it watches

| Check               | What counts as a change                                            | Severity                               |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Accounts            | a new account that can log in                                      | high; **critical** for a second uid 0  |
| Admin groups        | someone added to sudo, wheel, adm, docker, lxd or libvirt          | high                                   |
| SSH login keys      | a new key in any `authorized_keys` you can read                    | high                                   |
| SSH server settings | `PermitRootLogin`, `PasswordAuthentication` and friends changed    | high when it opens a door, else medium |
| Setuid programs     | a new setuid/setgid program in the usual program folders           | high                                   |
| Listening ports     | something new listening on the network                             | medium; low on localhost only          |
| Scheduled jobs      | new or changed cron jobs and systemd timers                        | medium                                 |
| Login startup       | new or changed autostart entries, user services, `~/.bashrc`       | medium                                 |
| Services            | a new service enabled at boot                                      | medium                                 |
| Firewall            | the rule set changed (needs passwordless `sudo nft`)               | medium                                 |
| Kernel modules      | a new module loaded                                                | low                                    |
| LAN devices         | a device never seen before on your networks                        | low                                    |
| Failed SSH logins   | many failures from one address in one sweep (`loginThreshold`, 10) | high, judged fresh each sweep          |

Every check is read-only and needs no root. A check that can't run on a machine (a missing tool, or no permission) is listed as "not watched here" and left out, rather than reported as a change. Devices that leave, modules that unload and ports that close aren't reported, because an ordinary day is full of them.

**LAN:** sentry looks for devices only on private networks: the ones this machine is on, or those in `sentry.networks`. It reads the neighbour table and, if `nmap` is installed, runs a ping sweep (`nmap -sn`), which is discovery only with no port scan. It refuses public ranges and anything larger than a /22.

**Failed logins:** these are read from the journal or `/var/log/auth.log`. Your user needs to be in the `adm` or `systemd-journal` group to read them.

## The sentry agent

When a sweep finds something of medium severity or worse, a separate sentry agent looks into it. It waits until the main agent is free, so it doesn't compete with your work for the model. It runs read-only commands only; anything that would change the system is refused, except a shield. It decides what's expected, suspicious or malicious, protects where it must, and its report appears as a notice and next to the findings. It treats log lines, file contents and process or user names as data an attacker could have written, never as instructions.

## Shields

| Shield            | What it does                                                             | Undo                   | Automatic               |
| ----------------- | ------------------------------------------------------------------------ | ---------------------- | ----------------------- |
| `block-ip`        | drops traffic to and from one IPv4 address, for a time                   | lift, or it expires    | for an outside address  |
| `quarantine-file` | moves a file into sentry's quarantine with its hash, permissions removed | puts it back as it was | for a file you can move |
| `quarantine-key`  | takes an SSH key out of your `authorized_keys`, kept aside               | puts it back           | no, asks                |
| `stop-service`    | stops and disables one service                                           | enables and starts it  | no, asks                |
| `kill-process`    | stops one process                                                        | cannot be undone       | no, asks                |
| `lock-account`    | locks and expires one account (stops SSH key logins too)                 | unlocks it             | no, asks                |

- **Automatic shields.** Blocking an outside address and quarantining a file you can move go ahead without asking (`sentry.autoShields`), and you're told at once. Sentry blocks an outside address that's guessing SSH passwords for `blockMinutes` (60). Every other shield, and lifting any shield, asks you every time, in every approval mode, with no "don't ask again".
- **Never:** blocking this machine, a model server or a mesh node; moving system programs or files like `/etc/passwd`; stopping services that keep the machine running or reachable (ssh, systemd, networking, the firewall); locking root or yourself; deleting anything.
- **Address blocks** go into sentry's own nftables table, `inet nexus_sentry`, with a timeout, so the kernel removes them on time even if the harness is closed. Sentry never touches your other rules.

**sudo.** Shields that need root run `sudo -n`, which never waits for a password. If sudo would ask, the shield fails and tells you the exact command to run yourself. For automatic address blocks to work, give your user passwordless sudo for `nft` only:

```
# /etc/sudoers.d/nexus-sentry  (edit with: sudo visudo -f /etc/sudoers.d/nexus-sentry)
youruser ALL=(root) NOPASSWD: /usr/sbin/nft
```

## The ledger

Every baseline, accepted change, shield raised, lifted, expired or failed goes on `ledger.jsonl` in sentry's folder. Each entry carries an HMAC-SHA256 over itself and the entry before it, made with a key only your user can read. An edited, removed or reordered entry breaks the chain, and `/sentry ledger` and `/sentry status` say where. Root on the machine could rewrite the whole thing, so the ledger shows tampering; it can't prevent it.

## Alerts

- **Terminal:** a notice. High and critical findings show in red, medium in amber.
- **Dashboard:** the Sentry card.
- **Telegram:** when your bot is set up (`nexus telegram`, with `telegram.allowedUsers`), alerts of medium and above, shields and reports also go to the bot's users. Set `sentry.telegram: false` to keep them off your phone.

## Settings

| Setting                  | Default                           | What it does                                                              |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `sentry.intervalMinutes` | `10`                              | Minutes between sweeps                                                    |
| `sentry.networks`        | `[]`                              | Private networks to watch for devices; empty: the ones this machine is on |
| `sentry.autoShields`     | `["block-ip", "quarantine-file"]` | Shields that go ahead without asking; `[]` makes every shield ask         |
| `sentry.blockMinutes`    | `60`                              | How long an automatic address block lasts                                 |
| `sentry.loginThreshold`  | `10`                              | Failed SSH logins from one address in one sweep that count as an attack   |
| `sentry.investigate`     | `true`                            | Have the sentry agent look into medium and worse findings                 |
| `sentry.telegram`        | `true`                            | Also send alerts to your Telegram bot, when it is set up                  |

Sentry keeps its baseline, findings, shields, quarantine and ledger in `sentry/` under the harness's data folder, with owner-only permissions. They stay there when sentry is off. Shields stay up when you turn sentry off too: `/sentry shields` lists them.

## Limits

- It sees what your user can see. Without root it can't read other users' `authorized_keys`, root's crontab or the firewall rules (unless you give passwordless `sudo nft`).
- An intruder who already has root can hide from any tool running on the same machine, including this one. Sentry is a tripwire and a first responder, not a guarantee. Keep systems patched, and consider an off-machine monitor (Wazuh, for example) alongside it.
- With the `container` sandbox, the agent's commands see the container, not the machine; sentry says so when it turns on. Use the `guard` sandbox with sentry.
