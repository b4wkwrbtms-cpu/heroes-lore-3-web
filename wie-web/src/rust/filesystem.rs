use alloc::{
    boxed::Box,
    rc::Rc,
    string::{String, ToString},
    sync::Arc,
    vec,
    vec::Vec,
};
use core::cell::RefCell;
use core::cmp::{max, min};

use hashbrown::HashMap;

use wie_backend::Filesystem;

use crate::indexed_db_store::{Store, StoreKey};

const DB_NAME: &str = "wie_filesystem";
const STORE_NAME: &str = "files";

fn make_key(pid: &str, path: &str) -> StoreKey {
    StoreKey::Pair(pid.to_string(), path.to_string())
}

pub struct WebFilesystem {
    store: Rc<RefCell<Option<Store>>>,
    /// Contents of files this session has touched (`None`: known not to exist). Games read resource files in many
    /// small seeks and reads; going to IndexedDB for each one turned a map load into seconds of waiting.
    /// Writes go to IndexedDB first and then here, so the store stays the source of truth.
    cache: Rc<RefCell<HashMap<(String, String), Option<Arc<Vec<u8>>>>>>,
}

// single threaded wasm; RefCell + Rc are only touched sequentially.
unsafe impl Send for WebFilesystem {}
unsafe impl Sync for WebFilesystem {}

impl WebFilesystem {
    pub fn new() -> Self {
        Self {
            store: Rc::new(RefCell::new(None)),
            cache: Rc::new(RefCell::new(HashMap::new())),
        }
    }

    async fn get(&self, pid: &str, path: &str) -> Option<Arc<Vec<u8>>> {
        let cache_key = (pid.to_string(), path.to_string());
        let cached = self.cache.borrow().get(&cache_key).cloned();
        if let Some(entry) = cached {
            return entry;
        }
        let data = self.store().await.get(make_key(pid, path)).await.map(Arc::new);
        self.cache.borrow_mut().insert(cache_key, data.clone());
        data
    }

    async fn put(&self, pid: &str, path: &str, data: Vec<u8>) {
        self.store().await.set(make_key(pid, path), &data).await;
        self.cache.borrow_mut().insert((pid.to_string(), path.to_string()), Some(Arc::new(data)));
    }

    async fn store(&self) -> Store {
        if let Some(store) = self.store.borrow().as_ref() {
            return store.clone();
        }
        let store = Store::open(DB_NAME, STORE_NAME).await;
        *self.store.borrow_mut() = Some(store.clone());
        store
    }
}

#[async_trait::async_trait]
impl Filesystem for WebFilesystem {
    async fn remove(&self, pid: &str, path: &str) -> bool {
        if self.get(pid, path).await.is_none() {
            return false;
        }
        self.store().await.delete(make_key(pid, path)).await;
        self.cache.borrow_mut().insert((pid.to_string(), path.to_string()), None);
        true
    }

    async fn usage(&self, pid: &str) -> u64 {
        let store = self.store().await;
        let mut usage = 0;
        for key in store.get_all_keys().await {
            if matches!(&key, StoreKey::Pair(owner, _) if owner == pid)
                && let Some(data) = store.get(key).await
            {
                usage += data.len() as u64;
            }
        }
        usage
    }

    async fn exists(&self, pid: &str, path: &str) -> bool {
        self.get(pid, path).await.is_some()
    }

    async fn size(&self, pid: &str, path: &str) -> Option<usize> {
        self.get(pid, path).await.map(|v| v.len())
    }

    async fn read(&self, pid: &str, path: &str, offset: usize, count: usize, buf: &mut [u8]) -> Option<usize> {
        let data = self.get(pid, path).await?;

        if offset >= data.len() {
            return Some(0);
        }

        let size_to_read = min(count, data.len() - offset);
        buf[..size_to_read].copy_from_slice(&data[offset..offset + size_to_read]);
        Some(size_to_read)
    }

    async fn write(&self, pid: &str, path: &str, offset: usize, data: &[u8]) -> usize {
        let existing = self.get(pid, path).await.unwrap_or_default();
        let new_len = max(existing.len(), offset + data.len());

        let mut next = vec![0u8; new_len];
        next[..existing.len()].copy_from_slice(&existing);
        next[offset..offset + data.len()].copy_from_slice(data);

        self.put(pid, path, next).await;
        data.len()
    }

    async fn truncate(&self, pid: &str, path: &str, len: usize) {
        let existing = self.get(pid, path).await.unwrap_or_default();

        let mut next = vec![0u8; len];
        let copy_len = min(existing.len(), len);
        next[..copy_len].copy_from_slice(&existing[..copy_len]);

        self.put(pid, path, next).await;
    }
}
