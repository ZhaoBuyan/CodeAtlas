use crate::defs::{Coincidence, Kept};
pub trait SignatureDeclaration {
    fn Coincidence();
    fn kept() -> Kept;
}
