# Fleet managed-windows enrollment surface v0.2.0
# Generic managed Windows enrollment; instance configuration is deployment-owned.
# No live host mutation without explicit -Apply and elevated context.
# Stages:
#   Bootstrap — ensure pinned PowerShell 7 baseline + install OpenSSH.Server + establish host identity (no remote exposure)
#   Activate  — configure admin authorized_keys (ACL), scoped firewall, service activation
# Default execution is plan/non-mutating; mutation requires -Apply + elevation.
# Evidence is typed/sanitized: fingerprints are bounded SHA256:/MD5: only, no private keys, no TOFU.
[CmdletBinding()]
param(
    [switch]$Apply,
    [ValidateSet("Bootstrap","Activate")][string]$Stage = "Bootstrap",
    [string]$AuthorizedKeyPath,
    [string]$ManagementSourceScope,
    [string[]]$AllowedExistingLocalAddress = @(),
    [switch]$CaptureFingerprint
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$MinimumPowerShellVersion = [version]'7.6.6'
$PowerShell7Path = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
$PowerShellReleaseBase = 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6'
$PowerShellMsi = @{
    X64 = [ordered]@{ File = 'PowerShell-7.6.6-win-x64.msi'; Sha256 = '958838FF55091E1C8705D89EFED0CC7E8245A3A6EF6C0CCFAE20015227108AD8' }
    Arm64 = [ordered]@{ File = 'PowerShell-7.6.6-win-arm64.msi'; Sha256 = '387D0AF8E92BA97F73616C91FA8F29A284E8F82EE6C40FE12DADE971BB05BAC4' }
}

# W4: registry/lifecycle separation — this script never edits the Fleet registry file
# W4: reboot gate — no Restart-Computer / reboot in this surface
# W4: overlay — Tailscale is presence only; never login/up/down

function Test-IsElevated {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($id)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Write-EnrollmentJson([Parameter(Mandatory = $true)][object]$Report) {
    $Report | ConvertTo-Json -Depth 5
}

function Get-PowerShell7State {
    if (-not (Test-Path -LiteralPath $PowerShell7Path -PathType Leaf)) {
        return [ordered]@{ present = $false; version = $null; compliant = $false }
    }
    try {
        $raw = (& $PowerShell7Path -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()' 2>$null | Out-String).Trim()
        $version = $null
        if (-not [version]::TryParse($raw, [ref]$version)) { throw 'PWSH7_VERSION_UNREADABLE' }
        return [ordered]@{ present = $true; version = $version.ToString(); compliant = $version -ge $MinimumPowerShellVersion }
    } catch {
        if ($_.Exception.Message -eq 'PWSH7_VERSION_UNREADABLE') { throw }
        throw 'PWSH7_VERSION_UNREADABLE'
    }
}

function Ensure-PowerShell7 {
    $state = Get-PowerShell7State
    if ($state.compliant) { return 'already_compliant' }

    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    if (-not $PowerShellMsi.ContainsKey($arch)) { throw 'BOOTSTRAP_PWSH7_ARCH_UNSUPPORTED' }
    $spec = $PowerShellMsi[$arch]
    $msi = Join-Path $env:TEMP $spec.File
    try {
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
        $bits = Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue
        try {
            if ($null -ne $bits) {
                Start-BitsTransfer -Source ($PowerShellReleaseBase + '/' + $spec.File) -Destination $msi -DisplayName 'Fleet PowerShell 7 bootstrap' -ErrorAction Stop
            } else {
                Invoke-WebRequest -Uri ($PowerShellReleaseBase + '/' + $spec.File) -OutFile $msi -UseBasicParsing -ErrorAction Stop
            }
        } catch {
            throw 'BOOTSTRAP_PWSH7_DOWNLOAD_FAILED'
        }
        $hash = (Get-FileHash -LiteralPath $msi -Algorithm SHA256 -ErrorAction Stop).Hash
        if ($hash -ine $spec.Sha256) { throw 'BOOTSTRAP_PWSH7_SHA256_MISMATCH' }
        $signature = Get-AuthenticodeSignature -LiteralPath $msi
        if ([string]$signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or [string]$signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation') {
            throw 'BOOTSTRAP_PWSH7_SIGNATURE_INVALID'
        }
        $msiParams = @(
            '/package', $msi, '/quiet', '/norestart',
            'ENABLE_PSREMOTING=0', 'REGISTER_MANIFEST=1',
            'USE_MU=1', 'ENABLE_MU=1', 'ADD_PATH=1'
        )
        & (Join-Path $env:WINDIR 'System32\msiexec.exe') @msiParams
        $msiExit = $LASTEXITCODE
        if ($msiExit -notin @(0,3010)) { throw 'BOOTSTRAP_PWSH7_MSI_INSTALL_FAILED' }
    } finally {
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    }

    $after = Get-PowerShell7State
    if (-not $after.compliant) { throw 'BOOTSTRAP_PWSH7_POST_INSTALL_NOT_COMPLIANT' }
    if ($msiExit -eq 3010) { return 'installed_reboot_pending' }
    return 'installed'
}

function Get-CapabilityState {
    # Returns NotPresent | Installed | UNKNOWN (fail-closed)
    try {
        $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction Stop
        if ($null -eq $cap) { return "UNKNOWN" }
        $state = "$($cap.State)"
        if ($state -eq "Installed") { return "Installed" }
        if ($state -eq "NotPresent") { return "NotPresent" }
        return "UNKNOWN"
    } catch {
        return "UNKNOWN"
    }
}

function Get-BoundedFingerprints {
    # Public .pub only + ssh-keygen -lf bounded SHA256:/MD5:, typed status
    $results = @()
    try {
        $pubDir = Join-Path -Path $Env:ProgramData -ChildPath 'ssh'
        $pubFiles = Get-ChildItem -Path (Join-Path $pubDir 'ssh_host_*.pub') -ErrorAction SilentlyContinue
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
            $results += $entry
        }
    } catch {
        $results = @([ordered]@{ file = $null; fingerprint = $null; keyType = $null; status = "FINGERPRINT_ENUMERATION_FAILED" })
    }
    return $results
}

function Test-ValidSSHPublicKey([string]$Line) {
    # Single-line OpenSSH public key: <type> <base64> [comment]
    if ([string]::IsNullOrWhiteSpace($Line)) { return $false }
    $trim = $Line.Trim()
    if ($trim -match '^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp[0-9]+)\s+[A-Za-z0-9+/=]+(\s+.*)?$') {
        return $true
    }
    return $false
}

function Test-ValidManagementScope([string]$Scope) {
    # Narrow validator v0.1.2 (R2 single-scope contract): exactly ONE exact IP
    # or CIDR, with valid prefix bounds. Comma-separated lists are rejected so
    # the intended scope always compares idempotently (exact single match)
    # against observed RemoteAddress. Rejects broad/special aliases and
    # malformed values.
    if ([string]::IsNullOrWhiteSpace($Scope)) { return $false }
    if ($Scope.Contains(',')) { return $false }
    $s = $Scope.Trim()
    if ([string]::IsNullOrWhiteSpace($s)) { return $false }
    if ($s -match '\s') { return $false }
    if ($s -match '[\*\?\\]') { return $false }
    $lower = $s.ToLowerInvariant()
    $aliasSet = @('any','internet','localsubnet','dns','dhcp','wins','defaultgateway','unicast','multicast','intranet','ipv6internet')
    if ($aliasSet -contains $lower) { return $false }
    if ($s -eq '0.0.0.0/0' -or $s -eq '::/0') { return $false }
    if ($s.Contains('/')) {
        $parts = $s.Split('/')
        if ($parts.Count -ne 2) { return $false }
        $ipText = $parts[0].Trim()
        $prefixText = $parts[1].Trim()
        if ([string]::IsNullOrWhiteSpace($ipText)) { return $false }
        if ([string]::IsNullOrWhiteSpace($prefixText)) { return $false }
        $parsedIp = $null
        if (-not [System.Net.IPAddress]::TryParse($ipText, [ref]$parsedIp)) { return $false }
        $prefix = 0
        if (-not [int]::TryParse($prefixText, [ref]$prefix)) { return $false }
        if ($parsedIp.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
            if ($prefix -lt 8 -or $prefix -gt 32) { return $false }
            if ($ipText -eq '0.0.0.0') { return $false }
            if ($prefix -eq 0) { return $false }
        } elseif ($parsedIp.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
            if ($prefix -lt 16 -or $prefix -gt 128) { return $false }
            if ($ipText -eq '::') { return $false }
            if ($prefix -eq 0) { return $false }
        } else {
            return $false
        }
    } else {
        $parsedIp = $null
        if (-not [System.Net.IPAddress]::TryParse($s, [ref]$parsedIp)) { return $false }
        if ($s -eq '0.0.0.0' -or $s -eq '::' -or $s -eq '255.255.255.255') { return $false }
    }
    return $true
}

function Get-IPv4PrefixLengthFromDottedMask([string]$MaskText) {
    $maskIp = $null
    if (-not [System.Net.IPAddress]::TryParse($MaskText, [ref]$maskIp)) { return -1 }
    if ($maskIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return -1 }
    $prefix = 0
    $seenZero = $false
    foreach ($b in $maskIp.GetAddressBytes()) {
        for ($bit = 7; $bit -ge 0; $bit--) {
            $isOne = (($b -band (1 -shl $bit)) -ne 0)
            if ($isOne) {
                if ($seenZero) { return -1 }
                $prefix += 1
            } else {
                $seenZero = $true
            }
        }
    }
    return $prefix
}

function Convert-ToCanonicalManagementScope([string]$Scope) {
    $s = "$Scope".Trim()
    if ([string]::IsNullOrWhiteSpace($s) -or $s.Contains(',')) { throw 'SCOPE_CANONICALIZATION_INVALID' }

    $ipText = $s
    $prefixText = $null
    if ($s.Contains('/')) {
        $parts = $s.Split('/')
        if ($parts.Count -ne 2) { throw 'SCOPE_CANONICALIZATION_INVALID' }
        $ipText = $parts[0].Trim()
        $prefixText = $parts[1].Trim()
    }

    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($ipText, [ref]$ip)) { throw 'SCOPE_CANONICALIZATION_INVALID' }
    $isV4 = ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork)
    $isV6 = ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6)
    if (-not ($isV4 -or $isV6)) { throw 'SCOPE_CANONICALIZATION_INVALID' }
    $maxPrefix = if ($isV4) { 32 } else { 128 }

    $prefix = $maxPrefix
    if ($null -ne $prefixText) {
        $numeric = 0
        if ([int]::TryParse($prefixText, [ref]$numeric)) {
            $prefix = $numeric
        } elseif ($isV4) {
            $prefix = Get-IPv4PrefixLengthFromDottedMask -MaskText $prefixText
        } else {
            throw 'SCOPE_CANONICALIZATION_INVALID'
        }
    }
    if ($prefix -lt 0 -or $prefix -gt $maxPrefix) { throw 'SCOPE_CANONICALIZATION_INVALID' }

    $bytes = $ip.GetAddressBytes()
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        $bits = $prefix - ($i * 8)
        if ($bits -ge 8) { continue }
        if ($bits -le 0) {
            $bytes[$i] = 0
            continue
        }
        $maskValue = 256 - [int][math]::Pow(2, (8 - $bits))
        $bytes[$i] = [byte]($bytes[$i] -band $maskValue)
    }
    $hex = ($bytes | ForEach-Object { $_.ToString('X2') }) -join ''
    $family = if ($isV4) { 'IPv4' } else { 'IPv6' }
    return "$family|$prefix|$hex"
}

