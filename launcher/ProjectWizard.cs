// 首次运行向导：选项目 → 勾语言 → 草拟分组规则 → 保存（可一并开跑）。
// 只在"这个项目还没有记录"或用户主动点「项目设置…」时出现；有记录的项目再打开=零操作。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace CodeAtlas
{
    /// <summary>一句输入的极简弹窗（WinForms 没有 InputBox）</summary>
    internal static class InputPrompt
    {
        public static string Ask(IWin32Window owner, string title, string initial)
        {
            using var f = new Form
            {
                Text = title,
                BackColor = Palette.Bg,
                ForeColor = Palette.Fg,
                Font = new Font("Microsoft YaHei UI", 10.5f),
                FormBorderStyle = FormBorderStyle.FixedDialog,
                StartPosition = FormStartPosition.CenterParent,
                ClientSize = new Size(400, 116),
                MinimizeBox = false,
                MaximizeBox = false,
                ShowInTaskbar = false,
            };
            var tb = new TextBox
            {
                Text = initial,
                BackColor = Palette.Panel,
                ForeColor = Palette.Fg,
                BorderStyle = BorderStyle.FixedSingle,
                Left = 16,
                Top = 16,
                Width = 368,
            };
            var ok = new Button { Text = "确定", Width = 84, Height = 30, Left = 16 + 368 - 84, Top = 62 };
            Launcher.Style(ok, true);
            ok.BackColor = Palette.Accent;
            ok.ForeColor = Palette.Bg;
            var cancel = new Button { Text = "取消", Width = 84, Height = 30, Left = ok.Left - 92, Top = 62 };
            Launcher.Style(cancel);
            ok.DialogResult = DialogResult.OK;
            cancel.DialogResult = DialogResult.Cancel;
            f.Controls.AddRange(new Control[] { tb, ok, cancel });
            f.AcceptButton = ok;
            f.CancelButton = cancel;
            return f.ShowDialog(owner) == DialogResult.OK ? tb.Text.Trim() : null;
        }
    }

    internal sealed class ProjectWizard : Form
    {
        /// <summary>换颜色时轮着用的一小套色（和草拟用的同一批，够用）</summary>
        private static readonly string[] Colors = { "#58a6ff", "#f778ba", "#3fb950", "#d29922", "#bc8cff", "#39c5cf", "#f0883e", "#8b949e" };

        private readonly LangInfo[] _langs;
        private readonly Func<string, string, bool, DraftResult> _draft;

        /// <summary>向导结果（ShowDialog 之后读）</summary>
        public string Target { get; private set; } = "";
        public string Langs { get; private set; } = "";
        public string FacetsPath { get; private set; } = "";
        public bool StartNow { get; private set; }

        private int _step = 1;
        private List<DraftSystem> _systems = new List<DraftSystem>();
        private string _comment = "";
        private List<string> _exclude = new List<string>();
        private string _draftedFor = null;

        private readonly Label _stepTitle = new Label();
        private readonly Label _stepHint = new Label();
        private readonly Panel _body = new Panel { Dock = DockStyle.Fill };

        // 第一步：选项目
        private readonly TextBox _path = new TextBox();
        // 第二步：语言
        private readonly Label _langInfo = new Label();
        private readonly Button _pickLangs = new Button();
        // 第三步：分组规则草案
        private readonly CheckedListBox _list = new CheckedListBox();
        private readonly Label _draftInfo = new Label();
        private readonly CheckBox _intoProject = new CheckBox();
        private readonly Button _redraft = new Button();
        private readonly Button _rename = new Button();
        private readonly Button _recolor = new Button();
        private readonly Button _byNs = new Button();
        /// <summary>有没有可用的 bundle（没扫过就用不了命名空间草拟）</summary>
        private readonly bool _hasBundle;
        /// <summary>当前草案是按哪种视角来的（「重新草拟」沿用同一个视角）</summary>
        private bool _draftByNs;
        // 底部
        private readonly Button _prev = new Button();
        private readonly Button _next = new Button();
        private readonly Button _cancel = new Button();

        public ProjectWizard(LangInfo[] langs, string target, string langsSpec, string facetsPath,
            Func<string, string, bool, DraftResult> draft, bool hasBundle)
        {
            _langs = langs ?? Array.Empty<LangInfo>();
            _draft = draft;
            _hasBundle = hasBundle;
            Target = target ?? "";
            Langs = langsSpec ?? "";
            FacetsPath = facetsPath ?? "";

            Text = "项目设置";
            BackColor = Palette.Bg;
            ForeColor = Palette.Fg;
            Font = new Font("Microsoft YaHei UI", 10.5f);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.Sizable;
            MinimumSize = new Size(560, 420);
            ShowInTaskbar = false;

            _stepTitle.ForeColor = Palette.Fg;
            _stepTitle.AutoSize = true;
            _stepHint.ForeColor = Palette.Dim;
            _stepHint.AutoSize = false;

            var head = new Panel { Dock = DockStyle.Top, BackColor = Palette.Bg, Height = 74 };
            head.Controls.AddRange(new Control[] { _stepTitle, _stepHint });

            BuildStep1();
            BuildStep2();
            BuildStep3();

            var left = new FlowLayoutPanel { Dock = DockStyle.Left, AutoSize = true, WrapContents = false, FlowDirection = FlowDirection.LeftToRight };
            var right = new FlowLayoutPanel { Dock = DockStyle.Right, AutoSize = true, WrapContents = false, FlowDirection = FlowDirection.RightToLeft };
            _next.Text = "下一步";
            _next.Click += (s, e) => OnNext();
            _prev.Text = "上一步";
            _prev.Click += (s, e) => SetStep(_step - 1);
            _cancel.Text = "取消";
            _cancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };
            foreach (var b in new[] { _next, _prev, _cancel }) Launcher.Style(b);
            _next.BackColor = Palette.Accent;
            _next.ForeColor = Palette.Bg;
            right.Controls.AddRange(new Control[] { _next, _prev, _cancel });   // RightToLeft：先加的在最右
            var foot = new Panel { Dock = DockStyle.Bottom, BackColor = Palette.Bg, Height = 56 };
            foot.Controls.Add(left);
            foot.Controls.Add(right);
            foot.Controls.Add(new Label { Text = "首次配置只做一次；以后打开这个项目就直接开跑。", ForeColor = Palette.Dim, AutoSize = true, Left = 16, Top = 18 });

            Controls.Add(_body);     // Fill 先加
            Controls.Add(head);
            Controls.Add(foot);

            AcceptButton = _next;
            CancelButton = _cancel;
            SetStep(1);
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            float k = DeviceDpi / 96f;
            int pad = (int)(18 * k);
            ClientSize = new Size(Math.Max((int)(640 * k), ClientSize.Width), Math.Max((int)(480 * k), ClientSize.Height));
            ((Panel)_stepTitle.Parent).Height = (int)(84 * k);
            _stepTitle.Location = new Point(pad, (int)(12 * k));
            _stepHint.SetBounds(pad, (int)(38 * k), ((Panel)_stepTitle.Parent).ClientSize.Width - pad * 2, (int)(42 * k));
            ((Panel)_prev.Parent.Parent).Height = (int)(56 * k);
            foreach (var b in new[] { _next, _prev, _cancel })
                b.Margin = new Padding(0, (int)(12 * k), (int)(10 * k), 0);
            // 第三步的排版
            int w = _body.ClientSize.Width - pad * 2;
            _list.SetBounds(pad, (int)(64 * k), w, Math.Max(120, _body.ClientSize.Height - (int)(190 * k)));
            _draftInfo.SetBounds(pad, (int)(64 * k) + _list.Height + (int)(8 * k), w, (int)(40 * k));
            _intoProject.Location = new Point(pad, _draftInfo.Bottom + (int)(4 * k));
            int bx = _draftInfo.Right;
            _recolor.Location = new Point(bx - _recolor.PreferredSize.Width, (int)(20 * k));
            _rename.Location = new Point(_recolor.Left - _rename.PreferredSize.Width - (int)(8 * k), (int)(20 * k));
            _byNs.Location = new Point(_redraft.Left - _byNs.PreferredSize.Width - (int)(8 * k), (int)(16 * k));
            _redraft.Location = new Point(_rename.Left - _redraft.PreferredSize.Width - (int)(8 * k), (int)(20 * k));
            // 第一/二步
            _path.SetBounds(pad, (int)(70 * k), w - (int)(200 * k), (int)(30 * k));
        }

        // ----------------------------------------------------------------- 三步的界面
        private void BuildStep1()
        {
            var p = new Panel { Dock = DockStyle.Fill, BackColor = Palette.Bg };
            _path.BackColor = Palette.Panel;
            _path.ForeColor = Palette.Fg;
            _path.BorderStyle = BorderStyle.FixedSingle;
            // TextBox 默认 AutoSize=true，它的“首选宽度”会按文本长度算 —— 放进 TableLayoutPanel 会把列撑爆
            //（实测：一行控件会超出面板右边界 50 多像素）。关掉，宽度交给布局。
            _path.AutoSize = false;
            _path.Text = Target;
            _path.SelectionStart = 0;   // 长路径默认从头显示（不然会滚到末尾，看不清是哪个盘）
            _path.SelectionLength = 0;
            var pickDir = new Button { Text = "选择文件夹…" };
            var pickFile = new Button { Text = "选择文件…" };
            Launcher.Style(pickDir);
            Launcher.Style(pickFile);
            pickDir.Click += (s, e) => { using var d = new FolderBrowserDialog { Description = "选一个要分析的文件夹（源码目录，或放着 .dll / .exe / .jar 的目录）" }; if (d.ShowDialog(this) == DialogResult.OK) _path.Text = d.SelectedPath; };
            pickFile.Click += (s, e) => { using var d = new OpenFileDialog { Title = "选一个要分析的文件", Filter = "程序集 / 压缩包 (*.dll;*.exe;*.jar)|*.dll;*.exe;*.jar|所有文件 (*.*)|*.*" }; if (d.ShowDialog(this) == DialogResult.OK) _path.Text = d.FileName; };
            var label = new Label { Text = "要分析什么？", ForeColor = Palette.Fg, AutoSize = true };
            // 一行三个：输入框 + 两个按钮。用 TableLayoutPanel + Anchor 排——
            // 这是 WinForms 自己的布局引擎：Anchor=Left|Right 的控件会在单元格里**垂直居中**，
            // 宽度自己撑满，不需要我们算任何像素（手算坐标会跟框架的缩放叠在一起，踩过三次）。
            var row = new TableLayoutPanel
            {
                Name = "row", BackColor = Palette.Bg, ColumnCount = 3, RowCount = 1,
                // 注意：不能开 AutoSize——AutoSize + 百分比列会互相打架（面板为了装下内容自动变宽，于是整行溢出右边界）
                AutoSize = false,
            };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _path.Dock = DockStyle.None;
            _path.Anchor = AnchorStyles.Left | AnchorStyles.Right;   // 水平撑满 + 垂直居中
            _path.Margin = new Padding(0, 0, 8, 0);
            foreach (var b in new[] { pickDir, pickFile }) { b.Dock = DockStyle.None; b.Anchor = AnchorStyles.None; b.Margin = new Padding(0, 0, 8, 0); }
            pickFile.Margin = new Padding(0);
            row.Controls.Add(_path, 0, 0);
            row.Controls.Add(pickDir, 1, 0);
            row.Controls.Add(pickFile, 2, 0);
            var note = new Label
            {
                Text = "源码目录直接扫；.dll / .exe（含单文件发行版）/ .jar 会先反编译再扫。\n这一页就是主窗口那个「目标」，在这里选完，后面两页会用到它。",
                ForeColor = Palette.Dim,
                AutoSize = false,
            };
            note.Name = "note";
            p.Controls.AddRange(new Control[] { label, row, note });
            p.Resize += (s, e) => LayoutStep1(p, label, row, note);
            _body.Controls.Add(p);
            _p1 = p;
        }
        private Panel _p1;

        private void LayoutStep1(Panel p, Label label, TableLayoutPanel row, Label note)
        {
            float k = DeviceDpi / 96f;
            int pad = (int)(18 * k);
            int w = Math.Max(80, p.ClientSize.Width - pad * 2);
            label.Location = new Point(pad, (int)(24 * k));
            // 行高取按钮的自然高度（同一尺度，不用 k 自己算）
            int rowH = row.Controls.OfType<Button>().Select((b) => b.PreferredSize.Height).DefaultIfEmpty((int)(32 * k)).Max();
            row.SetBounds(pad, (int)(50 * k), w, rowH);
            note.SetBounds(pad, row.Bottom + (int)(12 * k), w, (int)(60 * k));
        }

        private void BuildStep2()
        {
            var p = new Panel { Dock = DockStyle.Fill, BackColor = Palette.Bg };
            var label = new Label { Text = "扫哪些语言？", ForeColor = Palette.Fg, AutoSize = true };
            _langInfo.ForeColor = Palette.Dim;
            _langInfo.AutoSize = false;
            _pickLangs.Text = "选择语言…";
            Launcher.Style(_pickLangs);
            _pickLangs.Click += (s, e) =>
            {
                using var d = new LangPicker(_langs, Langs);
                if (d.ShowDialog(this) != DialogResult.OK) return;
                Langs = d.Result;
                _draftedFor = null;   // 语言变了，规则草案要重算
                RefreshLangs();
            };
            var row2 = new TableLayoutPanel
            {
                Name = "row", BackColor = Palette.Bg, ColumnCount = 2, RowCount = 1,
                AutoSize = false,   // 同上：AutoSize + 百分比列会打架
            };
            row2.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            row2.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _langInfo.Dock = DockStyle.None;
            _langInfo.Anchor = AnchorStyles.Left | AnchorStyles.Right;   // 水平撑满 + 垂直居中
            _langInfo.TextAlign = ContentAlignment.MiddleLeft;
            _langInfo.Margin = new Padding(0, 0, 8, 0);
            _pickLangs.Dock = DockStyle.None;
            _pickLangs.Anchor = AnchorStyles.None;
            _pickLangs.Margin = new Padding(0);
            row2.Controls.Add(_langInfo, 0, 0);
            row2.Controls.Add(_pickLangs, 1, 0);
            var note = new Label
            {
                Text = "默认「自动」= 所有代码语言都扫、配置文件格式（JSON/YAML…）不扫。\n只扫这个项目真正用的语言能明显提速，也能让地图干净。",
                ForeColor = Palette.Dim,
                AutoSize = false,
            };
            note.Name = "note";
            p.Controls.AddRange(new Control[] { label, row2, note });
            p.Resize += (s, e) => LayoutStep2(p, label, row2, note);
            _body.Controls.Add(p);
            _p2 = p;
        }
        private Panel _p2;

        private void LayoutStep2(Panel p, Label label, TableLayoutPanel row, Label note)
        {
            float k = DeviceDpi / 96f;
            int pad = (int)(18 * k);
            int w = Math.Max(80, p.ClientSize.Width - pad * 2);
            label.Location = new Point(pad, (int)(24 * k));
            int rowH = Math.Max(_pickLangs.PreferredSize.Height, (int)(32 * k));
            row.SetBounds(pad, (int)(50 * k), w, rowH);
            note.SetBounds(pad, row.Bottom + (int)(12 * k), w, (int)(60 * k));
        }

        private void BuildStep3()
        {
            var p = new Panel { Dock = DockStyle.Fill, BackColor = Palette.Bg };
            var label = new Label { Text = "系统分组规则（按目录草拟，可改）", ForeColor = Palette.Fg, AutoSize = true };
            label.Name = "label";
            _list.CheckOnClick = true;
            _list.BackColor = Palette.Panel;
            _list.ForeColor = Palette.Fg;
            _list.BorderStyle = BorderStyle.None;
            _list.IntegralHeight = false;
            _draftInfo.ForeColor = Palette.Dim;
            _draftInfo.AutoSize = false;
            _intoProject.Text = "写进项目目录（atlas.facets.json，跟项目走）";
            _intoProject.ForeColor = Palette.Dim;
            _intoProject.AutoSize = true;
            _redraft.Text = "重新草拟";
            _rename.Text = "改名";
            _recolor.Text = "换色";
            foreach (var b in new[] { _redraft, _rename, _recolor, _byNs }) Launcher.Style(b);
            _byNs.Text = "用命名空间重新草拟";
            _byNs.ForeColor = _hasBundle ? Palette.Fg : Palette.DimInactive;
            _byNs.Cursor = _hasBundle ? Cursors.Hand : Cursors.Default;
            _byNs.Click += (s, e) =>
            {
                if (!_hasBundle)
                {
                    _draftInfo.Text = "这个项目还没扫过 —— 先点一次「保存并开跑」，再回来用命名空间重新草拟。";
                    return;
                }
                _draftedFor = null;
                DraftNow(true);
            };
            _redraft.Click += (s, e) => { _draftedFor = null; DraftNow(_draftByNs); };
            _rename.Click += (s, e) =>
            {
                int i = _list.SelectedIndex;
                if (i < 0 || i >= _systems.Count) return;
                string name = InputPrompt.Ask(this, "系统名", _systems[i].Name);
                if (name == null || name.Length == 0) return;
                _systems[i].Name = name;
                RefreshList(i);
            };
            _recolor.Click += (s, e) =>
            {
                int i = _list.SelectedIndex;
                if (i < 0 || i >= _systems.Count) return;
                int cur = Array.IndexOf(Colors, _systems[i].Color);
                _systems[i].Color = Colors[(cur + 1 + Colors.Length) % Colors.Length];
                RefreshList(i);
            };
            p.Controls.AddRange(new Control[] { label, _list, _draftInfo, _intoProject, _redraft, _rename, _recolor, _byNs });
            p.Resize += (s, e) => LayoutStep3(p, label);
            _body.Controls.Add(p);
            _p3 = p;
        }
        private Panel _p3;

        private void LayoutStep3(Panel p, Label label)
        {
            float k = DeviceDpi / 96f;
            int pad = (int)(18 * k);
            label.Location = new Point(pad, (int)(24 * k));
            int listTop = (int)(52 * k);
            _list.SetBounds(pad, listTop, p.ClientSize.Width - pad * 2, Math.Max(120, p.ClientSize.Height - listTop - (int)(112 * k)));
            _draftInfo.SetBounds(pad, _list.Bottom + (int)(6 * k), p.ClientSize.Width - pad * 2, (int)(42 * k));
            _intoProject.Location = new Point(pad, _draftInfo.Bottom + (int)(6 * k));
            _recolor.Location = new Point(p.ClientSize.Width - pad - _recolor.PreferredSize.Width, (int)(16 * k));
            _rename.Location = new Point(_recolor.Left - _rename.PreferredSize.Width - (int)(8 * k), (int)(16 * k));
            _byNs.Location = new Point(_redraft.Left - _byNs.PreferredSize.Width - (int)(8 * k), (int)(16 * k));
            _redraft.Location = new Point(_rename.Left - _redraft.PreferredSize.Width - (int)(8 * k), (int)(16 * k));
        }

        // ----------------------------------------------------------------- 流程
        private void SetStep(int n)
        {
            _step = Math.Min(3, Math.Max(1, n));
            _p1.Visible = _step == 1;
            _p2.Visible = _step == 2;
            _p3.Visible = _step == 3;
            _prev.Tag = _step > 1 ? "on" : "off";
            // 不用 Enabled=false（系统会把文字压成深灰，在暗底上等于隐形），改成变暗 + 不响应
            _prev.ForeColor = _step > 1 ? Palette.Fg : Palette.DimInactive;
            _prev.Cursor = _step > 1 ? Cursors.Hand : Cursors.Default;
            _next.Text = _step == 3 ? "保存并开跑" : "下一步";
            _next.Tag = "on";
            _next.BackColor = Palette.Accent;
            _next.ForeColor = Palette.Bg;

            string[] titles = { "① 选项目", "② 选语言", "③ 分组规则" };
            string[] hints =
            {
                "要分析哪个项目？源码目录、.dll / .exe / .jar 都行。",
                "这个项目用哪些语言？默认自动（所有代码语言）。",
                "规则草案：不想要的取消勾选，名字/颜色可以改。保存后扫描就会用上它。",
            };
            _stepTitle.Text = titles[_step - 1];
            _stepHint.Text = hints[_step - 1];
            if (_step == 2) RefreshLangs();
            if (_step == 3) DraftNow();
        }

        private void RefreshLangs()
        {
            int n = string.IsNullOrWhiteSpace(Langs) ? _langs.Count((l) => !l.OptIn) : Langs.Split(',').Count((s) => s.Trim().Length > 0);
            _langInfo.Text = string.IsNullOrWhiteSpace(Langs)
                ? $"自动（{n} 门代码语言；配置文件格式不扫）"
                : $"只扫 {n} 种：{Langs}";
        }

        /// <summary>草拟（target 或语言变了才重算；失败就把原因写在界面上，不假装成功）</summary>
        private void DraftNow(bool byNs = false)
        {
            string t = _path.Text.Trim().Trim('"');
            if (t.Length == 0) { _draftInfo.Text = "先在上一步选个目标。"; _list.Items.Clear(); _systems = new List<DraftSystem>(); return; }
            if (!Directory.Exists(t) && !File.Exists(t)) { _draftInfo.Text = "这个路径不存在：" + t; _list.Items.Clear(); _systems = new List<DraftSystem>(); return; }
            string key = t + "|" + Langs + (byNs ? "|ns" : "");
            if (_draftedFor == key && _list.Items.Count > 0) return;
            try
            {
                var res = _draft(t, Langs, byNs);
                if (res.Config == null)
                {
                    // 这个项目用不上（没有命名空间）——把原因说清楚，但别把现有草案毁掉
                    _draftInfo.Text = res.Notes != null && res.Notes.Count > 0 ? string.Join("　·　", res.Notes) : "按命名空间草拟用不上。";
                    _draftedFor = null;
                    return;
                }
                _draftByNs = byNs;
                _comment = res.Config._comment ?? "";
                _exclude = res.Config.Exclude ?? new List<string>();
                _systems = res.Config.Systems ?? new List<DraftSystem>();
                _draftedFor = key;
                RefreshList(-1);
                var bits = new List<string> { $"共 {res.Files} 个文件 · 草拟 {_systems.Count} 个系统" };
                bits.AddRange(res.Notes);
                _draftInfo.Text = string.Join("　·　", bits);
            }
            catch (Exception ex)
            {
                _draftedFor = null;
                _systems = new List<DraftSystem>();
                RefreshList(-1);
                _draftInfo.Text = "草拟失败：" + ex.Message.Replace("\n", " ");
            }
        }

        private void RefreshList(int select)
        {
            var checkedIdx = new HashSet<int>();
            for (int i = 0; i < _list.Items.Count; i++) if (_list.GetItemChecked(i)) checkedIdx.Add(i);
            bool firstTime = !_listInitialized;
            _listInitialized = true;
            _list.Items.Clear();
            for (int i = 0; i < _systems.Count; i++)
            {
                var s = _systems[i];
                string rule = (s.Paths != null && s.Paths.Count > 0) ? string.Join("  ", s.Paths) : (s.Files != null ? string.Join("  ", s.Files) : "");
                _list.Items.Add($"{s.Name}    ·    {s.FileCount} 个文件    ·    {rule}");
                _list.SetItemChecked(i, firstTime || checkedIdx.Contains(i));
            }
            if (select >= 0 && select < _list.Items.Count) _list.SelectedIndex = select;
        }
        private bool _listInitialized;

        private void OnNext()
        {
            if (_step < 3) { SetStep(_step + 1); return; }
            string t = _path.Text.Trim().Trim('"');
            if (t.Length == 0) { MessageBox.Show(this, "还没选目标。", "Code Atlas", MessageBoxButtons.OK, MessageBoxIcon.Information); SetStep(1); return; }
            if (!Directory.Exists(t) && !File.Exists(t)) { MessageBox.Show(this, "这个路径不存在：" + t, "Code Atlas", MessageBoxButtons.OK, MessageBoxIcon.Warning); SetStep(1); return; }
            Target = t;
            try
            {
                FacetsPath = WriteFacets();
                StartNow = true;
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "规则文件写不出来：" + ex.Message, "Code Atlas", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        /// <summary>把勾中的系统写成 facets 文件，返回文件路径（一个都没勾就返回空）</summary>
        private string WriteFacets()
        {
            var keep = new List<DraftSystem>();
            for (int i = 0; i < _systems.Count && i < _list.Items.Count; i++) if (_list.GetItemChecked(i)) keep.Add(_systems[i]);
            if (keep.Count == 0) return "";

            string name = Directory.Exists(Target) ? new DirectoryInfo(Target).Name : Path.GetFileNameWithoutExtension(Target);
            string path = _intoProject.Checked
                ? Path.Combine(Directory.Exists(Target) ? Target : (Path.GetDirectoryName(Target) ?? Target), "atlas.facets.json")
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodeAtlas", "configs", name + ".facets.json");
            Directory.CreateDirectory(Path.GetDirectoryName(path) ?? ".");
            var cfg = new DraftConfig { _comment = _comment, Exclude = _exclude.Count > 0 ? _exclude : null, Systems = keep };
            File.WriteAllText(path, JsonSerializer.Serialize(cfg, FacetJson.Options), new UTF8Encoding(false));
            return path;
        }
    }
}
