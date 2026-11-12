// Host-side helpers: memory functions, heaps, printf-style formatting shared by host logs and guest vsnprintf.
#include "base.h"

void *memcpy(void *d, const void *s, size_t n) { return __builtin_memcpy(d, s, n); }
void *memmove(void *d, const void *s, size_t n) { return __builtin_memmove(d, s, n); }
void *memset(void *d, int c, size_t n) { return __builtin_memset(d, c, n); }
int memcmp(const void *a, const void *b, size_t n) {
  const u8 *x = a, *y = b;
  for (size_t i = 0; i < n; i++)
    if (x[i] != y[i]) return x[i] - y[i];
  return 0;
}
size_t hstrlen(const char *s) {
  size_t n = 0;
  while (s[n]) n++;
  return n;
}
int hstrcmp(const char *a, const char *b) {
  while (*a && *a == *b) { a++; b++; }
  return (u8)*a - (u8)*b;
}

// ---------------------------------------------------------------------------------------------
// Heap: segregated free lists with boundary tags. Works on offsets inside `base` so the same code
// serves the guest heap (base = G, offsets are guest addresses) and the host heap.
// Chunk layout: [u32 size|INUSE][u32 prev_size][payload...]; free chunks keep next/prev in payload.
#define NBINS 136
typedef struct {
  u8 *base;
  u32 start, top, end;
  u32 bins[NBINS];
  u32 last_size; // size of the chunk right before top
  u32 in_use;
} Heap;

static inline u32 h_rd(Heap *h, u32 o) { u32 v; __builtin_memcpy(&v, h->base + o, 4); return v; }
static inline void h_wr(Heap *h, u32 o, u32 v) { __builtin_memcpy(h->base + o, &v, 4); }

static u32 bin_of(u32 size) {
  if (size < 1024) return size >> 4;
  u32 lg = 31 - __builtin_clz(size);
  u32 idx = 64 + (lg - 10) * 4 + ((size >> (lg - 2)) & 3);
  return idx < NBINS ? idx : NBINS - 1;
}

static void bin_insert(Heap *h, u32 c, u32 size) {
  u32 b = bin_of(size);
  u32 head = h->bins[b];
  h_wr(h, c + 8, head);
  h_wr(h, c + 12, 0);
  if (head) h_wr(h, head + 12, c);
  h->bins[b] = c;
}

static void bin_remove(Heap *h, u32 c, u32 size) {
  u32 next = h_rd(h, c + 8), prev = h_rd(h, c + 12);
  if (prev) h_wr(h, prev + 8, next);
  else h->bins[bin_of(size)] = next;
  if (next) h_wr(h, next + 12, prev);
}

static void heap_init(Heap *h, u8 *base, u32 start, u32 end) {
  h->base = base;
  h->start = (start + 7) & ~7u;
  h->top = h->start;
  h->end = end & ~7u;
  h->last_size = 0;
  h->in_use = 0;
  for (int i = 0; i < NBINS; i++) h->bins[i] = 0;
}

static u32 heap_alloc(Heap *h, u32 n) {
  u32 need = (n + 8 + 7) & ~7u;
  if (need < 24) need = 24;
  for (u32 b = bin_of(need); b < NBINS; b++) {
    for (u32 c = h->bins[b]; c; c = h_rd(h, c + 8)) {
      u32 size = h_rd(h, c);
      if (size < need) continue;
      bin_remove(h, c, size);
      u32 rest = size - need;
      if (rest >= 32) {
        u32 r = c + need;
        h_wr(h, r, rest);
        h_wr(h, r + 4, need);
        u32 after = r + rest;
        if (after == h->top) h->last_size = rest;
        else h_wr(h, after + 4, rest);
        bin_insert(h, r, rest);
        size = need;
      }
      h_wr(h, c, size | 1);
      h->in_use += size;
      return c + 8;
    }
  }
  if (h->top + need > h->end) return 0;
  u32 c = h->top;
  h_wr(h, c, need | 1);
  h_wr(h, c + 4, h->last_size);
  h->top += need;
  h->last_size = need;
  h->in_use += need;
  return c + 8;
}