function Test-ExactManagementScopeEquivalent([string]$Observed, [string]$Intended) {
    try {
        $observedCanonical = Convert-ToCanonicalManagementScope -Scope $Observed
        $intendedCanonical = Convert-ToCanonicalManagementScope -Scope $Intended
        return ($observedCanonical -ceq $intendedCanonical)
    } catch {
        return $false
    }
}

function Get-NormalizedAllowedLocalAddresses([string[]]$Addresses) {
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($raw in @($Addresses)) {
        $text = "$raw".Trim()
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        $parsed = $null
        if (-not [System.Net.IPAddress]::TryParse($text, [ref]$parsed)) {
            throw "ACTIVATE_ALLOWED_LOCAL_ADDRESS_INVALID: only exact IP addresses are accepted."
        }
        if ($parsed.Equals([System.Net.IPAddress]::Any) -or $parsed.Equals([System.Net.IPAddress]::IPv6Any)) {
            throw "ACTIVATE_ALLOWED_LOCAL_ADDRESS_INVALID: wildcard local addresses are forbidden."
        }
        [void]$set.Add($parsed.ToString())
    }
    return ,$set
}

function Test-CanonicalAdminAuthorizedKeysAcl([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        if (-not $acl.AreAccessRulesProtected) { return $false }
        $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        [void]$expected.Add('S-1-5-32-544')
        [void]$expected.Add('S-1-5-18')
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($rule in @($acl.Access)) {
            if ([string]$rule.AccessControlType -ne 'Allow') { return $false }
            try {
                $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
            } catch { return $false }
            if (-not $expected.Contains($sid)) { return $false }
            $full = [System.Security.AccessControl.FileSystemRights]::FullControl
            if (($rule.FileSystemRights -band $full) -ne $full) { return $false }
            [void]$seen.Add($sid)
        }
        return ($seen.Count -eq 2 -and $seen.Contains('S-1-5-32-544') -and $seen.Contains('S-1-5-18'))
    } catch {
        return $false
    }
}

