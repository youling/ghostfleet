# Fleet managed-windows read-only preflight v0.1.0
# Repo-only canonical surface. Read-only detection: no install, enable, start,
# firewall, WinRM, Tailscale, or registry mutation. Reports public host-key
# fingerprints only (*.pub + ssh-keygen -lf); never reads private key material.
# Live execution (separate Work Order only) requires a pinned Windows OpenSSH
# fingerprint and Human authorization over a verified SSH path with
# StrictHostKeyChecking=yes. This Work Order performs no real Windows contact.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-os.ps1')

function Write-PreflightJson([Parameter(Mandatory = $true)][object]$Report) {
    $Report | ConvertTo-Json -Depth 4
}

$report = [ordered]@{
    preflight = 'managed-windows-preflight'
    version = '0.1.0'
    readonly = $true
}

# SECTION: os_build
$osBuild = $null
try {
    $osBuild = Get-FleetWindowsOs
} catch {
    $osBuild = [ordered]@{ error = $_.Exception.Message }
}
$report['osBuild'] = $osBuild

# SECTION: openssh_capability_service
$openSshCapability = $null
try {
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction Stop
    $openSshCapability = $cap | Select-Object Name, State
} catch {
    $openSshCapability = [ordered]@{ error = $_.Exception.Message }
}
$sshdService = $null
try {
    $svc = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        $sshdService = [ordered]@{ exists = $false }
    } else {
        $sshdService = [ordered]@{
            exists = $true
            status = "$($svc.Status)"
            startType = "$($svc.StartType)"
        }
    }
} catch {
    $sshdService = [ordered]@{ error = $_.Exception.Message }
}
$sshAgentService = $null
try {
    $agent = Get-Service -Name 'ssh-agent' -ErrorAction SilentlyContinue
    if ($null -eq $agent) {
        $sshAgentService = [ordered]@{ exists = $false }
    } else {
        $sshAgentService = [ordered]@{
            exists = $true
            status = "$($agent.Status)"
            startType = "$($agent.StartType)"
        }
    }
} catch {
    $sshAgentService = [ordered]@{ error = $_.Exception.Message }
}
$defaultShell = $null
try {
    $prop = Get-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name 'DefaultShell' -ErrorAction SilentlyContinue
    if ($null -eq $prop) {
        $defaultShell = [ordered]@{ exists = $false }
    } else {
        $defaultShell = [ordered]@{ exists = $true; value = $prop.DefaultShell }
    }
} catch {
    $defaultShell = [ordered]@{ error = $_.Exception.Message }
}
$report['openSsh'] = [ordered]@{
    capability = $openSshCapability
    sshd = $sshdService
    sshAgent = $sshAgentService
    defaultShell = $defaultShell
}

# SECTION: tailscale_presence
# Presence only: service + install path. Never login/up/down/status (topology).
$tailscaleService = $null
try {
    $ts = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
    if ($null -eq $ts) {
        $tailscaleService = [ordered]@{ exists = $false }
    } else {
        $tailscaleService = [ordered]@{
            exists = $true
            status = "$($ts.Status)"
            startType = "$($ts.StartType)"
        }
    }
} catch {
    $tailscaleService = [ordered]@{ error = $_.Exception.Message }
}
$tailscaleExe = $null
try {
    $exePath = Join-Path -Path $Env:ProgramFiles -ChildPath 'Tailscale\tailscale.exe'
    $tailscaleExe = [ordered]@{
        pathExists = (Test-Path -Path $exePath)
    }
    $cmd = Get-Command -Name 'tailscale' -ErrorAction SilentlyContinue
    $tailscaleExe['onPath'] = ($null -ne $cmd)
} catch {
    $tailscaleExe = [ordered]@{ error = $_.Exception.Message }
}
$report['tailscale'] = [ordered]@{
    service = $tailscaleService
    install = $tailscaleExe
    note = 'presence only; no login/up/down/status'
}

