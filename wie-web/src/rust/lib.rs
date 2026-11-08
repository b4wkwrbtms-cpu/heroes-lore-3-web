#![no_std]
extern crate alloc;

mod aot;
mod audio_sink;
mod database;
mod filesystem;
mod host;
mod indexed_db_store;
mod save_migration;
mod util;
mod window;

use alloc::{
    boxed::Box,
    string::{String, ToString},
    sync::Arc,
    vec::Vec,
};
use core::{
    str,
    sync::atomic::{AtomicBool, Ordering},
};

use hashbrown::HashMap;
use tracing_subscriber::{Layer, filter::LevelFilter, fmt::time::UtcTime, layer::SubscriberExt, util::SubscriberInitExt};
use tracing_web::MakeConsoleWriter;
use wasm_bindgen::{JsError, prelude::*};
use web_sys::HtmlCanvasElement;

use wie_backend::{DatabaseRepository as BackendDatabaseRepository, Emulator, Event, Filesystem, Font, Instant, KeyCode, Options, Platform, Screen};

use self::{
    audio_sink::{AudioPlayer, AudioSink},
    database::DatabaseRepository,
    filesystem::WebFilesystem,
    host::WasmHost,
    window::WindowImpl,
};

#[wasm_bindgen(module = "panic.ts")]
extern "C" {
    #[wasm_bindgen(js_name = recordPanic)]
    fn record_panic(message: &str);
}

struct WieWebPlatform {
    audio_player: AudioPlayer,
    database_repository: Box<dyn BackendDatabaseRepository>,
    filesystem: Box<dyn Filesystem>,
    host: Option<WasmHost>,
    exited: Arc<AtomicBool>,
    font: Font,
    window: WindowImpl,
}

// XXX we're on single thread
unsafe impl Sync for WieWebPlatform {}
unsafe impl Send for WieWebPlatform {}

impl WieWebPlatform {
    fn new(window: WindowImpl, font: Font, audio_player: AudioPlayer, host: Option<WasmHost>, exited: Arc<AtomicBool>) -> Self {
        let (database_repository, filesystem): (Box<dyn BackendDatabaseRepository>, Box<dyn Filesystem>) = match &host {
            Some(host) => (Box::new(host.clone()), Box::new(host.clone())),
            None => (Box::new(DatabaseRepository::new()), Box::new(WebFilesystem::new())),
        };
        Self {
            audio_player,
            database_repository,
            filesystem,
            host,
            exited,
            font,
            window,
        }
    }
}

impl Platform for WieWebPlatform {
    fn font(&self) -> &Font {
        &self.font
    }

    fn screen(&self) -> &dyn Screen {
        &self.window
    }

    fn now(&self) -> Instant {
        let millis = self.host.as_ref().map_or_else(js_sys::Date::now, WasmHost::now);

        Instant::from_epoch_millis(millis as _)
    }

    fn database_repository(&self) -> &dyn BackendDatabaseRepository {
        self.database_repository.as_ref()
    }

    fn filesystem(&self) -> &dyn Filesystem {
        self.filesystem.as_ref()
    }

    fn audio_sink(&self) -> Box<dyn wie_backend::AudioSink> {
        Box::new(AudioSink::new(self.audio_player.clone()))
    }

    fn write_stdout(&self, data: &[u8]) {
        let string = str::from_utf8(data).unwrap();
        tracing::info!("{}", string);
    }

    fn write_stderr(&self, data: &[u8]) {
        let string = str::from_utf8(data).unwrap();
        tracing::info!("{}", string);
    }

    fn exit(&self) {
        self.exited.store(true, Ordering::SeqCst);
    }

    fn vibrate(&self, duration_ms: u64, intensity: u8) {
        if let Some(host) = &self.host {
            host.vibrate(duration_ms as f64, intensity);
            return;
        }

        if duration_ms == 0 || intensity == 0 {
            return;
        }

        let Some(window) = web_sys::window() else { return };
        let navigator = window.navigator();
        if !js_sys::Reflect::has(navigator.as_ref(), &JsValue::from_str("vibrate")).unwrap_or(false) {
            return;
        }
        let duration = core::cmp::min(duration_ms, u32::MAX as u64) as u32;
        navigator.vibrate_with_duration(duration);
    }
}

#[wasm_bindgen]
pub struct WieWeb {
    emulator: Box<dyn Emulator>,
    audio_player: AudioPlayer,
    host: Option<WasmHost>,
    exited: Arc<AtomicBool>,
    should_redraw: Arc<AtomicBool>,
    key_events: HashMap<KeyCode, f64>,
    /// Cheat "freeze" entries: (address, width in bytes, value, big_endian) rewritten after every tick.
    frozen: Vec<(u32, u32, u32, bool)>,
}

