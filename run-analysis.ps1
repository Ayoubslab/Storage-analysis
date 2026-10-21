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

function Find-Node {
    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundled) { return $bundled }

    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    throw 'Node.js was not found on PATH or in the Codex bundled runtime.'
}

function Find-DataAppBuilder {
    $pattern = Join-Path $env:USERPROFILE '.codex\plugins\cache\openai-curated-remote\data-analytics\*\scripts\data-app.mjs'
    $builder = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($builder) { return $builder.FullName }
    throw 'The Codex Data Analytics runtime was not found. Reinstall or enable the data-analytics plugin before rerunning the full visual report.'
}

$requiredFiles = @(
    'scan-storage.ps1',
    'collect-system-evidence.ps1',
    'analyze-storage.mjs',
    'build-dashboard-snapshot.mjs',
    'build-report-snapshot.mjs',
    'dashboard\src\content\dashboard\DashboardContent.jsx',
    'report\src\content\report\ReportContent.jsx'
)
foreach ($relativePath in $requiredFiles) {
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath)) { throw "Required project file is missing: $relativePath" }
}

$node = Find-Node
$dataAppBuilder = Find-DataAppBuilder
$isAdministrator = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

Write-Host 'SSD allocation-based scan' -ForegroundColor Cyan
Write-Host "Project: $projectRoot"
Write-Host 'Scan root: C:\'
Write-Host "Administrator: $isAdministrator"
Write-Host "Node.js: $node"
Write-Host "Data app builder: $dataAppBuilder"
if (-not $isAdministrator) {
    Write-Warning 'Protected Windows areas, shadow storage, restore points, reserved storage, and some NTFS metadata may remain unresolved. Run as administrator for broader coverage.'
}

if ($DryRun) {
    Write-Host 'Dry run passed. No scan or output files were created.' -ForegroundColor Green
    exit 0
}

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
Write-Host "Run output: $runRoot"

Write-Host '[1/7] Scanning allocated file storage and exact duplicate candidates...'
& (Join-Path $projectRoot 'scan-storage.ps1') -Roots 'C:\' -OutputDirectory $dataDirectory

Write-Host '[2/7] Collecting Windows volume, system-file, and application evidence...'
& (Join-Path $projectRoot 'collect-system-evidence.ps1') -OutputPath (Join-Path $dataDirectory 'system_evidence.json')

$reviewedData = Join-Path $runRoot 'reviewed-data.json'
$dashboardSnapshot = Join-Path $runRoot 'dashboard-snapshot.json'
$reportSnapshot = Join-Path $runRoot 'report-snapshot.json'
$sourcePrefix = "runs/$runId/data"

Write-Host '[3/7] Building the reviewed analysis dataset...'
& $node (Join-Path $projectRoot 'analyze-storage.mjs') $dataDirectory $reviewedData
Assert-NativeSuccess 'Dataset analysis'

Write-Host '[4/7] Building dashboard and report snapshots...'
& $node (Join-Path $projectRoot 'build-dashboard-snapshot.mjs') $reviewedData $dashboardSnapshot $sourcePrefix
Assert-NativeSuccess 'Dashboard snapshot generation'
& $node (Join-Path $projectRoot 'build-report-snapshot.mjs') $dashboardSnapshot $reportSnapshot
Assert-NativeSuccess 'Report snapshot generation'

Write-Host '[5/7] Preparing isolated visualization projects for this run...'
Copy-Item -LiteralPath (Join-Path $projectRoot 'dashboard') -Destination $runRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'report') -Destination $runRoot -Recurse -Force
Copy-Item -LiteralPath $dashboardSnapshot -Destination (Join-Path $runRoot 'dashboard\src\data.json') -Force
Copy-Item -LiteralPath $reportSnapshot -Destination (Join-Path $runRoot 'report\src\data.json') -Force

Write-Host '[6/7] Compiling the interactive dashboard and detailed report...'
$dashboardProject = Join-Path $runRoot 'dashboard'
$reportProject = Join-Path $runRoot 'report'
& $node $dataAppBuilder build --project-dir $dashboardProject --separate-data
Assert-NativeSuccess 'Dashboard build'
& $node $dataAppBuilder build --project-dir $reportProject --separate-data
Assert-NativeSuccess 'Report build'

Write-Host '[7/7] Exporting portable offline HTML files...'
$dashboardHtml = Join-Path $dashboardProject '.data-app-offline\exports\SSD-storage-dashboard.html'
$reportHtml = Join-Path $reportProject '.data-app-offline\exports\SSD-storage-report.html'
& $node $dataAppBuilder export-offline --project-dir $dashboardProject --output $dashboardHtml
Assert-NativeSuccess 'Dashboard offline export'
& $node $dataAppBuilder export-offline --project-dir $reportProject --output $reportHtml
Assert-NativeSuccess 'Report offline export'

@"
SSD allocation-based scan completed
Run: $runId
Output: $runRoot
Administrator: $isAdministrator
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
