import React from "react";

import {
  DataComponent, DataTable, EvidenceChart, MetricCard, ReportSection, RichNarrative, useDataApp,
} from "../../data-app-public.jsx";

const GIB = 2 ** 30;
const formatGiB = (bytes, digits = 2) => Number.isFinite(bytes) ? `${(bytes / GIB).toFixed(digits)} GiB` : "—";
const formatPct = (value, digits = 1) => Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
const baseName = (value = "") => value.split(/[\\/]/).filter(Boolean).pop() || value;

const categoryChart = {
  type: "horizontalBar",
  x: "category",
  y: "allocated_gib",
  sortOrder: "descending",
  showXAxisLabel: false,
  yLabel: "Allocated GiB",
  colors: { allocated_gib: "var(--chart-1)" },
};

const fileColumns = [
  { field: "rank", label: "Rank" },
  { field: "path", label: "File", presentation: "identity" },
  { field: "allocated_gib", label: "Allocated", renderCell: (value) => `${value.toFixed(2)} GiB` },
  { field: "last_write_utc", label: "Last modified" },
];

const applicationColumns = [
  { field: "name", label: "Application", presentation: "identity", secondaryField: "install_location" },
  { field: "actual_allocated_gib", label: "Measured install folder", renderCell: (value) => value == null ? "—" : `${value.toFixed(2)} GiB` },
  { field: "version", label: "Version" },
];

const cleanupColumns = [
  { field: "opportunity", label: "Candidate", presentation: "identity", secondaryField: "guidance" },
  { field: "safety", label: "Class", presentation: "status" },
  { field: "allocated_gib", label: "Allocated", renderCell: (value) => `${value.toFixed(2)} GiB` },
];

const duplicateColumns = [
  { field: "group_id", label: "Group" },
  { field: "copy_count", label: "Copies" },
  { field: "recoverable_gib", label: "Potential", renderCell: (value) => `${value.toFixed(2)} GiB` },
  { field: "paths", label: "Locations", presentation: "identity" },
];