static void heap_free(Heap *h, u32 p) {
  if (!p) return;
  u32 c = p - 8;
  u32 size = h_rd(h, c);
  if (!(size & 1)) return; // double free: ignore
  size &= ~1u;
  h->in_use -= size;
  u32 next = c + size;
  if (next != h->top) {
    u32 ns = h_rd(h, next);
    if (!(ns & 1)) {
      bin_remove(h, next, ns);
      size += ns;
    }
  }
  if (c != h->start) {
    u32 ps = h_rd(h, c + 4);
    u32 prev = c - ps;
    u32 pv = h_rd(h, prev);
    if (!(pv & 1)) {
      bin_remove(h, prev, pv);
      c = prev;
      size += pv;
    }
  }
  if (c + size == h->top) {
    h->top = c;
    h->last_size = c == h->start ? 0 : h_rd(h, c + 4);
    return;
  }
  h_wr(h, c, size);
  h_wr(h, c + size + 4, size);
  bin_insert(h, c, size);
}

static u32 heap_size(Heap *h, u32 p) { return (h_rd(h, p - 8) & ~1u) - 8; }

static Heap guest_heap;
static Heap host_heap;
#define HOST_ARENA_SIZE (24u << 20)
static u8 host_arena[HOST_ARENA_SIZE] __attribute__((aligned(16)));

void heaps_init(void) { heap_init(&guest_heap, G, HEAP_BASE, HEAP_END); }

void *hmalloc(u32 n) {
  if (!host_heap.end) heap_init(&host_heap, host_arena, 16, HOST_ARENA_SIZE);
  u32 o = heap_alloc(&host_heap, n);
  if (!o) { logf("host heap exhausted (%u)", n); return 0; }
  return host_arena + o;
}
void hfree(void *p) {
  if (p) heap_free(&host_heap, (u32)((u8 *)p - host_arena));
}
u32 gmalloc(u32 n) {
  u32 a = heap_alloc(&guest_heap, n);
  if (!a) logf("guest heap exhausted (%u, in use %u)", n, guest_heap.in_use);
  return a;
}
void gfree(u32 a) { heap_free(&guest_heap, a); }
u32 gcalloc(u32 n) {
  u32 a = gmalloc(n);
  if (a) memset(gptr(a), 0, n);
  return a;
}
void heap_state(void *buf, int save) {
  if (save) memcpy(buf, &guest_heap, sizeof guest_heap);
  else memcpy(&guest_heap, buf, sizeof guest_heap);
}
u32 heap_state_size(void) { return sizeof guest_heap; }
u32 gmalloc_usable(u32 a) { return heap_size(&guest_heap, a); }
u32 guest_heap_in_use(void) { return guest_heap.in_use; }
u32 guest_heap_top(void) { return guest_heap.top; }

int gstrlen(u32 a) {
  int n = 0;
  while (rd8(a + n)) n++;
  return n;
}
u32 gstrdup_host(const char *s) {
  u32 n = hstrlen(s);
  u32 a = gmalloc(n + 1);
  memcpy(gptr(a), s, n + 1);
  return a;
}

// ---------------------------------------------------------------------------------------------
// Formatting. Arguments come either from host varargs or from guest memory (a va_list pointer).
typedef struct {
  int guest;
  u32 gap; // guest arg pointer
  __builtin_va_list *hap;
} ArgSrc;

