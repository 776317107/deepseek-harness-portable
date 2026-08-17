// DeepSeek Harness Portable — self-extracting single-file exe launcher.
//
// Embeds dsh.zip (the app payload: app\, runtime\tools\, launcher scripts, docs)
// and node.zip (node.exe). On first run it extracts both next to the exe
// (<exeDir>\portable\<version>), then executes
//   node <install>\app\node_modules\@deepseek-ai\dsh\lib\bin.js <args...>
//
// Portability contract:
//   * ALL user data lives in <exeDir>\data (DSH_HOME) — settings, credentials,
//     profiles, plugins and sessions travel with the exe.
//   * The runtime cache sits next to the exe so moving the whole folder needs
//     no re-extraction; if that location is read-only it falls back to
//     %LOCALAPPDATA%\dsh-portable-exe\<version>.
//
// Web mode (no args, `web`, or `--profile web`):
//   * If a dsh web server already answers on the target port (default 3080),
//     just opens the browser and exits — repeated double-clicks are idempotent.
//   * Otherwise boots `dsh web`, watches its "http://..." URL line (covers
//     --port and --port 0) and opens the default browser there.
//   * A named mutex per data root prevents two servers from writing the same
//     session history concurrently.
//
// Compiled with the .NET Framework csc.exe (ships with Windows); see build-exe.ps1.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

class DshLauncher
{
    // TEMPLATE: build-exe.ps1 replaces this with the installed dsh npm version,
    // so a rebuilt exe extracts into a fresh cache dir and never reuses an
    // older payload.
    const string Version = "__DSH_VERSION__";
    const string DefaultPort = "3080";
    const string DshEntryRel = @"app\node_modules\@deepseek-ai\dsh\lib\bin.js";
    const string NodeRel = @"runtime\node\node.exe";

