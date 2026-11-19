//! Work split across threads with the outcome of one thread (Engine v2 N17b, #3255): items are taken a chunk at a
//! time, in order, and the results come back in the items' order, so the number of threads changes nothing but the
//! time. The engine reads no clock here and keeps no thread between calls (each call's threads end with it).

use std::sync::Mutex;

/// `f` of each item, in the items' order, on `threads` threads (the caller's own included), `chunk` items at a time.
/// A panic in `f` goes on as the caller's, as it would on one thread.
pub fn map<T: Sync, R: Send>(
    items: &[T],
    threads: usize,
    chunk: usize,
    f: impl Fn(&T) -> R + Sync,
) -> Vec<R> {
    let chunk = chunk.max(1);
    if threads <= 1 || items.len() <= chunk {
        return items.iter().map(f).collect();
    }
    let queue = Mutex::new(items.chunks(chunk).enumerate());
    let work = || {
        let mut done = Vec::new();
        while let Some((k, c)) = queue.lock().ok().and_then(|mut q| q.next()) {
            done.push((k, c.iter().map(&f).collect::<Vec<R>>()));
        }
        done
    };
    let work = &work;
    let mut done: Vec<(usize, Vec<R>)> = std::thread::scope(|sc| {
        let handles: Vec<_> = (1..threads).map(|_| sc.spawn(work)).collect();
        let mut all = work();
        for h in handles {
            all.extend(h.join().unwrap_or_else(|p| std::panic::resume_unwind(p)));
        }
        all
    });
    done.sort_by_key(|(k, _)| *k);
    done.into_iter().flat_map(|(_, v)| v).collect()
}

/// [`map`] of items `f` may change: each item is one thread's alone while `f` runs on it.
pub fn map_mut<T: Send, R: Send>(
    items: &mut [T],
    threads: usize,
    chunk: usize,
    f: impl Fn(&mut T) -> R + Sync,
) -> Vec<R> {
    let chunk = chunk.max(1);
    if threads <= 1 || items.len() <= chunk {
        return items.iter_mut().map(f).collect();
    }
    let queue = Mutex::new(items.chunks_mut(chunk).enumerate());
    let work = || {
        let mut done = Vec::new();
        while let Some((k, c)) = queue.lock().ok().and_then(|mut q| q.next()) {
            done.push((k, c.iter_mut().map(&f).collect::<Vec<R>>()));
        }
        done
    };
    let work = &work;
    let mut done: Vec<(usize, Vec<R>)> = std::thread::scope(|sc| {
        let handles: Vec<_> = (1..threads).map(|_| sc.spawn(work)).collect();
        let mut all = work();
        for h in handles {
            all.extend(h.join().unwrap_or_else(|p| std::panic::resume_unwind(p)));
        }
        all
    });
    done.sort_by_key(|(k, _)| *k);
    done.into_iter().flat_map(|(_, v)| v).collect()
}

#[cfg(test)]
mod tests {
    use super::map;

    #[test]
    fn the_order_and_the_results_do_not_depend_on_the_threads() {
        let items: Vec<u64> = (0..10_000).collect();
        let one = map(&items, 1, 64, |x| {
            x.wrapping_mul(0x9e37_79b9_7f4a_7c15) >> 7
        });
        for threads in [2, 3, 4, 8] {
            for chunk in [1, 7, 64, 20_000] {
                assert_eq!(
                    map(&items, threads, chunk, |x| x
                        .wrapping_mul(0x9e37_79b9_7f4a_7c15)
                        >> 7),
                    one
                );
            }
        }
    }
}
