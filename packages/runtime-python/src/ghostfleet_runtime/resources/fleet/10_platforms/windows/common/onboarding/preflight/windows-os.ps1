# Shared read-only CIM projection. No raw exception or extra CIM properties escape.
function Get-FleetWindowsOs {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    return [ordered]@{
        caption = [string]$os.Caption
        version = [string]$os.Version
        buildNumber = [string]$os.BuildNumber
        osArchitecture = [string]$os.OSArchitecture
    }
}
