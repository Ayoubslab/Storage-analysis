import React, { useMemo, useState } from "react";

import {
  DataComponent, DataTable, EvidenceChart, MetricCard, Section, SectionHeader,
  SectionNavigator, useDataApp,
} from "../../data-app-public.jsx";

const GIB = 2 ** 30;

const categoryChart = {
  type: "horizontalBar",
  x: "category",
  y: "allocated_gib",
  sortOrder: "descending",
  showXAxisLabel: false,
  yLabel: "Allocated GiB",
  colors: { allocated_gib: "var(--chart-1)" },
};

const topLevelChart = {
  type: "horizontalBar",
  x: "path",
  y: "allocated_gib",
  sortOrder: "descending",
  showXAxisLabel: false,
  yLabel: "Allocated GiB",
  colors: { allocated_gib: "var(--chart-2)" },
};

const cleanupChart = {
  type: "horizontalBar",
  x: "opportunity",
  y: "allocated_gib",
  sortOrder: "descending",
  showXAxisLabel: false,
  yLabel: "Potential GiB to review",
  colors: { allocated_gib: "var(--chart-3)" },
};

function formatGiB(bytes, digits = 2) {
  if (!Number.isFinite(bytes)) return "—";
  return `${(bytes / GIB).toFixed(digits)} GiB`;
}

function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function shortPath(value, max = 82) {
  if (!value || value.length <= max) return value;
  return `…${value.slice(-(max - 1))}`;
}

function splitRectangles(items, x, y, width, height) {
  if (!items.length) return [];
  if (items.length === 1) return [{ ...items[0], x, y, width, height }];
  const total = items.reduce((sum, item) => sum + item.allocated_bytes, 0);
  let running = 0;
  let split = 1;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < items.length; index += 1) {
    running += items[index - 1].allocated_bytes;
    const difference = Math.abs(total / 2 - running);
    if (difference < best) { best = difference; split = index; }
  }
  const first = items.slice(0, split);
  const second = items.slice(split);
  const firstTotal = first.reduce((sum, item) => sum + item.allocated_bytes, 0);
  const ratio = total > 0 ? firstTotal / total : 0.5;
  if (width >= height) {
    const firstWidth = width * ratio;
    return [
      ...splitRectangles(first, x, y, firstWidth, height),
      ...splitRectangles(second, x + firstWidth, y, width - firstWidth, height),
    ];
  }
  const firstHeight = height * ratio;
  return [
    ...splitRectangles(first, x, y, width, firstHeight),
    ...splitRectangles(second, x, y + firstHeight, width, height - firstHeight),
  ];
}

function TreeMap({ root, usedBytes }) {
  const [trail, setTrail] = useState([root]);
  const [hovered, setHovered] = useState(null);
  const current = trail.at(-1);
  const children = (current?.children ?? []).filter((child) => child.allocated_bytes > 0)
    .sort((left, right) => right.allocated_bytes - left.allocated_bytes);
  const rectangles = splitRectangles(children, 0, 0, 100, 100);

  function navigate(node) {
    if ((node.children ?? []).length > 1) setTrail((items) => [...items, node]);
  }

  return <div className="treemap-shell" data-reviewed-rows>
    <div className="treemap-breadcrumb" aria-label="Treemap location">
      {trail.map((node, index) => <React.Fragment key={`${node.path}-${index}`}>
        {index > 0 && <span aria-hidden="true">›</span>}
        <button type="button" onClick={() => setTrail((items) => items.slice(0, index + 1))}>{node.name}</button>
      </React.Fragment>)}
    </div>
    <div className="treemap-plot" role="group" aria-label={`Storage treemap for ${current?.path ?? "all storage"}`}>
      {rectangles.map((rect, index) => {
        const share = current?.allocated_bytes ? rect.allocated_bytes / current.allocated_bytes : 0;
        const canDrill = (rect.children ?? []).length > 1;
        return <button key={`${rect.path}-${index}`} type="button"
          className={`treemap-cell treemap-tone-${index % 7}`}
          style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
          onClick={() => navigate(rect)} onMouseEnter={() => setHovered(rect)} onMouseLeave={() => setHovered(null)}
          onFocus={() => setHovered(rect)} onBlur={() => setHovered(null)}
          aria-label={`${rect.name}, ${formatGiB(rect.allocated_bytes)}, ${formatPercent(share)} of current folder${canDrill ? ", open folder" : ""}`}>
          <span className="treemap-name">{rect.name}</span>
          {share >= 0.035 && <span className="treemap-value">{formatGiB(rect.allocated_bytes)} · {formatPercent(share)}</span>}
        </button>;
      })}
      {hovered && <div className="treemap-tooltip" role="status">
        <strong>{hovered.name}</strong>
        <span>{formatGiB(hovered.allocated_bytes)} · {formatPercent(hovered.allocated_bytes / current.allocated_bytes)} of this folder</span>
        <span>{formatPercent(hovered.allocated_bytes / usedBytes)} of all used scanned space</span>
        <code>{hovered.path}</code>
      </div>}
    </div>
    <p className="component-note">Select a rectangle to drill into a retained child folder. “Direct files & smaller folders” groups the bounded long tail; the complete hierarchy is in <code>directories.csv.gz</code>.</p>
  </div>;
}

