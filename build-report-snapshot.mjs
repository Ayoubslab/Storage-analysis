import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.resolve(process.argv[2] ?? './storage-analysis/dashboard-snapshot.json');
const outputPath = path.resolve(process.argv[3] ?? './storage-analysis/report-snapshot.json');
const snapshot = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const drive = snapshot.queries?.drive_summary?.rows?.[0] ?? {};
const usedPercent = Number.isFinite(drive.used_bytes / drive.capacity_bytes)
  ? ((drive.used_bytes / drive.capacity_bytes) * 100).toFixed(1)
  : 'unknown';
const asOf = String(snapshot.generatedAt ?? new Date().toISOString()).slice(0, 10);

snapshot.id = 'report:3bde730a-c6ec-4256-ba20-2a5d7ae8c23c';
snapshot.surface = 'report';
snapshot.title = `SSD allocation analysis — ${usedPercent}% full`;
snapshot.buildStatus = 'complete';
snapshot.filters = [];
snapshot.report = { asOf, visibleFilterIds: [] };

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
console.log(`Wrote ${outputPath}`);
