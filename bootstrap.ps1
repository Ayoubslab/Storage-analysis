param(
    [switch] $CheckOnly,
    [string] $InstallRoot = (Join-Path $env:LOCALAPPDATA 'SSD-Allocation-Based-Scan'),
    [string] $SourceDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repositoryArchive = 'https://github.com/Ayoubslab/Storage-analysis/archive/refs/heads/main.zip'
$nodeReleaseRoot = 'https://nodejs.org/dist/latest-v22.x'
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("ssd-allocation-bootstrap-{0}" -f [guid]::NewGuid().ToString('N'))

function Assert-NativeSuccess {
    param([string] $Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

function Get-NodeVersion {
    param([string] $NodePath)
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $null }
    try {
        $text = (& $NodePath -p 'process.versions.node' 2>$null).Trim()
        if ($LASTEXITCODE -ne 0) { return $null }
        return [version] $text
    }
    catch {
        Write-Warning "Could not use Node.js candidate '$NodePath': $($_.Exception.Message)"
        return $null
    }
}

function Test-SupportedNode {
    param([version] $Version)
    if (-not $Version) { return $false }
    return (($Version.Major -eq 20 -and $Version -ge [version] '20.19.0') -or
        ($Version.Major -ge 22 -and $Version -ge [version] '22.12.0'))
}

function Find-UsableNode {
    $candidates = @(
        @(
            $env:SSD_SCAN_NODE,
            (Join-Path $InstallRoot '.runtime\node\node.exe')
        ) | Where-Object { $_ }
    )

    $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }

    foreach ($candidate in $candidates) {
        Write-Host "Checking Node.js candidate: $candidate"
        $version = Get-NodeVersion -NodePath $candidate
        if ($version) {
            Write-Host "Checked Node.js $version at $candidate"
        }
        if (Test-SupportedNode -Version $version) {
            $resolvedNode = (Resolve-Path -LiteralPath $candidate).Path
            $npmPath = Join-Path (Split-Path -Parent $resolvedNode) 'npm.cmd'
            if (Test-Path -LiteralPath $npmPath -PathType Leaf) {
                return [pscustomobject]@{ Path = $resolvedNode; NpmPath = $npmPath; Version = $version }
            }
            Write-Warning "The Node.js candidate has no matching npm.cmd and will not be used: $candidate"
        }
    }
    return $null
}

function Get-WindowsNodeArchitecture {
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($architecture.ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        'X86' { return 'x86' }
        default { throw "Unsupported Windows architecture: $architecture" }
    }
}

function Install-PortableNode {
    param([string] $Architecture)

    Write-Host 'No compatible Node.js runtime was found.' -ForegroundColor Yellow
    Write-Host 'Downloading the official portable Node.js 22 LTS package...'

    $checksumPath = Join-Path $temporaryRoot 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing -Uri "$nodeReleaseRoot/SHASUMS256.txt" -OutFile $checksumPath
    $checksumText = Get-Content -LiteralPath $checksumPath -Raw
    $pattern = "(?m)^([0-9a-fA-F]{64})\s+(node-v[0-9.]+-win-$Architecture\.zip)$"
    $match = [regex]::Match($checksumText, $pattern)
    if (-not $match.Success) {
        throw "The official Node.js checksum list does not contain a Windows $Architecture ZIP."
    }

    $expectedHash = $match.Groups[1].Value.ToUpperInvariant()
    $archiveName = $match.Groups[2].Value
    $archivePath = Join-Path $temporaryRoot $archiveName
    Invoke-WebRequest -UseBasicParsing -Uri "$nodeReleaseRoot/$archiveName" -OutFile $archivePath

    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Node.js download checksum mismatch. Expected $expectedHash but received $actualHash."
    }

    $extractRoot = Join-Path $temporaryRoot 'node-extracted'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
    $extractedDirectory = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    if (-not $extractedDirectory -or -not (Test-Path -LiteralPath (Join-Path $extractedDirectory.FullName 'node.exe'))) {
        throw 'The downloaded Node.js archive did not contain the expected runtime.'
    }

    $runtimeRoot = Join-Path $InstallRoot '.runtime'
    $nodeDestination = Join-Path $runtimeRoot 'node'
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    if (Test-Path -LiteralPath $nodeDestination) {
        $backupName = 'node-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Move-Item -LiteralPath $nodeDestination -Destination (Join-Path $runtimeRoot $backupName)
    }
    Move-Item -LiteralPath $extractedDirectory.FullName -Destination $nodeDestination

    $nodePath = Join-Path $nodeDestination 'node.exe'
    $version = Get-NodeVersion -NodePath $nodePath
    if (-not (Test-SupportedNode -Version $version)) {
        throw 'The portable Node.js runtime failed its post-installation version check.'
    }
    $npmPath = Join-Path $nodeDestination 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
        throw 'The portable Node.js archive did not contain npm.cmd.'
    }
    return [pscustomobject]@{ Path = $nodePath; NpmPath = $npmPath; Version = $version }
}

