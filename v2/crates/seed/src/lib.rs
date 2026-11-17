//! A placeholder crate so CI's `v2` job has something to build and test (K15, #2637). K1 replaces it.

/// Adds two numbers; `None` when the sum does not fit.
pub fn checked_sum(a: u64, b: u64) -> Option<u64> {
    a.checked_add(b)
}

#[cfg(test)]
mod tests {
    use super::checked_sum;

    #[test]
    fn sums_and_refuses_overflow() {
        assert_eq!(checked_sum(2, 3), Some(5));
        assert_eq!(checked_sum(u64::MAX, 1), None);
    }
}
