namespace CallRoles;

public class BareOnly {
    void Collision() { }
    public void Run() { Collision(); }
}
public class Mixed {
    void Collision() { }
    public Collision Run() { Collision(); return new Collision(); }
}
public class GenericOnly {
    T GenericCollision<T>(T item) => item;
    public int Run() => GenericCollision<int>(1);
}
public class TypeArguments {
    T GenericCollision<T>(T item) => item;
    public Token Run() => GenericCollision<Token>(new Token());
}
public class TypedUses {
    public bool Run(object item) => item is Collision;
    public System.Type Reflect() => typeof(Collision);
    public string Label() => nameof(Collision);
    public void Qualified() => Token.Touch();
}
public class GenericType {
    public GenericCollision<Token> Create() => new GenericCollision<Token>();
}
public class CallbackOwner {
    public Callback Callback;
    public void Run() { Callback(); }
}
public class DerivedCallback : CallbackOwner {
    public void RunAgain() { Callback(); }
}
