// Code Atlas 启动台：双击 exe -> 选/拖一个路径 -> 开跑 -> 地图直接嵌在窗口里。
// 三件事：找到引擎（node + src/cli.mjs）、把路径丢给它、把地图或日志显示给你。
// 地图用 WebView2（Edge 内核）嵌进来，和浏览器里看的是同一套页面、同一份观感。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CodeAtlas
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // 无界面自检模式：--headless --path <目标> [--out dist] [--port 5173] [--log launcher.log] [--lang csharp,typescript] [--list-langs]
            if (args.Length > 0 && args[0] == "--headless")
            {
                Headless.Run(args);
                return;
            }
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // --auto <路径>：开窗后直接跑（可以做快捷方式：双击就分析指定项目）
            string autoPath = null;
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--auto") autoPath = args[i + 1];
            var form = new Launcher();
            if (!string.IsNullOrWhiteSpace(autoPath)) form.Shown += (s, e) => form.AutoRun(autoPath);
            Application.Run(form);
        }
    }

    internal sealed class Config
    {
        public string NodePath { get; set; } = "node";
        public int Port { get; set; } = 5173;
        public string Out { get; set; } = "dist";
        public string LastPath { get; set; } = "";
        public int WindowWidth { get; set; } = 1400;
        public int WindowHeight { get; set; } = 900;
        /// <summary>要扫描的语言（逗号分隔的语言 id）；空串 = 自动（所有代码语言，配置文件不扫）</summary>
        public string Langs { get; set; } = "";
    }

    /// <summary>一门语言在界面上的样子（来自引擎的 langs --json，启动器不自己维护语言表）</summary>
    internal sealed class LangInfo
    {
        public string Id { get; set; } = "";
        public string Label { get; set; } = "";
        public bool OptIn { get; set; }
        public string[] Exts { get; set; } = Array.Empty<string>();
    }

    /// <summary>配色：主窗和弹窗共用一套，免得两个窗口对不上暗色</summary>
    internal static class Palette
    {
        public static readonly Color Bg = Color.FromArgb(0x0D, 0x11, 0x17);
        public static readonly Color Panel = Color.FromArgb(0x16, 0x1B, 0x22);
        public static readonly Color Fg = Color.FromArgb(0xC9, 0xD1, 0xD9);
        public static readonly Color Dim = Color.FromArgb(0x8B, 0x94, 0x9E);
        public static readonly Color Accent = Color.FromArgb(0x58, 0xA6, 0xFF);
        public static readonly Color DimInactive = Color.FromArgb(0x6E, 0x76, 0x81);
        public static readonly Color Line = Color.FromArgb(0x30, 0x36, 0x3D);
    }

    /// <summary>
    /// 内置引擎：完全版 / 精简版的 exe 里都嵌了一份引擎（src / web / configs / 需要的 wasm / d3），
    /// 首次运行释放到 %LocalAppData%\CodeAtlas\engine\&lt;版本-包大小&gt;\，之后直接用。
    /// 目录名带版本号 + 包大小：换了版本或换了引擎包就自然重新释放，不会拿旧引擎跑新代码。
    /// 完全版多一个 node.exe；精简版没有，得用系统装的 Node。
    /// </summary>
    internal static class Payload
    {
        public const string ResourceName = "CodeAtlas.engine.zip";

        /// <summary>释放动作上锁：OnShown 的后台预热和「开跑」可能同时来</summary>
        private static readonly object Gate = new object();

        /// <summary>这份 exe 里带没带引擎</summary>
        public static bool HasEngine => ResourceLength() > 0;

        private static long ResourceLength()
        {
            try
            {
                using var s = typeof(Payload).Assembly.GetManifestResourceStream(ResourceName);
                return s?.Length ?? 0;
            }
            catch { return 0; }
        }

        public static string TargetDir()
        {
            var v = typeof(Payload).Assembly.GetName().Version;
            string ver = v == null ? "0.0.0" : $"{v.Major}.{v.Minor}.{v.Build}";
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CodeAtlas", "engine", $"{ver}-{Stamp()}");
        }

        /// <summary>
        /// 引擎包指纹：构建时算好的内容哈希（csproj 的 Hash 目标→AssemblyMetadata）。
        /// **不能用包大小**：内容改了但大小不变时，会继续用旧的解包目录（实际踩过）。
        /// 读不到指纹（老构建）才退回用大小。
        /// </summary>
        private static string Stamp()
        {
            try
            {
                string s = typeof(Payload).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                    .FirstOrDefault((a) => a.Key == "PayloadStamp")?.Value ?? "";
                if (s.Length >= 12) return s.Substring(0, 12);
                if (s.Length > 0) return s;
            }
            catch { }
            return ResourceLength().ToString();
        }

        /// <summary>确保引擎已释放好，返回引擎目录（exe 里没带引擎就返回 null）</summary>
        public static string Ensure(Action<string> log)
        {
            lock (Gate)
            {
                if (!HasEngine) return null;
                string dir = TargetDir();
                string marker = Path.Combine(dir, ".ready");
                if (File.Exists(marker)) return dir;

                using var s = typeof(Payload).Assembly.GetManifestResourceStream(ResourceName);
                using var zip = new ZipArchive(s, ZipArchiveMode.Read);
                Directory.CreateDirectory(dir);
                log?.Invoke($"首次运行：正在释放内置引擎到 {dir}（{zip.Entries.Count} 个文件，只做这一次）…");
                string rootFull = Path.GetFullPath(dir) + Path.DirectorySeparatorChar;
                int n = 0;
                foreach (var e in zip.Entries)
                {
                    if (string.IsNullOrEmpty(e.Name)) continue;                    // 目录条目
                    string target = Path.GetFullPath(Path.Combine(dir, e.FullName.Replace('\\', '/')));
                    if (!target.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) continue;  // 防 zip slip
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    e.ExtractToFile(target, true);
                    n++;
                }
                File.WriteAllText(marker, DateTime.Now.ToString("o") + Environment.NewLine + n + Environment.NewLine, Encoding.UTF8);
                log?.Invoke($"✓ 内置引擎就绪（{n} 个文件）");
                CleanupOld(dir);
                return dir;
            }
        }

        /// <summary>
        /// 顺手擦掉长期不用的旧解包目录（每次换版本大约 120 MB，不清会一直长）。
        /// 只动 7 天没碰过的：正在用的那份绝不会被删（也可能另一份 exe 正在扫）。
        /// </summary>
        private static void CleanupOld(string keep)
        {
            try
            {
                string parent = Path.GetDirectoryName(keep);
                if (parent == null || !Directory.Exists(parent)) return;
                foreach (var d in Directory.GetDirectories(parent))
                {
                    if (string.Equals(Path.GetFullPath(d), Path.GetFullPath(keep), StringComparison.OrdinalIgnoreCase)) continue;
                    try
                    {
                        string marker = Path.Combine(d, ".ready");
                        if (!File.Exists(marker)) continue;
                        if ((DateTime.UtcNow - File.GetLastWriteTimeUtc(marker)).TotalDays < 7) continue;
                        Directory.Delete(d, true);
                    }
                    catch { }
                }
            }
            catch { }
        }

        /// <summary>内置 node.exe（精简版没有 = null）</summary>
        public static string NodePath(string engineDir)
        {
            if (engineDir == null) return null;
            string p = Path.Combine(engineDir, "node.exe");
            return File.Exists(p) ? p : null;
        }
    }

    internal static class Engine
    {
        public static string ConfigPath => Path.Combine(AppContext.BaseDirectory, "launcher.config.json");

        public static Config LoadConfig()
        {
            try
            {
                if (File.Exists(ConfigPath))
                    return JsonSerializer.Deserialize<Config>(File.ReadAllText(ConfigPath)) ?? new Config();
            }
            catch { /* 配置坏了就用默认值 */ }
            return new Config();
        }

        public static void SaveConfig(Config c)
        {
            try { File.WriteAllText(ConfigPath, JsonSerializer.Serialize(c, new JsonSerializerOptions { WriteIndented = true }), Encoding.UTF8); }
            catch { }
        }

        /// <summary>开发模式：exe 所在目录（或上级）里就有 src/cli.mjs（源码就在手边）</summary>
        public static string FindDevRoot()
        {
            DirectoryInfo dir = new DirectoryInfo(AppContext.BaseDirectory);
            for (int i = 0; i < 4 && dir != null; i++, dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "src", "cli.mjs"))) return dir.FullName;
            }
            return null;
        }

        /// <summary>用哪份引擎：优先 exe 旁边的源码（开发），否则用内嵌的（首次会释放）</summary>
        public static string Resolve(Action<string> log) => FindDevRoot() ?? Payload.Ensure(log);

        /// <summary>带 node 的解析：返回（引擎目录, node 路径）；都找不到就返回 (null, null)</summary>
        public static (string root, string node) ResolveAll(Config cfg, Action<string> log)
        {
            string root = Resolve(log);
            return (root, root == null ? null : PickNode(cfg, root));
        }

        /// <summary>
        /// node 用哪个：配置里写死了就用它；还是默认的 "node" 就优先用内置的（完全版），
        /// 没有内置就按 PATH 找（精简版，要求机器上装了 Node.js）。
        /// </summary>
        public static string PickNode(Config cfg, string engineDir)
        {
            string configured = (cfg.NodePath ?? "").Trim();
            string inner = Payload.NodePath(engineDir);
            if (inner != null && (configured.Length == 0 || configured.Equals("node", StringComparison.OrdinalIgnoreCase))) return inner;
            return configured.Length == 0 ? "node" : configured;
        }

        /// <summary>给日志用的一句话：现在到底是哪份引擎</summary>
        public static string DescribeEngine()
        {
            string dev = FindDevRoot();
            if (dev != null) return $"仓库模式（旁边就有源码）：{dev}";
            if (Payload.HasEngine) return $"内置引擎：{Payload.TargetDir()}（首次运行自动释放）";
            return "没找到：这个 exe 没带内置引擎，旁边也没有 src\\cli.mjs";
        }

        /// <summary>这份启动器是什么版（构建时写进程序集，不是猜的）</summary>
        public static string EditionName
        {
            get
            {
                string ed = typeof(Engine).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                    .FirstOrDefault((a) => a.Key == "Edition")?.Value ?? "";
                if (ed == "lite") return "精简版";
                if (ed == "full") return "完全版";
                return "开发构建";
            }
        }

        public static bool NodeOk(string nodePath)
        {
            try
            {
                var psi = new ProcessStartInfo(nodePath, "--version")
                {
                    RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
                };
                using var p = Process.Start(psi);
                p.WaitForExit(10000);
                return p.ExitCode == 0;
            }
            catch { return false; }
        }

        /// <summary>读语言表：直接问引擎（langs --json），这样加语言只要改 languages.mjs，启动器不用跟着改</summary>
        public static LangInfo[] ListLangs(Config cfg)
        {
            string root = Resolve(null);
            if (root == null) throw new InvalidOperationException("找不到引擎：这个 exe 没带内置引擎，旁边也没有 src\\cli.mjs。");
            string script = Path.Combine(root, "src", "cli.mjs");
            string nodeExe = PickNode(cfg, root);
            var psi = new ProcessStartInfo(nodeExe, $"\"{script}\" langs --json")
            {
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            var sb = new StringBuilder();
            var proc = new Process { StartInfo = psi };
            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) sb.AppendLine(e.Data); };
            proc.Start();
            proc.BeginErrorReadLine();
            string text = proc.StandardOutput.ReadToEnd();
            if (!proc.WaitForExit(30000)) { try { proc.Kill(true); } catch { } throw new InvalidOperationException("读语言表超时（30 秒）。"); }
            if (proc.ExitCode != 0 || string.IsNullOrWhiteSpace(text))
                throw new InvalidOperationException("引擎没能返回语言表。" + (sb.Length > 0 ? "\n" + sb.ToString().Trim() : ""));
            return JsonSerializer.Deserialize<LangInfo[]>(text, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? Array.Empty<LangInfo>();
        }

        public static Process Start(string target, Config cfg, bool open, Action<string> onLine, Action<int> onExit)
        {
            string dev = FindDevRoot();
            string root = dev ?? Payload.Ensure(null);
            if (root == null)
                throw new InvalidOperationException("找不到引擎：这个 exe 里没带内置引擎，旁边也没有 src\\cli.mjs。" +
                    "\n完全版（CodeAtlas.exe）自带引擎；精简版请把 exe 放进 CodeAtlas 目录，或换成完全版。");
            string script = Path.Combine(root, "src", "cli.mjs");
            string node = PickNode(cfg, root);
            if (!NodeOk(node))
                throw new InvalidOperationException(Payload.NodePath(root) != null
                    ? $"内置的 node 跑不起来：{node}"
                    : $"跑不起来：找不到 node（当前配置为 \"{node}\"）。精简版需要机器上装 Node.js；或在 launcher.config.json 里把 NodePath 改成 node.exe 的完整路径。");

            var args = new StringBuilder();
            args.Append('"').Append(script).Append('"');
            args.Append(" \"").Append(target).Append('"');
            args.Append(" --out \"").Append(cfg.Out).Append('"');
            args.Append(" --port ").Append(cfg.Port);
            // 语言：空串 = 引擎默认（auto）。显式选过就原样传过去。
            if (!string.IsNullOrWhiteSpace(cfg.Langs)) args.Append(" --lang \"").Append(cfg.Langs.Trim()).Append('"');
            if (!open) args.Append(" --no-open");

            var psi = new ProcessStartInfo(node, args.ToString())
            {
                // 工作目录：开发模式还是仓库（行为不变）；完全/精简版用 exe 所在目录，
                // 这样 dist/ 和 ingest/ 落在 exe 旁边（引擎目录是缓存，不该往里写用户数据）
                WorkingDirectory = dev ?? AppContext.BaseDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (s, e) => { if (e.Data != null) onLine(e.Data); };
            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) onLine("[err] " + e.Data); };
            proc.Exited += (s, e) => { try { onExit(proc.ExitCode); } catch { } };
            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            return proc;
        }
    }

    internal sealed class Launcher : Form
    {
        private readonly Config _cfg = Engine.LoadConfig();
        /// <summary>版本号从程序集读（csproj 里的 Version 是唯一来源，别再写第二份）</summary>
        private static readonly string AppVer =
            (typeof(Launcher).Assembly.GetName().Version ?? new Version(0, 0, 0)).ToString(3);

        private readonly TextBox _path = new TextBox();
        private readonly TextBox _log = new TextBox();
        private readonly WebView2 _web = new WebView2();
        private readonly Button _run = new Button();
        private readonly Button _stop = new Button();
        private readonly Button _browser = new Button();
        private readonly Button _toggle = new Button();
        private readonly Button _pickDir = new Button();
        private readonly Button _pickFile = new Button();
        private readonly Button _langs = new Button();
        private readonly Label _status = new Label();
        private readonly Label _hint = new Label();
        private readonly Label _targetLabel = new Label();
        private Panel _bar;
        private readonly CheckBox _autoSwitch = new CheckBox();
        private Process _proc;
        private string _url;
        private bool _webReady;
        private bool _showingMap;

        private static readonly Color Bg = Palette.Bg;
        private static readonly Color Panel = Palette.Panel;
        private static readonly Color Fg = Palette.Fg;
        private static readonly Color Dim = Palette.Dim;
        private static readonly Color Accent = Palette.Accent;
        private static readonly Color DimInactive = Palette.DimInactive;

        public Launcher()
        {
            Text = "Code Atlas";
            // 双屏注意：用"光标所在的那块屏幕"的工作区来定尺寸与位置（默认居中到主屏可能会跨屏）
            var startScreen = Screen.FromPoint(Cursor.Position);
            Rectangle wa = startScreen.WorkingArea;
            float k0 = DeviceDpi / 96f;
            int wantW = (int)(_cfg.WindowWidth * k0);
            int wantH = (int)(_cfg.WindowHeight * k0);
            ClientSize = new Size(
                Math.Min(Math.Max(wantW, (int)(940 * k0)), Math.Max(760, wa.Width - 60)),
                Math.Min(Math.Max(wantH, (int)(620 * k0)), Math.Max(520, wa.Height - 60)));
            MinimumSize = new Size(760, 520);
            StartPosition = FormStartPosition.Manual;
            BackColor = Bg;
            ForeColor = Fg;
            Font = new Font("Microsoft YaHei UI", 10.5f);
            AllowDrop = true;

            // ---------- 工具栏（标题就靠窗口标题了，这里省下来的空间用来排版）----------
            _bar = new Panel { Dock = DockStyle.Top, BackColor = Bg };

            var targetLabel = _targetLabel;
            targetLabel.Text = "目标";
            targetLabel.ForeColor = Dim;
            targetLabel.AutoSize = true;

            _path.SetBounds(0, 0, 400, 30);
            _path.BackColor = Panel;
            _path.ForeColor = Fg;
            _path.BorderStyle = BorderStyle.FixedSingle;

            _pickDir.Text = "选择文件夹…";
            _pickFile.Text = "选择文件…";
            Style(_pickDir);
            Style(_pickFile);
            _pickDir.Click += (s, e) => PickFolder();
            _pickFile.Click += (s, e) => PickFile();

            var tips = new ToolTip { AutoPopDelay = 12000, InitialDelay = 300 };
            tips.SetToolTip(_path, "要分析的目标：源码目录 / 编译好的 .dll、.exe / .jar；也可以直接把文件夹拖进窗口");
            tips.SetToolTip(_pickDir, "选一个文件夹：源码目录，或里面放着 .dll / .exe / .jar 的目录");
            tips.SetToolTip(_pickFile, "选一个文件：.dll / .exe / .jar（没有源码的目标）");
            tips.SetToolTip(_run, "开始分析，完事后把地图嵌到窗口里");            tips.SetToolTip(_stop, "停掉分析和服务");
            tips.SetToolTip(_toggle, "在地图与运行日志之间切换");
            tips.SetToolTip(_browser, "用系统浏览器另外开一个窗口看（方便左右对照）");

            _hint.Text = "提示：源码目录直接扫，.dll / .exe / .jar 先反编译；也可以直接把文件夹拖进来";
            _hint.ForeColor = Dim;
            _hint.AutoSize = false;
            _hint.AutoEllipsis = true;
            _hint.TextAlign = ContentAlignment.MiddleLeft;

            _autoSwitch.Text = "跑完自动切到地图";
            _autoSwitch.Checked = true;
            _autoSwitch.ForeColor = Fg;
            _autoSwitch.AutoSize = true;
            _autoSwitch.Click += (s, e) => { if (_autoSwitch.Checked && _url != null) ShowMap(); };

            _run.Text = "开跑";
            Style(_run, true);
            SetBtn(_run, true, true); // 必须让它处于"可用"状态（点击处理里会查 IsOn，漏了这行就会点了没反应）
            _run.Click += (s, e) => { if (IsOn(_run)) Run(); };
            _stop.Text = "停止";
            Style(_stop);
            SetBtn(_stop, false);
            _stop.Click += (s, e) => { if (IsOn(_stop)) Stop(); };
            _toggle.Text = "看日志";
            Style(_toggle);
            SetBtn(_toggle, false);
            _toggle.Click += (s, e) => { if (IsOn(_toggle)) ToggleView(); };
            _browser.Text = "在浏览器打开";
            Style(_browser);
            SetBtn(_browser, false);
            _browser.Click += (s, e) => { if (_url != null && IsOn(_browser)) OpenUrl(_url); };

            // 语言：默认不传 --lang（引擎自己“自动”：所有代码语言，配置文件不扫）。
            _langs.Text = LangsButtonText();
            Style(_langs);
            SetBtn(_langs, true); // 常驻可用（IsOn 检查要求 Tag=on，漏了就跟当初"开跑"一样点了没反应）
            _langs.Click += (s, e) => { if (IsOn(_langs)) PickLangs(); };
            tips.SetToolTip(_langs, "选择要扫描的语言（默认自动：19 门代码语言，配置文件不扫）。\r\n只扫需要的语言能明显提速，也能让地图不被配置文件淹没。");

            _bar.Controls.AddRange(new Control[] { targetLabel, _path, _pickDir, _pickFile, _autoSwitch, _hint, _run, _stop, _toggle, _browser, _langs });
            _targetLabel = targetLabel;
            _bar.Resize += (s, e) => ApplyLayout();

            // ---------- 状态栏 ----------
            _status.Text = "就绪";
            _status.ForeColor = Dim;
            _status.Dock = DockStyle.Bottom;
            _status.TextAlign = ContentAlignment.MiddleLeft;
            _status.Padding = new Padding(12, 0, 0, 0);
            _status.Height = 30;

            // ---------- 内容区：日志 / 地图二选一 ----------
            _log.Multiline = true;
            _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical;
            _log.BackColor = Panel;
            _log.ForeColor = Fg;
            _log.BorderStyle = BorderStyle.None;
            _log.Font = new Font("Consolas", 10.5f);
            _log.Dock = DockStyle.Fill;
            _log.WordWrap = false;

            _web.Dock = DockStyle.Fill;
            _web.Visible = false;
            _web.DefaultBackgroundColor = Bg;

            Controls.Add(_log);
            Controls.Add(_web);
            Controls.Add(_status);
            Controls.Add(_bar);

            ApplyLayout();

            if (!string.IsNullOrWhiteSpace(_cfg.LastPath)) _path.Text = _cfg.LastPath;
            Log("启动器 " + AppVer + "（" + Engine.EditionName + " · 内嵌地图）");
            Log("引擎：" + Engine.DescribeEngine());
            Log($"node：{_cfg.NodePath}（值为 node 时优先用内置的，没有内置就按 PATH 找）   输出目录：{_cfg.Out}   端口：{_cfg.Port}");
            Log("语言：" + LangsSummary());
            Log("");
            Log("下一步：点「开跑」开始扫描（也可以直接把文件夹拖进上面的输入框）。");
            Log("扫完地图会自动嵌到这个窗口里；想看扫描日志就点「看日志」。");
            if (Engine.FindDevRoot() == null && !Payload.HasEngine)
                _status.Text = "⚠ 找不到引擎：把 CodeAtlas.exe 放进 CodeAtlas 目录（含 src\\cli.mjs）再运行";

            DragEnter += (s, e) => { if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy; };
            DragDrop += (s, e) =>
            {
                var items = (string[])e.Data.GetData(DataFormats.FileDrop);
                if (items != null && items.Length > 0) { _path.Text = items[0]; Log($"拖入：{items[0]}"); }
            };
            FormClosing += (s, e) =>
            {
                Stop();
                try { _cfg.WindowWidth = (int)(ClientSize.Width / K); _cfg.WindowHeight = (int)(ClientSize.Height / K); Engine.SaveConfig(_cfg); } catch { }
            };
        }

        /// <summary>DPI 缩放系数：之前用固定像素，在 150% 缩放下显得偏小</summary>
        private float K => DeviceDpi / 96f;

        /// <summary>排版：第一行 = 目标 + 路径 + 选目录/选文件；第二行 = 自动切图 + 提示 + 动作按钮</summary>
        private void ApplyLayout()
        {
            if (_bar == null) return;
            float k = K;
            int pad = (int)(16 * k);
            int rowA = (int)(14 * k);
            int rowB = (int)(58 * k);
            int hCtrl = (int)(30 * k);
            int btnH = (int)(32 * k);
            int gap = (int)(8 * k);
            int w = _bar.ClientSize.Width;
            int right = w - pad;

            _pickFile.Location = new Point(right - _pickFile.PreferredSize.Width, rowA);
            right = _pickFile.Left - gap;
            _pickDir.Location = new Point(right - _pickDir.PreferredSize.Width, rowA);
            right = _pickDir.Left - (int)(12 * k);

            _targetLabel.Location = new Point(pad, rowA + (hCtrl - _targetLabel.PreferredHeight) / 2);
            int pathLeft = _targetLabel.Right + gap;
            _path.SetBounds(pathLeft, rowA, Math.Max(160, right - pathLeft), hCtrl);

            _autoSwitch.Location = new Point(pad, rowB + (btnH - _autoSwitch.PreferredSize.Height) / 2);

            int x = w - pad;
            foreach (var b in new[] { _browser, _toggle, _stop, _langs, _run })
            {
                b.Location = new Point(x - b.PreferredSize.Width, rowB);
                x = b.Left - gap;
            }
            int hintLeft = _autoSwitch.Right + (int)(16 * k);
            _hint.SetBounds(hintLeft, rowB, Math.Max(60, x - gap - hintLeft), btnH + (int)(4 * k));

            _bar.Height = rowB + btnH + (int)(16 * k);
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            // 句柄建好之后才知道真实 DPI：按光标所在屏幕居中，并确保整体落在屏幕里
            var scr = Screen.FromPoint(Cursor.Position);
            Rectangle wa = scr.WorkingArea;
            float k = K;
            int w = Math.Min(ClientSize.Width, wa.Width - (int)(40 * k));
            int h = Math.Min(ClientSize.Height, wa.Height - (int)(40 * k));
            ClientSize = new Size(Math.Max(760, w), Math.Max(520, h));
            Location = new Point(
                wa.Left + Math.Max(0, (wa.Width - Width) / 2),
                wa.Top + Math.Max(0, (wa.Height - Height) / 2));
        }

        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            ApplyLayout();
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // 内置引擎要释放一次（几十 MB，别占着 UI 线程）；提前放好，用户点「开跑」时就不用等
            if (Payload.HasEngine && !File.Exists(Path.Combine(Payload.TargetDir(), ".ready")))
            {
                _status.Text = "正在释放内置引擎（首次运行，只做一次）…";
                Task.Run(() =>
                {
                    string dir = Payload.Ensure(Log);
                    Ui(() => _status.Text = dir != null ? "内置引擎就绪，点「开跑」开始" : "就绪");
                });
            }
            // 内嵌地图用 WebView2；没装运行时就退回系统浏览器（功能不受影响）
            try
            {
                // 用户数据目录带上进程号：避免残留的 msedgewebview2 进程占着目录导致卡死
                var userData = Path.Combine(Path.GetTempPath(), "CodeAtlas.WebView2", Environment.ProcessId.ToString());
                // 注意：必须在 UI（STA）线程上初始化 —— 放进 Task.Run 会在 MTA 线程上创建 COM 环境，
                // 报 RPC_E_CHANGED_MODE(0x80010106)。这里直接在 UI 线程发起，只给它加个超时。
                var init = InitWebAsync(userData);
                var done = await Task.WhenAny(init, Task.Delay(15000));
                if (done != init)
                {
                    _webReady = false;
                    _web.Visible = false;
                    Log("内嵌浏览器：初始化超时（15 秒）✗ → 会用系统浏览器打开页面");
                    return;
                }
                await init; // 有异常就在这里抛出来，交给下面的 catch
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                _web.CoreWebView2.NavigationCompleted += (s, args) =>
                {
                    if (args.IsSuccess) _status.Text = "内嵌地图：" + _url;
                    else _status.Text = "页面加载失败：" + args.WebErrorStatus + "（可以点「在浏览器打开」）";
                };
                _webReady = true;
                Log("内嵌浏览器：已就绪 ✓（扫完地图显示在本窗口）");
            }
            catch (Exception ex)
            {
                _webReady = false;
                _web.Visible = false;
                Log("内嵌浏览器：不可用 ✗（原因：" + ex.Message + "）");
                Log("→ 跑完会自动用系统浏览器打开页面（功能不受影响，只是不在本窗口里）");
            }
        }

        /// <summary>
        /// 按钮的"不可用"状态：不用 Enabled=false —— 系统会把文字压成深灰，在暗底上等于隐形。
        /// 改成文字变暗灰 + 不响应点击，任何时候都读得清。
        /// </summary>
        private void SetBtn(Button b, bool on, bool primary = false)
        {
            b.ForeColor = on ? (primary ? Bg : Fg) : DimInactive;
            b.BackColor = on && primary ? Accent : Panel;
            b.Cursor = on ? Cursors.Hand : Cursors.Default;
            b.Tag = on ? "on" : "off";
        }

        private static bool IsOn(Button b) => (b.Tag as string) == "on";

        internal static void Style(Button b, bool primary = false)
        {
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = primary ? Accent : Color.FromArgb(0x30, 0x36, 0x3D);
            b.BackColor = Panel;
            b.ForeColor = primary ? Accent : Fg;
            b.Cursor = Cursors.Hand;
            // 按钮大小跟着文字走（自适应用户的 DPI 与中文字宽），别写死像素
            b.AutoSize = true;
            b.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            b.Padding = new Padding(12, 5, 12, 5);
            b.Margin = new Padding(0);
            b.Name = "btn" + Math.Abs(b.Text.GetHashCode());
        }

        private void PickFolder()
        {
            using var d = new FolderBrowserDialog { Description = "选一个要分析的文件夹（源码目录、或者编译产物目录都行）" };
            if (d.ShowDialog(this) == DialogResult.OK) _path.Text = d.SelectedPath;
        }

        private void PickFile()
        {
            using var d = new OpenFileDialog
            {
                Title = "选一个要分析的文件",
                Filter = "程序集 / 压缩包 (*.dll;*.exe;*.jar)|*.dll;*.exe;*.jar|所有文件 (*.*)|*.*",
            };
            if (d.ShowDialog(this) == DialogResult.OK) _path.Text = d.FileName;
        }

        /// <summary>选语言：列表来自引擎（langs --json），选完存进 launcher.config.json</summary>
        private void PickLangs()
        {
            LangInfo[] langs;
            try { langs = Engine.ListLangs(_cfg); }
            catch (Exception ex)
            {
                MessageBox.Show(this, "读不到语言表：" + ex.Message, "Code Atlas", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            using var d = new LangPicker(langs, _cfg.Langs);
            if (d.ShowDialog(this) != DialogResult.OK) return;
            _cfg.Langs = d.Result;
            Engine.SaveConfig(_cfg);
            _langs.Text = LangsButtonText();
            ApplyLayout(); // 文字变了按钮宽度也变，重排一下免得压到旁边的按钮
            Log("语言：" + LangsSummary());
        }

        private string LangsButtonText()
        {
            if (string.IsNullOrWhiteSpace(_cfg.Langs)) return "语言：自动";
            int n = _cfg.Langs.Split(',').Count((s) => s.Trim().Length > 0);
            return "语言：" + n + " 种";
        }

        /// <summary>日志 / 状态区里的人类可读描述（不糊弄：没配就说清楚默认到底扫什么）</summary>
        private string LangsSummary()
        {
            if (string.IsNullOrWhiteSpace(_cfg.Langs)) return "自动（19 门代码语言；配置文件格式不扫）";
            var ids = _cfg.Langs.Split(',').Select((s) => s.Trim()).Where((s) => s.Length > 0).ToArray();
            return $"只扫 {ids.Length} 种：" + string.Join(", ", ids);
        }

        private void Ui(Action a)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { try { BeginInvoke(a); } catch { } } else a();
        }

        private async Task InitWebAsync(string userData)
        {
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await _web.EnsureCoreWebView2Async(env);
        }

        private void Log(string line)
        {
            Ui(() =>
            {
                _log.AppendText(line + Environment.NewLine);
                _log.SelectionStart = _log.TextLength;
                _log.ScrollToCaret();
            });
        }

        private void Run()
        {            string target = _path.Text.Trim().Trim('"');
            if (target.Length == 0) { MessageBox.Show(this, "先选一个文件夹或文件。", "Code Atlas", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            if (!File.Exists(target) && !Directory.Exists(target)) { MessageBox.Show(this, "这个路径不存在：" + target, "Code Atlas", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }

            _cfg.LastPath = target;
            Engine.SaveConfig(_cfg);
            _url = null;
            SetBtn(_browser, false);
            SetBtn(_toggle, false);
            _toggle.Text = "看日志";
            SetBtn(_run, false, true);
            SetBtn(_stop, true);
            _status.Text = "运行中…（第一次扫描大项目会慢一点）";
            _log.Clear();
            ShowLog();
            Log($"> 开始：{target}");

            try
            {
                // 先把引擎落实（内置的话首次会释放，日志里能看到进度），再交给引擎跑
                var (engRoot, engNode) = Engine.ResolveAll(_cfg, Log);
                if (engRoot != null) Log("> 引擎：" + engRoot + Environment.NewLine + "> node：" + engNode);
                _proc = Engine.Start(target, _cfg, false, OnLine, code =>
                {
                    Ui(() =>
                    {
                        SetBtn(_run, true, true);
                        SetBtn(_stop, false);
                        _status.Text = code == 0
                            ? (_url != null ? "完成，在看地图：" + _url : "完成（没起服务）")
                            : $"进程退出（代码 {code}），看日志。";
                    });
                    if (_url == null) Log("提示：这次没拿到服务地址，地图就不会出现在本窗口 —— 上面应该有报错原因（路径不存在 / 引擎没找到等）。");
                    _proc = null;
                });
            }
            catch (Exception ex)
            {
                SetBtn(_run, true, true);
                SetBtn(_stop, false);
                _status.Text = "起不来";
                Log("错误：" + ex.Message);
                MessageBox.Show(this, ex.Message, "Code Atlas", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>--auto：开窗后直接开跑</summary>
        public void AutoRun(string path)
        {
            _path.Text = path;
            Run();
        }

        private void OnLine(string line)
        {
            var m = Regex.Match(line ?? "", @"http://localhost:\d+");
            if (m.Success && _url == null)
            {
                _url = m.Value;
                Ui(() =>
                {
                    SetBtn(_browser, true);
                    SetBtn(_toggle, true);
                    _status.Text = "服务已启动：" + _url + "（关掉窗口，服务就停）";
                    if (_autoSwitch.Checked) ShowMap(); else ShowLog();
                });
            }
            Log(line);
        }

        private void ShowMap()
        {
            if (_url == null) { ShowLog(); return; }
            if (!_webReady) { OpenUrl(_url); return; }
            _showingMap = true;
            _web.Visible = true;
            _log.Visible = false;
            _toggle.Text = "看日志";
            try { _web.CoreWebView2.Navigate(_url); } catch { }
        }

        private void ShowLog()
        {
            _showingMap = false;
            _web.Visible = false;
            _log.Visible = true;
            _toggle.Text = "看地图";
        }

        private void ToggleView()
        {
            if (_showingMap) ShowLog(); else ShowMap();
        }

        private void Stop()
        {
            try
            {
                if (_proc != null && !_proc.HasExited) { _proc.Kill(entireProcessTree: true); Log("> 已停止"); }
            }
            catch { }
            _proc = null;
        }

        private static void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }
    }

    /// <summary>
    /// 勾选要扫描的语言。
    /// “一个都不勾” = 自动（引擎默认：所有代码语言，配置文件格式不扫）；
    /// 勾齐所有代码语言也归成“自动” —— 免得配置里写死一长串 id，以后引擎加语言反而跟不上。
    /// </summary>
    internal sealed class LangPicker : Form
    {
        private readonly CheckedListBox _list = new CheckedListBox();
        private readonly Panel _listHost = new Panel();
        private readonly Label _hint = new Label();
        private readonly Button _ok = new Button();
        private readonly Button _cancel = new Button();
        private readonly Button _onlyCode = new Button();
        private readonly Button _allBtn = new Button();
        private readonly Button _noneBtn = new Button();
        private readonly LangInfo[] _langs;

        /// <summary>确定后的值：逗号分隔的语言 id；空串 = 自动</summary>
        public string Result { get; private set; } = "";

        public LangPicker(LangInfo[] langs, string current)
        {
            _langs = langs ?? Array.Empty<LangInfo>();

            Text = "要扫描的语言";
            BackColor = Palette.Bg;
            ForeColor = Palette.Fg;
            Font = new Font("Microsoft YaHei UI", 10.5f);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;

            _hint.Dock = DockStyle.Top;
            _hint.AutoSize = false;
            _hint.ForeColor = Palette.Dim;
            _hint.TextAlign = ContentAlignment.MiddleLeft;

            _list.Dock = DockStyle.Fill;
            _list.CheckOnClick = true;
            _list.BackColor = Palette.Panel;
            _list.ForeColor = Palette.Fg;
            _list.BorderStyle = BorderStyle.None;
            _list.IntegralHeight = false;
            // 套一层留白：列表自己不吃 Padding，直接贴边太挤
            _listHost.Dock = DockStyle.Fill;
            _listHost.BackColor = Palette.Bg;
            _listHost.Controls.Add(_list);

            var cur = (current ?? "").Split(',').Select((s) => s.Trim().ToLowerInvariant()).Where((s) => s.Length > 0).ToArray();
            for (int i = 0; i < _langs.Length; i++)
            {
                var l = _langs[i];
                string ext = (l.Exts != null && l.Exts.Length > 0) ? "   " + string.Join(" ", l.Exts) : "";
                _list.Items.Add(l.Label + ext + (l.OptIn ? "    （文件级格式 · 默认不扫）" : ""));
                _list.SetItemChecked(i, cur.Length == 0 ? !l.OptIn : Array.IndexOf(cur, l.Id) >= 0);
            }
            // 勾选状态在 ItemCheck 之后才变，所以推到消息循环下一轮再算摘要
            _list.ItemCheck += (s, e) => BeginInvoke(new Action(UpdateHint));

            _ok.Text = "确定";
            Launcher.Style(_ok, true);
            _ok.BackColor = Palette.Accent;
            _ok.ForeColor = Palette.Bg;
            _ok.Click += (s, e) => { Result = ComputeResult(); DialogResult = DialogResult.OK; Close(); };
            _cancel.Text = "取消";
            Launcher.Style(_cancel);
            _cancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };

            _onlyCode.Text = "仅代码语言";
            _allBtn.Text = "全选";
            _noneBtn.Text = "清空";
            foreach (var b in new[] { _onlyCode, _allBtn, _noneBtn }) Launcher.Style(b);
            _onlyCode.Click += (s, e) => SetChecks((l) => !l.OptIn);
            _allBtn.Click += (s, e) => SetChecks((l) => true);
            _noneBtn.Click += (s, e) => SetChecks((l) => false);

            var bottom = new Panel { Dock = DockStyle.Bottom, BackColor = Palette.Bg };
            var left = new FlowLayoutPanel { Dock = DockStyle.Left, AutoSize = true, WrapContents = false, FlowDirection = FlowDirection.LeftToRight };
            var right = new FlowLayoutPanel { Dock = DockStyle.Right, AutoSize = true, WrapContents = false, FlowDirection = FlowDirection.RightToLeft };
            left.Controls.AddRange(new Control[] { _onlyCode, _allBtn, _noneBtn });
            right.Controls.AddRange(new Control[] { _ok, _cancel }); // RightToLeft：先加的在最右
            bottom.Controls.Add(left);
            bottom.Controls.Add(right);

            Controls.Add(_listHost);   // Fill 先加
            Controls.Add(_hint);   // 再 Top
            Controls.Add(bottom);  // 再 Bottom

            AcceptButton = _ok;
            CancelButton = _cancel;
            UpdateHint();
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            float k = DeviceDpi / 96f;
            int pad = (int)(16 * k);
            _hint.Padding = new Padding(pad, (int)(14 * k), pad, (int)(10 * k));
            _hint.Height = (int)(72 * k);
            _listHost.Padding = new Padding(pad, 0, pad, (int)(4 * k));
            foreach (var c in new Control[] { _onlyCode, _allBtn, _noneBtn, _ok, _cancel })
                c.Margin = new Padding(0, 0, (int)(8 * k), 0);
            var flowPad = (int)(12 * k);
            ((FlowLayoutPanel)_ok.Parent).Padding = new Padding(0, flowPad, pad, flowPad);
            ((FlowLayoutPanel)_onlyCode.Parent).Padding = new Padding(pad, flowPad, 0, flowPad);
            var wa = Screen.FromPoint(Cursor.Position).WorkingArea;
            int h = Math.Min((int)(660 * k), Math.Max((int)(380 * k), wa.Height - (int)(140 * k)));
            ClientSize = new Size((int)(470 * k), h);
        }

        private void SetChecks(Func<LangInfo, bool> want)
        {
            for (int i = 0; i < _langs.Length; i++) _list.SetItemChecked(i, want(_langs[i]));
            UpdateHint();
        }

        private void UpdateHint()
        {
            var picked = new List<LangInfo>();
            for (int i = 0; i < _langs.Length; i++) if (_list.GetItemChecked(i)) picked.Add(_langs[i]);
            int codeTotal = _langs.Count((l) => !l.OptIn);
            bool isAuto = picked.Count == codeTotal && picked.All((l) => !l.OptIn);
            if (picked.Count == 0)
                _hint.Text = "一个都没勾 —— 按「自动」算：所有代码语言都扫，配置文件格式（JSON/YAML…）不扫。";
            else if (isAuto)
                _hint.Text = "当前 = 引擎默认（自动）：所有代码语言都扫，配置文件格式不扫。";
            else
            {
                var names = picked.Select((l) => l.Label).ToArray();
                string tail = names.Length > 8 ? string.Join(" ", names.Take(8)) + " 等" : string.Join(" ", names);
                _hint.Text = $"只扫勾中的 {names.Length} 种：" + tail;
            }
        }

        private string ComputeResult()
        {
            var ids = new List<string>();
            var codeIds = new List<string>();
            for (int i = 0; i < _langs.Length; i++)
            {
                if (!_langs[i].OptIn) codeIds.Add(_langs[i].Id);
                if (_list.GetItemChecked(i)) ids.Add(_langs[i].Id);
            }
            if (ids.Count == 0) return "";
            if (ids.Count == codeIds.Count && codeIds.All((id) => ids.Contains(id))) return "";
            return string.Join(",", ids);
        }
    }

    /// <summary>无界面自检：跑一遍引擎并把日志写进文件（用来验证启动器接线是否正确）</summary>
    internal static class Headless
    {
        public static void Run(string[] args)
        {
            string target = null, outDir = "dist", logPath = "launcher.log";
            string langs = null;
            bool listLangs = false, extractOnly = false;
            int port = 5173;
            bool open = false;
            for (int i = 1; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--path": target = args[++i]; break;
                    case "--out": outDir = args[++i]; break;
                    case "--port": port = int.Parse(args[++i]); break;
                    case "--log": logPath = args[++i]; break;
                    case "--lang": langs = args[++i]; break;
                    case "--list-langs": listLangs = true; break;
                    case "--extract": extractOnly = true; break;
                    case "--open": open = true; break;
                }
            }
            var sb = new StringBuilder();
            void Log(string s) { sb.AppendLine(s); }
            var cfg = Engine.LoadConfig();
            cfg.Out = outDir;
            cfg.Port = port;
            if (langs != null) cfg.Langs = langs;
            try
            {
                var (engRoot, engNode) = Engine.ResolveAll(cfg, Log);
                Log("edition = " + Engine.EditionName);
                Log("payload = " + (Payload.HasEngine ? "内嵌（首次会释放）" : "无"));
                Log("engine = " + (engRoot ?? "(没找到)"));
                Log("node = " + (engNode ?? "(没找到)") + " [ok=" + (engNode != null && Engine.NodeOk(engNode)) + "]");
                Log("devRoot = " + (Engine.FindDevRoot() ?? "(无，用的是内置引擎)"));
                // --list-langs：只验证"启动器能不能从引擎读到语言表"这条接线
                if (listLangs)
                {
                    var all = Engine.ListLangs(cfg);
                    Log("语言表 = " + all.Length + " 条：" + string.Join(", ", all.Select((l) => l.Id + (l.OptIn ? "*" : ""))));
                    File.WriteAllText(logPath, sb.ToString(), Encoding.UTF8);
                    return;
                }
                if (extractOnly)
                {
                    File.WriteAllText(logPath, sb.ToString(), Encoding.UTF8);
                    return;
                }
                if (target == null) throw new InvalidOperationException("缺 --path");
                var p = Engine.Start(target, cfg, open, Log, code => Log("exit = " + code));
                p.WaitForExit(600000);
                if (!p.HasExited) { p.Kill(true); Log("超时，已结束"); }
            }
            catch (Exception ex) { Log("ERROR: " + ex.Message); }
            File.WriteAllText(logPath, sb.ToString(), Encoding.UTF8);
        }
    }
}
