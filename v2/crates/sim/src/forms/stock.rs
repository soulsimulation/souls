//! What a container's take yields beyond its kind (#4837): a stock's `carries` (entry section 15, SA-F12), the text
//! fields of the yielded thing that come by reference from a library the world supplies (a book's title and first
//! page). The world works out each stocked container's pile once, from its own data ([`Stocked`]); a `create` of the
//! stock's kind at that container then gives the made thing the fields of the row at the top of the pile. No code
//! here names a kind, a field or a library.
//!
//! - **The pile.** A copy of a stock row (`content/worlds/<world>/stock.json`) holds `start` rows of its draw's pool,
//!   from `offset` on: row `j` of the pile is `pool[(offset + j) mod pool size]`. A take yields the row at index
//!   `count - 1`, the top of the pile, `count` being the container's count field as the take reads it, or `start`
//!   while that field was never written.
//! - **Deterministic.** The pile and the pool are the world's own data, fixed at its start; the count is the tree's.
//!   Nothing here reads a clock or draws a number.
//!
//! Not here: lowering the count as the take yields (the stock's count is the container's own field, unchanged by a
//! take today), refills.

use std::collections::BTreeMap;
use std::sync::Arc;

use replica::encode::Value;
use replica::ids::Id;

/// One stocked container's pile: the kind it yields, its count field, its pile's start and size, and the pool its
/// rows come from.
#[derive(Clone, Debug, PartialEq)]
pub struct Stocked {
    /// The yielded kind's plain name (`namespace:name`).
    pub kind: String,
    /// The container's count field, by number.
    pub count: u64,
    /// How many rows the copy's pile holds when the world starts (its stock row's `count`), at least 1.
    pub start: i64,
    /// Where the copy's pile starts in the pool.
    pub offset: u64,
    /// The pool, in its library's order: each row's carried fields, the yielded kind's field number to its value.
    pub pool: Arc<Vec<BTreeMap<u64, Value>>>,
}

/// The world's stocked containers, by node.
pub type Stocks = BTreeMap<Id, Stocked>;

impl Stocked {
    /// The fields a take gives the thing it yields while the container's count is `count` (`None`: never written):
    /// the row at the top of the pile. None when the pool is empty.
    pub fn carried(&self, count: Option<i64>) -> BTreeMap<u64, Value> {
        let size = self.pool.len() as u64;
        if size == 0 {
            return BTreeMap::new();
        }
        let start = self.start.max(1);
        let top = count.unwrap_or(start).clamp(1, start) - 1;
        let at = self.offset.wrapping_add(top as u64) % size;
        self.pool[at as usize].clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(n: u64) -> Arc<Vec<BTreeMap<u64, Value>>> {
        Arc::new(
            (0..n)
                .map(|r| BTreeMap::from([(29, Value::Uint(r))]))
                .collect(),
        )
    }

    /// The top of the pile is the row at `count - 1` from the copy's offset, wrapping round the pool; a count never
    /// written is the pile's start; a count past the pile's start reads its top.
    #[test]
    fn the_top_of_the_pile_is_the_row_at_count_less_one() {
        let s = Stocked {
            kind: "eden:book".into(),
            count: 28,
            start: 4,
            offset: 8,
            pool: pool(10),
        };
        assert_eq!(s.carried(None), BTreeMap::from([(29, Value::Uint(1))]));
        assert_eq!(s.carried(Some(1)), BTreeMap::from([(29, Value::Uint(8))]));
        assert_eq!(s.carried(Some(2)), BTreeMap::from([(29, Value::Uint(9))]));
        assert_eq!(s.carried(Some(100)), s.carried(None));
        assert_eq!(s.carried(Some(0)), s.carried(Some(1)));
        let empty = Stocked {
            pool: Arc::new(Vec::new()),
            ..s
        };
        assert!(empty.carried(None).is_empty());
    }
}
