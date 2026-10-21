import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.resolve(process.argv[2] ?? './storage-analysis/reviewed-data.json');
const outputPath = path.resolve(process.argv[3] ?? './storage-analysis/dashboard-snapshot.json');
const sourcePrefix = process.argv[4] ?? 'storage-analysis/data';
const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const sourceFiles = data.provenance.source_files.map((file) => `${sourcePrefix}/${file}`);
const executedAt = data.metadata.generated_utc;
const scannedRoots = (data.drive.scanned_volumes ?? []).map((volume) => `${volume.drive_letter}:`);

function source(label, files, caveats = [], metricDefinitions = []) {
  return {
    label,
    provider: 'Local NTFS read-only scan',
    files,
    sourceFiles: files,
    executedAt,
    filters: [
      `${scannedRoots.join(', ')} inventory captured ${data.metadata.scan_started_utc} to ${data.metadata.scan_completed_utc}`,
      `Duplicate content hashing threshold: ${data.metadata.duplicate_hash_threshold_bytes} bytes`,
    ],
    caveats,
    metricDefinitions,
    evidenceFlow: [
      { title: 'Enumerate', detail: 'Recursively enumerated all accessible local fixed and removable volumes without following directory reparse points.' },
      { title: 'Measure allocation', detail: 'Read NTFS allocation size and file identity using Windows file-handle metadata.' },
      { title: 'Deduplicate filesystem identities', detail: 'Counted each NTFS volume/file ID once; retained extra hard-link references separately.' },
      { title: 'Aggregate and classify', detail: 'Aggregated unique allocated bytes to directories, categories, rankings, and cleanup review classes.' },
      { title: 'Confirm duplicate content', detail: 'SHA-256 hashed same-size candidate files at or above 10 MiB.' },
    ],
  };
}