const directoryColumns = [
  { field: "rank", label: "Rank" },
  { field: "path", label: "Folder", presentation: "identity", renderCell: (value) => <span title={value}>{shortPath(value)}</span> },
  { field: "allocated_gib", label: "Allocated", renderCell: (value) => `${value.toFixed(2)} GiB` },
  { field: "percent_used", label: "% used", presentation: "percent" },
  { field: "file_count", label: "Files" },
];

const volumeColumns = [
  { field: "drive", label: "Volume", presentation: "identity", secondaryField: "label" },
  { field: "file_system", label: "Filesystem" },
  { field: "used_bytes", label: "Used", renderCell: (value) => formatGiB(value) },
  { field: "free_bytes", label: "Free", renderCell: (value) => formatGiB(value) },
  { field: "scan_visible_bytes", label: "Attributed", renderCell: (value) => formatGiB(value) },
  { field: "used_percent", label: "% full", presentation: "percent" },
];

const fileColumns = [
  { field: "rank", label: "Rank" },
  { field: "path", label: "File", presentation: "identity", renderCell: (value) => <span title={value}>{shortPath(value)}</span> },
  { field: "allocated_gib", label: "Allocated", renderCell: (value) => `${value.toFixed(2)} GiB` },
  { field: "percent_used", label: "% used", presentation: "percent" },
  { field: "last_write_utc", label: "Last modified" },
  { field: "age_bucket", label: "Age" },
];

const cleanupColumns = [
  { field: "opportunity", label: "Opportunity", presentation: "identity", secondaryField: "guidance" },
  { field: "safety", label: "Decision class", presentation: "status" },
  { field: "allocated_gib", label: "Allocated", renderCell: (value) => `${value.toFixed(2)} GiB` },
  { field: "file_count", label: "Files" },
];

const duplicateColumns = [
  { field: "group_id", label: "Group" },
  { field: "copy_count", label: "Copies" },
  { field: "recoverable_gib", label: "Potential", renderCell: (value) => `${value.toFixed(2)} GiB` },
  { field: "paths", label: "Locations", presentation: "identity", renderCell: (value) => <span className="multiline-path" title={value}>{value.split("\n").slice(0, 3).join(" · ")}</span> },
];

