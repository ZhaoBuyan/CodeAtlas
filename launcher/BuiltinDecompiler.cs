using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.TypeSystem;
using SingleFileExtractor.Core;

namespace CodeAtlas
{
    /// <summary>
    /// 启动器自带的两个"引擎会来调"的能力（隐藏子命令，用户一般不直接用）：
    ///
    ///   CodeAtlas.exe --decompile &lt;.dll 或 .exe&gt; -o &lt;输出目录&gt;
    ///   CodeAtlas.exe --extract-bundle &lt;.NET 单文件发行版.exe&gt; -o &lt;输出目录&gt;
    ///
    /// 为什么要放进启动器：完全版/精简版本来就带 .NET，这两个库（都是 MIT）加起来只有几 MB，
    /// 而让用户去装 ilspycmd 要先装 .NET **SDK**（不是运行时），门槛高得多。引擎侧保留回退：
    /// 开发模式（node src/cli.mjs）没有 CODEATLAS_SELF 时，仍然用 ilspycmd / sfextract。
    ///
    /// 输出形态要跟 ilspycmd 对齐：一个目录里平铺 .cs 文件（扫描器只看内容，不看目录结构，
    /// 命名空间是从源码里的 namespace 声明读的）。
    /// </summary>
    internal static class BuiltinDecompiler
    {
        /// <summary>命中我们的子命令就执行并返回 true（调用方直接退出，不启动界面）</summary>
        public static bool TryRun(string[] args, out int exitCode)
        {
            exitCode = 0;
            if (args == null || args.Length == 0) return false;
            if (args[0] == "--decompile") { exitCode = Decompile(args); return true; }
            if (args[0] == "--extract-bundle") { exitCode = ExtractBundle(args); return true; }
            return false;
        }

        /// <summary>解析 <c>-o &lt;目录&gt;</c>；返回 null 表示没给</summary>
        private static string ParseOut(string[] args)
        {
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == "-o" || args[i] == "--out") return args[i + 1];
            return null;
        }