function Test-PortSelectorCoversSsh([string]$Selector) {
    # R2: conservative TCP/22 coverage for one firewall port selector token.
    # Returns $true when the token provably exposes 22 (exact 22, Any, or a
    # numeric range containing 22); $false when provably disjoint. Throws typed
    # ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR when the token cannot
    # be safely classified — the caller must fail closed, never ignore it.
    $t = "$Selector".Trim()
    if ([string]::IsNullOrWhiteSpace($t)) {
        throw "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR: unclassifiable firewall port selector; failing closed."
    }
    if ($t -ieq "Any") { return $true }
    if ($t -match '^\d+$') {
        $n = 0
        if (-not [int]::TryParse($t, [ref]$n)) {
            throw "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR: unclassifiable firewall port selector; failing closed."
        }
        if ($n -lt 0 -or $n -gt 65535) {
            throw "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR: out-of-range firewall port selector; failing closed."
        }
        return ($n -eq 22)
    }
    if ($t -match '^(\d+)\s*-\s*(\d+)$') {
        $lo = 0
        $hi = 0
        if (-not [int]::TryParse($Matches[1], [ref]$lo)) {
            throw "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR: unclassifiable firewall port range; failing closed."
        }
        if (-not [int]::TryParse($Matches[2], [ref]$hi)) {
            throw "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR: unclassifiable firewall port range; failing closed."
        }
        if ($lo -lt 0 -or $hi -gt 65535 -or $lo -gt $hi) {
            throw "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR: invalid firewall port range; failing closed."
        }
        return ($lo -le 22 -and 22 -le $hi)
    }
    throw "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR: unclassifiable firewall port selector; failing closed."
}

$report = [ordered]@{
    enrollment = 'managed-windows-enroll'
    version = '0.2.0'
    stage = $Stage
    apply = [bool]$Apply
    elevated = (Test-IsElevated)
    timestamp = (Get-Date -Format o)
}

