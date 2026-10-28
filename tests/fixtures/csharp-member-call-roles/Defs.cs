namespace MemberCallRoles;

public class Collision { }
public class GenericCollision<T> { }
public class Token { public static void Touch() { } }
public delegate void Callback();
public class Provider {
    public static void Collision() { }
    public void Collision(int value) { }
    public static T GenericCollision<T>(T item) => item;
    public class Nested { }
}
