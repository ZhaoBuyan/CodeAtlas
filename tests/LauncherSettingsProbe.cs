using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Windows.Forms;

internal static class LauncherSettingsProbe
{
    [STAThread]
    private static void Main(string[] args)
    {
        string assemblyPath = Path.GetFullPath(args[0]), work = Path.GetFullPath(args[1]);
        Directory.CreateDirectory(work);
        var resolver = new AssemblyDependencyResolver(assemblyPath);
        AssemblyLoadContext.Default.Resolving += (context, name) => {
            string p = resolver.ResolveAssemblyToPath(name);
            return p == null ? null : context.LoadFromAssemblyPath(p);
        };
        var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(assemblyPath);
        var config = assembly.GetType("CodeAtlas.Config", true);
        var engine = assembly.GetType("CodeAtlas.Engine", true);
        var load = engine.GetMethod("LoadConfig");
        var save = engine.GetMethod("SaveConfig");
        string file = Path.Combine(work, "config.json");
        File.WriteAllText(file, "{\"Port\":5234,\"FutureSetting\":{\"keep\":true}}");
        object value = load.Invoke(null, new object[] { file });
        Check((string)config.GetProperty("ExtraIgnore").GetValue(value) == "", "old config defaults to no extra exclusions");
        string rules = "中文 folder/\r\nprivate=copy.js\r\n*.generated.js";
        config.GetProperty("ExtraIgnore").SetValue(value, rules);
        save.Invoke(null, new object[] { value, file });
        value = load.Invoke(null, new object[] { file });
        Check((string)config.GetProperty("ExtraIgnore").GetValue(value) == rules, "settings survive save/reload");
        using var json = JsonDocument.Parse(File.ReadAllText(file));
        Check(json.RootElement.GetProperty("FutureSetting").GetProperty("keep").GetBoolean(), "unknown config fields survive");
        var langs = Array.CreateInstance(assembly.GetType("CodeAtlas.LangInfo", true), 0);
        foreach (string language in new[] { "zh", "en" })
        {
            Environment.SetEnvironmentVariable("CODEATLAS_LANG", language);
            assembly.GetType("CodeAtlas.L", true).GetMethod("Init").Invoke(null, new object[] { language });
            using var form = (Form)Activator.CreateInstance(assembly.GetType("CodeAtlas.LangPicker", true), new object[] { langs, "", true, rules });
            _ = form.Handle;
            form.GetType().GetMethod("OnLoad", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new object[] { EventArgs.Empty });
            form.PerformLayout();
            void Handles(Control control) { _ = control.Handle; foreach (Control child in control.Controls) Handles(child); }
            Handles(form);
            var flags = BindingFlags.Instance | BindingFlags.NonPublic;
            var input = (TextBox)form.GetType().GetField("_extraIgnore", flags).GetValue(form);
            Check(input.Text == rules, "saved exclusions populate the input");
            Check(input.Width > 250 && input.Height >= 50, "exclusion input has usable space");
            var hint = (Label)form.GetType().GetField("_excludeHint", flags).GetValue(form);
            Check(hint.Height >= hint.GetPreferredSize(new System.Drawing.Size(hint.Width, 0)).Height, "rule explanation fits");
            var none = (Button)form.GetType().GetField("_noneBtn", flags).GetValue(form);
            var cancel = (Button)form.GetType().GetField("_cancel", flags).GetValue(form);
            Check(none.PointToScreen(new System.Drawing.Point(none.Width, 0)).X <= cancel.PointToScreen(System.Drawing.Point.Empty).X, "footer buttons do not overlap");
            using var bitmap = new System.Drawing.Bitmap(form.ClientSize.Width, form.ClientSize.Height);
            form.DrawToBitmap(bitmap, form.ClientRectangle);
            bitmap.Save(Path.Combine(work, $"scope-{language}.png"));
            input.Text = "  final.js\r\ncache/  ";
            var ok = (Button)form.GetType().GetField("_ok", flags).GetValue(form);
            typeof(Button).GetMethod("OnClick", flags).Invoke(ok, new object[] { EventArgs.Empty });
            Check((string)form.GetType().GetProperty("ExtraIgnore").GetValue(form) == "final.js\r\ncache/", "OK returns the edited rules");
        }
        Console.WriteLine("Launcher settings: compatibility, persistence, unknown fields and bilingual offscreen UI passed.");
    }
    private static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
}
