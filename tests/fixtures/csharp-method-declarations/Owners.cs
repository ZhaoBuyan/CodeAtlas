namespace MethodRoles;

public class Declaration { public void Collision() { } }
public class Combined { public Collision Collision() => new Collision(); }
public class Genuine { public Kept Create() => new Kept(); }
public interface Signature { void Collision(); Kept Return(); }
public class Explicit : IContract { Collision IContract.Collision() => new Collision(); }
public class Generic { public T Collision<T>(T value) => value; }
public static class Extensions { public static Collision Extend(this Collision item) => item; }
public class Reflected { public System.Type Get() => typeof(Collision); }
