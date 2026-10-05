[CmdletBinding()]
param(
    [switch]$Apply,
    [Parameter(Mandatory=$true)][ValidatePattern('^node-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')][string]$NodeUid,
    [string]$AuthorizedKeyPath,
    [string]$ManagementSourceScope,
    [string]$TunnelTokenPath,
    [string]$TunnelId,
    [string]$CloudflaredExePath,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$CloudflaredSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$EnrollScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'enrollment\managed-windows-enroll.ps1'
$MinimumPowerShellVersion = [version]'7.6.6'
$DesiredShell = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
$LegacyFleetShell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$CloudflaredInstall = 'C:\Cloudflared\bin\cloudflared.exe'
$CommonData = [Environment]::GetFolderPath('CommonApplicationData')
if ([string]::IsNullOrWhiteSpace($CommonData)) { throw 'COMMON_APP_DATA_UNAVAILABLE' }
$StateDir = Join-Path $CommonData 'GhostFleet\Control'
$StatePath = Join-Path $StateDir 'state.json'
$BootstrapCheckpointPath = Join-Path $StateDir 'bootstrap-checkpoint.json'

function Test-IsAdministrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = [Security.Principal.WindowsPrincipal]::new($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-DefaultShell {
    try {
        return (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction Stop).DefaultShell
    } catch { return $null }
}
function Get-PowerShell7State {
    if (-not (Test-Path -LiteralPath $DesiredShell -PathType Leaf)) {
        return [ordered]@{ present = $false; version = $null; compliant = $false }
    }
    try {
        $raw = (& $DesiredShell -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()' 2>$null | Out-String).Trim()
        $version = $null
        if (-not [version]::TryParse($raw, [ref]$version)) { throw 'PWSH7_VERSION_UNREADABLE' }
        return [ordered]@{ present = $true; version = $version.ToString(); compliant = $version -ge $MinimumPowerShellVersion }
    } catch {
        if ($_.Exception.Message -eq 'PWSH7_VERSION_UNREADABLE') { throw }
        throw 'PWSH7_VERSION_UNREADABLE'
    }
}
function Get-ControlMarker {
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json }
    catch { throw 'CONTROL_MARKER_INVALID' }
}
function Get-CloudflaredService {
    return Get-CimInstance Win32_Service -Filter "Name='Cloudflared'" -ErrorAction SilentlyContinue
}
function Invoke-CloudflaredQuiet {
    param([Parameter(Mandatory=$true)][string[]]$Arguments)
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 can surface native stderr as ErrorRecord.
        # cloudflared writes informational install/uninstall lines to stderr,
        # so judge the native process only by its exit code here.
        $ErrorActionPreference = 'Continue'
        & $CloudflaredInstall @Arguments *> $null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}
function Get-BootstrapCheckpoint {
    if (-not (Test-Path -LiteralPath $BootstrapCheckpointPath -PathType Leaf)) { return $null }
    try {
        $c = Get-Content -LiteralPath $BootstrapCheckpointPath -Raw | ConvertFrom-Json -ErrorAction Stop
        if ([string]$c.owner -ne 'youling-fleet-ai-client-control' -or [string]$c.node_uid -ne $NodeUid -or [bool]$c.openssh_fresh_install -ne $true) {
            throw 'BOOTSTRAP_CHECKPOINT_CONFLICT'
        }
        return $c
    } catch {
        if ($_.Exception.Message -eq 'BOOTSTRAP_CHECKPOINT_CONFLICT') { throw }
        throw 'BOOTSTRAP_CHECKPOINT_INVALID'
    }
}
function Write-BootstrapCheckpoint {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    $checkpoint = [ordered]@{
        schema = 1
        owner = 'youling-fleet-ai-client-control'
        node_uid = $NodeUid
        openssh_fresh_install = $true
        created_utc = [DateTimeOffset]::UtcNow.ToString('o')
    }
    $checkpoint | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $BootstrapCheckpointPath -Encoding UTF8
}
function Clear-BootstrapCheckpoint {
    if (Test-Path -LiteralPath $BootstrapCheckpointPath -PathType Leaf) {
        Remove-Item -LiteralPath $BootstrapCheckpointPath -Force
    }
}
function Get-ExplicitOverlayLocalAddresses {
    $result = New-Object 'System.Collections.Generic.List[string]'
    $tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($null -eq $tailscale) { $tailscale = Get-Command tailscale -ErrorAction SilentlyContinue }
    if ($null -eq $tailscale) { return @() }

    foreach ($family in @('-4','-6')) {
        $value = (& $tailscale.Source ip $family 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) { continue }
        foreach ($line in ($value -split '\r?\n')) {
            $candidate = $line.Trim()
            $parsed = $null
            if ([System.Net.IPAddress]::TryParse($candidate, [ref]$parsed)) {
                if (-not $result.Contains($parsed.ToString())) { [void]$result.Add($parsed.ToString()) }
            }
        }
    }
    return @($result)
}

function Set-FleetServiceRecovery {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][string]$FailureCode
    )
    & sc.exe failure $Name reset= 86400 actions= 'restart/5000/restart/15000/restart/60000' *> $null
    if ($LASTEXITCODE -ne 0) { throw $FailureCode }
    & sc.exe failureflag $Name 1 *> $null
    if ($LASTEXITCODE -ne 0) { throw $FailureCode }
}