# SECTION: plan_guard
# Default is plan / non-mutating. Mutation requires explicit -Apply and elevated context.
if (-not $Apply) {
    $capState = Get-CapabilityState
    $powerShell7State = Get-PowerShell7State
    $fingerprints = Get-BoundedFingerprints
    # Plan-only observes current state; does not install/start/firewall.
    $sshdProbe = $null
    try {
        $svc = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
        if ($null -eq $svc) { $sshdProbe = [ordered]@{ exists = $false } }
        else { $sshdProbe = [ordered]@{ exists = $true; status = "$($svc.Status)"; startType = "$($svc.StartType)" } }
    } catch { $sshdProbe = [ordered]@{ error = "UNKNOWN" } }

    $fwProbe = @()
    try {
        $rules = Get-NetFirewallRule -DisplayName 'OpenSSH Server (Fleet enrollment)' -ErrorAction SilentlyContinue
        foreach ($r in $rules) {
            $addr = $r | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
            $remote = @()
            if ($null -ne $addr) { $remote = @($addr.RemoteAddress) }
            $isScoped = $true
            if ($remote.Count -eq 0 -or ($remote.Count -eq 1 -and $remote[0] -eq 'Any')) { $isScoped = $false }
            $fwProbe += [ordered]@{ name = $r.Name; displayName = $r.DisplayName; remoteScoped = $isScoped }
        }
    } catch { $fwProbe = @() }

    $adminAuthPathPlan = Join-Path (Join-Path $env:ProgramData 'ssh') 'administrators_authorized_keys'
    $authorizedKeysPresent = Test-Path -LiteralPath $adminAuthPathPlan -PathType Leaf
    $authorizedKeysAclCanonical = $false
    if ($authorizedKeysPresent) {
        $authorizedKeysAclCanonical = Test-CanonicalAdminAuthorizedKeysAcl -Path $adminAuthPathPlan
    }

    $report['mode'] = 'plan'
    $report['capabilityState'] = $capState
    $report['powershell7'] = $powerShell7State
    $report['sshd'] = $sshdProbe
    $report['hostKeyFingerprints'] = $fingerprints
    $report['firewall'] = $fwProbe
    $report['authorizedKeysPresent'] = [bool]$authorizedKeysPresent
    $report['authorizedKeysAclCanonical'] = [bool]$authorizedKeysAclCanonical
    $report['wouldInstallPowerShell7'] = ($Stage -eq 'Bootstrap' -and -not $powerShell7State.compliant)
    $report['wouldBootstrap'] = ($Stage -eq 'Bootstrap' -and ($capState -eq 'NotPresent' -or -not $powerShell7State.compliant))
    $report['wouldActivate'] = ($Stage -eq 'Activate')
    $report['note'] = 'plan only; no mutation. Re-run with -Apply (elevated) to mutate.'
    Write-EnrollmentJson -Report ([PSCustomObject]$report)
    exit 0
}

# SECTION: apply_authority
# Explicit apply requires elevated context — fail closed otherwise.
if (-not (Test-IsElevated)) {
    throw "Apply requires elevated Administrator context; refusing fail-closed."
}

# Fail-closed current-state guard before any mutation
$capState = Get-CapabilityState
if ($capState -eq "UNKNOWN") {
    throw "OpenSSH capability state is UNKNOWN (ambiguous/error); refusing mutation fail-closed."
}
$report['capabilityStateBefore'] = $capState
$report['mode'] = 'apply'

# Evidence hygiene: never emit private key material, IPs, usernames, tokens
# SECTION: stage_bootstrap
if ($Stage -eq "Bootstrap") {
    # Containment-first: establish the PowerShell 7 execution baseline, then install
    # OpenSSH capability and public host identity. Do NOT expose remotely.
    $powerShell7Result = Ensure-PowerShell7
    $powerShell7State = Get-PowerShell7State
    if (-not $powerShell7State.compliant) { throw 'BOOTSTRAP_PWSH7_NOT_COMPLIANT' }

    # Idempotent: if OpenSSH is already Installed, skip Add-WindowsCapability.
    $installResult = "skipped"
    if ($capState -eq "NotPresent") {
        # Bounded mutation — requires -Apply + elevation + explicit Bootstrap stage
        try {
            $null = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction Stop
        } catch {
            throw "BOOTSTRAP_CAPABILITY_INSTALL_FAILED: OpenSSH capability install failed fail-closed."
        }
        $installResult = "installed"
        $capState = Get-CapabilityState
        if ($capState -ne "Installed") {
            throw "BOOTSTRAP_CAPABILITY_NOT_INSTALLED: OpenSSH capability install did not reach Installed state; failing closed."
        }
    } elseif ($capState -eq "Installed") {
        $installResult = "already_installed"
    }

    # Ensure host identity is available as bounded public fingerprints only (never private key).
    $fingerprints = Get-BoundedFingerprints
    # Do NOT start sshd, do NOT create firewall rule, do NOT configure authorized_keys.
    $sshdProbe = $null
    try {
        $svc = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
        if ($null -eq $svc) { $sshdProbe = [ordered]@{ exists = $false } }
        else { $sshdProbe = [ordered]@{ exists = $true; status = "$($svc.Status)"; startType = "$($svc.StartType)" } }
    } catch { $sshdProbe = [ordered]@{ error = "UNKNOWN" } }

    $report['bootstrap'] = [ordered]@{
        powershell7 = [ordered]@{
            result = $powerShell7Result
            present = [bool]$powerShell7State.present
            version = $powerShell7State.version
            compliant = [bool]$powerShell7State.compliant
            rebootPending = ($powerShell7Result -eq 'installed_reboot_pending')
        }
        installResult = $installResult
        capabilityStateAfter = $capState
        hostKeyFingerprints = $fingerprints
        sshd = $sshdProbe
        firewallCreated = $false
        authorizedKeysConfigured = $false
        serviceStarted = $false
    }
    $report['containment'] = 'sshd not started; no firewall rule created; no remote exposure'
    Write-EnrollmentJson -Report ([PSCustomObject]$report)
    exit 0
}