/// Encode `value` as `width` bytes (2 or 4) in guest byte order.
fn cheat_pattern(value: u32, width: usize, big_endian: bool) -> Vec<u8> {
    if big_endian {
        value.to_be_bytes()[4 - width..].to_vec()
    } else {
        value.to_le_bytes()[..width].to_vec()
    }
}

/// Decode `width` bytes (2 or 4) from guest byte order.
fn cheat_decode(bytes: &[u8], big_endian: bool) -> u32 {
    let mut buf = [0u8; 4];
    if big_endian {
        buf[4 - bytes.len()..].copy_from_slice(bytes);
        u32::from_be_bytes(buf)
    } else {
        buf[..bytes.len()].copy_from_slice(bytes);
        u32::from_le_bytes(buf)
    }
}

impl Drop for WieWeb {
    fn drop(&mut self) {
        // Runtime tasks can retain platform references after the view closes.
        self.audio_player.dispose();
    }
}

#[wasm_bindgen]
pub struct ImportedAppMetadata {
    id: String,
    title: String,
    icon: Vec<u8>,
}

#[wasm_bindgen]
impl ImportedAppMetadata {
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn title(&self) -> String {
        self.title.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn icon(&self) -> Vec<u8> {
        self.icon.clone()
    }
}

#[wasm_bindgen(js_name = extractAppMetadata)]
pub fn extract_app_metadata(filename: &str, buf: &[u8]) -> Result<ImportedAppMetadata, JsError> {
    let file_type = wie::determine_file_type(filename, buf).map_err(|error| JsError::new(&error.to_string()))?;
    let metadata = wie::extract_app_metadata(filename, buf, file_type).map_err(|error| JsError::new(&error.to_string()))?;
    Ok(ImportedAppMetadata {
        id: metadata.id,
        title: metadata.title,
        icon: metadata.icon.unwrap_or_default(),
    })
}

#[wasm_bindgen]
impl WieWeb {
    #[wasm_bindgen(constructor)]
    pub fn new(
        filename: &str,
        buf: &[u8],
        canvas: HtmlCanvasElement,
        font_data: Vec<u8>,
        audio_player: AudioPlayer,
        host: Option<WasmHost>,
    ) -> Result<WieWeb, JsError> {
        (|| {
            let should_redraw = Arc::new(AtomicBool::new(true));
            let exited = Arc::new(AtomicBool::new(false));
            let window = WindowImpl::new(canvas, should_redraw.clone());
            let font = Font::try_from_vec(font_data)?;
            let platform = Box::new(WieWebPlatform::new(window, font, audio_player.clone(), host.clone(), exited.clone()));
            let options = Options {
                enable_gdbserver: false,
                aot: Some(Box::new(aot::WasmExecutor::default())),
                profile: None,
            };

            let emulator = wie::load_emulator(filename, buf.to_vec(), platform, options)?;

            anyhow::Ok(Self {
                emulator,
                audio_player,
                host,
                exited,
                should_redraw,
                key_events: HashMap::new(),
                frozen: Vec::new(),
            })
        })()
        .map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn is_preparing(&self) -> bool {
        self.emulator.is_preparing()
    }

    pub fn is_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    pub fn update(&mut self) -> Result<(), JsError> {
        if self.should_redraw.load(Ordering::SeqCst) {
            self.emulator.handle_event(Event::Redraw);
            self.should_redraw.store(false, Ordering::SeqCst)
        }

        let millis = self.host.as_ref().map_or_else(js_sys::Date::now, WasmHost::now);

        for (key, key_millis) in self.key_events.iter_mut() {
            if millis - *key_millis > 100.0 {
                self.emulator.handle_event(Event::Keyrepeat(*key));
                *key_millis = millis;
            }
        }

        self.emulator.tick().map_err(|e| JsError::new(&e.to_string()))?;

        if !self.frozen.is_empty() {
            let frozen = self.frozen.clone();
            for (address, width, value, big_endian) in frozen {
                let bytes = cheat_pattern(value, width as usize, big_endian);
                let _ = self.emulator.write_memory(address, &bytes);
            }
        }

        Ok(())
    }

    /// Total mapped guest memory in bytes (what `cheat_search` scans).
    pub fn cheat_memory_size(&self) -> u32 {
        self.emulator.memory_ranges().iter().fold(0u32, |acc, (_, size)| acc.saturating_add(*size))
    }

    /// Search guest memory for `value` stored in `width` bytes (2 or 4), at every byte offset.
    /// When `previous` is non-empty only those addresses are re-checked (narrowing search).
    pub fn cheat_search(&self, value: u32, width: u32, big_endian: bool, previous: &[u32]) -> Result<Vec<u32>, JsError> {
        const MAX_RESULTS: usize = 50_000;
        const STEP: usize = 0x10000;
        let width = if width == 2 { 2usize } else { 4usize };
        let needle = cheat_pattern(value, width, big_endian);
        let mut results = Vec::new();

        if !previous.is_empty() {
            let mut buf = [0u8; 4];
            for &address in previous {
                if self.emulator.read_memory(address, &mut buf[..width]).is_ok() && buf[..width] == needle[..] {
                    results.push(address);
                }
            }
            return Ok(results);
        }

        // Chunks overlap by `width - 1` bytes so values straddling a chunk boundary are found too.
        let mut chunk = alloc::vec![0u8; STEP + 4];
        let first = needle[0];
        for (start, size) in self.emulator.memory_ranges() {
            let mut offset: u64 = 0;
            while offset < size as u64 {
                let remaining = size as u64 - offset;
                let len = core::cmp::min((STEP + width - 1) as u64, remaining) as usize;
                let address = start.wrapping_add(offset as u32);
                if self.emulator.read_memory(address, &mut chunk[..len]).is_err() {
                    break;
                }
                if len >= width {
                    let mut i = 0;
                    let last = len - width;
                    while i <= last {
                        if chunk[i] == first && chunk[i..i + width] == needle[..] {
                            results.push(address.wrapping_add(i as u32));
                            if results.len() >= MAX_RESULTS {
                                return Ok(results);
                            }
                        }
                        i += 1;
                    }
                }
                offset += STEP as u64;
            }
        }

        Ok(results)
    }

    /// Mapped guest memory ranges, flattened as [start0, size0, start1, size1, ...].
    pub fn cheat_memory_ranges(&self) -> Vec<u32> {
        self.emulator.memory_ranges().into_iter().flat_map(|(start, size)| [start, size]).collect()
    }

    /// Copy `size` bytes of guest memory starting at `address` (unmapped tail is truncated).
    pub fn cheat_dump(&self, address: u32, size: u32) -> Result<Vec<u8>, JsError> {
        let mut data = alloc::vec![0u8; size as usize];
        let mut done = 0usize;
        while done < data.len() {
            let len = core::cmp::min(0x10000, data.len() - done);
            if self.emulator.read_memory(address.wrapping_add(done as u32), &mut data[done..done + len]).is_err() {
                data.truncate(done);
                break;
            }
            done += len;
        }

        Ok(data)
    }

    pub fn cheat_read(&self, address: u32, width: u32, big_endian: bool) -> Result<u32, JsError> {
        let width = if width == 2 { 2usize } else { 4usize };
        let mut buf = [0u8; 4];
        self.emulator
            .read_memory(address, &mut buf[..width])
            .map_err(|e| JsError::new(&e.to_string()))?;

        Ok(cheat_decode(&buf[..width], big_endian))
    }

    pub fn cheat_write(&mut self, address: u32, width: u32, big_endian: bool, value: u32) -> Result<(), JsError> {
        let width = if width == 2 { 2usize } else { 4usize };
        let bytes = cheat_pattern(value, width, big_endian);
        self.emulator.write_memory(address, &bytes).map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn cheat_freeze(&mut self, address: u32, width: u32, big_endian: bool, value: u32) -> Result<(), JsError> {
        let width = if width == 2 { 2 } else { 4 };
        self.frozen.retain(|(a, _, _, _)| *a != address);
        self.frozen.push((address, width, value, big_endian));
        self.cheat_write(address, width, big_endian, value)
    }

    pub fn cheat_unfreeze(&mut self, address: u32) {
        self.frozen.retain(|(a, _, _, _)| *a != address);
    }

    pub fn cheat_clear_freezes(&mut self) {
        self.frozen.clear();
    }

    pub fn key_down(&mut self, key: String) -> Result<(), JsError> {
        let millis = self.host.as_ref().map_or_else(js_sys::Date::now, WasmHost::now);
        let key = KeyCode::parse(&key);

        self.emulator.handle_event(Event::Keydown(key));
        self.key_events.insert(key, millis);

        Ok(())
    }

    pub fn key_up(&mut self, key: String) -> Result<(), JsError> {
        let key = KeyCode::parse(&key);

        self.emulator.handle_event(Event::Keyup(key));
        self.key_events.remove(&key);

        Ok(())
    }
}

#[wasm_bindgen(start)]
pub fn start() {
    extern crate std;
    use std::panic;

    panic::set_hook(Box::new(|info| record_panic(&info.to_string())));

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_timer(UtcTime::rfc_3339())
        .with_writer(MakeConsoleWriter)
        .with_filter(LevelFilter::INFO);

    tracing_subscriber::registry().with(fmt_layer).init();
}
