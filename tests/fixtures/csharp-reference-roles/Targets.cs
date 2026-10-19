public class Status { }
public class RoleUser { }
public class Error { }
public class Source { }
public class LegitGlobal { }
public class GenericBox<T> { }
public class GenericBase<T> { }
public class RoleAccessBase
{
    private protected class RoleSharedNested { }
}
public static class InitConstants { public const int Seed = 2; }
public static class Constants { public static int Status => 1; }
public enum Severity { Error }
public class Context { public object RoleUser => new object(); }

public partial class HashCode
{
    private static class BitOperations { public static uint RotateLeft(uint value) => value; }
    public static uint Inside() => BitOperations.RotateLeft(1);
}

public class Wrapper
{
    internal class JsonConverter { }
}

namespace Preserved
{
    public class Outer
    {
        public class Inner { public static void Touch() { } }
    }
}
