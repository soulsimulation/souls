// Seeded (K14, #2648): a selector (E2) that ranks by a float distance. v2/tools/arch/check.mjs must fail it by
// `float-in-replica`, as if it were crates/replica/src/selectors.rs. Never compiled.
pub fn nearer(a: [i64; 2], b: [i64; 2]) -> bool {
    let d = |p: [i64; 2]| ((p[0] * p[0] + p[1] * p[1]) as f64).sqrt();
    d(a) < d(b)
}
