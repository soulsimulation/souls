// Seeded (K14, #2648): a v2 crate that reads one of today's packages. v2/tools/arch/check.mjs must fail it by
// `v2-imports-today`, as if it were crates/sim/src/ground/legacy.rs. Never compiled.
pub const BRIDGE: &str = include_str!("../../../../../packages/engine-mars/src/ground-bridge.ts");
