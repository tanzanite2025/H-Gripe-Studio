//! Process-global registry mapping a stable `ResourceId` to a media file's
//! canonical path plus its cached header metadata.
//!
//! The webview should hold a lightweight **reference** to heavy media, never
//! the bytes: originals, decoded buffers, masks and video frames all live in
//! Rust (see [`super::thumb_cache`] / [`super::studio`]'s frame cache), and the
//! frontend just passes a `ResourceId` back to fetch info or a thumbnail. This
//! is the seam that lets later work (a unified image-buffer pipeline, rayon
//! parallelism) key its caches off one id instead of re-deriving everything
//! from a path string on every call.
//!
//! The id is a stable FNV-1a hash of the file's *canonical* path, so the same
//! file always resolves to the same id — a card can re-register on project load
//! and get its handle back without any persisted mapping. The registry is a
//! plain process-global `static` guarded by a `Mutex` (the commands are
//! handle-free), mirroring the thumbnail LRU.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

/// A registered media resource: its canonical path and cached header dims.
///
/// `width`/`height` are read from the file header at registration time (best
/// effort — `None` when the source is not a decodable image), so a consumer can
/// render an info row straight from [`get`] without re-probing.
#[derive(Clone)]
pub(crate) struct ResourceEntry {
    pub path: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Registry cap: entries are tiny (path + dims) but the process lives for the
/// whole app session, so growth must still be bounded. Past the cap the oldest
/// registrations are dropped (FIFO); a dropped resource is simply re-registered
/// by its card on the next lookup, since the id is a pure function of the path.
const MAX_ENTRIES: usize = 4096;

struct Registry {
    map: HashMap<String, ResourceEntry>,
    /// Insertion order of ids, oldest first, for FIFO eviction.
    order: VecDeque<String>,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| {
        Mutex::new(Registry {
            map: HashMap::new(),
            order: VecDeque::new(),
        })
    })
}

/// Stable `res-…` id for a resource, an FNV-1a 64-bit hash of its canonical
/// path. Deterministic across sessions, so the frontend never has to persist
/// the id/path mapping — re-registering the same file yields the same id.
pub(crate) fn id_for(canonical_path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in canonical_path.as_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("res-{hash:016x}")
}

/// Insert or refresh the entry for `id` (re-registering an edited file updates
/// its cached dims).
pub(crate) fn put(id: &str, entry: ResourceEntry) {
    if let Ok(mut reg) = registry().lock() {
        put_bounded(&mut reg, id, entry, MAX_ENTRIES);
    }
}

fn put_bounded(reg: &mut Registry, id: &str, entry: ResourceEntry, cap: usize) {
    if reg.map.insert(id.to_string(), entry).is_none() {
        reg.order.push_back(id.to_string());
        while reg.map.len() > cap {
            match reg.order.pop_front() {
                Some(oldest) => {
                    reg.map.remove(&oldest);
                }
                None => break,
            }
        }
    }
}

/// Look up a registered resource by id, or `None` if it was never registered.
pub(crate) fn get(id: &str) -> Option<ResourceEntry> {
    registry().lock().ok()?.map.get(id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_is_stable_and_path_dependent() {
        assert_eq!(id_for("/a/b.png"), id_for("/a/b.png"));
        assert_ne!(id_for("/a/b.png"), id_for("/a/c.png"));
        assert!(id_for("/a/b.png").starts_with("res-"));
    }

    #[test]
    fn put_then_get_roundtrips() {
        let id = id_for("/reg/roundtrip.png");
        assert!(get(&id).is_none());
        put(
            &id,
            ResourceEntry {
                path: "/reg/roundtrip.png".to_string(),
                width: Some(1920),
                height: Some(1080),
            },
        );
        let got = get(&id).expect("entry present after put");
        assert_eq!(got.path, "/reg/roundtrip.png");
        assert_eq!((got.width, got.height), (Some(1920), Some(1080)));
    }

    #[test]
    fn put_refreshes_existing_entry() {
        let id = id_for("/reg/refresh.png");
        put(
            &id,
            ResourceEntry {
                path: "/reg/refresh.png".to_string(),
                width: Some(10),
                height: Some(10),
            },
        );
        put(
            &id,
            ResourceEntry {
                path: "/reg/refresh.png".to_string(),
                width: Some(20),
                height: Some(30),
            },
        );
        let got = get(&id).expect("entry present");
        assert_eq!((got.width, got.height), (Some(20), Some(30)));
    }

    #[test]
    fn bounded_put_evicts_oldest_first() {
        let mut reg = Registry {
            map: HashMap::new(),
            order: VecDeque::new(),
        };
        let entry = |p: &str| ResourceEntry {
            path: p.to_string(),
            width: None,
            height: None,
        };
        put_bounded(&mut reg, "a", entry("/a"), 2);
        put_bounded(&mut reg, "b", entry("/b"), 2);
        // Refreshing an existing id must not create a duplicate order slot.
        put_bounded(&mut reg, "a", entry("/a2"), 2);
        assert_eq!(reg.map.len(), 2);
        // Third distinct id evicts the oldest ("a").
        put_bounded(&mut reg, "c", entry("/c"), 2);
        assert_eq!(reg.map.len(), 2);
        assert!(!reg.map.contains_key("a"));
        assert!(reg.map.contains_key("b"));
        assert!(reg.map.contains_key("c"));
    }
}
