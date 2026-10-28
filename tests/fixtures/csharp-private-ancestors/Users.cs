using System;
namespace AncestorAccess;
public class Outside
{
    // This names System.Math, not a public type inside Vault's private Hidden.
    public double Fallback() => Math.Sqrt(1);
    public Vault.PublicBranch.Visible Allowed() => new Vault.PublicBranch.Visible();
}
public partial class Vault
{
    public double PartialInside() => Hidden.Math.Sqrt(3);
    private Hidden.Layer.Leaf InternalLeaf() => new Hidden.Layer.Leaf();
}
