//! The scripted agents' load shapes, as O3's drill has them (`v2/tools/archive/src/drill.rs`, from
//! `tools/bench/capacity/profiles/shapes.json`): which of the agents send an intent each tick.

use archive::{R, refuse};

/// SplitMix64: the drill's own numbers, never the world's.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn between(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.unit()
    }

    fn normal(&mut self) -> f64 {
        let (u, v) = (self.unit().max(1e-12), self.unit());
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}

/// Which agents (bodies) act each tick: `uniform` (even) or `event` (uneven) from shapes.json, simplified to what
/// the log sees: even, 1,000 agents each acting every 10 s × U(0.5, 1.5); uneven, 800 present agents in runs of 1 to
/// 4 acts 2 to 4 s apart, pauses lognormal (median 30 s, sigma 1.25, at least 2 s), and every 45 to 120 s a crowd
/// moment where 30 % of them act within 2 s; still, none.
pub struct Load {
    shape: String,
    rng: Rng,
    due: Vec<u64>,
    run: Vec<u32>,
    crowd: u64,
}

impl Load {
    pub fn new(shape: &str, seed: u64) -> R<Load> {
        let agents = match shape {
            "even" => 1_000,
            "uneven" => 800,
            "still" => 0,
            _ => return refuse("usage", "a load is even, uneven or still"),
        };
        let mut rng = Rng(seed);
        let first = if shape == "even" { 10.0 } else { 30.0 };
        let due = (0..agents)
            .map(|_| (rng.between(0.0, first) * 1e6) as u64)
            .collect();
        let crowd = (rng.between(45.0, 120.0) * 1e6) as u64;
        Ok(Load {
            shape: shape.to_owned(),
            rng,
            due,
            run: vec![0; agents],
            crowd,
        })
    }

    fn pause(&mut self) -> f64 {
        (30f64.ln() + 1.25 * self.rng.normal()).exp().max(2.0)
    }

    /// The agents whose act falls in the tick ending at `now` µs, each acting at most once a tick.
    pub fn acting(&mut self, now: u64) -> Vec<usize> {
        if self.shape == "uneven" && now >= self.crowd {
            for i in 0..self.due.len() {
                if self.rng.unit() < 0.3 {
                    self.due[i] = self.due[i].min(now + (self.rng.between(0.0, 2.0) * 1e6) as u64);
                }
            }
            self.crowd = now + (self.rng.between(45.0, 120.0) * 1e6) as u64;
        }
        let mut out = Vec::new();
        for i in 0..self.due.len() {
            if self.due[i] > now {
                continue;
            }
            out.push(i);
            let gap = if self.shape == "even" {
                10.0 * self.rng.between(0.5, 1.5)
            } else if self.run[i] > 0 {
                self.run[i] -= 1;
                self.rng.between(2.0, 4.0)
            } else {
                self.run[i] = (self.rng.next() % 4) as u32;
                self.pause()
            };
            self.due[i] = now + (gap * 1e6) as u64;
        }
        out
    }
}
