param(
    [Parameter(Mandatory = $true)]
    [string] $OutputPath,
    [string[]] $Roots
)

$ErrorActionPreference = 'Continue'
if (-not $Roots) {
    $eligibleTypes = @([IO.DriveType]::Fixed, [IO.DriveType]::Removable)
    $Roots = @([IO.DriveInfo]::GetDrives() |
        Where-Object { $_.IsReady -and $eligibleTypes -contains $_.DriveType } |
        ForEach-Object { $_.RootDirectory.FullName } |
        Sort-Object -Unique)
}

function Invoke-CapturedCommand {
    param([string] $FilePath, [string[]] $ArgumentList)
    try {
        $output = & $FilePath @ArgumentList 2>&1 | Out-String
        [ordered]@{ command = "$FilePath $($ArgumentList -join ' ')"; exit_code = $LASTEXITCODE; output = $output.Trim() }
    } catch {
        [ordered]@{ command = "$FilePath $($ArgumentList -join ' ')"; exit_code = $null; output = $_.Exception.Message }
    }
}

function Get-OptionalPropertyValue {
    param($InputObject, [string] $Name)
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

$volumeRows = @(Get-Volume | ForEach-Object {
    [ordered]@{
        drive_letter = [string]$_.DriveLetter
        label = [string]$_.FileSystemLabel
        file_system = [string]$_.FileSystem
        drive_type = [string]$_.DriveType
        health_status = [string]$_.HealthStatus
        size_bytes = [long]$_.Size
        free_bytes = [long]$_.SizeRemaining
        path = [string]$_.Path
    }
})

$diskRows = @(Get-PhysicalDisk | ForEach-Object {
    [ordered]@{
        friendly_name = [string]$_.FriendlyName
        media_type = [string]$_.MediaType
        bus_type = [string]$_.BusType
        health_status = [string]$_.HealthStatus
        size_bytes = [long]$_.Size
    }
})

$specialFiles = @()
foreach ($root in $Roots) {
foreach ($name in @('pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'DumpStack.log.tmp', 'MEMORY.DMP')) {
    $specialPath = Join-Path $root $name
    try {
        $item = Get-Item -LiteralPath $specialPath -Force -ErrorAction Stop
        $specialFiles += [ordered]@{ path = $specialPath; visible = $true; logical_bytes = [long]$item.Length; error = $null }
    } catch {
        $specialFiles += [ordered]@{ path = $specialPath; visible = $false; logical_bytes = $null; error = $_.Exception.Message }
    }
}
}

$pageFiles = @()
try {
    $pageFiles = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object {
        [ordered]@{
            name = [string]$_.Name
            allocated_base_mb = [long]$_.AllocatedBaseSize
            current_usage_mb = [long]$_.CurrentUsage
            peak_usage_mb = [long]$_.PeakUsage
            temp_page_file = [bool]$_.TempPageFile
        }
    })
} catch { $pageFiles = @([ordered]@{ error = $_.Exception.Message }) }

$installedApplications = @()
foreach ($registryPath in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)) {
    try {
        $installedApplications += @(Get-ItemProperty $registryPath -ErrorAction SilentlyContinue | ForEach-Object {
            $displayName = Get-OptionalPropertyValue $_ 'DisplayName'
            if ([string]::IsNullOrWhiteSpace([string]$displayName)) { return }
            $estimatedSize = Get-OptionalPropertyValue $_ 'EstimatedSize'
            [ordered]@{
                display_name = [string]$displayName
                display_version = [string](Get-OptionalPropertyValue $_ 'DisplayVersion')
                publisher = [string](Get-OptionalPropertyValue $_ 'Publisher')
                install_date = [string](Get-OptionalPropertyValue $_ 'InstallDate')
                install_location = [string](Get-OptionalPropertyValue $_ 'InstallLocation')
                estimated_size_kb = if ($null -eq $estimatedSize) { $null } else { [long]$estimatedSize }
                registry_key = [string](Get-OptionalPropertyValue $_ 'PSPath')
            }
        })
    } catch {
        $installedApplications += [ordered]@{ registry_path = $registryPath; error = $_.Exception.Message }
    }
}