# SECTION: winrm_observation
# Observation only: service state + typed config observation. Never quickconfig or raw output.
$winrmService = $null
try {
    $wr = Get-Service -Name 'WinRM' -ErrorAction SilentlyContinue
    if ($null -eq $wr) {
        $winrmService = [ordered]@{ exists = $false }
    } else {
        $winrmService = [ordered]@{
            exists = $true
            status = "$($wr.Status)"
            startType = "$($wr.StartType)"
        }
    }
} catch {
    $winrmService = [ordered]@{ exists = $null; status = "UNKNOWN" }
}
$winrmObservation = [ordered]@{ status = "UNKNOWN"; observed = $null }
try {
    $null = & winrm get winrm/config 2>&1
    $exit = $LASTEXITCODE
    if ($exit -eq 0) {
        $winrmObservation.status = "OBSERVED"
        $winrmObservation.observed = $true
    } elseif ($null -ne $exit) {
        $winrmObservation.status = "NOT_OBSERVED"
        $winrmObservation.observed = $false
    }
} catch {
    $winrmObservation.status = "UNKNOWN"
    $winrmObservation.observed = $null
}
$report['winrm'] = [ordered]@{
    service = $winrmService
    observation = $winrmObservation
    note = 'observation only; WinRM is not required in v1'
}

# SECTION: firewall_openssh_summary
# Presence/scope summary only: rule metadata + scoped boolean, no raw addresses.
$firewallSummary = @()
try {
    $rules = Get-NetFirewallRule -DisplayName '*OpenSSH*' -ErrorAction SilentlyContinue
    foreach ($rule in $rules) {
        $portFilter = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
        $addrFilter = $rule | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
        $remote = @()
        if ($null -ne $addrFilter) { $remote = @($addrFilter.RemoteAddress) }
        $isScoped = $true
        if ($remote.Count -eq 0) { $isScoped = $false }
        elseif ($remote.Count -eq 1 -and ($remote[0] -eq 'Any')) { $isScoped = $false }
        $firewallSummary += [ordered]@{
            name = $rule.Name
            displayName = $rule.DisplayName
            enabled = "$($rule.Enabled)"
            direction = "$($rule.Direction)"
            action = "$($rule.Action)"
            profiles = "$($rule.Profiles)"
            localPort = @($portFilter.LocalPort)
            remoteScoped = $isScoped
        }
    }
} catch {
    $firewallSummary = @([ordered]@{ error = $_.Exception.Message })
}
$report['firewallOpenSsh'] = $firewallSummary

# SECTION: host_key_fingerprints
# Public fingerprints only: *.pub files + ssh-keygen -lf. Bounded fingerprint
# plus typed status/keyType; raw comment text and raw exception output are
# never persisted.
$fingerprints = @()
try {
    $pubDir = Join-Path -Path $Env:ProgramData -ChildPath 'ssh'
    $pubFiles = Get-ChildItem -Path (Join-Path -Path $pubDir -ChildPath 'ssh_host_*.pub') -ErrorAction SilentlyContinue
    foreach ($pub in $pubFiles) {
        $entry = [ordered]@{ file = $pub.Name; fingerprint = $null; keyType = $null; status = "UNKNOWN" }
        try {
            $raw = & ssh-keygen -lf $pub.FullName 2>&1
            $exit = $LASTEXITCODE
            $rawText = "$raw".Trim()
            if ($exit -eq 0 -and $rawText -match '(SHA256:[A-Za-z0-9+/=]+|MD5:[0-9a-fA-F:]+)') {
                $entry.fingerprint = $Matches[1]
                $entry.status = "OK"
                if ($rawText -match '\(([^)]+)\)\s*$') {
                    $candidate = $Matches[1].Trim()
                    if ($candidate -match '^(ED25519|RSA|DSA|ECDSA|ED25519-CERT|RSA-CERT|ECDSA-CERT|DSA-CERT)$') {
                        $entry.keyType = $candidate
                    } else {
                        $entry.keyType = "UNKNOWN"
                    }
                }
            } else {
                $entry.status = "FINGERPRINT_UNAVAILABLE"
            }
        } catch {
            $entry.status = "FINGERPRINT_ERROR"
        }
        $fingerprints += $entry
    }
} catch {
    $fingerprints = @([ordered]@{ file = $null; fingerprint = $null; keyType = $null; status = "FINGERPRINT_ENUMERATION_FAILED" })
}
$report['hostKeyFingerprints'] = $fingerprints

Write-PreflightJson -Report ([PSCustomObject]$report)
