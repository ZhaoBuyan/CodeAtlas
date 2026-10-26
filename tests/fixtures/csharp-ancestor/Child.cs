namespace Ancestors.Configuration {
    public class AncChild {
        public void Run() { AncGlobalGuard.Check(); AncParentGuard.Check(); }
    }
}
