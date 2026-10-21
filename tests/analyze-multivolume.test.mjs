import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function writeGzip(filePath, text) {
  fs.writeFileSync(filePath, zlib.gzipSync(text));
}

test('aggregates two scanned volumes without collapsing the drive hierarchy', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-analysis-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'data');
  const output = path.join(root, 'reviewed-data.json');
  fs.mkdirSync(input);

  fs.writeFileSync(path.join(input, 'scan_summary.json'), JSON.stringify({
    started_utc: '2026-01-01T00:00:00Z', completed_utc: '2026-01-01T00:01:00Z',
    unique_files: 2, directories: 4, logical_bytes: 300, allocated_bytes: 300,
    hardlink_references_skipped: 0, reparse_points_skipped: 0, inaccessible_entries: 0,
    identity_failures: 0, allocation_failures: 0, duplicate_threshold_bytes: 10485760,
    duplicate_groups: 0, duplicate_recoverable_bytes: 0,
  }));
  fs.writeFileSync(path.join(input, 'system_evidence.json'), JSON.stringify({
    user: 'TEST\\User', is_administrator: false, physical_disks: [], installed_applications: [], appx_packages: [],
    volumes: [
      { drive_letter: 'C', label: 'System', file_system: 'NTFS', drive_type: 'Fixed', size_bytes: 1000, free_bytes: 500 },
      { drive_letter: 'D', label: 'Data', file_system: 'NTFS', drive_type: 'Fixed', size_bytes: 2000, free_bytes: 1500 },
    ],
    special_files: [], page_files: [], commands: {},
  }));
  writeGzip(path.join(input, 'directories.csv.gz'), [
    'path,parent,logical_bytes,allocated_bytes,file_count,unknown_identity_files',
    'C:\\,,100,100,1,0', 'C:\\Users,C:\\,100,100,1,0',
    'D:\\,,200,200,1,0', 'D:\\Games,D:\\,200,200,1,0',
  ].join('\n'));
  writeGzip(path.join(input, 'files.csv.gz'), [
    'path,root,logical_bytes,allocated_bytes,last_write_utc,attributes,identity,link_count,identity_verified,allocation_verified',
    'C:\\Users\\one.bin,C:\\,100,100,2026-01-01T00:00:00Z,Archive,C:1,1,true,true',
    'D:\\Games\\two.bin,D:\\,200,200,2026-01-01T00:00:00Z,Archive,D:1,1,true,true',
  ].join('\n'));
  fs.writeFileSync(path.join(input, 'large_files.csv'), 'rank,path,logical_bytes,allocated_bytes,last_write_utc,identity\n');
  fs.writeFileSync(path.join(input, 'duplicates.csv'), 'group_id,sha256,logical_bytes,allocated_bytes,path,last_write_utc\n');
  fs.writeFileSync(path.join(input, 'inaccessible.csv'), 'path,operation,error_type,message\n');

  execFileSync(process.execPath, [path.join(projectRoot, 'analyze-storage.mjs'), input, output]);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));

  assert.deepEqual(result.drive.scanned_volumes.map((volume) => volume.drive_letter), ['C', 'D']);
  assert.equal(result.drive.capacity_bytes, 3000);
  assert.equal(result.drive.used_bytes, 1000);
  assert.equal(result.drive.free_bytes, 2000);
  assert.equal(result.drive.scan_visible_allocated_bytes, 300);
  assert.equal(result.drive.unaccounted_or_protected_bytes, 700);
  assert.equal(result.breakdowns.hierarchy.name, 'All storage');
  assert.deepEqual(result.breakdowns.hierarchy.children.map((child) => child.name), ['C:', 'D:']);
  assert.deepEqual(result.breakdowns.top_level.map((row) => row.path), ['D:\\Games', 'C:\\Users']);
});