        private static string ParseInput(string[] args)
        {
            // 第一个不是选项、也不是 -o 的值的参数，就是输入路径
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "-o" || args[i] == "--out") { i++; continue; }
                if (args[i].StartsWith("-")) continue;
                return args[i];
            }
            return null;
        }

        // ------------------------------------------------------------------ 反编译

        private static int Decompile(string[] args)
        {
            string input = ParseInput(args);
            string outDir = ParseOut(args);
            if (string.IsNullOrEmpty(input) || string.IsNullOrEmpty(outDir))
            {
                Console.Error.WriteLine("用法：CodeAtlas.exe --decompile <程序集.dll|.exe> -o <输出目录>");
                return 2;
            }
            if (!File.Exists(input) && !Directory.Exists(input))
            {
                Console.Error.WriteLine("找不到输入：" + input);
                return 2;
            }

            // 目录：把里面的程序集都反编译（跟 ilspycmd 那套调用的语义保持一致）
            var assemblies = File.Exists(input)
                ? new List<string> { input }
                : Directory.GetFiles(input, "*.dll").Take(5).ToList();
            if (assemblies.Count == 0)
            {
                Console.Error.WriteLine("这个目录里没有 .dll：" + input);
                return 2;
            }

            int total = 0, failed = 0;
            foreach (var asm in assemblies)
            {
                string stem = Path.GetFileNameWithoutExtension(asm);
                string dest = File.Exists(input) ? outDir : Path.Combine(outDir, stem);
                Directory.CreateDirectory(dest);
                try
                {
                    var (n, bad) = DecompileOne(asm, dest);
                    total += n;
                    failed += bad;
                    if (n == 0 && bad > 0)
                        Console.Error.WriteLine("反编译失败：" + Path.GetFileName(asm));
                }
                catch (Exception ex)
                {
                    // 单个程序集出问题不能连累其他（ingest 里还会继续试别的）
                    Console.Error.WriteLine($"反编译失败（跳过）：{Path.GetFileName(asm)} — {ex.Message.Split('\n')[0]}");
                }
            }

            Console.WriteLine($"内置反编译器：{total} 个类型 → {outDir}" + (failed > 0 ? $"（{failed} 个类型反编译失败，已跳过）" : ""));
            return total > 0 ? 0 : 1;
        }

        /// <summary>把一个程序集里的每个类型写成一个 .cs（平铺）</summary>
        private static (int ok, int bad) DecompileOne(string asmPath, string destDir)
        {
            // 宽松解析器（throwOnError: false）：被引用的程序集找不到时不能硬崩——
            // ilspycmd 也是降级继续的（实际踩到：只拿一个 dll、旁边没有依赖时，严格的解析器直接抛 ResolutionException）。
            // 把程序集所在目录（以及它的上一级，兼容 _bundle 这种解包布局）加进搜索路径。
            var resolver = new ICSharpCode.Decompiler.Metadata.UniversalAssemblyResolver(asmPath, false, null);
            try
            {
                string dir = Path.GetDirectoryName(Path.GetFullPath(asmPath));
                if (!string.IsNullOrEmpty(dir))
                {
                    resolver.AddSearchDirectory(dir);
                    string parent = Path.GetDirectoryName(dir);
                    if (!string.IsNullOrEmpty(parent)) resolver.AddSearchDirectory(parent);
                }
            }
            catch { }

            // 设置要点：
            //  - ThrowOnAssemblyResolveErrors=false：引用程序集找不到时降级继续（默认真会抛异常）
            //  - ShowILComments=false：关掉 `//IL_004a: Unknown result type...` 这类诊断注释——
            //    它们会被扫描器当成注释行，甚至当成"说明"抽出来，属于凭空造出来的注释，不能要
            var settings = new DecompilerSettings
            {
                ThrowOnAssemblyResolveErrors = false,
            };
            var decompiler = new CSharpDecompiler(asmPath, resolver, settings);
            int ok = 0, bad = 0;
            var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            // 只输出**顶层类型**：嵌套类型（如编译器生成的 __c / __c__DisplayClass）让 ILSpy 写在外层类型里就行。
            // 单独反编译嵌套类型时，ILSpy 会把整个外层类型重复输出一遍——实测会让产物膨胀 5 倍（同一段代码出现在
            // Engine.cs 和 Engine.__c.cs 里各一份），类型数/边数也跟着虚高。
            foreach (var type in decompiler.TypeSystem.MainModule.TopLevelTypeDefinitions)
            {
                string fullName;
                string code;
                try
                {
                    fullName = type.FullName;
                    code = decompiler.DecompileTypeAsString(type.FullTypeName);
                }
                catch
                {
                    bad++;
                    continue;
                }
                string file = Path.Combine(destDir, UniqueName(used, Sanitize(fullName)) + ".cs");
                File.WriteAllText(file, StripIlDiagnostics(code), new UTF8Encoding(false));   // 不写 BOM（我们的扫描器按 UTF-8 读）
                ok++;
            }
            return (ok, bad);
        }

        /// <summary>
        /// 剥掉 ILSpy 的诊断注释。v11 里没有 ShowILComments 开关了，而引用程序集解析不到时它会往代码里插
        /// `//IL_004a: Unknown result type (might be due to invalid IL or missing references)` 这类行——
        /// 扫描器会把它们当注释行，甚至当"说明"抽出来（凭空造出来的注释，不能要）。
        /// </summary>
        private static string StripIlDiagnostics(string code)
        {
            if (code.IndexOf("//IL_", StringComparison.Ordinal) < 0) return code;
            var lines = code.Split('\n');
            var keep = new List<string>(lines.Length);
            foreach (var l in lines)
            {
                if (l.TrimStart().StartsWith("//IL_", StringComparison.Ordinal)) continue;
                keep.Add(l);
            }
            return string.Join("\n", keep);
        }

        /// <summary>文件名安全化：泛型会把 &lt;&gt; 带进全名，嵌套类型带 / 或 +</summary>
        private static string Sanitize(string name)
        {
            var sb = new StringBuilder(name.Length);
            var bad = Path.GetInvalidFileNameChars();
            foreach (char c in name)
                sb.Append(bad.Contains(c) || c == '<' || c == '>' || c == ',' || c == ' ' ? '_' : c);
            string s = sb.ToString().Replace("+", ".").Replace("/", ".");
            if (s.Length > 150) s = s.Substring(0, 150);
            return s;
        }

        private static string UniqueName(HashSet<string> used, string baseName)
        {
            if (used.Add(baseName)) return baseName;
            for (int i = 2; ; i++)
            {
                string cand = baseName + "_" + i;
                if (used.Add(cand)) return cand;
            }
        }

        // ------------------------------------------------------------------ 单文件解包

        private static int ExtractBundle(string[] args)
        {
            string input = ParseInput(args);
            string outDir = ParseOut(args);
            if (string.IsNullOrEmpty(input) || string.IsNullOrEmpty(outDir))
            {
                Console.Error.WriteLine("用法：CodeAtlas.exe --extract-bundle <.NET 单文件发行版.exe> -o <输出目录>");
                return 2;
            }
            if (!File.Exists(input))
            {
                Console.Error.WriteLine("找不到文件：" + input);
                return 2;
            }

            var reader = new ExecutableReader(input);
            if (!reader.IsSingleFile)
            {
                Console.Error.WriteLine("这不是 .NET 单文件发行版（没有 bundle 清单）：" + Path.GetFileName(input));
                return 1;
            }
            Directory.CreateDirectory(outDir);
            RunAsync(reader.ExtractToDirectoryAsync(outDir));
            int n = Directory.GetFiles(outDir, "*.dll", SearchOption.AllDirectories).Length;
            Console.WriteLine($"内置解包器：{Path.GetFileName(input)} → {n} 个 dll");
            return 0;
        }

        private static void RunAsync(Task t) => t.GetAwaiter().GetResult();
    }
}
