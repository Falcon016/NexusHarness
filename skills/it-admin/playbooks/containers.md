# Docker, Proxmox VMs and LXC

## Docker

```sh
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail 80 <container>                # why it exited or keeps restarting
docker inspect <container> --format '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}'
docker stats --no-stream                         # CPU and memory per container
docker system df                                 # disk used by images, containers, volumes, build cache
docker compose ps; docker compose logs --tail 50 <service>   # in the compose project folder
```

- Exit code 137 with `OOMKilled=true`: raise the memory limit or fix the leak. 137 without it: killed from
  outside. 1 or another code: read the logs.
- Restart loop: check the logs from the first failure (`docker logs --since 10m`), environment variables and
  mounted files (`docker inspect` → Mounts).
- Update a compose stack: `docker compose pull && docker compose up -d`; roll back by pinning the previous image
  tag in the compose file.
- Data lives in volumes or bind mounts; `docker compose down -v` deletes volumes. Never use it without asking.

## Proxmox VE (on the host, as root)

```sh
pveversion; pvecm status 2>/dev/null           # version, cluster quorum
qm list; pct list                              # VMs and LXC containers
qm status <vmid> --verbose | head; pct status <ctid>
qm config <vmid>; pct config <ctid>
pvesm status                                    # storage usage
journalctl -u pve-cluster -u pvedaemon -u pveproxy -b --no-pager | tail -40
tail -n 50 /var/log/pve/tasks/active; ls -t /var/log/pve/tasks/*/* | head   # recent task logs
```

- Start, stop, shut down: `qm start|shutdown|stop <vmid>`, `pct start|shutdown|stop <ctid>` (ask first;
  `shutdown` before `stop`).
- Snapshots before risky changes: `qm snapshot <vmid> pre-change` / `pct snapshot <ctid> pre-change`; roll back
  with `qm rollback` / `pct rollback` (ask first: it discards changes since).
- Run a command inside an LXC: `pct exec <ctid> -- <command>`; enter it: `pct enter <ctid>`.
- LXC resource limits: `pct set <ctid> -memory 4096 -cores 2` (ask first). GPU or device passthrough into LXC is
  done in `/etc/pve/lxc/<ctid>.conf`; back it up before editing.
- Storage full on `local-lvm`: `lvs` for thin pool data and metadata use; remove old snapshots and backups there.

## Report

The state of each container or guest involved, the cause found in its logs, and what you changed (with how to
undo it).
