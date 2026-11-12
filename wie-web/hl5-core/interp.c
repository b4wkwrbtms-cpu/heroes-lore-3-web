// In-between frames: the game draws ~20 frames a second and moves things in whole steps. To show
// frames between two game frames, the page saves the guest state, moves the camera, hero and monsters
// part of the way, lets the game draw once more, keeps that picture and restores everything.
#include "base.h"

u32 find_symbol(const char *name);
u32 guest_heap_top(void);
void heap_state(void *buf, int save);
u32 heap_state_size(void);
u32 jni_state_size(void);
void jni_state(u8 *buf, int save);
u32 fs_state_size(void);
void fs_state(u8 *buf, int save);

#define RW_START (LOAD_BASE + 0x162000u)
#define RW_END (LOAD_BASE + 0x177000u)
#define SLOTS 2
#define SMALL_SIZE (400 * 1024)

// Slot 0 holds the state as it was when the game started drawing its last frame (the page saves it from
// a watch on mainPaint: drawing advances animation counters, so only that state draws the same poses);
// slot 1 holds the live state while an in-between frame is drawn.
static struct {
  u8 *buf;
  u32 cap, heap_top;
  u8 small[SMALL_SIZE];
} slots[SLOTS];

// snapshot memory comes straight from memory.grow so it never competes with the host heap
static u8 *grow(u32 bytes) {
  int old = __builtin_wasm_memory_grow(0, (bytes + 0xffffu) >> 16);
  return old < 0 ? 0 : (u8 *)((u32)old << 16);
}

EXPORT(snap_save) int snap_save(int slot) {
  if (slot < 0 || slot >= SLOTS) return -1;
  if (heap_state_size() + jni_state_size() + fs_state_size() > SMALL_SIZE) return -2;
  u32 top = guest_heap_top();
  u32 need = (RW_END - RW_START) + (DATA_END - DATA_BASE) + (top - HEAP_BASE);
  if (need > slots[slot].cap) {
    u32 cap = need + (4u << 20);
    u8 *b = grow(cap);
    if (!b) return -1;
    slots[slot].buf = b;
    slots[slot].cap = cap;
  }
  u8 *p = slots[slot].buf;
  memcpy(p, gptr(RW_START), RW_END - RW_START); p += RW_END - RW_START;
  memcpy(p, gptr(DATA_BASE), DATA_END - DATA_BASE); p += DATA_END - DATA_BASE;
  memcpy(p, gptr(HEAP_BASE), top - HEAP_BASE);
  slots[slot].heap_top = top;
  u8 *h = slots[slot].small;
  heap_state(h, 1); h += heap_state_size();
  jni_state(h, 1); h += jni_state_size();
  fs_state(h, 1);
  return 0;
}

EXPORT(snap_restore) void snap_restore(int slot) {
  if (slot < 0 || slot >= SLOTS || !slots[slot].buf) return;
  u8 *p = slots[slot].buf;
  memcpy(gptr(RW_START), p, RW_END - RW_START); p += RW_END - RW_START;
  memcpy(gptr(DATA_BASE), p, DATA_END - DATA_BASE); p += DATA_END - DATA_BASE;
  memcpy(gptr(HEAP_BASE), p, slots[slot].heap_top - HEAP_BASE);
  u8 *h = slots[slot].small;
  heap_state(h, 0); h += heap_state_size();
  jni_state(h, 0); h += jni_state_size();
  fs_state(h, 0);
}

// Draws the current game state into its back buffer and copies it, RGB565, to `out` (stride in pixels).
EXPORT(paint_only) int paint_only(u16 *out, u32 out_stride, u32 out_h) {
  static u32 paint, get_fb;
  if (!paint) { paint = find_symbol("_Z9mainPaintv"); get_fb = find_symbol("_ZN7Graphic5GetFBEv"); }
  if (!paint || !get_fb || cpu_halt) return -1;
  call_guest(paint, 0, 0);
  u32 graphic = rd32(LOAD_BASE + 0x16fcc8);
  u32 fb = call_guest(get_fb, 1, &graphic);
  if (cpu_halt || !fb) return -1;
  u32 w = rd32(fb), h = rd32(fb + 4), bpl = rd32(fb + 8), bpp = rd32(fb + 0xc), data = rd32(fb + 0x10);
  if (bpp != 16) return -1;
  if (w > out_stride) w = out_stride;
  if (h > out_h) h = out_h;
  for (u32 y = 0; y < h; y++) memcpy(out + y * out_stride, gptr(data + y * bpl), w * 2);
  return 0;
}