function Get-ControlStatus {
    $sshd = Get-Service -Name sshd -ErrorAction SilentlyContinue
    $service = Get-CloudflaredService
    $marker = Get-ControlMarker
    $shell = Get-DefaultShell
    $pwsh = Get-PowerShell7State
    $markerNode = if ($null -ne $marker) { [string]$marker.node_uid } else { $null }
    $markerTunnel = if ($null -ne $marker) { [string]$marker.tunnel_id } else { $null }
    $markerHostAlgorithm = if ($null -ne $marker) { [string]$marker.ssh_host_key_algorithm } else { $null }
    $markerHostFingerprint = if ($null -ne $marker) { [string]$marker.ssh_host_key_sha256 } else { $null }
    $servicePath = if ($null -ne $service) { [string]$service.PathName } else { $null }
    [ordered]@{
        node_uid = $NodeUid; apply = [bool]$Apply; elevated = Test-IsAdministrator
        sshd_present = $null -ne $sshd; sshd_status = if($sshd){[string]$sshd.Status}else{$null}
        powershell7_present = [bool]$pwsh.present; powershell7_version = $pwsh.version; powershell7_compliant = [bool]$pwsh.compliant
        default_shell = $shell; default_shell_ok = $shell -eq $DesiredShell
        cloudflared_binary_present = Test-Path -LiteralPath $CloudflaredInstall -PathType Leaf
        cloudflared_service_present = $null -ne $service
        cloudflared_service_state = if($service){[string]$service.State}else{$null}
        cloudflared_uses_token_file = $null -ne $servicePath -and $servicePath -match '--token-file'
        marker_present = $null -ne $marker; marker_node_uid = $markerNode; marker_tunnel_id = $markerTunnel
        marker_ssh_host_key_algorithm = $markerHostAlgorithm; marker_ssh_host_key_sha256 = $markerHostFingerprint
        marker_host_identity_present = ($markerHostAlgorithm -eq 'ecdsa-sha2-nistp256' -and $markerHostFingerprint -match '^SHA256:[A-Za-z0-9+/]+={0,2}$')
        marker_matches = $null -ne $marker -and $markerNode -eq $NodeUid -and ([string]::IsNullOrWhiteSpace($TunnelId) -or $markerTunnel -eq $TunnelId)
    }
}
function Assert-ApplyInputs {
    if (-not (Test-IsAdministrator)) { throw 'ELEVATION_REQUIRED' }
    if (-not (Test-Path -LiteralPath $EnrollScript -PathType Leaf)) { throw 'WINDOWS_ENROLL_SCRIPT_MISSING' }
    if ([string]::IsNullOrWhiteSpace($AuthorizedKeyPath) -or -not (Test-Path -LiteralPath $AuthorizedKeyPath -PathType Leaf)) { throw 'AUTHORIZED_KEY_REQUIRED' }
    if ([string]::IsNullOrWhiteSpace($ManagementSourceScope)) { throw 'MANAGEMENT_SOURCE_SCOPE_REQUIRED' }
    if ([string]::IsNullOrWhiteSpace($TunnelId)) { throw 'TUNNEL_ID_REQUIRED' }
}

