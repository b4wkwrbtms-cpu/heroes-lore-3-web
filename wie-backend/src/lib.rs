#![no_std]
extern crate alloc;

mod audio_sink;
pub mod canvas;
mod database;
mod executor;
mod platform;
mod screen;
mod storage_request;
mod system;
mod task;
mod task_runner;
pub mod text_layout;
mod time;

pub use self::{
    audio_sink::{AudioCommand, AudioEventData, AudioHandle, AudioSequence, AudioSink, TimedAudioEvent},
    canvas::Font,
    database::{Database, DatabaseRepository, RecordId},
    executor::{AsyncCallable, AsyncCallableResult},
    platform::{Filesystem, Platform},
    screen::Screen,
    storage_request::StorageRequest,
    system::{Event, FilesystemOverlay, KeyCode, System, normalize_guest_path},
    task::YieldFuture,
    task_runner::{DefaultTaskRunner, TaskRunner},
    time::Instant,
};

use alloc::{boxed::Box, collections::BTreeMap, format, string::String, vec::Vec};

use wie_core_arm_aot::CompiledExecutor;
use wie_util::{Result, WieError};

pub trait Emulator {
    fn handle_event(&mut self, event: Event);
    fn tick(&mut self) -> Result<()>;
    fn is_preparing(&self) -> bool;

    /// Mapped guest memory ranges as (start, size), for memory/cheat tools. Empty when unsupported.
    fn memory_ranges(&self) -> Vec<(u32, u32)> {
        Vec::new()
    }

    /// Read guest memory into `result`.
    fn read_memory(&self, _address: u32, _result: &mut [u8]) -> Result<()> {
        Err(WieError::Unimplemented(String::from("read_memory")))
    }

    /// Write `data` into guest memory.
    fn write_memory(&mut self, _address: u32, _data: &[u8]) -> Result<()> {
        Err(WieError::Unimplemented(String::from("write_memory")))
    }

    /// Whether the guest is between its callbacks: every task is asleep. False when unsupported.
    fn is_idle(&self) -> bool {
        false
    }

    /// Runs the guest function at `address` to its end on a stack of its own, without running the
    /// guest's tasks, and returns its result register.
    fn call_function(&mut self, _address: u32, _params: &[u32]) -> Result<u32> {
        Err(WieError::Unimplemented(String::from("call_function")))
    }
}

pub struct ProfileSample {
    /// Leaf-first call stack: [pc, lr, lr_prev, ...].
    pub stack: Vec<u32>,
    pub count: u64,
}

/// Called periodically during execution with a batch of samples that the
/// profiler accumulated since the previous flush. The callback also fires once
/// more when the runtime shuts down to drain anything still in the buffer.
pub type ProfileCallback = Box<dyn FnMut(Vec<ProfileSample>) + Send + Sync>;

pub struct Options {
    pub enable_gdbserver: bool,
    pub aot: Option<Box<dyn CompiledExecutor>>,
    pub profile: Option<ProfileCallback>,
}

pub fn extract_zip(zip: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    extern crate std; // XXX

    use std::io::{Cursor, Read};
    use zip::ZipArchive;

    let mut archive = ZipArchive::new(Cursor::new(zip)).map_err(|x| WieError::FatalError(format!("Invalid zip archive: {x}")))?;

    (0..archive.len())
        .filter_map(|x| {
            let mut file = match archive.by_index(x) {
                Ok(file) => file,
                Err(err) => return Some(Err(WieError::FatalError(format!("Failed to read zip entry {x}: {err}")))),
            };
            if !file.is_file() {
                return None;
            }
            let name = match file.name() {
                Ok(name) => name.into_owned(),
                Err(err) => return Some(Err(WieError::FatalError(format!("Failed to read zip entry name {x}: {err}")))),
            };

            let mut data = Vec::new();
            if let Err(err) = file.read_to_end(&mut data) {
                return Some(Err(WieError::FatalError(format!("Failed to read zip entry {name}: {err}"))));
            }

            Some(Ok((name, data)))
        })
        .collect::<Result<_>>()
}
