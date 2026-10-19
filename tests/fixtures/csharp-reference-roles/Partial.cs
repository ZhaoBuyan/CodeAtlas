public partial class HashCode
{
    public static uint AcrossPartial() => BitOperations.RotateLeft(1);
}

public class RoleAccessDerived : RoleAccessBase
{
    public string Describe() => nameof(RoleSharedNested);
}
