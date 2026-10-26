using System;
public class External
{
    public double Outside() => Math.Sqrt(1);
    public Container.PublicThing Visible() => new Container.PublicThing();
    public IContainer.Shared InterfaceVisible() => new IContainer.Shared();
}
public partial class Container
{
    public double PartialInside() => Math.Sqrt(3);
}
