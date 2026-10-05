[CmdletBinding()]
param(
    [switch]$Apply,
    [ValidatePattern('^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')]
    [string]$NodeUid,
    [string]$BundleDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ControlScript = Join-Path (Join-Path $PSScriptRoot 'control') 'managed-windows-control.ps1'
$EnrollScript = Join-Path (Join-Path $PSScriptRoot 'enrollment') 'managed-windows-enroll.ps1'

function Read-JsonObject {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$ErrorCode)
    try {
        $value = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $value -or $value -is [System.Array]) { throw 'invalid' }
        return $value
    } catch {
        throw $ErrorCode
    }
}

function Get-ConvergenceStatus {
    param([Parameter(Mandatory=$true)][string]$ExactNodeUid)

    $controlRaw = (& $ControlScript -NodeUid $ExactNodeUid | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'CONVERGE_CONTROL_CHECK_FAILED' }
    try { $control = $controlRaw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'CONVERGE_CONTROL_REPORT_INVALID' }

    $enrollRaw = (& $EnrollScript -Stage Activate | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'CONVERGE_ENROLLMENT_CHECK_FAILED' }
    try { $enroll = $enrollRaw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'CONVERGE_ENROLLMENT_REPORT_INVALID' }

    $firewall = @($enroll.firewall)
    $firewallOk = (
        $firewall.Count -eq 1 -and
        [bool]$firewall[0].remoteScoped
    )
    $sshdOk = (
        $null -ne $enroll.sshd -and
        [bool]$enroll.sshd.exists -and
        [string]$enroll.sshd.status -eq 'Running' -and
        [string]$enroll.sshd.startType -eq 'Automatic'
    )
    $controlReady = (
        [string]$enroll.capabilityState -eq 'Installed' -and
        [bool]$enroll.powershell7.compliant -and
        $sshdOk -and
        $firewallOk -and
        [bool]$enroll.authorizedKeysPresent -and
        [bool]$enroll.authorizedKeysAclCanonical -and
        [bool]$control.default_shell_ok -and
        [bool]$control.marker_present -and
        [bool]$control.marker_matches -and
        [bool]$control.marker_host_identity_present -and
        [bool]$control.cloudflared_binary_present -and
        [bool]$control.cloudflared_service_present -and
        [string]$control.cloudflared_service_state -eq 'Running' -and
        [bool]$control.cloudflared_uses_token_file
    )

    return [ordered]@{
        schema = 1
        node_uid = $ExactNodeUid
        mode = if($Apply){'apply'}else{'check'}
        control_ready = [bool]$controlReady
        ready_for_external_verify = [bool]$controlReady
        lifecycle_effect = 'NONE'
        control = $control
        enrollment = $enroll
    }
}

if (-not $Apply) {
    if ([string]::IsNullOrWhiteSpace($NodeUid)) { throw 'NODE_UID_REQUIRED' }
    [pscustomobject](Get-ConvergenceStatus -ExactNodeUid $NodeUid) | ConvertTo-Json -Depth 8
    exit 0
}

if ([string]::IsNullOrWhiteSpace($BundleDir)) { throw 'CONVERGE_BUNDLE_REQUIRED' }
try { $BundleRoot = (Resolve-Path -LiteralPath $BundleDir -ErrorAction Stop).Path }
catch { throw 'CONVERGE_BUNDLE_NOT_FOUND' }

$bundleInfo = Get-Item -LiteralPath $BundleRoot -Force -ErrorAction Stop
if (-not $bundleInfo.PSIsContainer -or ($bundleInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'CONVERGE_BUNDLE_UNSAFE'
}

$ManifestPath = Join-Path $BundleRoot 'manifest.json'
$AuthorizedKeyPath = Join-Path $BundleRoot 'authorized_key.pub'
$TunnelTokenPath = Join-Path $BundleRoot 'tunnel_token'
$CloudflaredExePath = Join-Path $BundleRoot 'cloudflared.exe'

foreach ($required in @($ManifestPath,$AuthorizedKeyPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'CONVERGE_BUNDLE_INCOMPLETE' }
    $item = Get-Item -LiteralPath $required -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CONVERGE_BUNDLE_UNSAFE' }
}

foreach ($optional in @($TunnelTokenPath,$CloudflaredExePath)) {
    if (Test-Path -LiteralPath $optional -PathType Leaf) {
        $item = Get-Item -LiteralPath $optional -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CONVERGE_BUNDLE_UNSAFE' }
    }
}

$manifest = Read-JsonObject -Path $ManifestPath -ErrorCode 'CONVERGE_MANIFEST_INVALID'
$actualFields = @($manifest.PSObject.Properties.Name | Sort-Object)
$expectedFields = @('cloudflared_sha256','management_source_scope','node_uid','schema','tunnel_id' | Sort-Object)
if ((Compare-Object -ReferenceObject $expectedFields -DifferenceObject $actualFields).Count -ne 0) {
    throw 'CONVERGE_MANIFEST_FIELDS_INVALID'
}
if ([int]$manifest.schema -ne 1) { throw 'CONVERGE_MANIFEST_SCHEMA_UNSUPPORTED' }

$ManifestNodeUid = [string]$manifest.node_uid
if ($ManifestNodeUid -notmatch '^node-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'CONVERGE_MANIFEST_NODE_UID_INVALID'
}
if (-not [string]::IsNullOrWhiteSpace($NodeUid) -and $NodeUid -ne $ManifestNodeUid) {
    throw 'CONVERGE_NODE_UID_MISMATCH'
}
$NodeUid = $ManifestNodeUid

$TunnelId = [string]$manifest.tunnel_id
if ($TunnelId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'CONVERGE_TUNNEL_ID_INVALID'
}
$CloudflaredSha256 = [string]$manifest.cloudflared_sha256
if ($CloudflaredSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'CONVERGE_CLOUDFLARED_SHA256_INVALID' }
$ManagementSourceScope = [string]$manifest.management_source_scope
if ([string]::IsNullOrWhiteSpace($ManagementSourceScope)) { throw 'CONVERGE_MANAGEMENT_SCOPE_REQUIRED' }

$applyParams = @{
    Apply = $true
    NodeUid = $NodeUid
    AuthorizedKeyPath = $AuthorizedKeyPath
    ManagementSourceScope = $ManagementSourceScope
    TunnelTokenPath = $TunnelTokenPath
    TunnelId = $TunnelId
    CloudflaredExePath = $CloudflaredExePath
    CloudflaredSha256 = $CloudflaredSha256
}
$applyRaw = (& $ControlScript @applyParams | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'CONVERGE_APPLY_FAILED' }
try { $null = $applyRaw | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'CONVERGE_APPLY_REPORT_INVALID' }

$final = Get-ConvergenceStatus -ExactNodeUid $NodeUid
if (-not [bool]$final.control_ready) { throw 'CONVERGE_POSTCONDITION_FAILED' }
[pscustomobject]$final | ConvertTo-Json -Depth 8
