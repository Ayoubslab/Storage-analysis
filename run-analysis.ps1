param(
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$runRoot = Join-Path $projectRoot "runs\$runId"
$dataDirectory = Join-Path $runRoot 'data'

function Assert-NativeSuccess {
    param([string] $Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

function Get-ScanRoots {
    $eligibleTypes = @([IO.DriveType]::Fixed, [IO.DriveType]::Removable)
    $roots = @([IO.DriveInfo]::GetDrives() |
        Where-Object { $_.IsReady -and $eligibleTypes -contains $_.DriveType } |
        ForEach-Object { $_.RootDirectory.FullName } |
        Sort-Object -Unique)
    if ($roots.Count -eq 0) {
        throw 'No accessible fixed or removable local storage volumes were found.'
    }
    return $roots
}

function Find-Node {
    $candidates = @(
        $env:STORAGE_SCAN_NODE,
        (Join-Path $projectRoot '.runtime\node\node.exe')
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    throw 'Node.js was not found. Run INSTALL-AND-RUN.bat to provision the verified portable runtime.'
}

function Find-Npm {
    param([string] $NodePath)

    $candidates = @(
        $env:STORAGE_SCAN_NPM,
        (Join-Path (Split-Path -Parent $NodePath) 'npm.cmd')
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    throw 'npm was not found beside Node.js or on PATH. Run INSTALL-AND-RUN.bat to repair the runtime.'
}

function Assert-SupportedNode {
    param([string] $NodePath)

    $versionText = (& $NodePath -p 'process.versions.node').Trim()
    Assert-NativeSuccess 'Node.js version check'
    $version = [version] $versionText
    $supported = (($version.Major -eq 20 -and $version -ge [version] '20.19.0') -or
        ($version.Major -ge 22 -and $version -ge [version] '22.12.0'))
    if (-not $supported) {
        throw "Node.js $versionText is not supported. Vite requires Node.js 20.19+ or 22.12+. Run INSTALL-AND-RUN.bat to provision a compatible runtime."
    }
    return $versionText
}

$requiredFiles = @(
    'scan-storage.ps1',
    'collect-system-evidence.ps1',
    'analyze-storage.mjs',
    'build-dashboard-snapshot.mjs',
    'build-report-snapshot.mjs',
    'dashboard\package.json',
    'dashboard\package-lock.json',
    'dashboard\src\content\dashboard\DashboardContent.jsx',
    'report\package.json',
    'report\package-lock.json',
    'report\src\content\report\ReportContent.jsx'
)
foreach ($relativePath in $requiredFiles) {
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Required project file is missing: $relativePath" }
}

$node = Find-Node
$npm = Find-Npm -NodePath $node
$nodeVersion = Assert-SupportedNode -NodePath $node
$scanRoots = @(Get-ScanRoots)

$requiredBuildTools = @(
    'dashboard\node_modules\.bin\vite.cmd',
    'report\node_modules\.bin\vite.cmd'
)
foreach ($relativePath in $requiredBuildTools) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath) -PathType Leaf)) {
        throw "Build dependency is missing: $relativePath. Run INSTALL-AND-RUN.bat to install or repair all locked dependencies."
    }
}

$isAdministrator = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

Write-Host 'Storage allocation-based scan' -ForegroundColor Cyan
Write-Host "Project: $projectRoot"
Write-Host "Scan roots: $($scanRoots -join ', ')"
Write-Host "Administrator: $isAdministrator"
Write-Host "Node.js: $nodeVersion ($node)"
Write-Host "npm: $npm"
if (-not $isAdministrator) {
    Write-Warning 'Protected Windows areas, shadow storage, restore points, reserved storage, and some NTFS metadata may remain unresolved. Run as administrator for broader coverage.'
}

if ($DryRun) {
    Write-Host 'Self-check passed. No scan or output files were created.' -ForegroundColor Green
    return
}

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
Write-Host "Run output: $runRoot"

Write-Host '[1/6] Scanning all accessible local storage volumes and exact duplicate candidates...'
& (Join-Path $projectRoot 'scan-storage.ps1') -Roots $scanRoots -OutputDirectory $dataDirectory

Write-Host '[2/6] Collecting Windows volume, system-file, and application evidence...'
& (Join-Path $projectRoot 'collect-system-evidence.ps1') -Roots $scanRoots -OutputPath (Join-Path $dataDirectory 'system_evidence.json')

$reviewedData = Join-Path $runRoot 'reviewed-data.json'
$dashboardSnapshot = Join-Path $runRoot 'dashboard-snapshot.json'
$reportSnapshot = Join-Path $runRoot 'report-snapshot.json'
$sourcePrefix = "runs/$runId/data"

Write-Host '[3/6] Building the reviewed analysis dataset...'
& $node (Join-Path $projectRoot 'analyze-storage.mjs') $dataDirectory $reviewedData
Assert-NativeSuccess 'Dataset analysis'

Write-Host '[4/6] Building dashboard and report snapshots...'
& $node (Join-Path $projectRoot 'build-dashboard-snapshot.mjs') $reviewedData $dashboardSnapshot $sourcePrefix
Assert-NativeSuccess 'Dashboard snapshot generation'
& $node (Join-Path $projectRoot 'build-report-snapshot.mjs') $dashboardSnapshot $reportSnapshot
Assert-NativeSuccess 'Report snapshot generation'

Write-Host '[5/6] Compiling self-contained interactive HTML files...'
Copy-Item -LiteralPath $dashboardSnapshot -Destination (Join-Path $projectRoot 'dashboard\src\data.json') -Force
Copy-Item -LiteralPath $reportSnapshot -Destination (Join-Path $projectRoot 'report\src\data.json') -Force

$previousPath = $env:PATH
$env:PATH = "$(Split-Path -Parent $node);$previousPath"
try {
    Push-Location (Join-Path $projectRoot 'dashboard')
    try {
        & $npm run build
        Assert-NativeSuccess 'Dashboard build'
    }
    finally { Pop-Location }

    Push-Location (Join-Path $projectRoot 'report')
    try {
        & $npm run build
        Assert-NativeSuccess 'Report build'
    }
    finally { Pop-Location }
}
finally {
    $env:PATH = $previousPath
}

Write-Host '[6/6] Saving the portable dashboard and report...'
$dashboardHtml = Join-Path $runRoot 'Storage-analysis-dashboard.html'
$reportHtml = Join-Path $runRoot 'Storage-analysis-report.html'
Copy-Item -LiteralPath (Join-Path $projectRoot 'dashboard\dist\index.html') -Destination $dashboardHtml -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'report\dist\index.html') -Destination $reportHtml -Force

@"
Storage allocation-based scan completed
Run: $runId
Output: $runRoot
Scan roots: $($scanRoots -join ', ')
Administrator: $isAdministrator
Node.js: $nodeVersion
Dashboard: $dashboardHtml
Report: $reportHtml
No files were deleted, moved, uninstalled, or cleaned.
"@ | Set-Content -LiteralPath (Join-Path $runRoot 'run-summary.txt') -Encoding UTF8

$runRoot | Set-Content -LiteralPath (Join-Path $projectRoot 'LATEST-RUN.txt') -Encoding UTF8

Write-Host ''
Write-Host 'Analysis complete.' -ForegroundColor Green
Write-Host "Dashboard: $dashboardHtml"
Write-Host "Report: $reportHtml"
Write-Host 'No cleanup actions were performed.'
Start-Process -FilePath $dashboardHtml
