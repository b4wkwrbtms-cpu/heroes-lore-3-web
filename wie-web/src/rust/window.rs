use alloc::{sync::Arc, vec::Vec};
use core::cell::RefCell;
use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use js_sys::Uint8ClampedArray;
use wasm_bindgen::JsCast;
use web_sys::{CanvasRenderingContext2d, HtmlCanvasElement, ImageData};

use wie_backend::{Screen, canvas::Image};
use wie_util::Result;

pub struct WindowImpl {
    canvas: HtmlCanvasElement,
    context: CanvasRenderingContext2d,
    buffer: RefCell<PaintBuffer>,
    should_redraw: Arc<AtomicBool>,
    frames: Arc<AtomicU32>,
}

#[derive(Default)]
struct PaintBuffer {
    rgba: Vec<u8>,
    frame: Option<(ImageData, Uint8ClampedArray)>,
}

unsafe impl Send for WindowImpl {} // XXX We're on wasm, so it's fine
unsafe impl Sync for WindowImpl {}

impl WindowImpl {
    pub fn new(canvas: HtmlCanvasElement, should_redraw: Arc<AtomicBool>, frames: Arc<AtomicU32>) -> Self {
        let context = canvas.get_context("2d").unwrap().unwrap().dyn_into::<CanvasRenderingContext2d>().unwrap();
        Self {
            canvas,
            context,
            buffer: RefCell::new(PaintBuffer::default()),
            should_redraw,
            frames,
        }
    }
}

impl Screen for WindowImpl {
    fn resize(&self, width: u32, height: u32) -> Result<()> {
        self.canvas.set_width(width);
        self.canvas.set_height(height);
        self.request_redraw()
    }

    fn request_redraw(&self) -> Result<()> {
        self.should_redraw.store(true, Ordering::SeqCst);

        Ok(())
    }

    fn paint(&self, image: &dyn Image) {
        let mut buffer = self.buffer.borrow_mut();
        image.write_rgba(&mut buffer.rgba);
        let width = image.width();
        let height = image.height();
        if buffer
            .frame
            .as_ref()
            .is_none_or(|(data, _)| data.width() != width || data.height() != height)
        {
            // This array is owned by JavaScript, so growing WASM memory cannot detach it.
            let pixels = Uint8ClampedArray::new_with_length(buffer.rgba.len() as u32);
            let data = ImageData::new_with_js_u8_clamped_array_and_sh(&pixels, width, height).unwrap();
            buffer.frame = Some((data, pixels));
        }
        let (data, pixels) = buffer.frame.as_ref().unwrap();
        pixels.copy_from(&buffer.rgba);
        self.context.put_image_data(data, 0.0, 0.0).unwrap();
        self.frames.fetch_add(1, Ordering::SeqCst);
    }

    fn width(&self) -> u32 {
        self.canvas.width()
    }

    fn height(&self) -> u32 {
        self.canvas.height()
    }
}
