use std::fmt;

/// 形状基类：Rust 用 trait 表达能力。
pub trait Shape {
    fn area(&self) -> f64;
}

/// 圆形。
pub struct Circle {
    pub radius: f64,
}

impl Circle {
    pub fn new(radius: f64) -> Self {
        Circle { radius }
    }
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        std::f64::consts::PI * self.radius * self.radius
    }
}

pub enum Kind {
    Red,
    Green,
}

pub fn helper(a: i32) -> i32 {
    if a > 0 && a < 10 {
        return a;
    }
    -a
}

fn main() {
    let c = Circle::new(1.0);
    println!("{}", fmt::Debug::fmt(&c.area(), &mut std::io::stdout()));
}