    static int Main(string[] args)
    {
        // Long-path support: the bundled app's nested node_modules easily
        // exceeds MAX_PATH when the exe sits in a deep directory. The
        // documented AppContext switches must be set before any path API runs.
        try
        {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        }
        catch { /* switches unavailable on very old runtimes — proceed */ }
        try
        {
            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(exeDir)) exeDir = Directory.GetCurrentDirectory();

            // ---- data root: always next to the exe ----
            string dataRoot = Path.Combine(exeDir, "data");
            try { Directory.CreateDirectory(dataRoot); }
            catch (Exception ex) { throw new Exception("cannot create data directory " + dataRoot + ": " + ex.Message); }
            string dataReadme = Path.Combine(dataRoot, "README.txt");
            if (!File.Exists(dataReadme))
            {
                try
                {
                    File.WriteAllText(dataReadme,
                        "This folder (data) holds ALL DeepSeek Harness user data: settings, API keys,\r\n"
                        + "profiles, plugins, sessions. It lives next to the exe on purpose, so copying\r\n"
                        + "the exe (with this folder) to another PC carries everything with it.\r\n"
                        + "Delete this folder to fully reset the app.\r\n");
                }
                catch { /* cosmetic; never block startup */ }
            }

            // ---- runtime cache: next to the exe, fallback to LOCALAPPDATA ----
            string cacheBase = Path.Combine(exeDir, "portable");
            try { Directory.CreateDirectory(cacheBase); }
            catch { cacheBase = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-portable-exe"); }
            string install = Path.Combine(cacheBase, Version);
            string marker = Path.Combine(install, ".extracted.ok");
            string nodeExe = Path.Combine(install, NodeRel);
            string entry = Path.Combine(install, DshEntryRel);

            if (!File.Exists(marker))
            {
                Console.Error.WriteLine("dsh: first run - extracting embedded runtime to " + install);
                try
                {
                    if (Directory.Exists(install)) Directory.Delete(install, true);
                }
                catch { Console.Error.WriteLine("dsh: could not clean previous extraction; extracting over it"); }
                Directory.CreateDirectory(install);
                ExtractResource("dsh.zip", install);
                string nodeDir = Path.GetDirectoryName(nodeExe);
                Directory.CreateDirectory(nodeDir);
                ExtractResource("node.zip", nodeDir);
                File.WriteAllText(marker, Version + " " + DateTime.UtcNow.ToString("o"));
                Console.Error.WriteLine("dsh: extraction complete");
                // A new payload version extracted: drop stale sibling caches
                // (best effort — a server still running from one of them keeps
                // its files locked and the delete is skipped).
                try
                {
                    foreach (string dir in Directory.GetDirectories(cacheBase))
                    {
                        string name = Path.GetFileName(dir);
                        if (name != Version && File.Exists(Path.Combine(dir, ".extracted.ok")))
                            Directory.Delete(dir, true);
                    }
                }
                catch { /* cache cleanup is best effort */ }
            }
            if (!File.Exists(nodeExe)) throw new Exception("node.exe missing after extraction: " + nodeExe);
            if (!File.Exists(entry)) throw new Exception("dsh entry missing after extraction: " + entry);

            var passthrough = new List<string>(args);
            bool webMode = IsWebMode(passthrough);
            if (passthrough.Count == 0) passthrough.Add("web");

            if (webMode)
            {
                string port = FindPort(passthrough);
                if (port != "0" && DshWebOpen(port))
                {
                    // A dsh web server is already running on that port.
                    OpenBrowser("http://127.0.0.1:" + port);
                    return 0;
                }
                // Single-instance fence per data root: two dsh servers writing
                // the same session logs concurrently corrupt them.
                bool createdNew;
                using (var singleInstance = new Mutex(true, MutexName(dataRoot), out createdNew))
                {
                    if (!createdNew)
                    {
                        Console.Error.WriteLine("dsh: another dsh web instance is already running for this data directory (" + dataRoot + "); stop it before starting another (running two servers corrupts session history).");
                        return 1;
                    }
                    return RunWeb(entry, nodeExe, passthrough, install, exeDir, dataRoot);
                }
            }
            int exitCode = RunPlain(entry, nodeExe, passthrough, install, exeDir, dataRoot);
            if (exitCode != 0 && passthrough.Count > 0 && passthrough[0] == "plugin")
            {
                Console.Error.WriteLine("dsh: plugin 命令失败。常见原因:");
                Console.Error.WriteLine("  * pnpm 报 ERR_PNPM_IGNORED_BUILDS → 编辑 data\\profiles\\web\\pnpm-workspace.yaml,把 allowBuilds 下对应包改为 true 后重试");
                Console.Error.WriteLine("  * 提示缺少 Visual Studio 工具链 → 可选原生模块(ssh2 等)编译失败,一般不影响使用");
            }
            return exitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("DeepSeek Harness Portable: " + ex.Message);
            Console.Error.WriteLine("Press Enter to exit...");
            try { Console.ReadLine(); } catch { }
            return 1;
        }
    }

    /// Web mode only when the invocation actually boots the web profile:
    /// no args, `web`, or `--profile web` at the START of the command line.
    /// A subcommand like `plugin --profile web add <pkg>` must pass through to
    /// dsh untouched — matching `--profile web` anywhere would hijack it into
    /// "open the web UI" whenever a server already answers on the port.
    static bool IsWebMode(List<string> args)
    {
        if (args.Count == 0) return true;
        if (args[0] == "web") return true;
        return args.Count > 1 && args[0] == "--profile" && args[1] == "web";
    }

    /// Derive a stable per-data-root mutex name. The path already includes the
    /// exe directory (or LOCALAPPDATA fallback), so the sanitized name is
    /// unique per location without extra privileges.
    static string MutexName(string root)
    {
        var sb = new StringBuilder("Local\\dsh-portable-exe-");
        foreach (char c in root)
        {
            sb.Append(char.IsLetterOrDigit(c) ? c : '_');
        }
        return sb.ToString();
    }

    static string FindPort(List<string> args)
    {
        for (int i = 0; i < args.Count - 1; i++)
            if (args[i] == "--port")
            {
                int unused;
                if (int.TryParse(args[i + 1], out unused)) return args[i + 1];
            }
        return DefaultPort;
    }

