package roles;
class Coincidence {}
class Kept {}
enum Declaration {
    Coincidence, Actual(new Kept());
    Declaration() {}
    Declaration(Kept value) {}
}
class Genuine {
    Coincidence make() { return new Coincidence(); }
}
