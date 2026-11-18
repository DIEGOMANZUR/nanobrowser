using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class WorkspaceHost
{
    private const int Chunk = 384 * 1024;
    private const int FileLimit = 25 * 1024 * 1024;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
    private static Process server;
    private static string serverId;
    private static readonly string HostDirectory = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr attributes,
        uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint count, uint flags);

    private static void Main()
    {
        using (var input = new BinaryReader(Console.OpenStandardInput()))
        using (var output = new BinaryWriter(Console.OpenStandardOutput()))
        {
            while (true)
            {
                int length;
                try { length = input.ReadInt32(); }
                catch (EndOfStreamException) { CloseServer(); return; }
                if (length < 1 || length > 22 * 1024 * 1024) return;
                var bytes = input.ReadBytes(length);
                if (bytes.Length != length) return;
                object response;
                try
                {
                    var request = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
                    response = new { data = Run(request) };
                }
                catch (Exception error)
                {
                    response = new { error = error is UnauthorizedAccessException ? "Windows denied access to this path." : error.Message };
                }
                var payload = Encoding.UTF8.GetBytes(Json.Serialize(response));
                if (payload.Length > 1024 * 1024)
                    payload = Encoding.UTF8.GetBytes("{\"error\":\"The Windows response is too large.\"}");
                output.Write(payload.Length);
                output.Write(payload);
                output.Flush();
            }
        }
    }

    private static object Run(Dictionary<string, object> request)
    {
        switch (StringArg(request, "op"))
        {
            case "hello": return new { version = 1 };
            case "roots": return Roots();
            case "list": return Browse(PathArg(request), StringArg(request, "query"), NumberArg(request, "offset"));
            case "chunk": return ReadChunk(PathArg(request), NumberArg(request, "offset"));
            case "save": return Save(PathArg(request), RequiredString(request, "content"));
            case "copy": return Copy(PathArg(request, "source"), PathArg(request));
            case "mcp": return Exchange(StringArg(request, "server"), StringArg(request, "message"));
            case "mcp-close": CloseServer(); return true;
            default: throw new ArgumentException("The Windows companion does not support this operation.");
        }
    }

    private static void CloseServer()
    {
        if (server == null) return;
        try
        {
            server.StandardInput.Close();
            if (!server.WaitForExit(500)) server.Kill();
        }
        catch (InvalidOperationException) { }
        server.Dispose();
        server = null;
        serverId = null;
    }

    private static object Exchange(string id, string message)
    {
        if (!Regex.IsMatch(id, @"^[A-Za-z0-9_-]{1,64}$") || message.Length > 100000 || message.IndexOfAny(new[] {'\r', '\n'}) >= 0)
            throw new ArgumentException("Invalid local connector name or message.");
        var request = Json.Deserialize<Dictionary<string, object>>(message);
        var method = StringArg(request, "method");
        if (Array.IndexOf(new[] { "initialize", "notifications/initialized", "tools/list", "tools/call" }, method) < 0)
            throw new ArgumentException("This connector method is unavailable.");
        if (server == null)
        {
            if (method != "initialize") throw new InvalidOperationException("Open the connector first.");
            var configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "servers.json");
            if (!File.Exists(configPath)) throw new FileNotFoundException("Configure servers.json beside the Windows companion first.");
            var config = Json.Deserialize<Dictionary<string, Dictionary<string, object>>>(File.ReadAllText(configPath));
            Dictionary<string, object> entry;
            if (!config.TryGetValue(id, out entry)) throw new ArgumentException("No installed local connector has that name.");
            var executable = PathArg(entry, "executable");
            if (!executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Configure an absolute executable path ending in .exe.");
            var start = new ProcessStartInfo(executable, StringArg(entry, "arguments")) {
                UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true,
                RedirectStandardError = true, CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            };
            var cwd = StringArg(entry, "workingDirectory");
            if (!String.IsNullOrEmpty(cwd)) start.WorkingDirectory = PathArg(entry, "workingDirectory");
            object variables;
            if (entry.TryGetValue("environment", out variables)) {
                var map = variables as Dictionary<string, object>;
                if (map != null) foreach (var item in map) if (item.Value is string) start.EnvironmentVariables[item.Key] = (string)item.Value;
            }
            server = Process.Start(start);
            server.BeginErrorReadLine();
            serverId = id;
        }
        if (serverId != id) throw new InvalidOperationException("This session is connected to another server.");
        server.StandardInput.WriteLine(message);
        server.StandardInput.Flush();
        object requestId;
        if (!request.TryGetValue("id", out requestId)) return null;
        var deadline = Stopwatch.StartNew();
        for (var skipped = 0; skipped < 100; skipped++)
        {
            var line = ReadServerLine(server.StandardOutput);
            var remaining = 15000 - (int)deadline.ElapsedMilliseconds;
            if (remaining <= 0 || !line.Wait(remaining)) { CloseServer(); throw new TimeoutException("The local connector timed out."); }
            if (line.Result == null) throw new IOException("The local connector closed the output stream.");
            var reply = Json.Deserialize<Dictionary<string, object>>(line.Result);
            object replyId;
            if (reply.TryGetValue("id", out replyId) && Object.Equals(replyId, requestId)) return reply;
        }
        throw new IOException("The local connector did not return a matching response.");
    }

    private static async System.Threading.Tasks.Task<string> ReadServerLine(StreamReader reader)
    {
        // Bound the line while reading so a faulty server cannot allocate an unbounded string.
        var line = new StringBuilder();
        var character = new char[1];
        while (await reader.ReadAsync(character, 0, 1) > 0)
        {
            if (character[0] == '\n') return line.ToString();
            if (line.Length >= 250000) throw new IOException("The local connector response is too large.");
            line.Append(character[0]);
        }
        return null;
    }

    private static string StringArg(Dictionary<string, object> request, string key)
    {
        object value;
        return request.TryGetValue(key, out value) ? value as string ?? "" : "";
    }

    private static string RequiredString(Dictionary<string, object> request, string key)
    {
        object value;
        if (!request.TryGetValue(key, out value) || !(value is string)) throw new ArgumentException("Expected text for " + key + ".");
        return (string)value;
    }

    private static int NumberArg(Dictionary<string, object> request, string key)
    {
        object value;
        return request.TryGetValue(key, out value) && value is int ? Math.Max(0, (int)value) : 0;
    }

    private static string PathArg(Dictionary<string, object> request, string key = "path")
    {
        var path = RequiredString(request, key).Replace('/', '\\');
        if (path.Length > 245 || !Regex.IsMatch(path, @"^[a-zA-Z]:\\"))
            throw new ArgumentException("Use an absolute path on a Windows drive.");
        foreach (var part in path.Substring(3).Split('\\'))
        {
            if (part == "" && path.Length == 3) continue;
            if (part.Length == 0 || part.Trim() != part || part.EndsWith(".") ||
                part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                Regex.IsMatch(part, @"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)", RegexOptions.IgnoreCase))
                throw new ArgumentException("This Windows path contains a reserved name or an invalid segment.");
        }
        return Path.GetFullPath(path);
    }

    private static void CheckWorkspacePath(string path)
    {
        if (WithinHost(path, HostDirectory)) throw new UnauthorizedAccessException("The companion's configuration folder is private.");
        var ancestor = path;
        while (!Directory.Exists(ancestor) && !File.Exists(ancestor))
        {
            ancestor = Path.GetDirectoryName(ancestor);
            if (String.IsNullOrEmpty(ancestor)) throw new DirectoryNotFoundException("No accessible parent directory.");
        }
        using (var handle = CreateFile(ancestor, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new UnauthorizedAccessException("Windows could not verify this path.");
            CheckOpenedPath(handle, ancestor);
        }
    }

    private static string FinalPath(SafeFileHandle handle)
    {
        var result = new StringBuilder(32768);
        var size = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
        if (size <= 0 || size >= result.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        var final = result.ToString();
        if (final.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + final.Substring(8);
        return final.StartsWith(@"\\?\", StringComparison.Ordinal) ? final.Substring(4) : final;
    }

    private static bool WithinHost(string path, string root)
    {
        return path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
    }

    private static void CheckOpenedPath(SafeFileHandle handle, string requested)
    {
        var final = FinalPath(handle).TrimEnd('\\');
        if (WithinHost(final, HostDirectory))
            throw new UnauthorizedAccessException("The companion's configuration folder is private.");
        if (!final.Equals(requested.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Use the directory's direct Windows path.");
    }

    private static IList<object> Roots()
    {
        var roots = new List<object>();
        foreach (var drive in DriveInfo.GetDrives())
            if (drive.IsReady) roots.Add(new { path = drive.Name });
        foreach (var name in new[] { Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolder.MyDocuments, Environment.SpecialFolder.UserProfile })
        {
            var path = Environment.GetFolderPath(name);
            if (!String.IsNullOrEmpty(path)) roots.Add(new { name = name.ToString(), path = path });
        }
        return roots;
    }

    private static object Browse(string path, string query, int offset)
    {
        CheckWorkspacePath(path);
        var entries = new List<object>();
        var count = 0;
        var deadline = Stopwatch.StartNew();
        foreach (var item in new DirectoryInfo(path).EnumerateFileSystemInfos())
        {
            if (deadline.ElapsedMilliseconds > 8000) return new { entries, limited = true };
            if (item.Name.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0 || count++ < offset) continue;
            if (entries.Count == 10) return new { entries, nextOffset = offset + entries.Count };
            var file = item as FileInfo;
            entries.Add(new {
                kind = file == null ? "directory" : "file",
                path = item.FullName,
                size = file == null ? (long?)null : file.Length,
                modified = item.LastWriteTimeUtc.ToString("o"),
            });
        }
        return new { entries };
    }

    private static object ReadChunk(string path, int offset)
    {
        CheckWorkspacePath(path);
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            CheckOpenedPath(stream.SafeFileHandle, path);
            if (stream.Length > FileLimit || offset > stream.Length) throw new ArgumentException("File exceeds the 25 MiB limit or offset is invalid.");
            stream.Seek(offset, SeekOrigin.Begin);
            using (var reader = new BinaryReader(stream))
            {
                var bytes = reader.ReadBytes(Chunk);
                return new { name = Path.GetFileName(path), size = stream.Length, data = Convert.ToBase64String(bytes), modified = File.GetLastWriteTimeUtc(path).Ticks.ToString() };
            }
        }
    }

    private static object Save(string path, string content)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        if (bytes.Length > 5 * 1024 * 1024 || !Regex.IsMatch(path, @"\.(txt|md|csv|json|html?)$", RegexOptions.IgnoreCase))
            throw new ArgumentException("Use a supported text extension and at most 5 MiB.");
        return Publish(path, bytes.Length, output => output.Write(bytes, 0, bytes.Length));
    }

    private static object Copy(string source, string path)
    {
        CheckWorkspacePath(source);
        using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            CheckOpenedPath(input.SafeFileHandle, source);
            if (input.Length > FileLimit) throw new ArgumentException("File exceeds the 25 MiB copy limit.");
            if (!String.Equals(Path.GetExtension(source), Path.GetExtension(path), StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Keep the original file extension when copying.");
            return Publish(path, input.Length, input.CopyTo);
        }
    }

    private static object Publish(string path, long bytes, Action<FileStream> write)
    {
        CheckWorkspacePath(path);
        var directory = Path.GetDirectoryName(path);
        Directory.CreateDirectory(directory);
        CheckWorkspacePath(directory);
        var staging = Path.Combine(directory, ".nanobrowser-" + Guid.NewGuid().ToString("N") + ".tmp");
        using (var output = new FileStream(staging, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            CheckOpenedPath(output.SafeFileHandle, staging);
            write(output);
            output.Flush(true);
        }
        // Only the final name is published. A failed save may leave its unique staging file for manual inspection.
        CheckWorkspacePath(directory);
        try { File.Move(staging, path); }
        catch (IOException)
        {
            if (!File.Exists(path)) throw;
            path = Path.Combine(directory, Path.GetFileNameWithoutExtension(path) + " (" + Guid.NewGuid().ToString("N").Substring(0, 12) + ")" + Path.GetExtension(path));
            File.Move(staging, path);
        }
        return new { path, bytes };
    }
}