    /// True when a dsh web server already answers on the given port.
    static bool DshWebOpen(string port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
            req.Method = "GET";
            req.Timeout = 700;
            req.ReadWriteTimeout = 700;
            req.AllowAutoRedirect = false;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream()))
            {
                char[] buffer = new char[65536];
                int count = sr.ReadBlock(buffer, 0, buffer.Length);
                string body = new string(buffer, 0, count);
                return body.IndexOf("dsh", StringComparison.OrdinalIgnoreCase) >= 0 ||
                       body.IndexOf("DeepSeek Harness", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch
        {
            return false;
        }
    }

    static void OpenBrowser(string url)
    {
        try
        {
            var psi = new ProcessStartInfo(url) { UseShellExecute = true };
            Process.Start(psi);
            Console.Error.WriteLine("dsh: opened " + url);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("dsh: failed to open browser: " + ex.Message);
        }
    }

    /// Build the node child process with the portable environment pinned.
    static ProcessStartInfo BuildProcess(string nodeExe, string entry, List<string> passthrough, string install, string exeDir, string dataRoot)
    {
        var psi = new ProcessStartInfo(nodeExe);
        psi.UseShellExecute = false;
        psi.WorkingDirectory = exeDir;
        psi.Arguments = BuildArguments(entry, passthrough);

        // Portability: all data under <exeDir>\data, never the user profile.
        psi.EnvironmentVariables["DSH_HOME"] = dataRoot;
        psi.EnvironmentVariables["DSH_AGENTS_HOME"] = Path.Combine(dataRoot, ".agents");
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("DSH_TELEMETRY_DISABLED")))
            psi.EnvironmentVariables["DSH_TELEMETRY_DISABLED"] = "1";
        psi.EnvironmentVariables["PNPM_HOME"] = Path.Combine(dataRoot, ".pnpm-home");
        psi.EnvironmentVariables["PNPM_STORE_DIR"] = Path.Combine(dataRoot, ".pnpm-store");

        // Bundled tools on PATH: embedded node + pnpm.
        string nodeDir = Path.Combine(install, @"runtime\node");
        string toolsBin = Path.Combine(install, @"runtime\tools\node_modules\.bin");
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        psi.EnvironmentVariables["PATH"] = nodeDir + ";" + toolsBin + ";" + path;
        return psi;
    }

    static int RunPlain(string entry, string nodeExe, List<string> passthrough, string install, string exeDir, string dataRoot)
    {
        using (var p = Process.Start(BuildProcess(nodeExe, entry, passthrough, install, exeDir, dataRoot)))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    static int RunWeb(string entry, string nodeExe, List<string> passthrough, string install, string exeDir, string dataRoot)
    {
        var psi = BuildProcess(nodeExe, entry, passthrough, install, exeDir, dataRoot);
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = new UTF8Encoding(false);
        psi.StandardErrorEncoding = new UTF8Encoding(false);
        using (var p = Process.Start(psi))
        {
            bool opened = false;
            var stderrTask = Task.Run(() =>
            {
                string errLine;
                while ((errLine = p.StandardError.ReadLine()) != null) Console.Error.WriteLine(errLine);
            });
            string line;
            while ((line = p.StandardOutput.ReadLine()) != null)
            {
                Console.WriteLine(line);
                if (!opened)
                {
                    int idx = line.IndexOf("http://", StringComparison.Ordinal);
                    if (idx >= 0)
                    {
                        string url = line.Substring(idx).Split(' ')[0].Trim();
                        OpenBrowser(url);
                        opened = true;
                    }
                }
            }
            p.WaitForExit();
            stderrTask.Wait(5000);
            return p.ExitCode;
        }
    }

    static string BuildArguments(string entry, List<string> args)
    {
        var sb = new StringBuilder();
        AppendQuoted(sb, entry);
        foreach (var a in args) AppendQuoted(sb, a);
        return sb.ToString();
    }

    static void AppendQuoted(StringBuilder sb, string value)
    {
        if (sb.Length > 0) sb.Append(' ');
        sb.Append('"');
        sb.Append(value.Replace("\"", "\\\""));
        sb.Append('"');
    }

    static void ExtractResource(string name, string destDir)
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (stream == null) throw new Exception("embedded resource not found: " + name);
            // Manual extraction so long paths work (ZipFile.ExtractToDirectory
            // is not long-path aware even with the AppContext switches on).
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (var entry in zip.Entries)
                {
                    string entryPath = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string target = Path.Combine(destDir, entryPath);
                    if (entry.FullName.EndsWith("/"))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    string dir = Path.GetDirectoryName(target);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    using (var inStream = entry.Open())
                    using (var outStream = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                        inStream.CopyTo(outStream);
                }
            }
        }
    }
}
