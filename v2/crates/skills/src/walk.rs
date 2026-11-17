//! A toy walk (T9's proof, not N7's walk): it claims every locomotion resource the body has, asks the host the way
//! toward a point, and steers at a steady speed until it is there. It names no limb, so it runs on any family with
//! locomotion. K13 moves the real walk behind this interface.

use replica::bodies::{Class, SkillShape, Want};
use replica::encode::Name;
use replica::host::{Ask, Control, Host, Progress, Skill};
use replica::pose::{Mode, Vec3};

/// Its speed, in T4's units (micrometres) a second.
pub const SPEED: i64 = 1_400_000;
/// How near counts as there, in micrometres.
pub const NEAR: i64 = 50_000;

/// A toy walk to `to`, a point in the body's parent's frame.
pub struct Walk {
    pub to: Vec3,
}

fn isqrt(n: i128) -> i128 {
    if n <= 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

fn name(t: &str) -> Name {
    Name::new(t).unwrap_or_else(|| unreachable!("a fixed name"))
}

impl Skill for Walk {
    fn shape(&self) -> SkillShape {
        SkillShape {
            name: name("souls:toy-walk"),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: Vec::new(),
            cancelled_by: vec![Class::Locomotion],
        }
    }

    fn step(&mut self, host: &mut dyn Host) -> Progress {
        let body = host.body();
        let Some(me) = host.read(body) else {
            return Progress::Failed(name("souls:body-gone"));
        };
        let Some(next) = host.ask(&Ask::Toward {
            from: body,
            to: self.to,
        }) else {
            return Progress::Failed(name("souls:no-way"));
        };
        let d = Vec3 {
            x: next.x - me.position.x,
            y: next.y - me.position.y,
            z: next.z - me.position.z,
        };
        let len = isqrt(i128::from(d.x).pow(2) + i128::from(d.y).pow(2) + i128::from(d.z).pow(2));
        let still = Vec3 { x: 0, y: 0, z: 0 };
        if len <= i128::from(NEAR) {
            host.control(Control {
                velocity: still,
                mode: Mode::Surface,
            });
            return Progress::Done;
        }
        let v = |c: i64| i64::try_from(i128::from(c) * i128::from(SPEED) / len).unwrap_or(0);
        host.control(Control {
            velocity: Vec3 {
                x: v(d.x),
                y: v(d.y),
                z: v(d.z),
            },
            mode: Mode::Surface,
        });
        Progress::Going
    }
}
