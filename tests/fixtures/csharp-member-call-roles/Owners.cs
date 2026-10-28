namespace MemberCallRoles;

public class StaticOnly { public void Run() => Provider.Collision(); }
public class GenericOnly { public int Run() => Provider.GenericCollision<int>(1); }
public class ConditionalOnly { public void Run(Provider value) => value?.Collision(1); }
public class Mixed {
    public Collision Run() { Provider.Collision(); return new Collision(); }
}
public class TypeArguments { public Token Run() => Provider.GenericCollision<Token>(new Token()); }
public class NestedType {
    public Provider.Nested Create() => new Provider.Nested();
    public System.Type Reflect() => typeof(Provider.Nested);
}
public class QualifiedType { public void Run() => Token.Touch(); }
public class DelegateProvider { public Callback Callback; }
public class DelegateCaller { public void Run(DelegateProvider value) => value.Callback(); }
public class InheritedCallback : DelegateProvider { public void Run() => this.Callback(); }
