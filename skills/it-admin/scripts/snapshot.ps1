# Read-only health snapshot of this Windows machine, for the it-admin skill.
# Changes nothing. Works in Windows PowerShell 5.1 and PowerShell 7. Sections that need an elevated shell say so.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Section($name) { Write-Output ''; Write-Output "== $name ==" }
function Try-Section($name, [scriptblock]$body) {
  Section $name
  try { & $body | Out-String -Width 160 -Stream | Where-Object { $_.Trim() } }
  catch { Write-Output "(could not read: $($_.Exception.Message.Split([Environment]::NewLine)[0]))" }
}
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
  Write-Output 'This snapshot is for Windows. On Linux or macOS run snapshot.sh instead.'
  exit 1
}
try {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { $admin = $false }

Try-Section 'Machine' {
  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
  "host: $env:COMPUTERNAME  user: $env:USERNAME  elevated: $admin"
  "os: $($os.Caption) $($os.Version) ($($os.OSArchitecture))"
  "model: $($cs.Manufacturer) $($cs.Model)"
  "last boot: $($os.LastBootUpTime)  (up $([int]((Get-Date) - $os.LastBootUpTime).TotalHours) h)"
}

Try-Section 'CPU and memory' {
  $os = Get-CimInstance Win32_OperatingSystem
  $cpu = Get-CimInstance Win32_Processor
  "cpu: $(($cpu | Select-Object -First 1).Name.Trim())  logical cores: $(($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum)  load: $(($cpu | Measure-Object LoadPercentage -Average).Average)%"
  "memory: $([math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 1)) GB used of $([math]::Round($os.TotalVisibleMemorySize / 1MB, 1)) GB"
  $pf = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue
  if ($pf) { "page file: $(($pf | Measure-Object CurrentUsage -Sum).Sum) MB used of $(($pf | Measure-Object AllocatedBaseSize -Sum).Sum) MB" }
}

Try-Section 'Busiest processes (CPU seconds since start)' {
  Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Id, ProcessName,
    @{ n = 'CPU(s)'; e = { [math]::Round($_.CPU, 0) } }, @{ n = 'MemMB'; e = { [math]::Round($_.WorkingSet64 / 1MB) } } | Format-Table -AutoSize
}

Try-Section 'Largest processes (memory)' {
  Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 Id, ProcessName,
    @{ n = 'MemMB'; e = { [math]::Round($_.WorkingSet64 / 1MB) } } | Format-Table -AutoSize
}

Try-Section 'Disks' {
  Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, VolumeName,
    @{ n = 'SizeGB'; e = { [math]::Round($_.Size / 1GB, 1) } }, @{ n = 'FreeGB'; e = { [math]::Round($_.FreeSpace / 1GB, 1) } },
    @{ n = 'Free%'; e = { if ($_.Size) { [math]::Round(100 * $_.FreeSpace / $_.Size) } } } | Format-Table -AutoSize
}

Try-Section 'Listening ports' {
  $procs = @{}; Get-Process | ForEach-Object { $procs[$_.Id] = $_.ProcessName }
  Get-NetTCPConnection -State Listen | Sort-Object LocalPort -Unique | Select-Object -First 30 LocalAddress, LocalPort,
    @{ n = 'Process'; e = { $procs[[int]$_.OwningProcess] } } | Format-Table -AutoSize
}

Try-Section 'Network' {
  Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' } | ForEach-Object {
    "$($_.InterfaceAlias): $(($_.IPv4Address | ForEach-Object IPAddress) -join ', ')  gateway: $(($_.IPv4DefaultGateway | ForEach-Object NextHop) -join ', ')  dns: $(($_.DNSServer | Where-Object AddressFamily -eq 2 | ForEach-Object ServerAddresses) -join ', ')"
  }
}

Try-Section 'Automatic services that are not running' {
  $s = Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'" |
    Where-Object { $_.Name -notmatch '^(sppsvc|RemoteRegistry|edgeupdate|gupdate|MapsBroker|tiledatamodelsvc|WbioSrvc)' }
  if ($s) { $s | Select-Object Name, DisplayName, State, ExitCode | Format-Table -AutoSize } else { 'none' }
}

Try-Section 'Errors in the System log (last 24 h)' {
  $since = (Get-Date).AddDays(-1)
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2; StartTime = $since } -MaxEvents 15 -ErrorAction SilentlyContinue
  if ($ev) { $ev | Select-Object TimeCreated, Id, ProviderName, @{ n = 'Message'; e = { ($_.Message -split "`n")[0].Trim() } } | Format-Table -AutoSize -Wrap } else { 'none' }
}

Try-Section 'Updates' {
  Get-HotFix | Sort-Object InstalledOn -Descending -ErrorAction SilentlyContinue | Select-Object -First 3 HotFixID, Description, InstalledOn | Format-Table -AutoSize
  $reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
            (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
  "reboot pending: $reboot"
}

Try-Section 'Security' {
  $fw = Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$(if ($_.Enabled) { 'on' } else { 'OFF' })" }
  "firewall: $($fw -join ', ')"
  $mp = Get-MpComputerStatus -ErrorAction SilentlyContinue
  if ($mp) { "defender: real-time $(if ($mp.RealTimeProtectionEnabled) { 'on' } else { 'OFF' }), signatures from $($mp.AntivirusSignatureLastUpdated)" }
  else { 'defender: status not available (another antivirus, or not readable)' }
  "administrators: $((Get-LocalGroupMember -Group Administrators -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', ')"
  if ($admin) {
    $bl = Get-BitLockerVolume -ErrorAction SilentlyContinue
    if ($bl) { "bitlocker: $(($bl | ForEach-Object { "$($_.MountPoint) $($_.ProtectionStatus)" }) -join ', ')" }
  } else { 'bitlocker: needs an elevated shell' }
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
  Try-Section 'Docker' {
    $out = docker ps -a --format '{{.Names}}  {{.Status}}  {{.Image}}' 2>$null
    if ($LASTEXITCODE -ne 0) { '(Docker is installed but its engine is not reachable)' } elseif ($out) { $out } else { 'no containers' }
  }
}
