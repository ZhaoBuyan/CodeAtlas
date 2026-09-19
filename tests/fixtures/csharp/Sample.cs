using System;
using System.Collections.Generic;

namespace Fixture.Sample
{
    /// <summary>动物基类：测试类型级说明抽取。</summary>
    public abstract class Animal
    {
        /// <summary>名字。</summary>
        public string Name { get; set; }

        public abstract void Speak();

        public class Nested
        {
            public int Depth { get; set; }
        }
    }

    // ── 分节线 ──
    public class Dog : Animal
    {
        public override void Speak() { }

        public int Legs { get; set; } = 4;
    }

    // ── 接口 ────────────
    public interface IWalker
    {
        void Walk();
    }

    public enum Mood
    {
        Happy,
        Sad,
    }

    /// <summary>
    /// 多行说明块：第一段在这里。
    /// 第二段也要在——回归用（tree-sitter 把 /// 的每一行各算一个 comment 节点，
    /// 只取最近那行的话，这种以 </summary> 收尾的块会变成空壳）。
    /// 破折号后面也不该有空格——
    /// 就像这一行接上一行那样。
    /// </summary>
    public class MultiLineDoc
    {
        public int Value { get; set; }
    }

    public record Point(int X, int Y);

    public record struct Size(int W, int H);
}

// C# 11/12 写法：file 修饰符 + 主构造函数（语法包不认，靠预处理搞定）
file sealed class FileOnlyHelper
{
    public int N { get; set; }
}

internal class WithPrimaryCtor(Animal dep) : Animal
{
    public override void Speak() { }

    public string Tag { get; init; }
}
