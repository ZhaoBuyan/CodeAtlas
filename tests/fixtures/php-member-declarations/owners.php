<?php
namespace MemberRoles;
class Declaration { public function Coincidence(): void { } }
class Combined { public function Coincidence(): Coincidence { return new Coincidence(); } }
class Genuine { public function create(): Kept { return new Kept(); } }
function Coincidence(): void { }
enum Choice { case Coincidence; }
enum WithValue: string { case Active = Kept::VALUE; }
