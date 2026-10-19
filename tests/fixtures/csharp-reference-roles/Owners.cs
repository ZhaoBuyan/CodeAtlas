using System.Numerics;
using System.Text.Json.Serialization;
using Preserved;

namespace Clients
{
    public enum DeclOwner { Source = 1, Other = InitConstants.Seed }

    public class MemberOwner
    {
        private Context context => new Context();
        public void Run()
        {
            _ = Constants.Status;
            _ = context.RoleUser;
            _ = Severity.Error;
        }
    }

    public class ValidOwner
    {
        public LegitGlobal Create() => new LegitGlobal();
        public GenericBox<int> Box() => new GenericBox<int>();
        public void Nested() => Outer.Inner.Touch();
    }

    public class MixedOwner
    {
        private Context context => new Context();
        public RoleUser Create() { _ = context.RoleUser; return new RoleUser(); }
    }

    public class WrongPrivate
    {
        public int Run() => BitOperations.Log2(1);
    }

    public abstract class ConverterOwner : JsonConverter<byte[]> { }
    public class GenericChild : GenericBase<int> { }
}
