import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const inputDir = path.resolve(process.argv[2] ?? './storage-analysis/data');
const outputPath = path.resolve(process.argv[3] ?? './storage-analysis/reviewed-data.json');
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const now = new Date();

function parseCsvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { value += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(value); value = ''; }
    else value += ch;
  }
  out.push(value);
  return out;
}

async function eachCsv(filePath, onRow) {
  const source = fs.createReadStream(filePath);
  const stream = filePath.endsWith('.gz') ? source.pipe(zlib.createGunzip()) : source;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers;
  for await (const line of rl) {
    if (!headers) { headers = parseCsvLine(line.replace(/^\uFEFF/, '')); continue; }
    if (!line) continue;
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ''; });
    await onRow(row);
  }
}

function normalize(p) {
  return p.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

function addAggregate(map, key, bytes, count = 1) {
  const current = map.get(key) ?? { name: key, allocated_bytes: 0, file_count: 0 };
  current.allocated_bytes += bytes;
  current.file_count += count;
  map.set(key, current);
  return current;
}

function extensionOf(filePath) {
  const name = path.win32.basename(filePath);
  if (!name.includes('.') || name.startsWith('.') && !name.slice(1).includes('.')) return '(no extension)';
  const ext = path.win32.extname(name).toLowerCase();
  return ext || '(no extension)';
}

function classifyCategory(filePath) {
  const p = normalize(filePath);
  if (/^[a-z]:\\(pagefile|hiberfil|swapfile)\.sys$/.test(p)) return 'System-managed root files';
  if (p.includes('\\system volume information\\')) return 'Restore points & protected system data';
  if (p.includes('\\$recycle.bin\\')) return 'Recycle Bin';
  if (/^[a-z]:\\(games|gog games|riot games|xboxgames)(\\|$)/.test(p) || /(^|\\)(steamapps|epic games|gog galaxy|battle\.net|curseforge\\minecraft|\.minecraft|prismlauncher\\instances)(\\|$)/.test(p)) return 'Games';
  if (/\\(\.lmstudio\\models|\.ollama\\models|huggingface\\hub)(\\|$)/.test(p)) return 'Local AI models';
  if (/\.(vhdx?|vmdk|qcow2|vdi)$/.test(p) || /\\(virtualbox vms|vmware|wsl|docker|hyper-v)(\\|$)/.test(p)) return 'VMs & containers';
  if (/\\(node_modules|\.git|\.gradle|\.m2|\.nuget|\.npm|pnpm-store|cargo|rustup|\.venv|venv)(\\|$)/.test(p) || /\\(repos|source|projects|code|codex test)(\\|$)/.test(p)) return 'Development environments';
  if (/\\(appdata\\local\\temp|windows\\temp)(\\|$)/.test(p) || /\\(cache|code cache|gpucache|cache2|cachestorage)(\\|$)/.test(p)) return 'Temporary files & caches';
  if (/^[a-z]:\\windows\\/.test(p)) return 'Windows';
  if (/^[a-z]:\\(program files|program files \(x86\)|programdata)\\/.test(p)) return 'Applications & shared app data';
  if (/^[a-z]:\\users\\[^\\]+\\downloads(\\|$)/.test(p)) return 'Downloads';
  if (/^[a-z]:\\users\\[^\\]+\\(documents|desktop|pictures|videos|music)(\\|$)/.test(p)) return 'User documents & media';
  if (/^[a-z]:\\users\\[^\\]+\\appdata(\\|$)/.test(p)) return 'User application data';
  if (/^[a-z]:\\users\\/.test(p)) return 'Other user data';
  return 'Other';
}

function cleanupRule(filePath) {
  const p = normalize(filePath);
  const ext = path.win32.extname(p);
  if (/^[a-z]:\\hiberfil\.sys$/.test(p)) return ['Disable hibernation only if unused', 'setting_change', 'Power setting; removes Hibernate and may affect Fast Startup'];
  if (p.includes('\\$recycle.bin\\')) return ['Recycle Bin contents', 'review', 'Review before emptying; deletion becomes difficult to recover'];
  if (/\\(appdata\\local\\temp|windows\\temp)(\\|$)/.test(p)) return ['Temporary folders', 'safe_with_conditions', 'Use Storage Sense/Disk Cleanup or close apps first; locked files should be skipped'];
  if (/\\(google\\chrome|microsoft\\edge|opera software|mozilla\\firefox).*\\(cache|code cache|gpucache|cache2|cachestorage)(\\|$)/.test(p)) return ['Browser caches', 'safe_with_conditions', 'Clear through the browser where possible; close the browser first'];
  if (/\\windows\\softwaredistribution\\download(\\|$)/.test(p)) return ['Windows Update download cache', 'system_tool', 'Use Windows cleanup tools; do not manually remove servicing files'];
  if (/\\(\.npm\\_cacache|npm-cache|pip\\cache|\.gradle\\caches|\.nuget\\packages|pnpm-store|yarn\\cache|huggingface\\hub)(\\|$)/.test(p)) return ['Developer/package caches', 'review_regenerable', 'Usually re-downloadable, but verify active projects and offline needs'];
  if (/\\(node_modules|\.next|dist|build|target|\.venv|venv)(\\|$)/.test(p)) return ['Development dependencies & build outputs', 'review_regenerable', 'Regenerable only where manifests/source environments remain intact'];
  if (/^[a-z]:\\users\\[^\\]+\\downloads(\\|$)/.test(p)) return ['Downloads folder', 'review', 'Review manually; may contain unique documents and installers'];
  if (/\.(dmp|tmp|etl)$/.test(ext) || /\\(crashdumps|wer\\reportarchive)(\\|$)/.test(p)) return ['Crash dumps and diagnostic traces', 'review', 'Keep if debugging an active issue; otherwise remove through system/app tooling'];
  if (/\.(iso|img|msi|msix|appx|zip|7z|rar|tar|gz)$/.test(ext) && /^[a-z]:\\users\\/.test(p)) return ['User installers and archives', 'review', 'Confirm contents are backed up or reproducible before deleting'];
  return null;
}

function ageBucket(dateValue) {
  const d = new Date(dateValue);
  if (!Number.isFinite(d.getTime())) return 'Unknown';
  const days = (now - d) / 86400000;
  if (days <= 30) return '≤30 days';
  if (days <= 90) return '31–90 days';
  if (days <= 365) return '91–365 days';
  if (days <= 730) return '1–2 years';
  return '>2 years';
}

function pushTop(list, item, limit = 10, valueKey = 'allocated_bytes') {
  list.push(item);
  list.sort((a, b) => b[valueKey] - a[valueKey]);
  if (list.length > limit) list.length = limit;
}

const scanSummary = JSON.parse(fs.readFileSync(path.join(inputDir, 'scan_summary.json'), 'utf8'));
const systemEvidence = JSON.parse(fs.readFileSync(path.join(inputDir, 'system_evidence.json'), 'utf8'));

const directories = new Map();
const childrenByParent = new Map();
await eachCsv(path.join(inputDir, 'directories.csv.gz'), (row) => {
  const item = {
    path: row.path,
    parent: row.parent || null,
    allocated_bytes: Number(row.allocated_bytes),
    logical_bytes: Number(row.logical_bytes),
    file_count: Number(row.file_count),
    unknown_identity_files: Number(row.unknown_identity_files),
  };
  directories.set(normalize(item.path), item);
  const parentKey = item.parent ? normalize(item.parent) : null;
  const children = childrenByParent.get(parentKey) ?? [];
  children.push(item);
  childrenByParent.set(parentKey, children);
});

const categories = new Map();
const extensions = new Map();
const ages = new Map();
const cleanup = new Map();
let processedFiles = 0;
await eachCsv(path.join(inputDir, 'files.csv.gz'), (row) => {
  const bytes = Number(row.allocated_bytes);
  addAggregate(categories, classifyCategory(row.path), bytes);
  addAggregate(extensions, extensionOf(row.path), bytes);
  addAggregate(ages, ageBucket(row.last_write_utc), bytes);
  const rule = cleanupRule(row.path);
  if (rule) {
    const [name, safety, guidance] = rule;
    const item = cleanup.get(name) ?? { name, safety, guidance, allocated_bytes: 0, file_count: 0, examples: [] };
    item.allocated_bytes += bytes;
    item.file_count += 1;
    pushTop(item.examples, { path: row.path, allocated_bytes: bytes, last_write_utc: row.last_write_utc }, 8);
    cleanup.set(name, item);
  }
  processedFiles += 1;
  if (processedFiles % 500000 === 0) console.log(`Analyzed ${processedFiles.toLocaleString()} file rows`);
});

const largeFiles = [];
await eachCsv(path.join(inputDir, 'large_files.csv'), (row) => {
  largeFiles.push({
    rank: Number(row.rank), path: row.path,
    logical_bytes: Number(row.logical_bytes), allocated_bytes: Number(row.allocated_bytes),
    last_write_utc: row.last_write_utc,
    age_bucket: ageBucket(row.last_write_utc),
  });
});

const duplicateGroupsMap = new Map();
await eachCsv(path.join(inputDir, 'duplicates.csv'), (row) => {
  const id = Number(row.group_id);
  const item = duplicateGroupsMap.get(id) ?? { group_id: id, sha256: row.sha256, logical_bytes_each: Number(row.logical_bytes), copies: [] };
  item.copies.push({ path: row.path, allocated_bytes: Number(row.allocated_bytes), last_write_utc: row.last_write_utc });
  duplicateGroupsMap.set(id, item);
});
const duplicateGroups = [...duplicateGroupsMap.values()].map((group) => {
  const allocations = group.copies.map((copy) => copy.allocated_bytes);
  return { ...group, copy_count: group.copies.length, recoverable_bytes: allocations.reduce((a, b) => a + b, 0) - Math.max(...allocations) };
}).sort((a, b) => b.recoverable_bytes - a.recoverable_bytes);

const inaccessibleByType = new Map();
const inaccessibleExamples = [];
let inaccessibleLogRows = 0;
await eachCsv(path.join(inputDir, 'inaccessible.csv'), (row) => {
  inaccessibleLogRows += 1;
  const key = `${row.operation}: ${row.error_type}`;
  addAggregate(inaccessibleByType, key, 0);
  if (inaccessibleExamples.length < 50) inaccessibleExamples.push(row);
});

const roots = [...directories.values()]
  .filter((item) => !item.parent)
  .sort((a, b) => a.path.localeCompare(b.path));
const topLevel = roots.flatMap((root) => childrenByParent.get(normalize(root.path)) ?? [])
  .filter((item) => item.allocated_bytes > 0)
  .sort((a, b) => b.allocated_bytes - a.allocated_bytes);

const topDirectories = [...directories.values()]
  .filter((item) => item.allocated_bytes >= 100 * MiB && normalize(item.path) !== 'c:')
  .sort((a, b) => b.allocated_bytes - a.allocated_bytes)
  .slice(0, 300);

function makeTree(dirPath, depth = 0, maxDepth = 4) {
  const key = normalize(dirPath);
  const dir = directories.get(key);
  if (!dir) return null;
  const allChildren = (childrenByParent.get(key) ?? []).filter((item) => item.allocated_bytes > 0).sort((a, b) => b.allocated_bytes - a.allocated_bytes);
  const selected = allChildren.filter((item, index) => index < 14 && item.allocated_bytes >= 25 * MiB);
  const children = [];
  if (depth < maxDepth) {
    for (const child of selected) {
      const node = makeTree(child.path, depth + 1, maxDepth);
      if (node) children.push(node);
    }
  }
  const represented = children.reduce((sum, child) => sum + child.allocated_bytes, 0);
  const remainder = Math.max(0, dir.allocated_bytes - represented);
  if (remainder > 0) children.push({ name: depth === maxDepth ? 'Deeper content' : 'Direct files & smaller folders', path: dir.path, allocated_bytes: remainder, file_count: Math.max(0, dir.file_count - children.reduce((sum, child) => sum + (child.file_count ?? 0), 0)), children: [] });
  return { name: depth === 0 ? dir.path.replace(/[\\/]+$/, '') : path.win32.basename(dir.path) || dir.path, path: dir.path, allocated_bytes: dir.allocated_bytes, file_count: dir.file_count, children };
}

const installedApps = [];
const seenApps = new Set();
for (const app of systemEvidence.installed_applications ?? []) {
  if (!app.display_name || !app.install_location) continue;
  const location = normalize(app.install_location);
  const dir = directories.get(location);
  const key = `${app.display_name.toLowerCase()}|${location}`;
  if (seenApps.has(key)) continue;
  seenApps.add(key);
  installedApps.push({
    name: app.display_name, version: app.display_version, publisher: app.publisher,
    install_date: app.install_date, install_location: app.install_location,
    actual_allocated_bytes: dir?.allocated_bytes ?? null,
    registry_estimated_bytes: app.estimated_size_kb == null ? null : Number(app.estimated_size_kb) * 1024,
  });
}
installedApps.sort((a, b) => (b.actual_allocated_bytes ?? -1) - (a.actual_allocated_bytes ?? -1));

const rootByDrive = new Map(roots.map((root) => [root.path.slice(0, 1).toUpperCase(), root]));
const scannedVolumes = (systemEvidence.volumes ?? [])
  .filter((volume) => rootByDrive.has(String(volume.drive_letter).toUpperCase()))
  .map((volume) => {
    const root = rootByDrive.get(String(volume.drive_letter).toUpperCase());
    const capacityBytes = Number(volume.size_bytes) || 0;
    const freeBytes = Number(volume.free_bytes) || 0;
    const usedBytes = Math.max(0, capacityBytes - freeBytes);
    const scanVisibleBytes = root?.allocated_bytes ?? 0;
    return {
      ...volume,
      root: root?.path,
      capacity_bytes: capacityBytes,
      used_bytes: usedBytes,
      free_bytes: freeBytes,
      scan_visible_allocated_bytes: scanVisibleBytes,
      unaccounted_or_protected_bytes: Math.max(0, usedBytes - scanVisibleBytes),
    };
  });
const capacity = scannedVolumes.reduce((sum, volume) => sum + volume.capacity_bytes, 0);
const free = scannedVolumes.reduce((sum, volume) => sum + volume.free_bytes, 0);
const used = scannedVolumes.reduce((sum, volume) => sum + volume.used_bytes, 0);
const scanVisible = scanSummary.allocated_bytes;
const unaccounted = scannedVolumes.reduce((sum, volume) => sum + volume.unaccounted_or_protected_bytes, 0);
const driveTrees = roots.map((root) => makeTree(root.path)).filter(Boolean);
const hierarchy = {
  name: 'All storage', path: 'all-storage', allocated_bytes: scanVisible,
  file_count: scanSummary.unique_files, children: driveTrees,
};

const cleanupRows = [...cleanup.values()].sort((a, b) => b.allocated_bytes - a.allocated_bytes);
const safetyTotals = new Map();
for (const item of cleanupRows) addAggregate(safetyTotals, item.safety, item.allocated_bytes, item.file_count);

const reviewed = {
  metadata: {
    generated_utc: new Date().toISOString(),
    scan_started_utc: scanSummary.started_utc,
    scan_completed_utc: scanSummary.completed_utc,
    machine_user: systemEvidence.user,
    is_administrator: systemEvidence.is_administrator,
    duplicate_hash_threshold_bytes: scanSummary.duplicate_threshold_bytes,
    notes: [
      'Allocated bytes come from NTFS FILE_STANDARD_INFO allocation size.',
      'Hard-linked files are counted once by volume serial number and file ID.',
      'Directory reparse points, junctions, and symbolic links are recorded but not traversed.',
      'The scanner output directory was excluded to avoid self-generated data contaminating the scan.',
      'Duplicate candidates below the configured threshold were not content-hashed.',
    ],
  },
  drive: {
    physical_disks: systemEvidence.physical_disks,
    volumes: systemEvidence.volumes,
    scanned_volumes: scannedVolumes,
    capacity_bytes: capacity,
    used_bytes: used,
    free_bytes: free,
    scan_visible_allocated_bytes: scanVisible,
    unaccounted_or_protected_bytes: unaccounted,
    scan_visible_share_of_used: used ? scanVisible / used : null,
  },
  scan: scanSummary,
  system: {
    special_files: systemEvidence.special_files,
    page_files: systemEvidence.page_files,
    compact_os: systemEvidence.commands?.compact_os,
    sleep_states: systemEvidence.commands?.sleep_states,
    component_store: systemEvidence.commands?.component_store,
    reserved_storage: systemEvidence.commands?.reserved_storage,
    shadow_storage: systemEvidence.commands?.shadow_storage,
    shadow_copies: systemEvidence.commands?.shadow_copies,
    appx_package_count: (systemEvidence.appx_packages ?? []).length,
    registry_application_count: (systemEvidence.installed_applications ?? []).length,
  },
  breakdowns: {
    categories: [...categories.values()].sort((a, b) => b.allocated_bytes - a.allocated_bytes),
    top_level: topLevel,
    extensions: [...extensions.values()].sort((a, b) => b.allocated_bytes - a.allocated_bytes).slice(0, 100),
    age: [...ages.values()],
    hierarchy,
  },
  rankings: {
    top_directories: topDirectories,
    large_files: largeFiles.slice(0, 1000),
    old_large_files: largeFiles.filter((file) => ['1–2 years', '>2 years'].includes(file.age_bucket)).slice(0, 300),
    installed_apps_with_locations: installedApps.slice(0, 300),
  },
  duplicates: {
    threshold_bytes: scanSummary.duplicate_threshold_bytes,
    group_count: scanSummary.duplicate_groups,
    recoverable_bytes: scanSummary.duplicate_recoverable_bytes,
    largest_groups: duplicateGroups.slice(0, 500),
  },
  cleanup: {
    opportunities: cleanupRows,
    totals_by_safety: [...safetyTotals.values()].sort((a, b) => b.allocated_bytes - a.allocated_bytes),
    caveat: 'Opportunity categories are mutually exclusive within this table, but duplicate potential is separate and may overlap them. Do not add duplicates to cleanup totals without reviewing paths.',
  },
  coverage: {
    inaccessible_entry_count: scanSummary.inaccessible_entries,
    inaccessible_log_rows: inaccessibleLogRows,
    inaccessible_by_type: [...inaccessibleByType.values()].sort((a, b) => b.file_count - a.file_count),
    inaccessible_examples: inaccessibleExamples,
    identity_failures: scanSummary.identity_failures,
    allocation_failures: scanSummary.allocation_failures,
    reparse_points_skipped: scanSummary.reparse_points_skipped,
    hardlink_references_skipped: scanSummary.hardlink_references_skipped,
  },
  provenance: {
    source_files: [
      'scan_summary.json', 'system_evidence.json', 'directories.csv.gz', 'files.csv.gz',
      'large_files.csv', 'duplicates.csv', 'inaccessible.csv', 'reparse_points.csv',
      'hardlink_references.csv.gz',
    ],
    raw_inventory_file: 'files.csv.gz',
    raw_directory_file: 'directories.csv.gz',
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(reviewed, null, 2));
console.log(`Wrote ${outputPath}`);
console.log(JSON.stringify({
  used_gib: used / GiB,
  scan_visible_gib: scanVisible / GiB,
  unaccounted_gib: unaccounted / GiB,
  duplicate_potential_gib: scanSummary.duplicate_recoverable_bytes / GiB,
  category_count: reviewed.breakdowns.categories.length,
  cleanup_count: cleanupRows.length,
}, null, 2));