$appxPackages = @()
try {
    $appxPackages = @(Get-AppxPackage | ForEach-Object {
        [ordered]@{
            name = [string]$_.Name
            package_full_name = [string]$_.PackageFullName
            version = [string]$_.Version
            publisher = [string]$_.Publisher
            install_location = [string]$_.InstallLocation
            architecture = [string]$_.Architecture
            is_framework = [bool]$_.IsFramework
            non_removable = [bool]$_.NonRemovable
        }
    })
} catch { $appxPackages = @([ordered]@{ error = $_.Exception.Message }) }

$shadowStorage = @()
try {
    $shadowStorage = @(Get-CimInstance Win32_ShadowStorage | ForEach-Object {
        [ordered]@{
            allocated_space_bytes = [long]$_.AllocatedSpace
            used_space_bytes = [long]$_.UsedSpace
            max_space_bytes = [long]$_.MaxSpace
            volume = [string]$_.Volume
            diff_volume = [string]$_.DiffVolume
        }
    })
} catch { $shadowStorage = @([ordered]@{ error = $_.Exception.Message }) }

$shadowCopies = @()
try {
    $shadowCopies = @(Get-CimInstance Win32_ShadowCopy | ForEach-Object {
        [ordered]@{
            id = [string]$_.ID
            install_date = [string]$_.InstallDate
            volume_name = [string]$_.VolumeName
            device_object = [string]$_.DeviceObject
            state = [string]$_.State
        }
    })
} catch { $shadowCopies = @([ordered]@{ error = $_.Exception.Message }) }

$restorePoints = @()
try {
    $restorePoints = @(Get-ComputerRestorePoint | ForEach-Object {
        [ordered]@{
            sequence_number = [long]$_.SequenceNumber
            creation_time = [string]$_.CreationTime
            description = [string]$_.Description
            restore_point_type = [long]$_.RestorePointType
        }
    })
} catch { $restorePoints = @([ordered]@{ error = $_.Exception.Message }) }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)

$diskFreeCommands = @($Roots | ForEach-Object {
    Invoke-CapturedCommand 'fsutil.exe' @('volume', 'diskfree', $_.TrimEnd('\'))
})
$ntfsInfoCommands = @($Roots | ForEach-Object {
    Invoke-CapturedCommand 'fsutil.exe' @('fsinfo', 'ntfsinfo', $_.TrimEnd('\'))
})

$evidence = [ordered]@{
    captured_utc = [DateTime]::UtcNow.ToString('o')
    user = $identity.Name
    is_administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    volumes = $volumeRows
    physical_disks = $diskRows
    special_files = $specialFiles
    page_files = $pageFiles
    installed_applications = $installedApplications
    appx_packages = $appxPackages
    shadow_storage = $shadowStorage
    shadow_copies = $shadowCopies
    restore_points = $restorePoints
    commands = [ordered]@{
        fsutil_diskfree = $diskFreeCommands
        fsutil_ntfsinfo = $ntfsInfoCommands
        component_store = Invoke-CapturedCommand 'dism.exe' @('/Online', '/Cleanup-Image', '/AnalyzeComponentStore', '/English')
        reserved_storage = Invoke-CapturedCommand 'dism.exe' @('/Online', '/Get-ReservedStorageState', '/English')
        shadow_storage = Invoke-CapturedCommand 'vssadmin.exe' @('list', 'shadowstorage')
        shadow_copies = Invoke-CapturedCommand 'vssadmin.exe' @('list', 'shadows')
        compact_os = Invoke-CapturedCommand 'compact.exe' @('/CompactOS:query')
        sleep_states = Invoke-CapturedCommand 'powercfg.exe' @('/a')
    }
}

$json = $evidence | ConvertTo-Json -Depth 8
$fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($fullOutputPath)) | Out-Null
[System.IO.File]::WriteAllText($fullOutputPath, $json, [System.Text.UTF8Encoding]::new($false))
$json
