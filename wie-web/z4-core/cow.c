// Copy-on-write page logs for the in-between frames (motion.c). While a log is active (cow_on), the first
// write to each 4 KiB page of guest memory copies the page into the log; cow_restore puts every logged
// page back, which undoes everything written since cow_begin. Guest stores go through wr8/wr16/wr32 and
// host code that writes guest memory asks for gwptr, so both are seen.
#include "base.h"

u32 cow_on;
u32 cow_bits[GUEST_SIZE >> 17];

#define PAGE 4096u
#define CHUNK_PAGES 256u // 1 MiB
#define MAX_PAGES (GUEST_SIZE / PAGE)
#define MAX_CHUNKS (MAX_PAGES / CHUNK_PAGES)
typedef struct {
  u32 n, overflow;
  u32 page[MAX_PAGES];
  u8 *chunk[MAX_CHUNKS];
} CowLog;
static CowLog logs[2];
static CowLog *active;

static u8 *grow_bytes(u32 bytes) {
#ifdef NATIVE
  void *malloc(size_t);
  return malloc(bytes);
#else
  int old = __builtin_wasm_memory_grow(0, (bytes + 0xffffu) >> 16);
  return old < 0 ? 0 : (u8 *)((u32)old << 16);
#endif
}

static u8 *slot(CowLog *l, u32 i) {
  u8 **c = &l->chunk[i / CHUNK_PAGES];
  if (!*c) *c = grow_bytes(CHUNK_PAGES * PAGE);
  return *c ? *c + (i % CHUNK_PAGES) * PAGE : 0;
}

void cow_save_page(u32 p) {
  cow_bits[p >> 5] |= 1u << (p & 31);
  CowLog *l = active;
  if (!l) return;
  u8 *d = l->n < MAX_PAGES ? slot(l, l->n) : 0;
  if (!d) { l->overflow = 1; return; }
  memcpy(d, G + p * PAGE, PAGE);
  l->page[l->n++] = p;
}

void cow_range(u32 a, u32 n) {
  if (!n) return;
  u32 first = (a & GUEST_MASK) >> 12, last = ((a + n - 1) & GUEST_MASK) >> 12;
  for (u32 p = first;; p = (p + 1) & (MAX_PAGES - 1)) {
    if (!(cow_bits[p >> 5] & (1u << (p & 31)))) cow_save_page(p);
    if (p == last) break;
  }
}

void cow_begin(int log) {
  memset(cow_bits, 0, sizeof cow_bits);
  active = &logs[log];
  active->n = 0;
  active->overflow = 0;
  cow_on = 1;
}
void cow_end(void) {
  cow_on = 0;
  active = 0;
}
int cow_ok(int log) { return !logs[log].overflow; }
u32 cow_pages(int log) { return logs[log].n; }

// puts the pages of `log` back into guest memory (the log keeps them)
void cow_restore(int log) {
  CowLog *l = &logs[log];
  for (u32 i = 0; i < l->n; i++) memcpy(G + l->page[i] * PAGE, slot(l, i), PAGE);
}

// with another log active: writes the pages of `log` into guest memory, the active log saving what
// they replace first
void cow_rewind(int log) {
  CowLog *l = &logs[log];
  for (u32 i = 0; i < l->n; i++) {
    u32 p = l->page[i];
    if (!(cow_bits[p >> 5] & (1u << (p & 31)))) cow_save_page(p);
    memcpy(G + p * PAGE, slot(l, i), PAGE);
  }
}
