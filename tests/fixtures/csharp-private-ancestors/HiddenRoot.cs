namespace AncestorAccess;
public class AnotherVault
{
    class DefaultHidden { public class Coincidence { } }
    private DefaultHidden.Coincidence Inside() => new DefaultHidden.Coincidence();
}
public class MissingBinding { public object Outside() => new Coincidence(); }