static u32 arg32(ArgSrc *a) {
  if (a->guest) { u32 v = rd32(a->gap); a->gap += 4; return v; }
  return __builtin_va_arg(*a->hap, u32);
}
static u64 arg64(ArgSrc *a) {
  if (a->guest) {
    a->gap = (a->gap + 7) & ~7u;
    u64 v = (u64)rd32(a->gap) | ((u64)rd32(a->gap + 4) << 32);
    a->gap += 8;
    return v;
  }
  return __builtin_va_arg(*a->hap, u64);
}
static double argdbl(ArgSrc *a) {
  if (a->guest) { u64 v = arg64(a); double d; __builtin_memcpy(&d, &v, 8); return d; }
  return __builtin_va_arg(*a->hap, double);
}

typedef struct { char *buf; int cap; int len; } Out;
static void out_c(Out *o, char c) {
  if (o->len < o->cap - 1) o->buf[o->len] = c;
  o->len++;
}

static void out_num(Out *o, u64 v, int neg, int base, int upper, int width, int prec, int zero, int left, int plus, int space, int alt) {
  char tmp[32];
  int n = 0;
  const char *dig = upper ? "0123456789ABCDEF" : "0123456789abcdef";
  if (v == 0 && prec != 0) tmp[n++] = '0';
  while (v) { tmp[n++] = dig[v % base]; v /= base; }
  while (n < prec) tmp[n++] = '0';
  char sign = neg ? '-' : plus ? '+' : space ? ' ' : 0;
  int pre = (sign ? 1 : 0) + ((alt && base == 16) ? 2 : 0);
  int pad = width - n - pre;
  if (!left && !zero) while (pad-- > 0) out_c(o, ' ');
  if (sign) out_c(o, sign);
  if (alt && base == 16) { out_c(o, '0'); out_c(o, upper ? 'X' : 'x'); }
  if (!left && zero) while (pad-- > 0) out_c(o, '0');
  while (n) out_c(o, tmp[--n]);
  if (left) while (pad-- > 0) out_c(o, ' ');
}

