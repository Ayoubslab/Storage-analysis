param(
    [Parameter(Mandatory = $true)]
    [string[]] $Roots,
    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory,
    [long] $DuplicateMinimumBytes = 10485760,
    [long] $LargeFileMinimumBytes = 52428800
)

$ErrorActionPreference = 'Stop'
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null

$scannerSource = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

public static class StorageScanner
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME { public uint Low; public uint High; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);

    private enum FILE_INFO_BY_HANDLE_CLASS { FileBasicInfo = 0, FileStandardInfo = 1 }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_STANDARD_INFO
    {
        public long AllocationSize;
        public long EndOfFile;
        public uint NumberOfLinks;
        [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
        [MarshalAs(UnmanagedType.U1)] public bool Directory;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        IntPtr handle, FILE_INFO_BY_HANDLE_CLASS infoClass,
        out FILE_STANDARD_INFO info, uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private const uint FILE_READ_ATTRIBUTES = 0x80;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint FILE_SHARE_DELETE = 0x4;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    private sealed class DirStat
    {
        public string Path;
        public string Parent;
        public long LogicalBytes;
        public long AllocatedBytes;
        public long FileCount;
        public long UnknownIdentityFiles;
        public DirStat(string path, string parent) { Path = path; Parent = parent; }
    }

    private sealed class FileBrief
    {
        public string Path;
        public long LogicalBytes;
        public long AllocatedBytes;
        public DateTime LastWriteUtc;
        public string Identity;
    }

    private sealed class ScanTotals
    {
        public long UniqueFiles;
        public long HardLinkReferencesSkipped;
        public long LogicalBytes;
        public long AllocatedBytes;
        public long InaccessibleEntries;
        public long ReparsePointsSkipped;
        public long IdentityFailures;
        public long AllocationFailures;
        public DateTime StartedUtc = DateTime.UtcNow;
    }

    private static string Csv(string value)
    {
        if (value == null) return "";
        return "\"" + value.Replace("\"", "\"\"").Replace("\r", " ").Replace("\n", " ") + "\"";
    }

    private static StreamWriter GzipWriter(string path)
    {
        return new StreamWriter(new GZipStream(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read), CompressionLevel.Optimal), Encoding.UTF8, 1 << 20);
    }

    private static string Extended(string path)
    {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    private static bool TryFileSystemInfo(string path, out string identity, out uint linkCount, out long allocatedBytes, out int error)
    {
        identity = null; linkCount = 0; allocatedBytes = 0; error = 0;
        IntPtr handle = CreateFileW(Extended(path), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero,
            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE)
        {
            error = Marshal.GetLastWin32Error();
            return false;
        }
        try
        {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info))
            {
                error = Marshal.GetLastWin32Error();
                return false;
            }
            identity = info.VolumeSerialNumber.ToString("X8", CultureInfo.InvariantCulture) + ":" +
                info.FileIndexHigh.ToString("X8", CultureInfo.InvariantCulture) +
                info.FileIndexLow.ToString("X8", CultureInfo.InvariantCulture);
            linkCount = info.NumberOfLinks;
            FILE_STANDARD_INFO standard;
            if (!GetFileInformationByHandleEx(handle, FILE_INFO_BY_HANDLE_CLASS.FileStandardInfo,
                out standard, (uint)Marshal.SizeOf(typeof(FILE_STANDARD_INFO))))
            {
                error = Marshal.GetLastWin32Error();
                return false;
            }
            allocatedBytes = standard.AllocationSize;
            return true;
        }
        finally { CloseHandle(handle); }
    }

    private static DirStat EnsureDir(Dictionary<string, DirStat> dirs, string path, string parent)
    {
        DirStat stat;
        if (!dirs.TryGetValue(path, out stat))
        {
            stat = new DirStat(path, parent);
            dirs[path] = stat;
        }
        return stat;
    }

    private static void WriteIssue(StreamWriter writer, string path, string operation, Exception ex)
    {
        writer.WriteLine(Csv(path) + "," + Csv(operation) + "," + Csv(ex.GetType().Name) + "," + Csv(ex.Message));
    }

    private static string Sha256(string path, out string error)
    {
        try
        {
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, 1 << 20, FileOptions.SequentialScan))
            using (SHA256 sha = SHA256.Create())
            {
                error = null;
                byte[] hash = sha.ComputeHash(stream);
                StringBuilder sb = new StringBuilder(hash.Length * 2);
                foreach (byte b in hash) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }
        catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; return null; }
    }

    public static void Run(string[] roots, string outputDirectory, long duplicateMinimumBytes, long largeFileMinimumBytes)
    {
        Directory.CreateDirectory(outputDirectory);
        var totals = new ScanTotals();
        var seenIdentities = new HashSet<string>(StringComparer.Ordinal);
        var dirs = new Dictionary<string, DirStat>(StringComparer.OrdinalIgnoreCase);
        var duplicateCandidates = new Dictionary<long, List<FileBrief>>();
        var largeFiles = new List<FileBrief>();
        string scannerOutput = Path.GetFullPath(outputDirectory).TrimEnd(Path.DirectorySeparatorChar);
        DateTime nextProgress = DateTime.UtcNow.AddSeconds(20);

        using (var files = GzipWriter(Path.Combine(outputDirectory, "files.csv.gz")))
        using (var hardlinks = GzipWriter(Path.Combine(outputDirectory, "hardlink_references.csv.gz")))
        using (var inaccessible = new StreamWriter(Path.Combine(outputDirectory, "inaccessible.csv"), false, Encoding.UTF8))
        using (var reparses = new StreamWriter(Path.Combine(outputDirectory, "reparse_points.csv"), false, Encoding.UTF8))
        {
            files.WriteLine("path,root,logical_bytes,allocated_bytes,last_write_utc,attributes,identity,link_count,identity_verified,allocation_verified");
            hardlinks.WriteLine("path,identity,logical_bytes,allocated_bytes");
            inaccessible.WriteLine("path,operation,error_type,message");
            reparses.WriteLine("path,type,attributes");

            foreach (string rawRoot in roots)
            {
                string root = Path.GetFullPath(rawRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                var stack = new Stack<string>();
                stack.Push(root);
                EnsureDir(dirs, root, null);

                while (stack.Count > 0)
                {
                    string dir = stack.Pop();
                    string parent = null;
                    try
                    {
                        var parentInfo = Directory.GetParent(dir.TrimEnd(Path.DirectorySeparatorChar));
                        if (parentInfo != null && dir.Length > root.Length) parent = parentInfo.FullName;
                    }
                    catch { }
                    DirStat current = EnsureDir(dirs, dir.TrimEnd(Path.DirectorySeparatorChar), parent);

                    string[] entries;
                    try { entries = Directory.GetFileSystemEntries(dir); }
                    catch (Exception ex)
                    {
                        totals.InaccessibleEntries++;
                        WriteIssue(inaccessible, dir, "enumerate_directory", ex);
                        continue;
                    }

                    foreach (string entry in entries)
                    {
                        FileAttributes attrs;
                        try { attrs = File.GetAttributes(entry); }
                        catch (Exception ex)
                        {
                            totals.InaccessibleEntries++;
                            WriteIssue(inaccessible, entry, "read_attributes", ex);
                            continue;
                        }

                        bool isDirectory = (attrs & FileAttributes.Directory) != 0;
                        bool isReparse = (attrs & FileAttributes.ReparsePoint) != 0;
                        if (isReparse)
                        {
                            totals.ReparsePointsSkipped++;
                            reparses.WriteLine(Csv(entry) + "," + Csv(isDirectory ? "directory" : "file") + "," + Csv(attrs.ToString()));
                            continue;
                        }
                        if (isDirectory)
                        {
                            string child = entry.TrimEnd(Path.DirectorySeparatorChar);
                            if (String.Equals(child, scannerOutput, StringComparison.OrdinalIgnoreCase))
                            {
                                reparses.WriteLine(Csv(entry) + "," + Csv("scanner_output_excluded") + "," + Csv(attrs.ToString()));
                                continue;
                            }
                            EnsureDir(dirs, child, dir.TrimEnd(Path.DirectorySeparatorChar));
                            stack.Push(child);
                            continue;
                        }

                        try
                        {
                            var fi = new FileInfo(entry);
                            long logical = fi.Length;
                            string identity;
                            uint linkCount;
                            long allocated;
                            int identityError;
                            bool identityVerified = TryFileSystemInfo(entry, out identity, out linkCount, out allocated, out identityError);
                            bool allocationVerified = identityVerified;
                            if (!identityVerified)
                            {
                                totals.IdentityFailures++;
                                totals.AllocationFailures++;
                                identity = "PATH:" + entry;
                                linkCount = 1;
                                allocated = logical;
                                current.UnknownIdentityFiles++;
                            }

                            if (!seenIdentities.Add(identity))
                            {
                                totals.HardLinkReferencesSkipped++;
                                hardlinks.WriteLine(Csv(entry) + "," + Csv(identity) + "," + logical.ToString(CultureInfo.InvariantCulture) + "," + allocated.ToString(CultureInfo.InvariantCulture));
                                continue;
                            }

                            totals.UniqueFiles++;
                            totals.LogicalBytes += logical;
                            totals.AllocatedBytes += allocated;
                            current.FileCount++;
                            current.LogicalBytes += logical;
                            current.AllocatedBytes += allocated;

                            string lastWrite = fi.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture);
                            files.WriteLine(Csv(entry) + "," + Csv(root) + "," + logical.ToString(CultureInfo.InvariantCulture) + "," + allocated.ToString(CultureInfo.InvariantCulture) + "," + Csv(lastWrite) + "," + Csv(attrs.ToString()) + "," + Csv(identity) + "," + linkCount.ToString(CultureInfo.InvariantCulture) + "," + (identityVerified ? "true" : "false") + "," + (allocationVerified ? "true" : "false"));

                            var brief = new FileBrief { Path = entry, LogicalBytes = logical, AllocatedBytes = allocated, LastWriteUtc = fi.LastWriteTimeUtc, Identity = identity };
                            if (allocated >= largeFileMinimumBytes) largeFiles.Add(brief);
                            if (logical >= duplicateMinimumBytes)
                            {
                                List<FileBrief> candidates;
                                if (!duplicateCandidates.TryGetValue(logical, out candidates))
                                {
                                    candidates = new List<FileBrief>();
                                    duplicateCandidates[logical] = candidates;
                                }
                                candidates.Add(brief);
                            }
                        }
                        catch (Exception ex)
                        {
                            totals.InaccessibleEntries++;
                            WriteIssue(inaccessible, entry, "read_file", ex);
                        }

                        if (DateTime.UtcNow >= nextProgress)
                        {
                            double gib = totals.AllocatedBytes / 1073741824.0;
                            Console.WriteLine("SCAN progress: {0:N0} unique files, {1:N1} GiB accounted, {2:N0} directories, {3:N0} inaccessible", totals.UniqueFiles, gib, dirs.Count, totals.InaccessibleEntries);
                            nextProgress = DateTime.UtcNow.AddSeconds(20);
                        }
                    }
                }
            }
        }

        var orderedDirs = new List<DirStat>(dirs.Values);
        orderedDirs.Sort((a, b) => b.Path.Length.CompareTo(a.Path.Length));
        foreach (DirStat child in orderedDirs)
        {
            if (child.Parent == null) continue;
            DirStat parent;
            if (dirs.TryGetValue(child.Parent, out parent))
            {
                parent.LogicalBytes += child.LogicalBytes;
                parent.AllocatedBytes += child.AllocatedBytes;
                parent.FileCount += child.FileCount;
                parent.UnknownIdentityFiles += child.UnknownIdentityFiles;
            }
        }

        using (var dirWriter = GzipWriter(Path.Combine(outputDirectory, "directories.csv.gz")))
        {
            dirWriter.WriteLine("path,parent,logical_bytes,allocated_bytes,file_count,unknown_identity_files");
            foreach (DirStat stat in dirs.Values)
                dirWriter.WriteLine(Csv(stat.Path) + "," + Csv(stat.Parent) + "," + stat.LogicalBytes.ToString(CultureInfo.InvariantCulture) + "," + stat.AllocatedBytes.ToString(CultureInfo.InvariantCulture) + "," + stat.FileCount.ToString(CultureInfo.InvariantCulture) + "," + stat.UnknownIdentityFiles.ToString(CultureInfo.InvariantCulture));
        }

        largeFiles.Sort((a, b) => b.AllocatedBytes.CompareTo(a.AllocatedBytes));
        using (var writer = new StreamWriter(Path.Combine(outputDirectory, "large_files.csv"), false, Encoding.UTF8))
        {
            writer.WriteLine("rank,path,logical_bytes,allocated_bytes,last_write_utc,identity");
            for (int i = 0; i < largeFiles.Count; i++)
            {
                FileBrief f = largeFiles[i];
                writer.WriteLine((i + 1).ToString(CultureInfo.InvariantCulture) + "," + Csv(f.Path) + "," + f.LogicalBytes.ToString(CultureInfo.InvariantCulture) + "," + f.AllocatedBytes.ToString(CultureInfo.InvariantCulture) + "," + Csv(f.LastWriteUtc.ToString("o", CultureInfo.InvariantCulture)) + "," + Csv(f.Identity));
            }
        }

        Console.WriteLine("DUPLICATE phase: hashing same-size candidates >= {0:N0} bytes", duplicateMinimumBytes);
        var hashGroups = new Dictionary<string, List<FileBrief>>(StringComparer.Ordinal);
        long hashedFiles = 0;
        foreach (var pair in duplicateCandidates)
        {
            if (pair.Value.Count < 2) continue;
            foreach (FileBrief f in pair.Value)
            {
                string hashError;
                string hash = Sha256(f.Path, out hashError);
                if (hash == null)
                {
                    using (var append = new StreamWriter(Path.Combine(outputDirectory, "inaccessible.csv"), true, Encoding.UTF8))
                        append.WriteLine(Csv(f.Path) + "," + Csv("hash_duplicate_candidate") + "," + Csv("HashReadError") + "," + Csv(hashError));
                    continue;
                }
                string key = f.LogicalBytes.ToString(CultureInfo.InvariantCulture) + ":" + hash;
                List<FileBrief> group;
                if (!hashGroups.TryGetValue(key, out group))
                {
                    group = new List<FileBrief>();
                    hashGroups[key] = group;
                }
                group.Add(f);
                hashedFiles++;
                if (hashedFiles % 100 == 0) Console.WriteLine("DUPLICATE progress: {0:N0} files hashed", hashedFiles);
            }
        }

        long duplicateGroups = 0;
        long duplicatePotential = 0;
        using (var writer = new StreamWriter(Path.Combine(outputDirectory, "duplicates.csv"), false, Encoding.UTF8))
        {
            writer.WriteLine("group_id,sha256,logical_bytes,allocated_bytes,path,last_write_utc");
            foreach (var pair in hashGroups)
            {
                if (pair.Value.Count < 2) continue;
                duplicateGroups++;
                long maxAllocated = 0;
                long sumAllocated = 0;
                foreach (FileBrief f in pair.Value) { sumAllocated += f.AllocatedBytes; if (f.AllocatedBytes > maxAllocated) maxAllocated = f.AllocatedBytes; }
                duplicatePotential += Math.Max(0, sumAllocated - maxAllocated);
                string[] pieces = pair.Key.Split(new[] { ':' }, 2);
                foreach (FileBrief f in pair.Value)
                    writer.WriteLine(duplicateGroups.ToString(CultureInfo.InvariantCulture) + "," + Csv(pieces[1]) + "," + f.LogicalBytes.ToString(CultureInfo.InvariantCulture) + "," + f.AllocatedBytes.ToString(CultureInfo.InvariantCulture) + "," + Csv(f.Path) + "," + Csv(f.LastWriteUtc.ToString("o", CultureInfo.InvariantCulture)));
            }
        }

        DateTime completed = DateTime.UtcNow;
        string summary = "{" +
            "\"started_utc\":" + CsvJson(totals.StartedUtc.ToString("o", CultureInfo.InvariantCulture)) + "," +
            "\"completed_utc\":" + CsvJson(completed.ToString("o", CultureInfo.InvariantCulture)) + "," +
            "\"duration_seconds\":" + (completed - totals.StartedUtc).TotalSeconds.ToString("0.###", CultureInfo.InvariantCulture) + "," +
            "\"unique_files\":" + totals.UniqueFiles.ToString(CultureInfo.InvariantCulture) + "," +
            "\"directories\":" + dirs.Count.ToString(CultureInfo.InvariantCulture) + "," +
            "\"logical_bytes\":" + totals.LogicalBytes.ToString(CultureInfo.InvariantCulture) + "," +
            "\"allocated_bytes\":" + totals.AllocatedBytes.ToString(CultureInfo.InvariantCulture) + "," +
            "\"hardlink_references_skipped\":" + totals.HardLinkReferencesSkipped.ToString(CultureInfo.InvariantCulture) + "," +
            "\"reparse_points_skipped\":" + totals.ReparsePointsSkipped.ToString(CultureInfo.InvariantCulture) + "," +
            "\"inaccessible_entries\":" + totals.InaccessibleEntries.ToString(CultureInfo.InvariantCulture) + "," +
            "\"identity_failures\":" + totals.IdentityFailures.ToString(CultureInfo.InvariantCulture) + "," +
            "\"allocation_failures\":" + totals.AllocationFailures.ToString(CultureInfo.InvariantCulture) + "," +
            "\"duplicate_threshold_bytes\":" + duplicateMinimumBytes.ToString(CultureInfo.InvariantCulture) + "," +
            "\"duplicate_groups\":" + duplicateGroups.ToString(CultureInfo.InvariantCulture) + "," +
            "\"duplicate_recoverable_bytes\":" + duplicatePotential.ToString(CultureInfo.InvariantCulture) +
            "}";
        File.WriteAllText(Path.Combine(outputDirectory, "scan_summary.json"), summary, new UTF8Encoding(false));
        Console.WriteLine("COMPLETE: {0:N0} unique files, {1:N1} GiB allocated, {2:N0} hard-link references skipped, {3:N0} inaccessible entries, {4:N1} GiB duplicate potential", totals.UniqueFiles, totals.AllocatedBytes / 1073741824.0, totals.HardLinkReferencesSkipped, totals.InaccessibleEntries, duplicatePotential / 1073741824.0);
    }

    private static string CsvJson(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}
'@

Add-Type -TypeDefinition $scannerSource -Language CSharp
[StorageScanner]::Run($Roots, $outputPath, $DuplicateMinimumBytes, $LargeFileMinimumBytes)