if (-not $Apply) {
    [pscustomobject](Get-ControlStatus) | ConvertTo-Json -Depth 5
    exit 0
}
Assert-ApplyInputs
$existingMarker = Get-ControlMarker
if ($null -ne $existingMarker -and [string]$existingMarker.node_uid -ne $NodeUid) { throw 'CONTROL_MARKER_NODE_CONFLICT' }
# Reuse the accepted Managed Windows enrollment state machine; do not fork OpenSSH/firewall logic.
$bootstrapRaw = (& $EnrollScript -Apply -Stage Bootstrap | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_BOOTSTRAP_FAILED' }
try { $bootstrap = $bootstrapRaw | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'WINDOWS_BOOTSTRAP_REPORT_INVALID' }
$installResult = [string]$bootstrap.bootstrap.installResult
if ($installResult -notin @('installed','already_installed')) { throw 'WINDOWS_BOOTSTRAP_REPORT_UNEXPECTED' }
if ($null -eq $bootstrap.bootstrap.powershell7 -or [bool]$bootstrap.bootstrap.powershell7.compliant -ne $true) { throw 'WINDOWS_BOOTSTRAP_PWSH7_NOT_COMPLIANT' }
if ($installResult -eq 'installed') { Write-BootstrapCheckpoint }
$bootstrapCheckpoint = Get-BootstrapCheckpoint

# Windows OpenSSH capability installation may create a broad built-in port-22 rule.
# If this wrapper caused the fresh install, contain that known side effect before
# the accepted Activate stage runs its fail-closed exposure guard. If OpenSSH was
# already installed, an enabled built-in rule is foreign/pre-existing state and
# must be reviewed rather than silently changed.
$builtinRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($null -ne $builtinRule -and [string]$builtinRule.Enabled -eq 'True') {
    $ownedFreshInstall = ($installResult -eq 'installed') -or ($null -ne $bootstrapCheckpoint)
    if ($ownedFreshInstall) {
        Disable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction Stop
        $builtinRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction Stop
        if ([string]$builtinRule.Enabled -eq 'True') { throw 'OPENSSH_BUILTIN_FIREWALL_CONTAINMENT_FAILED' }
    } else {
        throw 'OPENSSH_BUILTIN_FIREWALL_RULE_CONFLICT'
    }
}

# Establish public SSH host identity before any service/firewall exposure.
$hostPub = Join-Path $env:ProgramData 'ssh\ssh_host_ecdsa_key.pub'
if (-not (Test-Path -LiteralPath $hostPub -PathType Leaf)) {
    $sshKeygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
    if (-not (Test-Path -LiteralPath $sshKeygen -PathType Leaf)) { throw 'SSH_KEYGEN_MISSING_AFTER_BOOTSTRAP' }
    & $sshKeygen -A | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'SSH_HOST_KEY_GENERATION_FAILED' }
}
if (-not (Test-Path -LiteralPath $hostPub -PathType Leaf)) { throw 'SUPPORTED_SSH_HOST_KEY_MISSING' }

$currentShell = Get-DefaultShell
if ($null -ne $currentShell -and $currentShell -notin @($DesiredShell,$LegacyFleetShell)) { throw 'DEFAULT_SHELL_CONFLICT' }
if ($currentShell -ne $DesiredShell) {
    New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
    New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $DesiredShell -PropertyType String -Force | Out-Null
}

