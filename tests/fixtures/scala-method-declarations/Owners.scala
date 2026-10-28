package methodroles

class Declaration { def Collision(): Unit = () }
class Combined { def Collision(): Collision = new Collision }
class Genuine { def genuine(): Kept = new Kept }
trait Signature { def Collision(): Unit; def kept(): Kept }