export function ReportContent() {
  const { reviewedRows, canEdit, mode, appTitle, setAppTitle } = useDataApp();
  const driveRows = reviewedRows("drive_summary");
  const drive = driveRows[0] ?? {};
  const categories = reviewedRows("categories");
  const topLevel = reviewedRows("top_level");
  const topDirectories = reviewedRows("top_directories");
  const files = reviewedRows("large_files");
  const applications = reviewedRows("installed_applications").filter((row) => row.actual_allocated_bytes != null);
  const cleanup = reviewedRows("cleanup_opportunities");
  const duplicates = reviewedRows("duplicate_groups");
  const coverageRows = reviewedRows("coverage");
  const coverage = coverageRows[0] ?? {};

  const category = Object.fromEntries(categories.map((row) => [row.category, row]));
  const safeConditional = cleanup.filter((row) => row.safety === "safe_with_conditions")
    .reduce((sum, row) => sum + row.allocated_bytes, 0);
  const downloads = cleanup.find((row) => row.opportunity === "Downloads folder")?.allocated_bytes ?? 0;
  const archives = cleanup.find((row) => row.opportunity === "User installers and archives")?.allocated_bytes ?? 0;
  const recycle = cleanup.find((row) => row.opportunity === "Recycle Bin contents")?.allocated_bytes ?? 0;
  const devBuilds = cleanup.find((row) => row.opportunity === "Development dependencies & build outputs")?.allocated_bytes ?? 0;
  const devCaches = cleanup.find((row) => row.opportunity === "Developer/package caches")?.allocated_bytes ?? 0;
  const hibernation = cleanup.find((row) => row.opportunity === "Disable hibernation only if unused")?.allocated_bytes ?? 0;
  const browserCaches = cleanup.find((row) => row.opportunity === "Browser caches")?.allocated_bytes ?? 0;
  const temporaryFolders = cleanup.find((row) => row.opportunity === "Temporary folders")?.allocated_bytes ?? 0;
  const games = category["Games"]?.allocated_bytes ?? 0;
  const userDocs = category["User documents & media"]?.allocated_bytes ?? 0;
  const userAppData = category["User application data"]?.allocated_bytes ?? 0;
  const vms = category["VMs & containers"]?.allocated_bytes ?? 0;
  const largestDuplicate = duplicates[0];
  const usersRoot = topLevel.find((row) => row.path?.toLowerCase() === "c:\\users");
  const topLocations = topLevel.slice(0, 5).map((row) => `\`${row.path}\` (${formatGiB(row.allocated_bytes)})`).join(", ");
  const topFileSummary = files.slice(0, 5).map((row) => `\`${baseName(row.path)}\` (${formatGiB(row.allocated_bytes)})`).join(", ");
  const topApplicationSummary = applications.slice(0, 4).map((row) => `${row.name} (${formatGiB(row.actual_allocated_bytes)})`).join(", ");
  const pagefile = files.find((row) => row.path?.toLowerCase() === "c:\\pagefile.sys")?.allocated_bytes;
  const sourceRowsByQuery = {
    drive_summary: driveRows,
    categories,
    top_level: topLevel,
    top_directories: topDirectories,
    large_files: files,
    installed_applications: applications,
    cleanup_opportunities: cleanup,
    duplicate_groups: duplicates,
    coverage: coverageRows,
  };

  const executiveSummary = `## Executive summary

- **The SSD is ${formatPct(drive.used_bytes / drive.capacity_bytes)} full:** ${formatGiB(drive.used_bytes)} used and ${formatGiB(drive.free_bytes)} free on a ${formatGiB(drive.capacity_bytes)} C: volume.
- **Games are the largest consumer at ${formatGiB(games)}** (${formatPct(games / drive.used_bytes)} of used space). The largest measured application locations are ${topApplicationSummary || "not available"}.
- **User-owned data is the next major block:** ${formatGiB(userDocs)} of documents/media, ${formatGiB(userAppData)} of application data, ${formatGiB(downloads)} in Downloads, and ${formatGiB(vms)} in VM/container files.
- **The lowest-risk reclaimable space is ${formatGiB(safeConditional)}** of browser caches and temporary folders, with applications closed or their own cleanup controls used. Larger opportunities require review: ${formatGiB(drive.duplicate_recoverable_bytes)} of exact duplicates, ${formatGiB(recycle)} in the Recycle Bin, and ${formatGiB(downloads)} in Downloads.

No files were deleted, moved, or modified.`;

  const consumerNarrative = `## The user profile and installed software dominate the visible allocation

The scan attributes **${formatGiB(usersRoot?.allocated_bytes)}** to \`C:\\Users\`—${formatPct(usersRoot?.allocated_bytes / drive.used_bytes)} of used space. The largest top-level locations are ${topLocations || "not available"}.

Within the mutually exclusive consumer categories, games use ${formatGiB(games)}, user documents and media use ${formatGiB(userDocs)}, user application data uses ${formatGiB(userAppData)}, Downloads uses ${formatGiB(downloads)}, and VM/container files use ${formatGiB(vms)}.`;

  const filesNarrative = `## A small number of files explain large blocks

The largest individual files in this run are ${topFileSummary || "not available"}.

VM/container images should be pruned through Docker, WSL, or the owning application rather than deleted directly. Likewise, game data files should be removed by uninstalling or moving the game, not by deleting individual archives.`;

  const cleanupNarrative = `## Start with caches, then make deliberate choices about large user data

**Safe with conditions — up to ${formatGiB(safeConditional)}.** Browser caches account for ${formatGiB(browserCaches)} and temporary folders for ${formatGiB(temporaryFolders)}. Close applications first and prefer browser settings, Storage Sense, or Disk Cleanup. Treat locked files as in use and leave them alone.

**Review before deletion.** Downloads contains ${formatGiB(downloads)}, user installers/archives outside Downloads account for ${formatGiB(archives)}, the Recycle Bin contains ${formatGiB(recycle)}, development dependencies/build outputs account for ${formatGiB(devBuilds)}, and developer/package caches account for ${formatGiB(devCaches)}. These categories are not automatically disposable: confirm backups, project manifests, and offline reinstall needs.

**Settings decision — ${formatGiB(hibernation)}.** Disabling hibernation would remove \`hiberfil.sys\`, but it also removes Hibernate and may affect Fast Startup. Do this only if that tradeoff is acceptable.

**Do not manually delete system files.** Keep \`pagefile.sys\` (${formatGiB(pagefile)}), \`swapfile.sys\`, \`WinSxS\`, Windows Installer, WindowsApps, and restore-point data under system control. Use supported Windows cleanup tools.`;

  const duplicateNarrative = `## Exact duplicates could reclaim ${formatGiB(drive.duplicate_recoverable_bytes)}, but paths matter

The scan confirmed **${Number(drive.duplicate_group_count).toLocaleString()} SHA-256 duplicate groups** among files of at least 10 MiB. This figure keeps one copy per group. It is separate from the cleanup categories above and may overlap them, so the numbers must not be added blindly.

The largest group alone represents ${formatGiB(largestDuplicate?.recoverable_bytes)} across ${largestDuplicate?.copy_count ?? 0} copies of a Codex Windows runtime package. Other leading groups include repeated Minecraft mod/resource files and updater/install binaries. Remove duplicates only through the owning application's cache/update controls or after confirming every listed path is redundant.`;

  const limitationsNarrative = `## The scan accounts for ${formatPct(drive.scan_visible_bytes / drive.used_bytes)} of Windows-reported used space

The read-only pass measured ${formatGiB(drive.scan_visible_bytes)} of unique allocated file data. A residual **${formatGiB(drive.unaccounted_bytes)}** remains unassigned. Because the process was not elevated, Windows denied direct queries for Volume Shadow Copy storage, restore points, DISM component-store analysis, reserved storage, and NTFS metadata totals. The residual therefore remains one combined uncertainty bucket rather than a speculative split.

Coverage controls worked as intended: ${Number(coverage.hardlink_references_skipped).toLocaleString()} additional hard-link references were excluded, ${Number(coverage.reparse_points_skipped).toLocaleString()} reparse points were recorded but not traversed, and ${Number(coverage.inaccessible_log_rows).toLocaleString()} coverage exceptions were logged (385 directory access denials plus 24 duplicate-hash read failures). For ${Number(coverage.identity_failures).toLocaleString()} files whose identity/allocation metadata could not be read, the scanner used path identity and logical size; those records carry a small residual hard-link double-count risk.

An elevated follow-up can resolve more of the ${formatGiB(drive.unaccounted_bytes)} with \`vssadmin list shadowstorage\`, \`DISM /Online /Cleanup-Image /AnalyzeComponentStore\`, \`DISM /Online /Get-ReservedStorageState\`, and \`fsutil volume diskfree C:\`.`;

  const recommendations = `## Recommended sequence

1. **Reclaim the low-risk ${formatGiB(safeConditional)} first.** Clear browser caches through each browser and temporary files through Windows cleanup tools, with applications closed.
2. **Review Downloads and the Recycle Bin next.** The largest visible targets are game repack payloads in Downloads; the Recycle Bin alone contains ${formatGiB(recycle)}. Confirm that nothing is unique before emptying it.
3. **Use application-native cleanup for duplicates and virtual disks.** Review the largest-file and duplicate tables, then prune through the applications that own those files.
4. **Uninstall or move games you no longer use.** Games account for ${formatGiB(games)}, making them the largest single discretionary category.
5. **Decide whether Hibernate is worth ${formatGiB(hibernation)}.** Keep it if you use Hibernate or value its Fast Startup behavior.
6. **Run an elevated measurement pass before touching system-managed storage.** That is the only responsible way to separate the remaining ${formatGiB(drive.unaccounted_bytes)}.`;

  return <article className="report-content" aria-label="SSD storage report">
    <header className="report-hero">
      <h1 data-data-app-title contentEditable={canEdit && mode === "edit"} suppressContentEditableWarning
        aria-label={canEdit && mode === "edit" ? "Edit report heading" : undefined}
        onBlur={canEdit && mode === "edit" ? (event) => setAppTitle(event.currentTarget.textContent.trim() || appTitle) : undefined}
        onKeyDown={canEdit && mode === "edit" ? (event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        } : undefined}>{appTitle}</h1>
      <RichNarrative id="report:deck" value="A read-only NTFS allocation audit from the latest completed run. The report distinguishes measured file allocation, protected or unresolved space, and cleanup actions by risk." className="report-deck" label="Edit report introduction" />
    </header>

    <ReportSection id="report-summary" title="Executive summary" queryId="drive_summary"
      queryIds={["drive_summary", "categories", "cleanup_opportunities", "duplicate_groups"]}
      sourceRowsByQuery={{ drive_summary: driveRows, categories, cleanup_opportunities: cleanup, duplicate_groups: duplicates }}
      showHeading={false}>
      <RichNarrative id="report-summary:body" value={executiveSummary} label="Edit executive summary" />
    </ReportSection>

    <div className="report-facts" aria-label="Key storage metrics">
      <MetricCard id="report-used" title="Used space" queryId="drive_summary" sourceRows={driveRows}
        value={formatGiB(drive.used_bytes)} comparison={formatPct(drive.used_bytes / drive.capacity_bytes)} description="Windows-reported used volume space." />
      <MetricCard id="report-free" title="Free space" queryId="drive_summary" sourceRows={driveRows}
        value={formatGiB(drive.free_bytes)} comparison={formatPct(drive.free_bytes / drive.capacity_bytes)} description="Windows-reported free volume space." />
      <MetricCard id="report-visible" title="Directly attributed" queryId="drive_summary" sourceRows={driveRows}
        value={formatGiB(drive.scan_visible_bytes)} comparison={formatPct(drive.scan_visible_bytes / drive.used_bytes)} description="Unique allocated file data measured by the scanner." />
      <MetricCard id="report-duplicates" title="Exact duplicate potential" queryId="duplicate_groups" sourceRows={duplicates}
        value={formatGiB(drive.duplicate_recoverable_bytes)} comparison={`${Number(drive.duplicate_group_count).toLocaleString()} groups`} description="Review only; duplicate paths may serve different application roles." />
    </div>

    <ReportSection id="report-consumers" title="Half of used space sits under the user profile" queryId="categories" queryIds={["categories", "top_level", "top_directories"]}
      sourceRowsByQuery={{ categories, top_level: topLevel, top_directories: topDirectories }} showHeading={false}>
      <RichNarrative id="report-consumers:body" value={consumerNarrative} label="Edit storage-consumer analysis" />
    </ReportSection>
    <EvidenceChart id="report-category-chart" title="Measured storage by consumer type" queryId="categories"
      spec={categoryChart} rows={categories} sourceRows={categories} height={430}
      description="Mutually exclusive path-based categories summing to scan-visible allocated bytes." />

    <ReportSection id="report-files" title="A small number of files explain large blocks" queryId="large_files" showHeading={false} sourceRows={files}>
      <RichNarrative id="report-files:body" value={filesNarrative} label="Edit large-file analysis" />
    </ReportSection>
    <DataComponent id="report-files-table" title="Largest individual files" queryId="large_files" kind="table"
      sourceRows={files} displayRows={files.slice(0, 40)} description="Top files by allocated size; the table can be searched and sorted.">
      <DataTable rows={files.slice(0, 40)} columns={fileColumns} rowKey="path" />
    </DataComponent>

    <ReportSection id="report-applications" title="Measured application locations confirm that games dominate installed software" queryId="installed_applications" showHeading={false} sourceRows={applications}>
      <RichNarrative id="report-applications:body" value="## Measured application locations confirm that games dominate installed software\n\nRegistry install locations were matched to the directory inventory. These sizes are actual allocated folder sizes, not Windows' estimated application sizes. Shared install locations can appear more than once and must not be added; application data outside the install folder is also separate." label="Edit application analysis" />
    </ReportSection>
    <DataComponent id="report-applications-table" title="Largest measured application install folders" queryId="installed_applications" kind="table"
      sourceRows={applications} displayRows={applications.slice(0, 40)}>
      <DataTable rows={applications.slice(0, 40)} columns={applicationColumns} rowKey="install_location" />
    </DataComponent>

    <ReportSection id="report-cleanup" title="Start with caches, then make deliberate choices about large user data" queryId="cleanup_opportunities" showHeading={false} sourceRows={cleanup}>
      <RichNarrative id="report-cleanup:body" value={cleanupNarrative} label="Edit cleanup assessment" />
    </ReportSection>
    <DataComponent id="report-cleanup-table" title="Cleanup opportunities and safety classes" queryId="cleanup_opportunities" kind="table"
      sourceRows={cleanup} displayRows={cleanup}>
      <DataTable rows={cleanup} columns={cleanupColumns} rowKey="opportunity" searchable={false} />
    </DataComponent>

    <ReportSection id="report-duplicates-section" title={`Exact duplicates could reclaim ${formatGiB(drive.duplicate_recoverable_bytes)}, but paths matter`} queryId="duplicate_groups" showHeading={false} sourceRows={duplicates}>
      <RichNarrative id="report-duplicates:body" value={duplicateNarrative} label="Edit duplicate analysis" />
    </ReportSection>
    <DataComponent id="report-duplicates-table" title="Largest confirmed duplicate groups" queryId="duplicate_groups" kind="table"
      sourceRows={duplicates} displayRows={duplicates.slice(0, 40)}>
      <DataTable rows={duplicates.slice(0, 40)} columns={duplicateColumns} rowKey="group_id" />
    </DataComponent>

    <ReportSection id="report-limitations" title={`The scan accounts for ${formatPct(drive.scan_visible_bytes / drive.used_bytes)} of Windows-reported used space`} queryId="coverage" queryIds={["coverage", "drive_summary"]}
      sourceRowsByQuery={{ coverage: coverageRows, drive_summary: driveRows }} showHeading={false}>
      <RichNarrative id="report-limitations:body" value={limitationsNarrative} label="Edit coverage and limitations" />
    </ReportSection>

    <ReportSection id="report-recommendations" title="Recommended sequence" queryId="cleanup_opportunities"
      queryIds={["cleanup_opportunities", "duplicate_groups", "drive_summary", "categories"]}
      sourceRowsByQuery={{ cleanup_opportunities: cleanup, duplicate_groups: duplicates, drive_summary: driveRows, categories }}
      showHeading={false}>
      <RichNarrative id="report-recommendations:body" value={recommendations} label="Edit recommendations" />
    </ReportSection>
  </article>;
}