# SECTION: stage_activate
if ($Stage -eq "Activate") {
    # Separate explicit stage: firewall + auth + service activation. Requires runtime-scoped inputs.
    # Bootstrap owns PowerShell installation; Activate never downloads/install tools.
    $powerShell7State = Get-PowerShell7State
    if (-not $powerShell7State.compliant) {
        throw 'ACTIVATE_PWSH7_NOT_COMPLIANT: run Bootstrap before Activate.'
    }
    if (-not (Test-ValidManagementScope -Scope $ManagementSourceScope)) {
        throw "ACTIVATE_MANAGEMENT_SCOPE_INVALID: Activate requires explicit -ManagementSourceScope (scoped CIDR, e.g. management overlay prefix); refusing open/Any scope."
    }
    if ([string]::IsNullOrWhiteSpace($AuthorizedKeyPath)) {
        throw "ACTIVATE_AUTHORIZED_KEY_PATH_REQUIRED: Activate requires -AuthorizedKeyPath pointing to a runtime-local OpenSSH public key file."
    }
    # Sanitized existence check — never echo raw local path (may contain username/topology).
    if (-not (Test-Path -LiteralPath $AuthorizedKeyPath)) {
        throw "ACTIVATE_AUTHORIZED_KEY_PATH_NOT_FOUND: runtime public-key file not found."
    }
    $pubKeyLine = $null
    try {
        $pubKeyLine = (Get-Content -LiteralPath $AuthorizedKeyPath -ErrorAction Stop | Select-Object -First 1)
    } catch {
        throw "ACTIVATE_AUTHORIZED_KEY_READ_FAILED: unable to read runtime public-key file."
    }
    if (-not (Test-ValidSSHPublicKey -Line $pubKeyLine)) {
        throw "ACTIVATE_AUTHORIZED_KEY_FORMAT_INVALID: AuthorizedKeyPath must contain a single-line OpenSSH public key (ssh-rsa/ssh-ed25519/ecdsa-sha2-*) — no private key material."
    }
    if ($pubKeyLine -match 'BEGIN.*PRIVATE KEY') {
        throw "ACTIVATE_PRIVATE_KEY_REJECTED: Private key material is never accepted as authorized_keys input."
    }

    # Capability must be Installed before activation — fail closed if ambiguous/missing
    if ($capState -ne "Installed") {
        throw "ACTIVATE_CAPABILITY_NOT_INSTALLED: Cannot Activate without Installed capability; run Bootstrap first."
    }

    $allowedLocalAddresses = Get-NormalizedAllowedLocalAddresses -Addresses $AllowedExistingLocalAddress
    $sshDataDir = Join-Path $Env:ProgramData 'ssh'
    $adminAuthPath = Join-Path $sshDataDir 'administrators_authorized_keys'

    # SUBSECTION: pre_activation_exposure_guard
    # Before any authorized_keys mutation, prove current sshd/inbound SSH exposure is contained.
    # Fail closed on unexpected active/broader foreign exposure; never modify foreign rules here.
    # R2 fail-closed enumeration: every inspection pairs its query with error
    # capture (-ErrorVariable) and null resolution with typed
    # ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED. A query error or an
    # unresolvable filter is never treated as "no exposure". Absent objects
    # ($null with no error, e.g. no sshd service / no inbound rules) are the
    # only proven-absent path and continue.
    $preSshd = $null
    try {
        $sshdErr = $null
        $svcProbe = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue -ErrorVariable sshdErr
        if ($sshdErr) {
            throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unable to prove pre-activation sshd containment."
        }
        if ($null -eq $svcProbe) { $preSshd = [ordered]@{ exists = $false } }
        else { $preSshd = [ordered]@{ exists = $true; status = "$($svcProbe.Status)"; startType = "$($svcProbe.StartType)" } }
    } catch {
        $innerSshd = "$($_.Exception.Message)"
        if ($innerSshd -match 'ACTIVATE_PRE_EXPOSURE_') { throw }
        throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unable to prove pre-activation sshd containment."
    }
    # R2 single-scope canonical form for exact idempotent comparison.
    $scopeNorm = "$ManagementSourceScope".Trim()
    $exactFleetRuleCount = 0
    try {
        $listErr = $null
        $inboundRules = Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue -ErrorVariable listErr
        if ($listErr) {
            throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unable to enumerate pre-activation inbound firewall rules."
        }
        foreach ($candidate in @($inboundRules)) {
            if ($null -eq $candidate) { continue }
            if ("$($candidate.Enabled)" -ne "True") { continue }
            if ("$($candidate.Action)" -ne "Allow") { continue }

            # R4: PackageFamilyName is an authoritative package-family constraint
            # on the firewall rule itself. A packaged-app capability rule cannot
            # match the Win32 OpenSSH daemon, even when Program/Port appear as Any.
            $packageFamilyName = "$($candidate.PackageFamilyName)".Trim()
            if (-not [string]::IsNullOrWhiteSpace($packageFamilyName)) { continue }

            # R3: port/protocol alone is insufficient. Windows merges AppContainer,
            # package, program and service-scoped rules into the firewall rule view;
            # many such rules expose LocalPort=Any but cannot match sshd.exe.
            # Prove the rule can apply to sshd before treating port 22 as exposure.
            $appErr = $null
            $appFilter = $candidate | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue -ErrorVariable appErr
            if ($appErr -or $null -eq $appFilter) {
                throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unable to resolve pre-activation firewall application filter."
            }
            $serviceErr = $null
            $serviceFilter = $candidate | Get-NetFirewallServiceFilter -ErrorAction SilentlyContinue -ErrorVariable serviceErr
            if ($serviceErr -or $null -eq $serviceFilter) {
                throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unable to resolve pre-activation firewall service filter."
            }

            $ruleCanMatchSshd = $true
            $sshdProgram = [IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'))
            foreach ($af in @($appFilter)) {
                if ($null -eq $af) {
                    throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unresolvable pre-activation firewall application filter."
                }
                $program = "$($af.Program)".Trim()
                $package = "$($af.Package)".Trim()
                if (-not [string]::IsNullOrWhiteSpace($package) -and $package -notin @('Any','*')) {
                    $ruleCanMatchSshd = $false
                }
                if (-not [string]::IsNullOrWhiteSpace($program) -and $program -notin @('Any','*')) {
                    try {
                        $expandedProgram = [Environment]::ExpandEnvironmentVariables($program)
                        $expandedProgram = [IO.Path]::GetFullPath($expandedProgram)
                    } catch {
                        throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unclassifiable pre-activation firewall program filter."
                    }
                    if ($expandedProgram -ine $sshdProgram) {
                        $ruleCanMatchSshd = $false
                    }
                }
            }
            foreach ($sf in @($serviceFilter)) {
                if ($null -eq $sf) {
                    throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unresolvable pre-activation firewall service filter."
                }
                $service = "$($sf.Service)".Trim()
                if (-not [string]::IsNullOrWhiteSpace($service) -and $service -notin @('Any','*') -and $service -ine 'sshd') {
                    $ruleCanMatchSshd = $false
                }
            }
            if (-not $ruleCanMatchSshd) { continue }

            $portErr = $null
            $portFilter = $candidate | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue -ErrorVariable portErr
            if ($portErr) {
                throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unable to resolve pre-activation firewall port filter."
            }
            if ($null -eq $portFilter) {
                throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unresolvable pre-activation firewall port filter; failing closed."
            }
            # R2: protocol gate — only TCP/Any port selectors can carry SSH.
            # UDP provably cannot; any other protocol value is unclassifiable.
            $coversSsh = $false
            foreach ($pf in @($portFilter)) {
                if ($null -eq $pf) {
                    throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unresolvable pre-activation firewall port filter; failing closed."
                }
                $proto = "$($pf.Protocol)".Trim()
                if ($proto -ieq "UDP") { continue }
                if (-not ($proto -ieq "TCP" -or $proto -ieq "Any")) {
                    throw "ACTIVATE_PRE_EXPOSURE_UNCLASSIFIABLE_PORT_SELECTOR: unclassifiable firewall protocol selector; failing closed."
                }
                # One LocalPort value may itself carry comma-separated tokens.
                $tokens = @("$($pf.LocalPort)".Split(','))
                foreach ($token in $tokens) {
                    if (Test-PortSelectorCoversSsh -Selector $token) { $coversSsh = $true }
                }
            }
            if (-not $coversSsh) { continue }

            $addrErr = $null
            $addrFilter = $candidate | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue -ErrorVariable addrErr
            if ($addrErr -or $null -eq $addrFilter) {
                throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unable to resolve pre-activation firewall address filter."
            }
            $localPre = @($addrFilter.LocalAddress | ForEach-Object { "$_".Trim() })
            $remotePre = @($addrFilter.RemoteAddress | ForEach-Object { "$_".Trim() })

            $isFleetRule = ("$($candidate.DisplayName)" -eq "OpenSSH Server (Fleet enrollment)")
            if ($isFleetRule) {
                if (-not ($remotePre.Count -eq 1 -and (Test-ExactManagementScopeEquivalent -Observed $remotePre[0] -Intended $scopeNorm))) {
                    throw "ACTIVATE_PRE_EXPOSURE_FLEET_SCOPE_MISMATCH: existing Fleet firewall rule has different scope; refusing without review."
                }
                $exactFleetRuleCount += 1
                continue
            }

            # R4: a caller may explicitly attest exact pre-existing local
            # management-overlay addresses (for example, current overlay IPs).
            # Accept only when EVERY LocalAddress is one exact attested IP.
            # Any/wildcard/range/CIDR/unknown local-address selector remains foreign.
            $localScopeExplicitlyAllowed = $false
            if ($allowedLocalAddresses.Count -gt 0 -and $localPre.Count -gt 0) {
                $allExactAllowed = $true
                foreach ($local in $localPre) {
                    if ([string]::IsNullOrWhiteSpace($local) -or $local -in @('Any','*')) {
                        $allExactAllowed = $false
                        break
                    }
                    $parsedLocal = $null
                    if (-not [System.Net.IPAddress]::TryParse($local, [ref]$parsedLocal)) {
                        $allExactAllowed = $false
                        break
                    }
                    if (-not $allowedLocalAddresses.Contains($parsedLocal.ToString())) {
                        $allExactAllowed = $false
                        break
                    }
                }
                $localScopeExplicitlyAllowed = $allExactAllowed
            }
            if ($localScopeExplicitlyAllowed) { continue }

            throw "ACTIVATE_PRE_EXPOSURE_FOREIGN_SSH_RULE: foreign inbound SSH exposure detected; refusing to add key fail-closed."
        }
    } catch {
        $innerPre = "$($_.Exception.Message)"
        if ($innerPre -match 'ACTIVATE_PRE_EXPOSURE_') { throw }
        throw "ACTIVATE_PRE_EXPOSURE_ENUMERATION_FAILED: unable to prove pre-activation firewall containment."
    }

    if ($exactFleetRuleCount -gt 1) {
        throw "ACTIVATE_PRE_EXPOSURE_FLEET_RULE_AMBIGUOUS: multiple exact Fleet SSH rules found; failing closed."
    }
    $preExposureMode = 'fresh_activation'
    if (($preSshd.exists -eq $true) -and ($preSshd.status -eq "Running")) {
        if ($exactFleetRuleCount -ne 1) {
            throw "ACTIVATE_PRE_EXPOSURE_UNEXPECTED_SSHD_RUNNING: Running sshd is not paired with exactly one canonical Fleet rule."
        }
        if (-not (Test-Path -LiteralPath $adminAuthPath -PathType Leaf)) {
            throw "ACTIVATE_PRE_EXPOSURE_RUNNING_NOT_RESUMABLE: Running Fleet-scoped sshd lacks canonical authorized_keys state."
        }
        $resumeKeyPresent = $false
        try {
            $resumeExisting = Get-Content -LiteralPath $adminAuthPath -Raw -ErrorAction Stop
            foreach ($line in @($resumeExisting -split '\r?\n')) {
                if ($line.Trim() -ceq $pubKeyLine.Trim()) { $resumeKeyPresent = $true; break }
            }
        } catch {
            throw "ACTIVATE_PRE_EXPOSURE_RUNNING_NOT_RESUMABLE: unable to prove existing controller key state."
        }
        if (-not $resumeKeyPresent -or -not (Test-CanonicalAdminAuthorizedKeysAcl -Path $adminAuthPath)) {
            throw "ACTIVATE_PRE_EXPOSURE_RUNNING_NOT_RESUMABLE: Running Fleet-scoped sshd key/ACL state is not canonical."
        }
        $preExposureMode = 'resume_existing_fleet_activation'
    }

    # Idempotent authorized_keys handling — key-content idempotency is independent of ACL idempotency.
    # Always verify/reconcile canonical administrators_authorized_keys ACL even when key is already present.
    $keyResult = "skipped"
    try {
        $existing = ""
        if (Test-Path -LiteralPath $adminAuthPath) {
            $existing = Get-Content -LiteralPath $adminAuthPath -Raw -ErrorAction SilentlyContinue
            if ($null -eq $existing) { $existing = "" }
        }
        if ($existing -match [regex]::Escape($pubKeyLine.Trim())) {
            $keyResult = "already_present"
        } else {
            if (-not (Test-Path -LiteralPath $sshDataDir)) { $null = New-Item -ItemType Directory -Path $sshDataDir -Force }
            if ([string]::IsNullOrWhiteSpace($existing)) {
                Set-Content -LiteralPath $adminAuthPath -Value ($pubKeyLine.Trim() + "`n") -Encoding ascii -Force
            } else {
                Add-Content -LiteralPath $adminAuthPath -Value ($pubKeyLine.Trim()) -Encoding ascii
            }
            $keyResult = "configured"
        }
    } catch {
        throw "ACTIVATE_AUTHORIZED_KEYS_WRITE_FAILED: failed to configure administrators_authorized_keys content."
    }

    # ACL idempotency — always reconcile to canonical Administrators+SYSTEM-only shape, even on already_present.
    $aclResult = "skipped"
    try {
        $acl = Get-Acl -LiteralPath $adminAuthPath
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRule($rule) }
        $adminSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
        $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
        $adminAccount = $adminSid.Translate([System.Security.Principal.NTAccount])
        $systemAccount = $systemSid.Translate([System.Security.Principal.NTAccount])
        $adminRule = New-Object System.Security.AccessControl.FileSystemAccessRule($adminAccount, 'FullControl', 'Allow')
        $systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule($systemAccount, 'FullControl', 'Allow')
        $acl.AddAccessRule($adminRule)
        $acl.AddAccessRule($systemRule)
        Set-Acl -LiteralPath $adminAuthPath -AclObject $acl
        $aclResult = "reconciled"
    } catch {
        throw "ACTIVATE_AUTHORIZED_KEYS_ACL_FAILED: failed to reconcile administrators_authorized_keys ACL."
    }
    $authResult = $keyResult

    # Firewall containment: scoped inbound rule only (R2 single exact scope).
    # R2: address-filter resolution is fail-closed like the pre-guard above.
    $fwResult = "skipped"
    try {
        $ruleErr = $null
        $allInboundForFleetRule = Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue -ErrorVariable ruleErr
        if ($ruleErr) {
            throw "ACTIVATE_FIREWALL_CREATE_FAILED: unable to enumerate inbound firewall rules."
        }
        $existingRule = @($allInboundForFleetRule | Where-Object { "$($_.DisplayName)" -eq 'OpenSSH Server (Fleet enrollment)' })
        if ($existingRule.Count -gt 1) {
            throw "ACTIVATE_FIREWALL_CREATE_FAILED: multiple existing Fleet firewall rules found; failing closed."
        }
        if ($existingRule.Count -eq 0) { $existingRule = $null }
        else { $existingRule = $existingRule[0] }
        if ($null -ne $existingRule) {
            $faddrErr = $null
            $addr = $existingRule | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue -ErrorVariable faddrErr
            if ($faddrErr) {
                throw "ACTIVATE_FIREWALL_CREATE_FAILED: unable to resolve existing Fleet address filter."
            }
            if ($null -eq $addr) {
                throw "ACTIVATE_FIREWALL_CREATE_FAILED: unresolvable existing Fleet address filter; failing closed."
            }
            $remote = @($addr.RemoteAddress | ForEach-Object { "$_".Trim() })
            # R2 single-scope contract: rerun is idempotent only when observed
            # RemoteAddress is exactly the one intended scope — no subset,
            # superset, or reordered-set matching.
            if ($remote.Count -eq 1 -and (Test-ExactManagementScopeEquivalent -Observed $remote[0] -Intended $scopeNorm)) {
                $fwResult = "already_present"
            } else {
                # Refuse to silently replace a differently-scoped rule — require explicit review
                throw "ACTIVATE_FIREWALL_SCOPE_MISMATCH: Existing firewall rule has different scope; refusing to overwrite without review."
            }
        } else {
            $null = New-NetFirewallRule -DisplayName 'OpenSSH Server (Fleet enrollment)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -RemoteAddress $ManagementSourceScope -Profile Any -Enabled True -ErrorAction Stop
            $fwResult = "created"
        }
    } catch {
        $innerFw = "$($_.Exception.Message)"
        if ($innerFw -match 'ACTIVATE_FIREWALL_SCOPE_MISMATCH|ACTIVATE_FIREWALL_CREATE_FAILED') { throw }
        throw "ACTIVATE_FIREWALL_CREATE_FAILED: failed to create scoped firewall rule."
    }

    # Service activation — explicit, bounded
    $svcResult = "skipped"
    try {
        $svc = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
        if ($null -eq $svc) { throw "ACTIVATE_SSHD_NOT_FOUND: sshd service not found after capability install; failing closed." }
        # Set startup type to Automatic (idempotent)
        $currentStart = "$($svc.StartType)"
        if ($currentStart -ne "Automatic") {
            Set-Service -Name 'sshd' -StartupType Automatic -ErrorAction Stop
            $svcResult = "startup_set"
        } else {
            $svcResult = "startup_already_automatic"
        }
        & sc.exe failure sshd reset= 86400 actions= 'restart/5000/restart/15000/restart/60000' *> $null
        if ($LASTEXITCODE -ne 0) { throw "ACTIVATE_SSHD_RECOVERY_CONFIG_FAILED" }
        & sc.exe failureflag sshd 1 *> $null
        if ($LASTEXITCODE -ne 0) { throw "ACTIVATE_SSHD_RECOVERY_CONFIG_FAILED" }
        $svc = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
        if ("$($svc.Status)" -ne "Running") {
            Start-Service -Name 'sshd' -ErrorAction Stop
            $svcResult = "$svcResult+started"
        } else {
            $svcResult = "$svcResult+already_running"
        }
    } catch {
        $innerSvc = "$($_.Exception.Message)"
        if ($innerSvc -match 'ACTIVATE_SSHD_NOT_FOUND') { throw }
        throw "ACTIVATE_SSHD_START_FAILED: failed to activate sshd service."
    }

    $fingerprints = Get-BoundedFingerprints
    $report['activate'] = [ordered]@{
        authorizedKeysResult = $authResult
        authorizedKeysAclResult = $aclResult
        firewallResult = $fwResult
        firewallRemoteScoped = $true
        serviceResult = $svcResult
        hostKeyFingerprints = $fingerprints
        managementSourceScopeSanitized = "scoped"
        preExposureGuard = "passed"
        preExposureMode = $preExposureMode
    }
    Write-EnrollmentJson -Report ([PSCustomObject]$report)
    exit 0
}

throw "Unknown stage: $Stage"