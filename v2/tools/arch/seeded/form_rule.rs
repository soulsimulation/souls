// Seeded (K14, #2648): a form rule (R2) whose chance is a float. v2/tools/arch/check.mjs must fail it by
// `float-in-replica`, as if it were crates/replica/src/form_rules.rs. Never compiled.
pub fn succeeds(roll: u32) -> bool {
    let chance = 0.25;
    (roll % 100) < (chance * 100.0) as u32
}