const snapshot = {
  id: 'dashboard:05f9d42a-3417-4513-86b1-8df413fbd24f',
  surface: 'dashboard',
  title: 'Storage allocation analysis',
  generatedAt: executedAt,
  status: 'observed',
  buildStatus: 'complete',
  filters: [],
  queries: {
    drive_summary: {
      rows: [{
        drive: scannedRoots.join(', '),
        volume_count: scannedRoots.length,
        capacity_bytes: data.drive.capacity_bytes,
        used_bytes: data.drive.used_bytes,
        free_bytes: data.drive.free_bytes,
        scan_visible_bytes: data.drive.scan_visible_allocated_bytes,
        unaccounted_bytes: data.drive.unaccounted_or_protected_bytes,
        visible_share_of_used: data.drive.scan_visible_share_of_used,
        unique_files: data.scan.unique_files,
        directories: data.scan.directories,
        hardlink_references_skipped: data.scan.hardlink_references_skipped,
        duplicate_recoverable_bytes: data.duplicates.recoverable_bytes,
        duplicate_group_count: data.duplicates.group_count,
      }],
      source: source('Windows volume metadata and NTFS file inventory', sourceFiles, [
        'The process was not elevated. Restore-point/shadow-storage allocation, reserved storage, DISM component-store analysis, and NTFS metadata totals could not be queried.',
        'Unaccounted bytes are the difference between Windows-reported used space and directly scanned unique file allocation at the evidence capture time.',
      ], [
        { label: 'Scan-visible allocated bytes', definition: 'NTFS allocation size summed once per unique volume/file identity.', componentIds: ['capacity-summary', 'accounting-waterfall'] },
        { label: 'Unaccounted/protected bytes', definition: 'Windows-reported used bytes minus scan-visible allocated bytes; includes protected allocations, filesystem metadata, and timing differences.', formula: 'used_bytes - scan_visible_bytes', dependencies: ['used_bytes', 'scan_visible_bytes'], componentIds: ['coverage-card', 'accounting-waterfall'] },
      ]),
    },
    volumes: {
      rows: (data.drive.scanned_volumes ?? []).map((volume) => ({
        drive: `${volume.drive_letter}:`,
        label: volume.label,
        file_system: volume.file_system,
        drive_type: volume.drive_type,
        capacity_bytes: volume.capacity_bytes,
        used_bytes: volume.used_bytes,
        free_bytes: volume.free_bytes,
        scan_visible_bytes: volume.scan_visible_allocated_bytes,
        unaccounted_bytes: volume.unaccounted_or_protected_bytes,
        used_percent: volume.capacity_bytes ? volume.used_bytes / volume.capacity_bytes : null,
      })),
      source: source('Per-volume Windows metadata and measured allocation', sourceFiles, [
        'Only ready local fixed and removable filesystem volumes are scanned; optical and network drives are excluded.',
      ]),
    },
    categories: {
      rows: data.breakdowns.categories.map((row) => ({
        category: row.name,
        allocated_bytes: row.allocated_bytes,
        allocated_gib: row.allocated_bytes / 2 ** 30,
        file_count: row.file_count,
        percent_used: data.drive.used_bytes ? row.allocated_bytes / data.drive.used_bytes : null,
        percent_capacity: data.drive.capacity_bytes ? row.allocated_bytes / data.drive.capacity_bytes : null,
      })),
      source: source('Classified unique file inventory', ['storage-analysis/data/files.csv.gz'], [
        'Categories are mutually exclusive path-based classifications and sum to scan-visible allocated bytes.',
        'Classification is analytical, not an uninstall recommendation.',
      ]),
    },
    top_level: {
      rows: data.breakdowns.top_level.map((row) => ({
        path: row.path,
        allocated_bytes: row.allocated_bytes,
        allocated_gib: row.allocated_bytes / 2 ** 30,
        logical_bytes: row.logical_bytes,
        file_count: row.file_count,
        percent_used: data.drive.used_bytes ? row.allocated_bytes / data.drive.used_bytes : null,
      })),
      source: source('Aggregated NTFS directory inventory', ['storage-analysis/data/directories.csv.gz']),
    },
    top_directories: {
      rows: data.rankings.top_directories.map((row, index) => ({
        rank: index + 1,
        path: row.path,
        parent: row.parent,
        allocated_bytes: row.allocated_bytes,
        allocated_gib: row.allocated_bytes / 2 ** 30,
        logical_bytes: row.logical_bytes,
        file_count: row.file_count,
        unknown_identity_files: row.unknown_identity_files,
        percent_used: data.drive.used_bytes ? row.allocated_bytes / data.drive.used_bytes : null,
      })),
      source: source('Aggregated NTFS directory inventory', ['storage-analysis/data/directories.csv.gz'], [
        'Ranked directories are nested and therefore overlap; do not add them together.',
        'Hard-linked content is attributed to the first encountered link path and omitted from later link paths.',
      ]),
    },
    large_files: {
      rows: data.rankings.large_files.map((row) => ({
        rank: row.rank,
        path: row.path,
        allocated_bytes: row.allocated_bytes,
        allocated_gib: row.allocated_bytes / 2 ** 30,
        logical_bytes: row.logical_bytes,
        last_write_utc: row.last_write_utc,
        age_bucket: row.age_bucket,
        percent_used: data.drive.used_bytes ? row.allocated_bytes / data.drive.used_bytes : null,
      })),
      source: source('Large-file inventory (files allocating at least 50 MiB)', ['storage-analysis/data/large_files.csv']),
    },
    installed_applications: {
      rows: data.rankings.installed_apps_with_locations.map((row) => ({
        name: row.name,
        version: row.version,
        publisher: row.publisher,
        install_date: row.install_date,
        install_location: row.install_location,
        actual_allocated_bytes: row.actual_allocated_bytes,
        actual_allocated_gib: row.actual_allocated_bytes == null ? null : row.actual_allocated_bytes / 2 ** 30,
        registry_estimated_bytes: row.registry_estimated_bytes,
      })),
      source: source('Installed-application registry entries matched to measured directory allocation', [
        'storage-analysis/data/system_evidence.json',
        'storage-analysis/data/directories.csv.gz',
      ], [
        'Only registry entries with a non-empty install location can be matched to a measured directory.',
        'Several products share one install location; those rows are not additive.',
        'Application data, caches, saves, and container disks outside the install location are separate.',
      ]),
    },
    cleanup_opportunities: {
      rows: data.cleanup.opportunities.map((row) => ({
        opportunity: row.name,
        safety: row.safety,
        guidance: row.guidance,
        allocated_bytes: row.allocated_bytes,
        allocated_gib: row.allocated_bytes / 2 ** 30,
        file_count: row.file_count,
        example_paths: row.examples.map((example) => example.path).join('\n'),
      })),
      source: source('Path-based cleanup review classification', ['storage-analysis/data/files.csv.gz'], [
        data.cleanup.caveat,
        'No files were deleted, moved, or modified.',
      ]),
    },
    duplicate_groups: {
      rows: data.duplicates.largest_groups.map((row) => ({
        group_id: row.group_id,
        sha256: row.sha256,
        copy_count: row.copy_count,
        logical_bytes_each: row.logical_bytes_each,
        recoverable_bytes: row.recoverable_bytes,
        recoverable_gib: row.recoverable_bytes / 2 ** 30,
        paths: row.copies.map((copy) => copy.path).join('\n'),
      })),
      source: source('SHA-256 duplicate-content groups', ['storage-analysis/data/duplicates.csv'], [
        'Only same-size files at or above 10 MiB were hashed.',
        'Potential recoverable bytes retain one copy per group and do not account for semantic requirements or backup policy.',
      ], [
        { label: 'Potential duplicate recovery', definition: 'Allocated bytes in a confirmed SHA-256 group minus the largest allocated copy retained.', componentIds: ['duplicate-card', 'duplicate-table'] },
      ]),
    },
    hierarchy: {
      payloadColumns: ['hierarchy_json'],
      rows: [{ hierarchy_json: JSON.stringify(data.breakdowns.hierarchy) }],
      source: source('Bounded four-level hierarchy for treemap exploration', ['storage-analysis/data/directories.csv.gz'], [
        'The treemap retains the 14 largest children of at least 25 MiB per visible parent and groups the remainder.',
        'The complete directory and file inventories remain available in the raw CSV evidence files.',
      ]),
    },
    coverage: {
      rows: [{
        inaccessible_entries: data.coverage.inaccessible_entry_count,
        inaccessible_log_rows: data.coverage.inaccessible_log_rows,
        identity_failures: data.coverage.identity_failures,
        allocation_failures: data.coverage.allocation_failures,
        reparse_points_skipped: data.coverage.reparse_points_skipped,
        hardlink_references_skipped: data.coverage.hardlink_references_skipped,
        administrator: data.metadata.is_administrator,
      }],
      source: source('Scanner coverage and exception logs', [
        'storage-analysis/data/inaccessible.csv',
        'storage-analysis/data/reparse_points.csv',
        'storage-analysis/data/hardlink_references.csv.gz',
      ], [
        'File identity/allocation failures fell back to logical size and path identity, so a small residual hard-link double-count risk remains for those records.',
      ]),
    },
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
console.log(`Wrote ${outputPath}`);