export function DashboardContent() {
  const { reviewedRows } = useDataApp();
  const driveRows = reviewedRows("drive_summary");
  const drive = driveRows[0] ?? {};
  const volumes = reviewedRows("volumes");
  const categories = reviewedRows("categories");
  const topLevel = reviewedRows("top_level").slice(0, 16);
  const directories = reviewedRows("top_directories");
  const files = reviewedRows("large_files");
  const cleanup = reviewedRows("cleanup_opportunities");
  const duplicates = reviewedRows("duplicate_groups");
  const hierarchyRows = reviewedRows("hierarchy");
  const coverageRows = reviewedRows("coverage");
  const coverage = coverageRows[0] ?? {};
  const hierarchy = useMemo(() => {
    try { return JSON.parse(hierarchyRows[0]?.hierarchy_json ?? "null"); }
    catch { return null; }
  }, [hierarchyRows]);
  const usedRatio = drive.capacity_bytes ? drive.used_bytes / drive.capacity_bytes : 0;
  const freeRatio = drive.capacity_bytes ? drive.free_bytes / drive.capacity_bytes : 0;
  const confirmedDuplicates = drive.duplicate_recoverable_bytes ?? duplicates.reduce((sum, row) => sum + row.recoverable_bytes, 0);
  const conditionallySafe = cleanup.filter((row) => row.safety === "safe_with_conditions")
    .reduce((sum, row) => sum + row.allocated_bytes, 0);
  const reviewPotential = cleanup.filter((row) => ["review", "review_regenerable"].includes(row.safety))
    .reduce((sum, row) => sum + row.allocated_bytes, 0);
  const sections = [
    { id: "overview", label: "Overview" },
    { id: "map", label: "Storage map" },
    { id: "rankings", label: "Largest items" },
    { id: "cleanup", label: "Cleanup" },
    { id: "coverage", label: "Coverage" },
  ];

  return <article className="storage-dashboard">
    <SectionNavigator sections={sections} placement="auto" />

    <section id="overview" className="storage-section">
      <SectionHeader id="storage:overview-title" title="Drive overview" />
      <div className="metric-grid">
        <MetricCard id="capacity-summary" title="Total capacity" queryId="drive_summary" sourceRows={driveRows}
          value={formatGiB(drive.capacity_bytes)} comparison={`${Number(drive.volume_count ?? volumes.length).toLocaleString()} volumes`} description="Combined Windows-reported capacity of scanned local volumes." />
        <MetricCard id="used-summary" title="Used" queryId="drive_summary" sourceRows={driveRows}
          value={formatGiB(drive.used_bytes)} comparison={formatPercent(usedRatio)} description="Windows-reported used volume space at evidence capture." />
        <MetricCard id="free-summary" title="Free" queryId="drive_summary" sourceRows={driveRows}
          value={formatGiB(drive.free_bytes)} comparison={formatPercent(freeRatio)} description="Windows-reported free space at evidence capture." />
        <MetricCard id="duplicate-card" title="Confirmed duplicate potential" queryId="duplicate_groups" sourceRows={duplicates}
          value={formatGiB(confirmedDuplicates)} comparison={`${Number(drive.duplicate_group_count ?? duplicates.length).toLocaleString()} confirmed groups`} description="SHA-256 confirmed duplicate content, retaining one copy per group; review only." />
      </div>

      <DataComponent variant="card" padding="spacious" id="accounting-waterfall" queryId="drive_summary"
        title="What Windows counts as used space" kind="custom" sourceRows={driveRows} displayRows={driveRows}
        description="The scan directly attributes unique allocated file data. The residual is protected/system-managed space and filesystem overhead that requires elevation to resolve further.">
        <div className="capacity-visual" data-reviewed-rows>
          <div className="capacity-track" aria-label={`${formatPercent(usedRatio)} used, ${formatPercent(freeRatio)} free`}>
            <span className="capacity-visible" style={{ width: `${(drive.scan_visible_bytes / drive.capacity_bytes) * 100}%` }} />
            <span className="capacity-unaccounted" style={{ width: `${(drive.unaccounted_bytes / drive.capacity_bytes) * 100}%` }} />
            <span className="capacity-free" style={{ width: `${freeRatio * 100}%` }} />
          </div>
          <div className="capacity-legend">
            <span><i className="legend-swatch visible" />Scan-visible files <strong>{formatGiB(drive.scan_visible_bytes)}</strong></span>
            <span><i className="legend-swatch unaccounted" />Protected/unaccounted <strong>{formatGiB(drive.unaccounted_bytes)}</strong></span>
            <span><i className="legend-swatch free" />Free <strong>{formatGiB(drive.free_bytes)}</strong></span>
          </div>
        </div>
      </DataComponent>

      <DataComponent variant="card" id="volume-table" queryId="volumes" title="Scanned volumes"
        kind="table" sourceRows={volumes} displayRows={volumes}
        description="Every ready local fixed or removable filesystem volume discovered when the run started.">
        <DataTable rows={volumes} columns={volumeColumns} rowKey="drive" searchable={false} />
      </DataComponent>

      <Section columns={2} spacing="content">
        <EvidenceChart variant="card" id="category-breakdown" title="Storage by consumer type" queryId="categories"
          spec={categoryChart} rows={categories} sourceRows={categories} height={430}
          description="Mutually exclusive path-based categories; bars sum to scan-visible allocated bytes." />
        <EvidenceChart variant="card" id="top-level-breakdown" title="Largest top-level folders" queryId="top_level"
          spec={topLevelChart} rows={topLevel} sourceRows={topLevel} height={430}
          description="Largest direct children across all scanned volumes. Folder values are actual allocated bytes after hard-link deduplication." />
      </Section>
    </section>

    <section id="map" className="storage-section">
      <SectionHeader id="storage:map-title" title="Hierarchical storage map" />
      {hierarchy ? <DataComponent variant="card" padding="spacious" id="storage-treemap" queryId="hierarchy"
        title="All-storage treemap" kind="custom" sourceRows={hierarchyRows} displayRows={hierarchyRows}
        description="Area encodes allocated bytes. Select a folder rectangle to drill down; use the breadcrumb to move back up.">
        <TreeMap root={hierarchy} usedBytes={drive.used_bytes} />
      </DataComponent> : <div className="empty-state">Hierarchy data is unavailable.</div>}
    </section>

    <section id="rankings" className="storage-section">
      <SectionHeader id="storage:rankings-title" title="Largest folders and files" />
      <Section columns={2} spacing="none">
        <DataComponent variant="card" id="directory-table" queryId="top_directories" title="Largest folders"
          kind="table" sourceRows={directories} displayRows={directories}
          description="Nested folders overlap; search a path to inspect it rather than adding ranked rows.">
          <DataTable rows={directories} columns={directoryColumns} rowKey="path" />
        </DataComponent>
        <DataComponent variant="card" id="file-table" queryId="large_files" title="Largest individual files"
          kind="table" sourceRows={files} displayRows={files}
          description="Files allocating at least 50 MiB, ranked by NTFS allocated size.">
          <DataTable rows={files} columns={fileColumns} rowKey="path" />
        </DataComponent>
      </Section>
    </section>

    <section id="cleanup" className="storage-section">
      <SectionHeader id="storage:cleanup-title" title="Cleanup decision support" />
      <div className="metric-grid metric-grid--three">
        <MetricCard id="conditional-safe-card" title="Safe with conditions" queryId="cleanup_opportunities" sourceRows={cleanup}
          value={formatGiB(conditionallySafe)} description="Temporary and browser caches. Close apps or use their cleanup controls; locked files should be skipped." />
        <MetricCard id="review-card" title="Review/regenerable candidates" queryId="cleanup_opportunities" sourceRows={cleanup}
          value={formatGiB(reviewPotential)} description="Not an automatic deletion total. It includes downloads, archives, build outputs, and other user-owned data." />
        <MetricCard id="coverage-card" title="Protected/unresolved" queryId="drive_summary" sourceRows={driveRows}
          value={formatGiB(drive.unaccounted_bytes)} description="Requires an elevated follow-up to split restore points, reserved storage, component store, and NTFS metadata." />
      </div>
      <Section columns={2} spacing="content">
        <EvidenceChart variant="card" id="cleanup-chart" title="Candidate space by review class" queryId="cleanup_opportunities"
          spec={cleanupChart} rows={cleanup} sourceRows={cleanup} height={360}
          description="Categories are mutually exclusive here. Confirmed duplicates are separate and may overlap these rows." />
        <DataComponent variant="card" id="cleanup-table" queryId="cleanup_opportunities" title="What can be reclaimed safely"
          kind="table" sourceRows={cleanup} displayRows={cleanup}>
          <DataTable rows={cleanup} columns={cleanupColumns} rowKey="opportunity" searchable={false} />
        </DataComponent>
      </Section>
      <DataComponent variant="card" id="duplicate-table" queryId="duplicate_groups" title="Largest exact duplicate groups"
        kind="table" sourceRows={duplicates} displayRows={duplicates}
        description="Content was SHA-256 confirmed for same-size files of at least 10 MiB. Review every path before removing any copy.">
        <DataTable rows={duplicates} columns={duplicateColumns} rowKey="group_id" />
      </DataComponent>
    </section>

    <section id="coverage" className="storage-section">
      <SectionHeader id="storage:coverage-title" title="Coverage and limitations" />
      <DataComponent variant="card" padding="spacious" id="coverage-detail" queryId="coverage" title="What the scan could and could not measure"
        kind="custom" sourceRows={coverageRows} displayRows={coverageRows}>
        <div className="coverage-grid" data-reviewed-rows>
          <div><strong>{Number(drive.unique_files ?? 0).toLocaleString()}</strong><span>unique file identities measured</span></div>
          <div><strong>{Number(drive.directories ?? 0).toLocaleString()}</strong><span>directories inventoried</span></div>
          <div><strong>{Number(coverage.hardlink_references_skipped ?? 0).toLocaleString()}</strong><span>hard-link references excluded</span></div>
          <div><strong>{Number(coverage.reparse_points_skipped ?? 0).toLocaleString()}</strong><span>junctions/symlinks not traversed</span></div>
          <div><strong>{Number(coverage.inaccessible_log_rows ?? coverage.inaccessible_entries ?? 0).toLocaleString()}</strong><span>coverage exceptions logged</span></div>
          <div><strong>{Number(coverage.identity_failures ?? 0).toLocaleString()}</strong><span>identity/allocation fallbacks</span></div>
        </div>
        <div className="coverage-callout">
          <strong>Administrator follow-up required for full system attribution.</strong>
          <p>The current token could not query Volume Shadow Copy storage, restore points, DISM component-store analysis, Windows reserved storage, or NTFS metadata totals. The dashboard preserves their combined residual as {formatGiB(drive.unaccounted_bytes)} instead of assigning it speculatively.</p>
        </div>
      </DataComponent>
    </section>
  </article>;
}