static int do_format(char *buf, int cap, int guest_fmt, u32 gfmt, const char *hfmt, ArgSrc *as) {
  Out o = {buf, cap, 0};
  u32 i = 0;
#define FC(k) (guest_fmt ? (char)rd8(gfmt + (k)) : hfmt[k])
  for (;;) {
    char c = FC(i++);
    if (!c) break;
    if (c != '%') { out_c(&o, c); continue; }
    int left = 0, plus = 0, space = 0, zero = 0, alt = 0, width = 0, prec = -1, lng = 0;
    for (;;) {
      c = FC(i);
      if (c == '-') left = 1;
      else if (c == '+') plus = 1;
      else if (c == ' ') space = 1;
      else if (c == '0') zero = 1;
      else if (c == '#') alt = 1;
      else break;
      i++;
    }
    c = FC(i);
    if (c == '*') { width = (s32)arg32(as); i++; if (width < 0) { left = 1; width = -width; } }
    else while ((c = FC(i)) >= '0' && c <= '9') { width = width * 10 + (c - '0'); i++; }
    if (FC(i) == '.') {
      i++;
      prec = 0;
      c = FC(i);
      if (c == '*') { prec = (s32)arg32(as); i++; }
      else while ((c = FC(i)) >= '0' && c <= '9') { prec = prec * 10 + (c - '0'); i++; }
    }
    for (;;) {
      c = FC(i);
      if (c == 'l') lng++;
      else if (c == 'h' || c == 'z' || c == 't' || c == 'j') { if (c == 'j') lng = 2; }
      else if (c == 'q' || c == 'L') lng = 2;
      else break;
      i++;
    }
    c = FC(i++);
    if (left) zero = 0;
    switch (c) {
    case 'd':
    case 'i': {
      s64 v = lng >= 2 ? (s64)arg64(as) : (s64)(s32)arg32(as);
      int neg = v < 0;
      out_num(&o, neg ? (u64)(-v) : (u64)v, neg, 10, 0, width, prec, zero && prec < 0, left, plus, space, 0);
      break;
    }
    case 'u':
    case 'x':
    case 'X':
    case 'o': {
      u64 v = lng >= 2 ? arg64(as) : arg32(as);
      int base = c == 'u' ? 10 : c == 'o' ? 8 : 16;
      out_num(&o, v, 0, base, c == 'X', width, prec, zero && prec < 0, left, 0, 0, alt);
      break;
    }
    case 'p':
      out_num(&o, arg32(as), 0, 16, 0, width, -1, 0, left, 0, 0, 1);
      break;
    case 'c': {
      char ch = (char)arg32(as);
      int pad = width - 1;
      if (!left) while (pad-- > 0) out_c(&o, ' ');
      out_c(&o, ch);
      if (left) while (pad-- > 0) out_c(&o, ' ');
      break;
    }
    case 's': {
      u32 gs = 0;
      const char *hs = 0;
      if (as->guest || guest_fmt) gs = arg32(as);
      else hs = __builtin_va_arg(*as->hap, const char *);
      if (!gs && !hs) hs = "(null)";
      int n = 0;
      if (hs) while (hs[n] && (prec < 0 || n < prec)) n++;
      else while (rd8(gs + n) && (prec < 0 || n < prec)) n++;
      int pad = width - n;
      if (!left) while (pad-- > 0) out_c(&o, ' ');
      for (int k = 0; k < n; k++) out_c(&o, hs ? hs[k] : (char)rd8(gs + k));
      if (left) while (pad-- > 0) out_c(&o, ' ');
      break;
    }
    case 'f':
    case 'F':
    case 'g':
    case 'G':
    case 'e':
    case 'E': {
      double d = argdbl(as);
      if (prec < 0) prec = 6;
      if (prec > 9) prec = 9;
      int neg = d < 0;
      if (neg) d = -d;
      u64 scale = 1;
      for (int k = 0; k < prec; k++) scale *= 10;
      u64 whole = (u64)d;
      u64 frac = (u64)((d - (double)whole) * (double)scale + 0.5);
      if (frac >= scale) { whole++; frac -= scale; }
      char tmp[48];
      Out t = {tmp, sizeof tmp, 0};
      out_num(&t, whole, neg, 10, 0, 0, -1, 0, 0, plus, space, 0);
      if (prec > 0) { out_c(&t, '.'); out_num(&t, frac, 0, 10, 0, 0, prec, 0, 0, 0, 0, 0); }
      int n = t.len < (int)sizeof tmp ? t.len : (int)sizeof tmp - 1;
      int pad = width - n;
      if (!left) while (pad-- > 0) out_c(&o, zero ? '0' : ' ');
      for (int k = 0; k < n; k++) out_c(&o, tmp[k]);
      if (left) while (pad-- > 0) out_c(&o, ' ');
      break;
    }
    case '%': out_c(&o, '%'); break;
    case 'n': arg32(as); break;
    default:
      out_c(&o, '%');
      if (c) out_c(&o, c);
      else i--;
      break;
    }
  }
  if (cap > 0) o.buf[o.len < cap ? o.len : cap - 1] = 0;
  return o.len;
#undef FC
}

int guest_vformat(char *buf, int cap, u32 gfmt, u32 gap) {
  ArgSrc as = {1, gap, 0};
  return do_format(buf, cap, 1, gfmt, 0, &as);
}

int hsnprintf(char *buf, int cap, const char *fmt, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, fmt);
  ArgSrc as = {0, 0, &ap};
  int n = do_format(buf, cap, 0, 0, fmt, &as);
  __builtin_va_end(ap);
  return n;
}

void logf(const char *fmt, ...) {
  char buf[1024];
  __builtin_va_list ap;
  __builtin_va_start(ap, fmt);
  ArgSrc as = {0, 0, &ap};
  int n = do_format(buf, sizeof buf, 0, 0, fmt, &as);
  __builtin_va_end(ap);
  if (n > (int)sizeof buf - 1) n = sizeof buf - 1;
  host_log(buf, n);
}
