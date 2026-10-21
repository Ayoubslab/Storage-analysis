# Storage Allocation-Based Scan

A read-only Windows storage-analysis toolkit that discovers every ready local fixed or removable filesystem volume, measures actual file allocation, maps usage hierarchically, detects exact duplicate files, records inaccessible areas, and generates interactive dashboard and report artifacts.

Unlike application lists that rely on estimated installation sizes, this project walks the filesystem and records both logical and allocated bytes. It protects the analysis from common sources of double-counting by identifying hard-linked files and refusing to traverse junctions or symbolic links.

> **Safety:** this project analyzes storage only. It does not delete, move, uninstall, or clean files.

## What it analyzes

- Combined and per-volume capacity, used space, free space, and scan-attributed allocation
- Hierarchical directory and file usage
- Hidden, system, application-data, and program-data locations that are accessible to the current Windows account
- Large folders, individual files, applications, games, downloads, caches, development environments, and virtual disks
- Exact SHA-256 duplicate groups for same-size files above the configured threshold
- Windows-specific consumers such as the page file, hibernation file, swap file, component store evidence, restore-point queries, and reserved-storage queries where permission allows
- Coverage limitations, including inaccessible directories, failed file-identity reads, and protected system-managed storage

## Accuracy controls

- Uses NTFS allocated size rather than only logical file length
- Deduplicates hard-linked data using volume serial number and file ID
- Records secondary hard-link references separately
- Records but does not traverse reparse points, junctions, or symbolic links
- Hashes duplicate candidates with SHA-256 before reporting them as exact duplicates
- Keeps protected or unresolved space as an explicit uncertainty bucket instead of estimating it
- Separates cleanup candidates into conditional-safe, review-required, settings-dependent, and system-tool-only classes

## Start on a clean Windows PC

Download only [`INSTALL-AND-RUN.bat`](https://github.com/Ayoubslab/Storage-analysis/raw/refs/heads/main/INSTALL-AND-RUN.bat), then double-click it. No Git, Node.js, npm, Codex, or manual project download is required.

The bootstrap performs these checks on every launch:

1. Downloads the latest project source from this repository
2. Reuses a compatible Node.js runtime or downloads a portable Node.js 22 LTS runtime into the per-user project directory
3. Verifies the official Node.js ZIP against its published SHA-256 checksum before use
4. Reinstalls the exact dependency tree from both `package-lock.json` files with `npm ci`
5. Runs the project's complete preflight self-check before scanning

The project is installed under `%LOCALAPPDATA%\Storage-Allocation-Based-Scan`. Nothing is installed system-wide and no administrator access is required for installation. Internet access is required for the bootstrap and dependency download.

To install or repair every requirement without starting a disk scan, run:

```bat
INSTALL-AND-RUN.bat -CheckOnly
```

## Run a fresh analysis from an installed project

Double-click:

```text
RUN-STORAGE-ANALYSIS.bat
```

Each execution creates a new timestamped directory under `runs/`, preserving previous results. It scans every ready local fixed or removable filesystem volume detected at startup; network and optical drives are excluded. A complete scan commonly takes 15–30 minutes and can take longer on systems with multiple drives or millions of files. `RUN-STORAGE-ANALYSIS.bat` uses the requirements already provisioned by the bootstrap and does not download updates.

For broader access to protected Windows areas, right-click the batch file and select **Run as administrator**. A normal non-administrator run remains useful, but protected and system-managed space may remain unresolved.

Validate the environment without starting a scan:

```powershell
.\run-analysis.ps1 -DryRun
```

## Generated outputs

Each completed run contains:

```text
runs/<timestamp>/
├── data/                       Raw CSV, compressed CSV, and JSON evidence
├── dashboard-snapshot.json     Reviewed dashboard dataset
├── report-snapshot.json        Reviewed report dataset
├── reviewed-data.json          Normalized analytical model
├── Storage-analysis-dashboard.html  Self-contained interactive dashboard
├── Storage-analysis-report.html     Self-contained detailed report
└── run-summary.txt             Run metadata and output locations
```

The dashboard provides capacity metrics, category charts, a hierarchical treemap, searchable folder and file rankings, cleanup classifications, duplicate groups, and scan-coverage evidence.

## Project structure

| Path | Purpose |
|---|---|
| `INSTALL-AND-RUN.bat` | Clean-PC downloader, requirement repairer, and launcher |
| `bootstrap.ps1` | Per-user portable Node provisioning and locked dependency verification |
| `RUN-STORAGE-ANALYSIS.bat` | Fast launcher after bootstrap installation |
| `run-analysis.ps1` | Safe, timestamped orchestration pipeline |
| `scan-storage.ps1` | Allocation-aware NTFS scanner and duplicate hasher |
| `collect-system-evidence.ps1` | Windows volumes, special files, installed applications, sleep states, and protected-storage queries |
| `analyze-storage.mjs` | Converts raw evidence into the reviewed analytical model |
| `build-dashboard-snapshot.mjs` | Produces the dashboard data contract |
| `build-report-snapshot.mjs` | Produces the report data contract |
| `dashboard/` | Interactive dashboard source |
| `report/` | Detailed analytical report source |

## Requirements

- Windows 10 or Windows 11
- PowerShell 5.1 or later
- Internet access for the initial bootstrap and dependency verification

PowerShell 5.1 is included with supported Windows versions. The clean-PC launcher provisions the compatible portable Node.js and npm runtime itself. The application has no Codex runtime dependency.

The standalone scan and build path does not read Codex files, require Codex credentials, or call Codex APIs. The completed dashboard and report are self-contained HTML files that open directly in a normal web browser.

## Privacy

Storage inventories can reveal usernames, application names, private directory names, and document filenames. Raw scans, reviewed datasets, generated dashboards, screenshots, and future run directories are excluded from Git by default. Review generated evidence carefully before sharing it.

## Repository publishing policy

Only reusable project files belong in this repository:

- Batch and PowerShell launchers and scanners
- Node.js analysis and snapshot builders
- Dashboard and report source code
- Dependency manifests and lockfiles
- Generic documentation and tests

The following stay on the computer that performed the scan and must not be committed:

- Raw file inventories, duplicate lists, and Windows system evidence
- Reviewed datasets and dashboard/report snapshots
- Generated HTML reports, screenshots, logs, and test output
- `node_modules`, portable runtimes, caches, editor settings, local environment files, and credentials

These exclusions are enforced by [`.gitignore`](.gitignore). Before publishing changes, verify the boundary with:

```powershell
git status --short --ignored
git diff --check
```

## Limitations

- Administrator access improves coverage but does not guarantee that every Windows-managed byte can be assigned to a normal file.
- NTFS metadata, Volume Shadow Copies, restore points, reserved storage, and component-store accounting may require elevated Windows tools.
- Files that change while the scan is running can produce small differences between filesystem totals and Windows' volume-level used-space figure.
- Duplicate recovery values are candidates for review, not automatic deletion recommendations; identical files can be required in separate application locations.
- Virtual-disk images should be reduced using Docker, WSL, or the owning application's supported tools rather than deleted directly.

## Design principle

Every result should distinguish:

1. What was directly measured
2. What could not be accessed or attributed
3. What may be safe to reclaim
4. What requires human review
5. What must remain under Windows or application control
