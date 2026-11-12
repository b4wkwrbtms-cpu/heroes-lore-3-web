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

static u8 *snap;
static u32 snap_cap, snap_heap_top;
static u8 host_small[400 * 1024];

static u32 snap_need(u32 heap_top) {
  return (RW_END - RW_START) + (DATA_END - DATA_BASE) + (heap_top - HEAP_BASE) + 64;
}

EXPORT(snap_save) int snap_save(void) {
  if (heap_state_size() + jni_state_size() + fs_state_size() > sizeof host_small) return -2;
  u32 top = guest_heap_top();
  u32 need = snap_need(top);
  if (need > snap_cap) {
    if (snap) hfree(snap);
    snap_cap = need + (1u << 20);
    snap = hmalloc(snap_cap);
    if (!snap) { snap_cap = 0; return -1; }
  }
  u8 *p = snap;
  memcpy(p, gptr(RW_START), RW_END - RW_START); p += RW_END - RW_START;
  memcpy(p, gptr(DATA_BASE), DATA_END - DATA_BASE); p += DATA_END - DATA_BASE;
  memcpy(p, gptr(HEAP_BASE), top - HEAP_BASE);
  snap_heap_top = top;
  u8 *h = host_small;
  heap_state(h, 1); h += heap_state_size();
  jni_state(h, 1); h += jni_state_size();
  fs_state(h, 1);
  return 0;
}

EXPORT(snap_restore) void snap_restore(void) {
  u8 *p = snap;
  memcpy(gptr(RW_START), p, RW_END - RW_START); p += RW_END - RW_START;
  memcpy(gptr(DATA_BASE), p, DATA_END - DATA_BASE); p += DATA_END - DATA_BASE;
  memcpy(gptr(HEAP_BASE), p, snap_heap_top - HEAP_BASE);
  u8 *h = host_small;
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
