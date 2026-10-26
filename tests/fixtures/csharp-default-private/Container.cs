public partial class Container
{
    class Math { public static double Sqrt(double x) => x; }
    public class PublicThing { }
    public double Inside() => Math.Sqrt(1);
    public class Child { public double Inside() => Math.Sqrt(2); }
}
public interface IContainer { class Shared { } }
