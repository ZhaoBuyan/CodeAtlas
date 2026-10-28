namespace AncestorAccess;
public partial class Vault
{
    private class Hidden
    {
        public class Math { public static double Sqrt(double value) => value; }
        public class Layer { public class Leaf { } }
    }
    public double Inside() => Hidden.Math.Sqrt(1);
    public class Sibling { public double Inside() => Hidden.Math.Sqrt(2); }
    public class PublicBranch { public class Visible { } }
}
