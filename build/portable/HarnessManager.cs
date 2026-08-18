// HarnessManager.cs — DeepSeek Harness 桌面管理器(WebView2 混合壳)
//
// 原生窗口壳:定位内嵌 node.exe + harness-manager.mjs,spawn 后台管理
// 服务器,然后用 WebView2(Windows 10/11 自带 Runtime)加载本地 Web UI。
//
// 便携化契约:
//   * WebView2 用户数据目录显式指向 <app>\data\webview2-cache,绝不写
//     %LOCALAPPDATA%(CoreWebView2Environment.CreateAsync 的 userDataFolder)。
//   * 管理器服务器只绑 127.0.0.1;壳退出时优雅关停服务器,不杀任何
//     dsh 实例进程(实例是 detached 的)。
//   * 无 WebView2 Runtime 时降级为系统浏览器打开管理面板。
//
// 编译:build-manager.ps1(系统 csc + WebView2 NuGet managed DLL)。
// 引用:System.Windows.Forms(System.Windows.Forms.dll 在 Windows 自带
// .NET Framework 4.x 中)。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

class HarnessManager
{
    static string appRoot;
    static string runtimeRoot;
    static string nodeExe;
    static string managerScript;
    static string dataRoot;
    static string exeDir;
    static Process nodeProc;
    static string managerUrl;
    static Form mainForm;

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        }
        catch { /* old runtime: proceed */ }

        try
        {
            exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(exeDir)) exeDir = Directory.GetCurrentDirectory();

            // ---- form factor: .extracted.ok marks the exe-edition cache ----
            if (File.Exists(Path.Combine(exeDir, ".extracted.ok")))
            {
                runtimeRoot = exeDir;                       // portable\<version>\
                appRoot = Directory.GetParent(Directory.GetParent(exeDir).FullName).FullName; // exe 旁
            }
            else
            {
                runtimeRoot = exeDir;
                appRoot = exeDir;
            }
            nodeExe = Path.Combine(runtimeRoot, @"runtime\node\node.exe");
            managerScript = Path.Combine(runtimeRoot, "harness-manager.mjs");
            dataRoot = Path.Combine(appRoot, "data");

            // ---- single instance per appRoot: second run focuses the first ----
            bool createdNew;
            using (var singleInstance = new Mutex(true, "Local\\dsh-harness-manager-" + Sanitize(appRoot), out createdNew))
            {
                if (!createdNew)
                {
                    try
                    {
                        using (var pipe = new NamedPipeClientStream(".", PipeName(appRoot), PipeDirection.Out))
                        {
                            pipe.Connect(500);
                            byte[] focus = Encoding.UTF8.GetBytes("focus");
                            pipe.Write(focus, 0, focus.Length);
                        }
                    }
                    catch { /* first instance may have just exited */ }
                    return 0;
                }
                return RunShell(args);
            }
        }
        catch (Exception ex)
        {
            ShellLog("FATAL: " + ex);
            MessageBox.Show("DeepSeek Harness Manager: " + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static void ShellLog(string message)
    {
        try
        {
            string logDir = string.IsNullOrEmpty(dataRoot)
                ? Path.Combine(exeDir, "data", ".manager")
                : Path.Combine(dataRoot, ".manager");
            Directory.CreateDirectory(logDir);
            File.AppendAllText(Path.Combine(logDir, "shell.log"),
                DateTime.Now.ToString("HH:mm:ss") + " " + message + "\r\n");
        }
        catch { /* never break the shell over logging */ }
    }

    static int RunShell(string[] args)
    {
        // ---- named pipe server: receives "focus" from later launches ----
        StartFocusPipe();

        // ---- spawn the manager server (embedded node) ----
        ShellLog("exeDir form: appRoot=" + appRoot + " runtimeRoot=" + runtimeRoot);
        if (!File.Exists(nodeExe)) throw new Exception("embedded node.exe not found: " + nodeExe);
        if (!File.Exists(managerScript)) throw new Exception("harness-manager.mjs not found: " + managerScript);

        var psi = new ProcessStartInfo(nodeExe);
        psi.Arguments = Quote(managerScript) + " --managed";
        psi.UseShellExecute = false;
        psi.WorkingDirectory = appRoot;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = new UTF8Encoding(false);
        psi.StandardErrorEncoding = new UTF8Encoding(false);
        ShellLog("spawning node: " + nodeExe);
        nodeProc = Process.Start(psi);
        ShellLog("node pid " + nodeProc.Id);

        // read lines until the URL line appears
        var urlReady = new ManualResetEvent(false);
        nodeProc.OutputDataReceived += (s, e) =>
        {
            if (e.Data == null) return;
            int idx = e.Data.IndexOf("HARNESS_MANAGER_URL", StringComparison.Ordinal);
            if (idx >= 0)
            {
                string url = e.Data.Substring(idx + "HARNESS_MANAGER_URL".Length).Trim();
                if (url.Length > 0) { managerUrl = url; urlReady.Set(); }
            }
        };
        nodeProc.ErrorDataReceived += (s, e) => { if (e.Data != null) ShellLog("[stderr] " + e.Data); };
        nodeProc.BeginOutputReadLine();
        nodeProc.BeginErrorReadLine();
        ShellLog("waiting for URL line...");
        if (!urlReady.WaitOne(20000))
        {
            ShellLog("TIMEOUT waiting for URL; node exited=" + nodeProc.HasExited + (nodeProc.HasExited ? " code=" + nodeProc.ExitCode : ""));
            throw new Exception("manager server did not start in time; see console output for details");
        }
        ShellLog("got URL " + managerUrl);

        // ---- WebView2 or browser fallback ----
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        mainForm = new Form
        {
            Text = "DeepSeek Harness Manager",
            Width = 1280,
            Height = 800,
            MinimumSize = new Size(1024, 640),
            StartPosition = FormStartPosition.CenterScreen,
        };
        try
        {
            string icon = Path.Combine(runtimeRoot, "app.ico");
            if (File.Exists(icon)) mainForm.Icon = new Icon(icon);
        }
        catch { /* cosmetic */ }

        bool webview2 = !(Environment.GetEnvironmentVariable("DSM_NO_WEBVIEW2") == "1");
        if (webview2)
        {
            try
            {
                if (string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString()))
                    webview2 = false;
            }
            catch { webview2 = false; }
        }
        // Some host environments export WEBVIEW2_USER_DATA_FOLDER globally,
        // which OUTRANKS the CreateAsync userDataFolder parameter. Clear it so
        // the portable contract (user data under <app>\data) always holds.
        Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", null);

        if (webview2)
        {
            ShellLog("initializing WebView2, userDataFolder=" + Path.Combine(dataRoot, "webview2-cache"));
            var webView = new WebView2 { Dock = DockStyle.Fill };
            mainForm.Controls.Add(webView);
            // Microsoft's canonical WinForms pattern: initialize from the Shown
            // event (message pump running) with async/await — the ContinueWith
            // + BeginInvoke variant hangs on some .NET Framework machines.
            mainForm.Shown += async (s, e) =>
            {
                try
                {
                    // 便携化关键:用户数据目录在应用 data 下,绝不写 %LOCALAPPDATA%
                    var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataRoot, "webview2-cache"), null);
                    await webView.EnsureCoreWebView2Async(env);
                    webView.CoreWebView2.NewWindowRequested += (sender, ev) =>
                    {
                        ev.Handled = true;
                        try { Process.Start(ev.Uri); } catch { /* ignore */ }
                    };
                    ShellLog("WebView2 init OK, userDataFolder=" + webView.CoreWebView2.Environment.UserDataFolder);
                    ShellLog("navigating " + managerUrl);
                    webView.CoreWebView2.Navigate(managerUrl);
                }
                catch (Exception ex)
                {
                    ShellLog("WebView2 init FAILED: " + ex.Message);
                    FallbackBrowser();
                }
            };
        }
        else
        {
            FallbackBrowser();
        }

        mainForm.FormClosing += (s, e) => ShutdownServer();
        Application.Run(mainForm);
        ShutdownServer();
        return 0;
    }

    static void FallbackBrowser()
    {
        try { Process.Start(managerUrl); } catch { /* ignore */ }
        var tip = new Label
        {
            Text = "未检测到 WebView2 Runtime,已在系统浏览器中打开管理面板。\r\n\r\n"
                 + "管理服务器将继续在后台运行;关闭本窗口即停止。\r\n"
                 + "如需原生窗口体验,请安装 Microsoft Edge WebView2 Runtime。",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 11),
            ForeColor = Color.FromArgb(0xd8, 0xde, 0xe9),
            Padding = new Padding(40),
        };
        tip.BackColor = Color.FromArgb(0x14, 0x16, 0x1a);
        mainForm.Controls.Add(tip);
    }

    static void ShutdownServer()
    {
        if (nodeProc == null || nodeProc.HasExited) return;
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(managerUrl + "/api/shutdown");
            req.Method = "POST";
            req.Timeout = 3000;
            req.ContentLength = 0;
            try { using (var resp = (HttpWebResponse)req.GetResponse()) { } } catch { /* fall through */ }
        }
        catch { /* server already down */ }
        if (!nodeProc.WaitForExit(3000))
        {
            try
            {
                // 只杀管理器 node 进程自身,绝不用 /T(实例是 detached 的,不能株连)
                Process.Start(new ProcessStartInfo("taskkill", "/PID " + nodeProc.Id + " /F")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
            }
            catch { /* already gone */ }
        }
        nodeProc.Dispose();
        nodeProc = null;
    }

    static void StartFocusPipe()
    {
        var t = new Thread(() =>
        {
            try
            {
                while (true)
                {
                    using (var server = new NamedPipeServerStream(PipeName(appRoot), PipeDirection.InOut, 1))
                    {
                        server.WaitForConnection();
                        var buf = new byte[16];
                        int n = server.Read(buf, 0, buf.Length);
                        if (n > 0 && mainForm != null && !mainForm.IsDisposed)
                        {
                            mainForm.BeginInvoke((Action)(() =>
                            {
                                if (mainForm.WindowState == FormWindowState.Minimized)
                                    mainForm.WindowState = FormWindowState.Normal;
                                mainForm.Activate();
                                mainForm.TopMost = true;
                                mainForm.TopMost = false;
                            }));
                        }
                    }
                }
            }
            catch { /* pipe closed with the process */ }
        });
        t.IsBackground = true;
        t.Start();
    }

    static string PipeName(string root)
    {
        var sb = new StringBuilder("dsh-hm-pipe-");
        foreach (char c in root)
        {
            sb.Append(char.IsLetterOrDigit(c) ? c : '_');
            if (sb.Length > 80) break;
        }
        return sb.ToString();
    }

    static string Sanitize(string root)
    {
        var sb = new StringBuilder();
        foreach (char c in root) sb.Append(char.IsLetterOrDigit(c) ? c : '_');
        return sb.ToString();
    }

    static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