function Copy-ProjectSource {
    param([string] $Source)
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $InstallRoot -Recurse -Force
    }
}

if ($PSVersionTable.PSVersion -lt [version] '5.1') {
    throw "PowerShell 5.1 or later is required. Found $($PSVersionTable.PSVersion)."
}
if ($env:OS -ne 'Windows_NT') {
    throw 'This bootstrap is designed for Windows 10 and Windows 11.'
}
if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is unavailable, so a per-user installation directory cannot be created.'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

Write-Host 'SSD Allocation-Based Scan - bootstrap' -ForegroundColor Cyan
Write-Host "Installation: $InstallRoot"
Write-Host 'No system-wide software will be installed.'

New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
    if ($SourceDirectory) {
        $resolvedSource = (Resolve-Path -LiteralPath $SourceDirectory).Path
        Write-Host "Using local project source: $resolvedSource"
        Copy-ProjectSource -Source $resolvedSource
    }
    else {
        Write-Host '[1/5] Downloading the latest project release from GitHub...'
        $projectArchive = Join-Path $temporaryRoot 'Storage-analysis-main.zip'
        $projectExtract = Join-Path $temporaryRoot 'project'
        Invoke-WebRequest -UseBasicParsing -Uri $repositoryArchive -OutFile $projectArchive
        Expand-Archive -LiteralPath $projectArchive -DestinationPath $projectExtract -Force
        $projectSource = Get-ChildItem -LiteralPath $projectExtract -Directory | Select-Object -First 1
        if (-not $projectSource -or -not (Test-Path -LiteralPath (Join-Path $projectSource.FullName 'run-analysis.ps1'))) {
            throw 'The downloaded project archive is incomplete.'
        }
        Copy-ProjectSource -Source $projectSource.FullName
    }

    Write-Host '[2/5] Checking the Node.js runtime...'
    $node = Find-UsableNode
    if (-not $node) {
        $node = Install-PortableNode -Architecture (Get-WindowsNodeArchitecture)
    }
    Write-Host "Node.js $($node.Version) ready: $($node.Path)" -ForegroundColor Green

    $nodeDirectory = Split-Path -Parent $node.Path
    $npm = $node.NpmPath

    $previousPath = $env:PATH
    $env:PATH = "$nodeDirectory;$previousPath"
    $env:SSD_SCAN_NODE = $node.Path
    $env:SSD_SCAN_NPM = $npm
    try {
        Write-Host '[3/5] Reinstalling and verifying locked dashboard dependencies...'
        Push-Location (Join-Path $InstallRoot 'dashboard')
        try {
            & $npm ci --no-audit --no-fund
            Assert-NativeSuccess 'Dashboard dependency installation'
        }
        finally { Pop-Location }

        Write-Host '[4/5] Reinstalling and verifying locked report dependencies...'
        Push-Location (Join-Path $InstallRoot 'report')
        try {
            & $npm ci --no-audit --no-fund
            Assert-NativeSuccess 'Report dependency installation'
        }
        finally { Pop-Location }

        Write-Host '[5/5] Running the complete preflight self-check...'
        $runner = Join-Path $InstallRoot 'run-analysis.ps1'
        & $runner -DryRun

        if ($CheckOnly) {
            Write-Host ''
            Write-Host 'All requirements are installed and verified. No disk scan was started.' -ForegroundColor Green
            return
        }

        Write-Host ''
        Write-Host 'Requirements are ready. Starting the read-only storage analysis...' -ForegroundColor Green
        & $runner
    }
    finally {
        $env:PATH = $previousPath
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        $resolvedTemporaryRoot = [IO.Path]::GetFullPath($temporaryRoot).TrimEnd('\') + '\'
        $resolvedSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if ($resolvedTemporaryRoot.StartsWith($resolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
