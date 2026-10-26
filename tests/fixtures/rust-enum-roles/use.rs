use crate::types::{Coincidence, Kept};
pub enum Declaration { Coincidence, Actual(Kept), Record { value: Kept } }
pub enum Discriminant { Size = std::mem::size_of::<Kept>() as isize }
pub struct Genuine { value: Coincidence }
