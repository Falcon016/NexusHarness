# Network problems

Work up the layers and stop at the first one that fails: link → address → gateway → DNS → route to the host →
the port → the application. Write down each result.

## Linux

```sh
ip -br link; ip -br addr                 # link UP? an address on the right subnet?
ip route                                 # a default route via the gateway?
ping -c 3 <gateway>                      # local network
ping -c 3 1.1.1.1                        # internet by IP (no DNS involved)
resolvectl status 2>/dev/null || cat /etc/resolv.conf     # which DNS servers
dig +short example.com; dig +short example.com @1.1.1.1   # works with a public resolver but not yours = DNS problem
tracepath -n example.com                 # where the path stops (or traceroute -n)
nc -vz -w 3 <host> <port>                # is the port reachable? (or: curl -v telnet://host:port)
curl -sv -o /dev/null https://<host>/    # TLS and HTTP: certificate errors, redirects, status
ss -tulpn                                # what listens locally, and on which address (127.0.0.1 = local only)
sudo nft list ruleset | head -50; sudo iptables -S | head -50; sudo ufw status verbose   # local firewall
```

- Listening only on `127.0.0.1`: the service is not reachable from other machines; change its bind address.
- Port open locally but not from outside: firewall (host, router, cloud security group) or NAT/port forward.
- Name resolves to an unexpected address: check `/etc/hosts`, then the DNS server (Pi-hole, router).
- Wi-Fi: `nmcli dev wifi list`, `nmcli dev status`, `journalctl -u NetworkManager -b --no-pager | tail -30`.

## Windows (PowerShell)

```powershell
Get-NetAdapter | Format-Table Name, Status, LinkSpeed
Get-NetIPConfiguration
Test-NetConnection 1.1.1.1
Resolve-DnsName example.com; Resolve-DnsName example.com -Server 1.1.1.1
Test-NetConnection <host> -Port <port>    # TcpTestSucceeded
Test-NetConnection example.com -TraceRoute
Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Format-Table LocalAddress, LocalPort, OwningProcess
Get-NetFirewallProfile | Format-Table Name, Enabled, DefaultInboundAction
```

Fixes to suggest (ask first): `ipconfig /flushdns`; `ipconfig /release` then `/renew`; resetting the adapter
(`Restart-NetAdapter -Name <name>`). `netsh winsock reset` needs a reboot; keep it for last.

## macOS

```sh
ifconfig | grep -A3 '^en'; netstat -rn | head
scutil --dns | head -30
ping -c 3 1.1.1.1; dig +short example.com
nc -vz -w 3 <host> <port>
```

## Report

The layer that failed, the evidence (the command and its output), the cause if found, and the fix or the next
person to involve (ISP, router admin, the service owner).