$allowedExistingLocalAddresses = @(Get-ExplicitOverlayLocalAddresses)
$activateParams = @{
    Apply = $true
    Stage = 'Activate'
    AuthorizedKeyPath = $AuthorizedKeyPath
    ManagementSourceScope = $ManagementSourceScope
}
if ($allowedExistingLocalAddresses.Count -gt 0) {
    $activateParams['AllowedExistingLocalAddress'] = $allowedExistingLocalAddresses
}
$activateRaw = (& $EnrollScript @activateParams | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_ACTIVATE_FAILED' }
try { $activateReport = $activateRaw | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'WINDOWS_ACTIVATE_REPORT_INVALID' }
$ecdsaHostIdentity = @($activateReport.activate.hostKeyFingerprints | Where-Object {
    [string]$_.file -eq 'ssh_host_ecdsa_key.pub' -and
    [string]$_.status -eq 'OK' -and
    [string]$_.fingerprint -match '^SHA256:[A-Za-z0-9+/]+={0,2}$'
})
if ($ecdsaHostIdentity.Count -ne 1) { throw 'WINDOWS_ACTIVATE_HOST_IDENTITY_INVALID' }
$hostKeyAlgorithm = 'ecdsa-sha2-nistp256'
$hostKeyFingerprint = [string]$ecdsaHostIdentity[0].fingerprint

$service = Get-CloudflaredService
if ($null -ne $service -and $null -eq $existingMarker) { throw 'CLOUDFLARED_SERVICE_OWNERSHIP_CONFLICT' }
if ($null -eq $service) {
    if ([string]::IsNullOrWhiteSpace($TunnelTokenPath) -or -not (Test-Path -LiteralPath $TunnelTokenPath -PathType Leaf)) { throw 'TUNNEL_TOKEN_FILE_REQUIRED' }
    if ([string]::IsNullOrWhiteSpace($CloudflaredExePath) -or -not (Test-Path -LiteralPath $CloudflaredExePath -PathType Leaf)) { throw 'CLOUDFLARED_SOURCE_REQUIRED' }
    if ([string]::IsNullOrWhiteSpace($CloudflaredSha256)) { throw 'CLOUDFLARED_SHA256_REQUIRED' }
    $actualHash = (Get-FileHash -LiteralPath $CloudflaredExePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $CloudflaredSha256.ToLowerInvariant()) { throw 'CLOUDFLARED_SHA256_MISMATCH' }
    $versionText = (& $CloudflaredExePath --version 2>&1 | Out-String).Trim()
    if ($versionText -notmatch 'cloudflared version ([0-9]+)\.([0-9]+)\.([0-9]+)') { throw 'CLOUDFLARED_VERSION_UNREADABLE' }
    $version = [version]::new([int]$Matches[1],[int]$Matches[2],[int]$Matches[3])
    if ($version -lt [version]'2025.7.0') { throw 'CLOUDFLARED_TOO_OLD' }
    New-Item -ItemType Directory -Path (Split-Path $CloudflaredInstall -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $CloudflaredExePath -Destination $CloudflaredInstall -Force
    $token = (Get-Content -LiteralPath $TunnelTokenPath -Raw).Trim()
    if ($token.Length -lt 32 -or $token.Length -gt 4096 -or $token -match '\s') { throw 'TUNNEL_TOKEN_INVALID' }
    try {
        $installExit = Invoke-CloudflaredQuiet -Arguments @('service','install',$token)
        if ($installExit -ne 0) { throw 'CLOUDFLARED_SERVICE_INSTALL_FAILED' }
    } finally { $tokenForCheck = $token; $token = $null }
    $service = Get-CloudflaredService
    if ($null -eq $service) { throw 'CLOUDFLARED_SERVICE_MISSING_AFTER_INSTALL' }
    $servicePath = [string]$service.PathName
    if ($servicePath -notmatch '--token-file' -or $servicePath.Contains($tokenForCheck)) {
        $uninstallExit = Invoke-CloudflaredQuiet -Arguments @('service','uninstall')
        if ($uninstallExit -ne 0) { throw 'CLOUDFLARED_SERVICE_UNINSTALL_FAILED' }
        throw 'CLOUDFLARED_SERVICE_TOKEN_NOT_FILE_BACKED'
    }
    $tokenForCheck = $null
}
Set-Service -Name Cloudflared -StartupType Automatic
Set-FleetServiceRecovery -Name 'Cloudflared' -FailureCode 'CLOUDFLARED_SERVICE_RECOVERY_CONFIG_FAILED'
if ((Get-Service -Name Cloudflared).Status -ne 'Running') { Start-Service -Name Cloudflared }
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
$installedVersion = (& $CloudflaredInstall --version 2>&1 | Out-String).Trim()
$marker = [ordered]@{
    schema = 1
    owner = 'youling-fleet-ai-client-control'
    node_uid = $NodeUid
    tunnel_id = $TunnelId
    default_shell = $DesiredShell
    powershell_version = (Get-PowerShell7State).version
    ssh_host_key_algorithm = $hostKeyAlgorithm
    ssh_host_key_sha256 = $hostKeyFingerprint
    cloudflared_version = $installedVersion
    updated_utc = [DateTimeOffset]::UtcNow.ToString('o')
}
$marker | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatePath -Encoding UTF8
if (-not [string]::IsNullOrWhiteSpace($TunnelTokenPath) -and (Test-Path -LiteralPath $TunnelTokenPath -PathType Leaf)) {
    Remove-Item -LiteralPath $TunnelTokenPath -Force
}
$final = Get-ControlStatus
if (-not $final.sshd_present -or $final.sshd_status -ne 'Running') { throw 'SSHD_NOT_RUNNING_AFTER_APPLY' }
if (-not $final.powershell7_compliant) { throw 'PWSH7_NOT_COMPLIANT_AFTER_APPLY' }
if (-not $final.default_shell_ok) { throw 'DEFAULT_SHELL_NOT_COMPLIANT' }
if (-not $final.marker_host_identity_present) { throw 'CONTROL_MARKER_HOST_IDENTITY_NOT_COMPLIANT' }
if (-not $final.cloudflared_service_present -or $final.cloudflared_service_state -ne 'Running') { throw 'CLOUDFLARED_NOT_RUNNING_AFTER_APPLY' }
if (-not $final.cloudflared_uses_token_file) { throw 'CLOUDFLARED_TOKEN_FILE_NOT_PROVEN' }
if (-not $final.marker_matches) { throw 'CONTROL_MARKER_NOT_COMPLIANT' }
Clear-BootstrapCheckpoint
[pscustomobject]$final | ConvertTo-Json -Depth 5