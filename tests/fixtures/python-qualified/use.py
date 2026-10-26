import pkg
import pkg as alias
import external
from . import pkg as relative

class Qualified:
    def make(self):
        pkg.Request()
        alias.Request()
        relative.Request()
        external.Response()
        pkg.Hidden()
        pkg.constructor()

class Inherited(pkg.Request):
    pass
