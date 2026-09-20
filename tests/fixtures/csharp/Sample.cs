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

        /// <summary>打招呼：测“成员签名”（参数表 + 返回类型）的抽取。</summary>
        public virtual string Greet(string tone, int times) { return tone; }

        /// <summary>普通字段：测“字段要能被列出来”（v1.4.0 复测报告 P1：计了数却不列）。</summary>
        public int Age = 0;

        /// <summary>常量字段：同上，走的是 field_declaration → variable_declaration 这条路。</summary>
        public const string Species = "animal";

        /// <summary>自定义类型的字段：名字要取字段名（Mate），不能取类型名（Animal）。</summary>
        public Animal Mate = null;

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

        // 同一个类型引用两次 → 这条边的权重是 2（测“引用次数”，不是“有几个来源”）
        public Animal Buddy { get; set; }
        public Animal Rival { get; set; }
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
