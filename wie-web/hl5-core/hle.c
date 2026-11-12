// ELF loader, imported libc/libm/liblog/GLES functions and the entry points the page drives.
#include "base.h"

void heaps_init(void);
int guest_vformat(char *buf, int cap, u32 gfmt, u32 gap);
int jni_dispatch(u32 trap);
void jni_init(u32 (*data_alloc)(u32));
void jni_end_frame(void);
u32 jni_new_string(const char *s);
u32 jni_this_object(void);
u32 jni_fd_object(int fd);
extern u32 jni_env_addr;
extern u32 guest_errno_addr;
extern u32 call_ret_hi;
extern int trace_java;
u32 gmalloc_usable(u32 a);
u32 guest_heap_in_use(void);
u32 guest_heap_top(void);
int fs_open(u32 gpath, int flags);
int fs_close(int fd);
int fs_read(int fd, u32 buf, u32 len);
int fs_write(int fd, u32 buf, u32 len);
s64 fs_lseek(int fd, s64 off, int whence);
int fs_dup(int fd);
int fs_stat(u32 gpath, u32 st);
int fs_access(u32 gpath);
int fs_mkdir(u32 gpath);
int fs_unlink(u32 gpath, int dir);
int fs_rename(u32 from, u32 to);
int fs_open_external(const char *path);

static u32 data_top = DATA_BASE;
static u32 data_alloc(u32 n) {
  u32 a = (data_top + 7) & ~7u;
  data_top = a + n;
  memset(gptr(a), 0, n);
  return a;
}
static u32 data_str(const char *s) {
  u32 n = hstrlen(s) + 1;
  u32 a = data_alloc(n);
  memcpy(gptr(a), s, n);
  return a;
}

static inline u32 arg(int i) { return i < 4 ? R[i] : rd32(R[13] + (i - 4) * 4); }
static inline double arg_dbl(int i) {
  u64 v = (u64)arg(i) | ((u64)arg(i + 1) << 32);
  double d;
  __builtin_memcpy(&d, &v, 8);
  return d;
}
static inline void ret_dbl(double d) {
  u64 v;
  __builtin_memcpy(&v, &d, 8);
  R[0] = (u32)v;
  R[1] = (u32)(v >> 32);
}
static inline float arg_flt(int i) {
  u32 v = arg(i);
  float f;
  __builtin_memcpy(&f, &v, 4);
  return f;
}

// =============================================================================================
// GLES 1.x: the Midas kernel renders in software and uploads the WIPI LCD into a texture.
#define MAX_TEX 16
typedef struct {
  int used;
  u32 w, h, bpp, format, type;
  u8 *data;
} Tex;
static Tex tex[MAX_TEX];
static u32 bound_tex;
static u32 vtx_ptr, vtx_type, vtx_size, tc_ptr, tc_type, tc_size;

typedef struct {
  u32 data, w, h, bpp, format, type, counter, draws;
  float u0, v0, u1, v1;
  float x0, y0, x1, y1;
  u32 uploads;
} FrameInfo;
static FrameInfo frame;

static u32 bpp_of(u32 format, u32 type) {
  if (type == 0x8363 || type == 0x8033 || type == 0x8034) return 2;
  if (format == 0x1907) return 3;
  if (format == 0x1908) return 4;
  return 1;
}

static void read_vec2(u32 ptr, u32 type, u32 size, int i, float *x, float *y) {
  if (type == 0x1406) { // GL_FLOAT
    u32 a = rd32(ptr + i * size * 4), b = rd32(ptr + i * size * 4 + 4);
    __builtin_memcpy(x, &a, 4);
    __builtin_memcpy(y, &b, 4);
  } else if (type == 0x140C) { // GL_FIXED
    *x = (s32)rd32(ptr + i * size * 4) / 65536.0f;
    *y = (s32)rd32(ptr + i * size * 4 + 4) / 65536.0f;
  } else { // GL_SHORT
    *x = (s16)rd16(ptr + i * size * 2);
    *y = (s16)rd16(ptr + i * size * 2 + 2);
  }
}

static void gl_tex_image(void) {
  u32 w = R[3], h = arg(4), format = arg(6), type = arg(7), pixels = arg(8);
  if (arg(1) != 0) return; // mip levels are not used for presentation
  if (!bound_tex || bound_tex >= MAX_TEX) return;
  Tex *t = &tex[bound_tex];
  u32 bpp = bpp_of(format, type);
  if (t->data && (t->w != w || t->h != h || t->bpp != bpp)) { hfree(t->data); t->data = 0; }
  if (!t->data) t->data = hmalloc(w * h * bpp);
  t->w = w; t->h = h; t->bpp = bpp; t->format = format; t->type = type;
  if (pixels) memcpy(t->data, gptr(pixels), w * h * bpp);
  else memset(t->data, 0, w * h * bpp);
  logf("glTexImage2D tex=%u %ux%u fmt=%x type=%x", bound_tex, w, h, format, type);
}

static void gl_tex_sub_image(void) {
  u32 xo = R[2], yo = R[3], w = arg(4), h = arg(5), pixels = arg(8);
  if (!bound_tex || bound_tex >= MAX_TEX) return;
  Tex *t = &tex[bound_tex];
  if (!t->data || !pixels) return;
  u32 bpp = t->bpp;
  u32 stride = (w * bpp + 3) & ~3u;
  for (u32 y = 0; y < h && yo + y < t->h; y++) {
    u32 n = w;
    if (xo + n > t->w) n = t->w - xo;
    memcpy(t->data + ((yo + y) * t->w + xo) * bpp, gptr(pixels + y * stride), n * bpp);
  }
  frame.uploads++;
}

static void gl_draw_arrays(void) {
  u32 count = R[2], first = R[1];
  if (!bound_tex || bound_tex >= MAX_TEX || !tex[bound_tex].data) return;
  Tex *t = &tex[bound_tex];
  frame.data = (u32)t->data;
  frame.w = t->w; frame.h = t->h; frame.bpp = t->bpp; frame.format = t->format; frame.type = t->type;
  frame.draws++;
  if (count >= 4 && vtx_ptr && tc_ptr) {
    float minx = 1e9f, miny = 1e9f, maxx = -1e9f, maxy = -1e9f, minu = 1e9f, minv = 1e9f, maxu = -1e9f, maxv = -1e9f;
    for (u32 i = first; i < first + count; i++) {
      float x, y, u, v;
      read_vec2(vtx_ptr, vtx_type, vtx_size, i, &x, &y);
      read_vec2(tc_ptr, tc_type, tc_size, i, &u, &v);
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (u < minu) minu = u; if (u > maxu) maxu = u; if (v < minv) minv = v; if (v > maxv) maxv = v;
    }
    frame.x0 = minx; frame.y0 = miny; frame.x1 = maxx; frame.y1 = maxy;
    frame.u0 = minu; frame.v0 = minv; frame.u1 = maxu; frame.v1 = maxv;
  }
  frame.counter++;
}

// =============================================================================================
// Imports
typedef void (*Hle)(void);
static void f_unimpl(void);

static u32 stack_guard_addr;
static u32 exidx_start, exidx_count;
static u32 file_struct(int fd) {
  u32 f = gcalloc(16);
  wr32(f, 0x454c4946);
  wr32(f + 4, (u32)fd);
  return f;
}

static void f_malloc(void) { R[0] = gmalloc(R[0]); }
static void f_calloc(void) { R[0] = gcalloc(R[0] * R[1]); }
static void f_free(void) { gfree(R[0]); }
static void f_memcpy(void) { memmove(gptr(R[0]), gptr(R[1]), R[2]); }
static void f_memmove(void) { memmove(gptr(R[0]), gptr(R[1]), R[2]); }
static void f_memset(void) { memset(gptr(R[0]), (int)R[1], R[2]); }
static void f_strlen(void) { R[0] = (u32)gstrlen(R[0]); }
static void f_strcmp(void) {
  u32 a = R[0], b = R[1];
  for (;;) {
    u8 x = rd8(a++), y = rd8(b++);
    if (x != y || !x) { R[0] = (u32)(x - y); return; }
  }
}
static void f_strncmp(void) {
  u32 a = R[0], b = R[1], n = R[2];
  for (u32 i = 0; i < n; i++) {
    u8 x = rd8(a + i), y = rd8(b + i);
    if (x != y || !x) { R[0] = (u32)(x - y); return; }
  }
  R[0] = 0;
}
static void f_strcpy(void) {
  u32 d = R[0], s = R[1];
  u8 c;
  do { c = rd8(s++); wr8(d++, c); } while (c);
}
static void f_strncpy(void) {
  u32 d = R[0], s = R[1], n = R[2];
  u32 i = 0;
  for (; i < n; i++) { u8 c = rd8(s + i); wr8(d + i, c); if (!c) break; }
  for (; i < n; i++) wr8(d + i, 0);
}
static void f_strcat(void) {
  u32 d = R[0] + gstrlen(R[0]), s = R[1];
  u8 c;
  do { c = rd8(s++); wr8(d++, c); } while (c);
}
static void f_strstr(void) {
  u32 h = R[0], n = R[1];
  int nl = gstrlen(n);
  if (!nl) return;
  for (u32 p = h; rd8(p); p++) {
    int k = 0;
    while (k < nl && rd8(p + k) == rd8(n + k)) k++;
    if (k == nl) { R[0] = p; return; }
  }
  R[0] = 0;
}
static void f_strdup(void) {
  int n = gstrlen(R[0]);
  u32 a = gmalloc(n + 1);
  memcpy(gptr(a), gptr(R[0]), n + 1);
  R[0] = a;
}
static u32 strerror_str;
static void f_strerror(void) { R[0] = strerror_str; }
static void f_errno(void) { R[0] = guest_errno_addr; }
static void f_abort(void) { logf("guest abort() lr=%08x", R[14]); cpu_halt = 1; }
static void f_stack_chk_fail(void) { logf("stack check failed lr=%08x", R[14]); cpu_halt = 1; }
static void f_vsnprintf(void) {
  char tmp[4096];
  int n = guest_vformat(tmp, sizeof tmp, R[2], R[3]);
  u32 cap = R[1];
  if (cap) {
    u32 m = (u32)n < cap - 1 ? (u32)n : cap - 1;
    if (m > sizeof tmp - 1) m = sizeof tmp - 1;
    memcpy(gptr(R[0]), tmp, m);
    wr8(R[0] + m, 0);
  }
  R[0] = (u32)n;
}
int log_enabled = 1;
static void f_android_log_print(void) {
  // (prio, tag, fmt, ...) - varargs start at r3
  u32 base = R[13] - 16;
  for (int i = 0; i < 4; i++) wr32(base + i * 4, R[i]);
  if (log_enabled) {
    char tmp[1024];
    int n = guest_vformat(tmp, sizeof tmp, R[2], base + 12);
    if (n > (int)sizeof tmp - 1) n = sizeof tmp - 1;
    while (n > 0 && (tmp[n - 1] == '\n' || tmp[n - 1] == '\r')) n--;
    host_log(tmp, n);
  }
  R[0] = 1;
}
static void f_ceil(void) { ret_dbl(__builtin_ceil(arg_dbl(0))); }
static void f_floor(void) { ret_dbl(__builtin_floor(arg_dbl(0))); }
static void f_pow(void) { ret_dbl(host_pow(arg_dbl(0), arg_dbl(2))); }
static void f_ftime(void) {
  double now = host_now();
  u64 ms = (u64)now;
  wr32(R[0], (u32)(ms / 1000));
  wr16(R[0] + 4, (u16)(ms % 1000));
  wr16(R[0] + 6, (u16)(-540));
  wr16(R[0] + 8, 0);
  R[0] = 0;
}
static void f_zero(void) { R[0] = 0; }
static void f_minus_one(void) {
  wr32(guest_errno_addr, 101); // ENETUNREACH
  R[0] = (u32)-1;
}
static void f_inet_addr(void) {
  u32 p = R[0], v = 0, part = 0, shift = 0;
  for (;;) {
    u8 c = rd8(p++);
    if (c >= '0' && c <= '9') part = part * 10 + (c - '0');
    else {
      v |= (part & 0xff) << shift;
      shift += 8;
      part = 0;
      if (c != '.') break;
    }
  }
  R[0] = v;
}
static void f_open(void) { R[0] = (u32)fs_open(R[0], (int)R[1]); }
static void f_close(void) { R[0] = (u32)fs_close((int)R[0]); }
static void f_read(void) { R[0] = (u32)fs_read((int)R[0], R[1], R[2]); }
static void f_write(void) { R[0] = (u32)fs_write((int)R[0], R[1], R[2]); }
static void f_lseek(void) { R[0] = (u32)fs_lseek((int)R[0], (s32)R[1], (int)R[2]); }
static void f_dup(void) { R[0] = (u32)fs_dup((int)R[0]); }
static void f_stat(void) { R[0] = (u32)fs_stat(R[0], R[1]); }
static void f_access(void) { R[0] = (u32)fs_access(R[0]); }
static void f_mkdir(void) { R[0] = (u32)fs_mkdir(R[0]); }
static void f_rmdir(void) { R[0] = (u32)fs_unlink(R[0], 1); }
static void f_unlink(void) { R[0] = (u32)fs_unlink(R[0], 0); }
static void f_rename(void) { R[0] = (u32)fs_rename(R[0], R[1]); }
static void f_fdopen(void) { R[0] = file_struct((int)R[0]); }
static void f_fread(void) {
  u32 size = R[1], n = R[2];
  int fd = (int)rd32(R[3] + 4);
  if (!size || !n) { R[0] = 0; return; }
  int got = fs_read(fd, R[0], size * n);
  R[0] = got <= 0 ? 0 : (u32)got / size;
  if (got >= 0 && (u32)got < size * n) wr32(R[3] + 8, 1);
}
static void f_fseek(void) {
  int fd = (int)rd32(R[0] + 4);
  s64 r = fs_lseek(fd, (s32)R[1], (int)R[2]);
  wr32(R[0] + 8, 0);
  R[0] = r < 0 ? (u32)-1 : 0;
}
static void f_fclose(void) {
  int fd = (int)rd32(R[0] + 4);
  gfree(R[0]);
  R[0] = (u32)fs_close(fd);
}
static void f_qsort(void) {
  u32 base = R[0], n = R[1], size = R[2], cmp = R[3];
  if (n < 2 || !size) return;
  u8 *tmp = hmalloc(size);
  // insertion sort for small arrays, shell sort otherwise; comparisons call back into the guest
  u32 gaps[] = {701, 301, 132, 57, 23, 10, 4, 1};
  for (int g = 0; g < 8; g++) {
    u32 gap = gaps[g];
    if (gap >= n) continue;
    for (u32 i = gap; i < n; i++) {
      memcpy(tmp, gptr(base + i * size), size);
      u32 j = i;
      u32 tmpg = gmalloc(size);
      memcpy(gptr(tmpg), tmp, size);
      while (j >= gap) {
        u32 args[2] = {base + (j - gap) * size, tmpg};
        s32 c = (s32)call_guest(cmp, 2, args);
        if (cpu_halt || c <= 0) break;
        memcpy(gptr(base + j * size), gptr(base + (j - gap) * size), size);
        j -= gap;
      }
      memcpy(gptr(base + j * size), tmp, size);
      gfree(tmpg);
    }
  }
  hfree(tmp);
}
static void f_unwind_find_exidx(void) {
  wr32(R[1], exidx_count);
  R[0] = exidx_start;
}
static void f_cxa(void) { logf("C++ exception runtime called lr=%08x", R[14]); cpu_halt = 1; }

static void f_glGenTextures(void) {
  for (u32 i = 0; i < R[0]; i++) {
    u32 id = 0;
    for (u32 k = 1; k < MAX_TEX; k++)
      if (!tex[k].used) { id = k; break; }
    if (id) tex[id].used = 1;
    wr32(R[1] + i * 4, id);
  }
}
static void f_glDeleteTextures(void) {
  for (u32 i = 0; i < R[0]; i++) {
    u32 id = rd32(R[1] + i * 4);
    if (id && id < MAX_TEX) {
      if (tex[id].data) hfree(tex[id].data);
      memset(&tex[id], 0, sizeof tex[id]);
    }
  }
}
static void f_glBindTexture(void) { bound_tex = R[1]; }
static void f_glTexImage2D(void) { gl_tex_image(); }
static void f_glTexSubImage2D(void) { gl_tex_sub_image(); }
static void f_glDrawArrays(void) { gl_draw_arrays(); }
static void f_glVertexPointer(void) { vtx_size = R[0]; vtx_type = R[1]; vtx_ptr = R[3]; }
static void f_glTexCoordPointer(void) { tc_size = R[0]; tc_type = R[1]; tc_ptr = R[3]; }
static void f_glViewport(void) { logf("glViewport %d %d %d %d", R[0], R[1], R[2], R[3]); }
static void f_glOrthof(void) {
  logf("glOrthof %d %d %d %d", (int)arg_flt(0), (int)arg_flt(1), (int)arg_flt(2), (int)arg_flt(3));
}
static void f_gl_ignore(void) {}

typedef struct {
  const char *name;
  Hle fn;
} ImportDef;

static const ImportDef import_defs[] = {
    {"malloc", f_malloc}, {"calloc", f_calloc}, {"free", f_free}, {"memcpy", f_memcpy}, {"memmove", f_memmove},
    {"memset", f_memset}, {"strlen", f_strlen}, {"strcmp", f_strcmp}, {"strncmp", f_strncmp}, {"strcpy", f_strcpy},
    {"strncpy", f_strncpy}, {"strcat", f_strcat}, {"strstr", f_strstr}, {"strdup", f_strdup},
    {"strerror", f_strerror}, {"__errno", f_errno}, {"abort", f_abort}, {"__stack_chk_fail", f_stack_chk_fail},
    {"vsnprintf", f_vsnprintf}, {"__android_log_print", f_android_log_print}, {"ceil", f_ceil}, {"floor", f_floor},
    {"pow", f_pow}, {"ftime", f_ftime}, {"pthread_mutex_lock", f_zero}, {"pthread_mutex_unlock", f_zero},
    {"select", f_zero}, {"fcntl", f_zero}, {"chdir", f_zero}, {"socket", f_minus_one}, {"connect", f_minus_one},
    {"recv", f_minus_one}, {"getsockopt", f_minus_one}, {"setsockopt", f_minus_one}, {"shutdown", f_zero},
    {"inet_addr", f_inet_addr}, {"open", f_open}, {"close", f_close}, {"read", f_read}, {"write", f_write},
    {"lseek", f_lseek}, {"dup", f_dup}, {"stat", f_stat}, {"access", f_access}, {"mkdir", f_mkdir},
    {"rmdir", f_rmdir}, {"unlink", f_unlink}, {"rename", f_rename}, {"fdopen", f_fdopen}, {"fread", f_fread},
    {"fseek", f_fseek}, {"fclose", f_fclose}, {"qsort", f_qsort}, {"__gnu_Unwind_Find_exidx", f_unwind_find_exidx},
    {"__cxa_begin_cleanup", f_cxa}, {"__cxa_call_unexpected", f_cxa}, {"__cxa_type_match", f_cxa},
    {"glGenTextures", f_glGenTextures}, {"glDeleteTextures", f_glDeleteTextures}, {"glBindTexture", f_glBindTexture},
    {"glTexImage2D", f_glTexImage2D}, {"glTexSubImage2D", f_glTexSubImage2D}, {"glDrawArrays", f_glDrawArrays},
    {"glVertexPointer", f_glVertexPointer}, {"glTexCoordPointer", f_glTexCoordPointer}, {"glViewport", f_glViewport},
    {"glOrthof", f_glOrthof}, {"glColor4f", f_gl_ignore}, {"glCullFace", f_gl_ignore}, {"glDisable", f_gl_ignore},
    {"glEnable", f_gl_ignore}, {"glDisableClientState", f_gl_ignore}, {"glEnableClientState", f_gl_ignore},
    {"glLoadIdentity", f_gl_ignore}, {"glMatrixMode", f_gl_ignore}, {"glTexParameterf", f_gl_ignore},
};
#define NIMPORT_DEFS (sizeof import_defs / sizeof import_defs[0])

// trap index -> handler for imports
#define MAX_IMPORTS 512
static Hle import_fn[MAX_IMPORTS];
static const char *import_name[MAX_IMPORTS];
static int nimports;

static const char *unimpl_name;
static void f_unimpl(void) {
  logf("unimplemented import %s called from %08x", unimpl_name ? unimpl_name : "?", R[14]);
  R[0] = 0;
}

static u32 import_calls[MAX_IMPORTS];
int trace_imports;
EXPORT(dump_import_calls) void dump_import_calls(void) {
  for (int i = 0; i < nimports; i++)
    if (import_calls[i]) { logf("  %s: %u", import_name[i], import_calls[i]); import_calls[i] = 0; }
}
EXPORT(set_trace_imports) void set_trace_imports(int on) { trace_imports = on; }

void hle_dispatch(u32 index) {
  if (index < (u32)nimports) {
    import_calls[index]++;
    if (trace_imports) logf("-> %s(%x, %x, %x, %x) lr=%08x", import_name[index], R[0], R[1], R[2], R[3], R[14]);
    if (import_fn[index] == f_unimpl) unimpl_name = import_name[index];
    import_fn[index]();
    return;
  }
  if (jni_dispatch(index)) return;
  logf("bad trap %u from %08x", index, R[14]);
  cpu_halt = 1;
}

// =============================================================================================
// ELF loading
static u32 dynsym, dynstr, nsyms;

static const char *sym_name_host(u32 i, char *buf, int cap) {
  u32 off = rd32(dynsym + i * 16);
  int k = 0;
  for (; k < cap - 1; k++) {
    buf[k] = (char)rd8(dynstr + off + k);
    if (!buf[k]) break;
  }
  buf[k] = 0;
  return buf;
}

static u32 resolve_import(const char *name) {
  if (!hstrcmp(name, "__stack_chk_guard")) return stack_guard_addr;
  for (int i = 0; i < nimports; i++)
    if (!hstrcmp(import_name[i], name)) return TRAP_BASE + i * 4;
  if (nimports >= MAX_IMPORTS) return 0;
  int idx = nimports++;
  int n = hstrlen(name);
  char *copy = hmalloc(n + 1);
  memcpy(copy, name, n + 1);
  import_name[idx] = copy;
  import_fn[idx] = f_unimpl;
  for (u32 k = 0; k < NIMPORT_DEFS; k++)
    if (!hstrcmp(import_defs[k].name, name)) { import_fn[idx] = import_defs[k].fn; break; }
  if (import_fn[idx] == f_unimpl) logf("import without implementation: %s", name);
  return TRAP_BASE + idx * 4;
}

EXPORT(find_symbol) u32 find_symbol(const char *name) {
  char buf[128];
  for (u32 i = 1; i < nsyms; i++) {
    if (rd16(dynsym + i * 16 + 14) == 0) continue;
    if (!hstrcmp(sym_name_host(i, buf, sizeof buf), name)) return LOAD_BASE + rd32(dynsym + i * 16 + 4);
  }
  return 0;
}

static u32 init_array, init_array_sz;

EXPORT(load_library) int load_library(const u8 *elf, u32 len) {
  heaps_init();
  guest_errno_addr = data_alloc(4);
  stack_guard_addr = data_alloc(4);
  wr32(stack_guard_addr, 0x5a17c0de);
  strerror_str = data_str("I/O error");
  jni_init(data_alloc);
  R[13] = STACK_TOP;

  u32 phoff, phnum;
  __builtin_memcpy(&phoff, elf + 28, 4);
  phnum = *(const u16 *)(elf + 44);
  u32 dyn = 0;
  for (u32 i = 0; i < phnum; i++) {
    const u8 *ph = elf + phoff + i * 32;
    u32 type, off, vaddr, filesz, memsz;
    __builtin_memcpy(&type, ph, 4);
    __builtin_memcpy(&off, ph + 4, 4);
    __builtin_memcpy(&vaddr, ph + 8, 4);
    __builtin_memcpy(&filesz, ph + 16, 4);
    __builtin_memcpy(&memsz, ph + 20, 4);
    if (type == 1) {
      memcpy(gptr(LOAD_BASE + vaddr), elf + off, filesz);
      memset(gptr(LOAD_BASE + vaddr + filesz), 0, memsz - filesz);
    } else if (type == 2) {
      dyn = LOAD_BASE + vaddr;
    } else if (type == 0x70000001) {
      exidx_start = LOAD_BASE + vaddr;
      exidx_count = filesz / 8;
    }
  }
  u32 rel = 0, relsz = 0, jmprel = 0, pltrelsz = 0, hash = 0;
  for (u32 d = dyn;; d += 8) {
    u32 tag = rd32(d), val = rd32(d + 4);
    if (!tag) break;
    switch (tag) {
    case 4: hash = LOAD_BASE + val; break;
    case 5: dynstr = LOAD_BASE + val; break;
    case 6: dynsym = LOAD_BASE + val; break;
    case 17: rel = LOAD_BASE + val; break;
    case 18: relsz = val; break;
    case 23: jmprel = LOAD_BASE + val; break;
    case 2: pltrelsz = val; break;
    case 25: init_array = LOAD_BASE + val; break;
    case 27: init_array_sz = val; break;
    }
  }
  nsyms = hash ? rd32(hash + 4) : 0;
  u32 tables[2][2] = {{rel, relsz}, {jmprel, pltrelsz}};
  int unresolved = 0;
  for (int t = 0; t < 2; t++) {
    for (u32 r = tables[t][0]; r < tables[t][0] + tables[t][1]; r += 8) {
      u32 off = rd32(r), info = rd32(r + 4);
      u32 type = info & 0xff, sym = info >> 8;
      u32 P = LOAD_BASE + off;
      u32 S = 0;
      if (sym) {
        u32 shndx = rd16(dynsym + sym * 16 + 14);
        if (shndx) S = LOAD_BASE + rd32(dynsym + sym * 16 + 4);
        else {
          char buf[128];
          S = resolve_import(sym_name_host(sym, buf, sizeof buf));
          if (!S) unresolved++;
        }
      }
      switch (type) {
      case 23: wr32(P, rd32(P) + LOAD_BASE); break; // RELATIVE
      case 2: wr32(P, rd32(P) + S); break;          // ABS32
      case 21:
      case 22: wr32(P, S); break; // GLOB_DAT, JUMP_SLOT
      default: logf("unsupported relocation %u", type); break;
      }
    }
  }
  logf("loaded: %u symbols, %d imports, %d unresolved, init_array %u", nsyms, nimports, unresolved, init_array_sz / 4);
  for (u32 i = 0; i < init_array_sz / 4; i++) {
    u32 f = rd32(init_array + i * 4);
    if (f && f != 0xffffffff) call_guest(f, 0, 0);
  }
  return cpu_halt ? -1 : 0;
}

// =============================================================================================
// Native replacements for hot guest routines. Each one reproduces the original routine's
// observable behaviour (including its clipping quirks) and is entered by patching a branch at
// the routine's first instruction.
static u32 midas_pixel_blend(u32 dst, u32 src, u32 a) {
  u32 ia = 255 - a;
  u32 g = (src & 0x7e0) * a + (dst & 0x7e0) * ia;
  u32 r = (src & 0xf800) * a + (dst & 0xf800) * ia;
  u32 b = (src & 31) * a + (dst & 31) * ia;
  return ((g >> 8) & 0x7e0) | ((r >> 8) & 0xf800) | ((b << 19) >> 27);
}

// void internalGrpCopyFrameBuffer(MC_GrpFrameBuffer dst, int dx, int dy, int w, int h,
//                                 MC_GrpFrameBuffer src, int sx, int sy, MC_GrpContext *gc, u8 useKey)
// frame buffer: {width, height, bytes per line, bits per pixel, data}
static void hle_copy_frame_buffer(void) {
  u32 dst = R[0];
  s32 dx = (s32)R[1], dy = (s32)R[2], w = (s32)R[3];
  s32 h = (s32)arg(4);
  u32 src = arg(5);
  s32 sx = (s32)arg(6), sy = (s32)arg(7);
  u32 gc = arg(8);
  u32 use_key = arg(9) & 0xff;
  s32 dbpp = (s32)rd32(dst + 0xc);
  if (sx < 0) { w += sx; sx = 0; }
  if (sy < 0) { w += sy; sy = 0; }
  s32 dW = (s32)rd32(dst), dH = (s32)rd32(dst + 4);
  if (w + dx > dW) w = dW - dx;
  if (h + dy > dH) h = dH - dy;
  if (h <= 0 || (dbpp != 16 && dbpp != 32)) return;
  s32 sW = (s32)rd32(src), sH = (s32)rd32(src + 4);
  u32 sbpl = rd32(src + 8), sdata = rd32(src + 0x10);
  u32 dbpl = rd32(dst + 8), ddata = rd32(dst + 0x10);
  s32 cx1 = (s32)rd32(gc + 4), cy1 = (s32)rd32(gc + 8), cx2 = (s32)rd32(gc + 0xc), cy2 = (s32)rd32(gc + 0x10);
  u32 key = rd32(gc + 0x1c);
  s32 alpha = (s32)rd32(gc + 0x20);
  u32 op = rd32(gc + 0x2c), opparam = rd32(gc + 0x30);
  for (s32 i = 0; i < h; i++, sy++) {
    s32 y = dy + i;
    if (sy < 0 || sy >= sH || y < 0 || y >= dH || y < cy1 || y >= cy2) continue;
    u32 srow = sdata + sbpl * (u32)sy, drow = ddata + dbpl * (u32)y;
    s32 j0 = 0, j1 = w;
    // the per-pixel tests of the original reduce to one x range
    if (j0 < -sx) j0 = -sx;
    if (j0 < -dx) j0 = -dx;
    if (j0 < cx1 - dx) j0 = cx1 - dx;
    if (j1 > sW - sx) j1 = sW - sx;
    if (j1 > dW - dx) j1 = dW - dx;
    if (j1 > cx2 - dx) j1 = cx2 - dx;
    if (dbpp == 16) {
      if (!use_key && alpha > 254 && !op && j1 > j0 && sdata != ddata) {
        memmove(gptr(drow + (u32)(dx + j0) * 2), gptr(srow + (u32)(sx + j0) * 2), (u32)(j1 - j0) * 2);
        continue;
      }
      for (s32 j = j0; j < j1; j++) {
        u32 v = rd16(srow + (u32)(sx + j) * 2);
        if (use_key && v == key) continue;
        u32 da = drow + (u32)(dx + j) * 2;
        if (alpha <= 254) v = midas_pixel_blend(rd16(da), v, (u32)alpha);
        if (op) {
          u32 a[3] = {rd16(da), v, opparam};
          v = call_guest(op, 3, a);
        }
        wr16(da, (u16)v);
      }
    } else {
      for (s32 j = j0; j < j1; j++) {
        u32 v = rd32(srow + (u32)(sx + j) * 4);
        if (use_key && v == key) continue;
        u32 da = drow + (u32)(dx + j) * 4;
        if (alpha <= 254) v = midas_pixel_blend(rd32(da), v, (u32)alpha);
        if (op) {
          u32 a[3] = {rd32(da), v, opparam};
          v = call_guest(op, 3, a);
        }
        wr32(da, v);
      }
    }
  }
}

// void MC_grpFillRect(MC_GrpFrameBuffer dst, int x, int y, int w, int h, MC_GrpContext *gc)
static void hle_fill_rect(void) {
  u32 fb = R[0];
  s32 x = (s32)R[1], y = (s32)R[2], w = (s32)R[3];
  s32 h = (s32)arg(4);
  u32 gc = arg(5);
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  s32 bpp = (s32)rd32(fb + 0xc), fbH = (s32)rd32(fb + 4), fbW = (s32)rd32(fb);
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  s32 y2 = h + y, x2 = w + x;
  if (y2 >= fbH) y2 = fbH;
  if (x2 >= fbW) x2 = fbW;
  if (bpp != 16 && bpp != 32) return;
  s32 cx1 = (s32)rd32(gc + 4), cy1 = (s32)rd32(gc + 8), cx2 = (s32)rd32(gc + 0xc), cy2 = (s32)rd32(gc + 0x10);
  s32 xa = x > cx1 ? x : cx1, xb = x2 < cx2 ? x2 : cx2;
  s32 ya = y > cy1 ? y : cy1, yb = y2 < cy2 ? y2 : cy2;
  if (xa >= xb || ya >= yb) return;
  u32 bpl = rd32(fb + 8), data = rd32(fb + 0x10);
  u32 color = rd32(gc + 0x14);
  s32 alpha = (s32)rd32(gc + 0x20);
  u32 op = rd32(gc + 0x2c), param = rd32(gc + 0x30);
  for (s32 yy = ya; yy < yb; yy++) {
    u32 row = data + bpl * (u32)yy;
    if (bpp == 16) {
      if (alpha > 254 && !op) {
        u16 c = (u16)color;
        for (s32 xx = xa; xx < xb; xx++) wr16(row + (u32)xx * 2, c);
        continue;
      }
      for (s32 xx = xa; xx < xb; xx++) {
        u32 p = row + (u32)xx * 2, v = color;
        if (alpha <= 254) v = midas_pixel_blend(rd16(p), color, (u32)alpha);
        if (op) { u32 a[3] = {rd16(p), v, param}; v = call_guest(op, 3, a); }
        wr16(p, (u16)v);
      }
    } else {
      for (s32 xx = xa; xx < xb; xx++) {
        u32 p = row + (u32)xx * 4, v = color;
        if (alpha <= 254) v = midas_pixel_blend(rd32(p), color, (u32)alpha);
        if (op) { u32 a[3] = {rd32(p), v, param}; v = call_guest(op, 3, a); }
        wr32(p, v);
      }
    }
  }
}

// Native versions of the hottest inner pixel loops of the game's Graphic blitters (palette image ->
// RGB565 with colour key and the Graphic's per-mode blend tables at this+0x6d). Each handler is
// entered at a loop head with the routine's own registers and stack frame, finishes the remaining
// iterations and continues at the loop's exit with every register that is live there set as the
// original loop would leave it. Offsets are only valid for the library build checked in hook_blitters.
static inline void blend_px(u32 lut, u32 m5, u32 A, u32 A1, u32 A2, u32 color, u32 d) {
  u32 D = rd16(d);
  u32 dg5 = (D & 0x7e0) >> 6, db = D & 31, dr = D >> 11;
  u32 lg = rd8(lut + ((m5 + ((color & 0x7e0) >> 6)) << 5) + dg5);
  u32 lr = rd8(lut + ((m5 + (color >> 11)) << 5) + dr);
  u32 lb = rd8(lut + ((m5 + (color & 31)) << 5) + db);
  u32 r, g2, b;
  if (A > 31) {
    r = lr; g2 = lg * 2; b = lb;
  } else {
    r = (u32)((s32)(A * lr + dr * (32 - A)) >> 5);
    g2 = (u32)((s32)(A1 * lg * 2 + (64 - A1) * dg5 * 2) >> 6);
    b = (u32)((s32)(A2 * lb + db * (32 - A2)) >> 5);
  }
  wr16(d, (u16)((b & 31) | (r << 11) | ((g2 << 5) & 0x7e0)));
}

// Graphic::DrawImageStretchClip565: every remaining row (scale, flip, clip), then the exit block.
#define STRETCH_LOOP 0x5a3bcu
#define STRETCH_EXIT 0x5a6d4u
static void hle_stretch_loop(void) {
  u32 sp = R[13];
  s32 flip = (s32)R[4];
  u32 self = R[5];
  s32 dstW = (s32)R[6], x = (s32)R[7];
  u32 stepx = R[8];
  s32 bits = (s32)R[9];
  u32 key = R[10];
  s32 j = (s32)rd32(sp + 0x34), y = (s32)rd32(sp + 0x74);
  u32 accY = rd32(sp + 0x40), dstRow = rd32(sp + 0x44);
  u32 srcBase = rd32(sp + 0x84), imgW = rd32(sp + 0x64);
  s32 hm1 = (s32)rd32(sp + 0x8c), wm1 = (s32)rd32(sp + 0x2c);
  u32 pixels = rd32(sp + 0x28), pal = rd32(sp + 0x20);
  u32 m5 = rd32(sp + 0x88) << 5;
  u32 stepy = rd32(sp + 0x80), rowStride = rd32(sp + 0x7c);
  s32 dstH = (s32)rd32(sp + 0x6c);
  u32 A = rd8(sp + 0xc4), A1 = rd8(sp + 0xc5), A2 = rd8(sp + 0xc6);
  s32 cx1 = (s32)rd32(self + 0x40e0), cy1 = (s32)rd32(self + 0x40e4), cx2 = (s32)rd32(self + 0x40e8), cy2 = (s32)rd32(self + 0x40ec);
  u32 lut = self + 0x6d;
  int hflip = flip == 8 || flip == 12, vflip = flip == 4 || flip == 12;
  do {
    s32 Y = j + y;
    s32 srow = (s32)accY >> 10;
    if (vflip) srow = hm1 - srow;
    u32 srcRowOff = imgW * (u32)srow + srcBase;
    if (dstW > 0 && Y >= cy1 && Y < cy2) {
      u32 accX = 0, d = dstRow, rowptr = pixels + srcRowOff;
      for (s32 i = 0; i < dstW; i++, accX += stepx, d += 2) {
        s32 X = i + x;
        if (X < cx1 || X >= cx2) continue;
        s32 sc = (s32)accX >> 10;
        if (hflip) sc = wm1 - sc;
        u32 color;
        if (bits == 4) {
          u32 b = rd8(rowptr + (u32)(sc >> 1));
          color = rd16(pal + ((sc & 1) ? (b & 15) : (b >> 4)) * 2);
        } else {
          color = rd16(pal + rd8(pixels + (u32)sc + srcRowOff) * 2);
        }
        if (color != key) blend_px(lut, m5, A, A1, A2, color, d);
      }
    }
    j++;
    accY += stepy;
    dstRow += rowStride;
  } while (j != dstH);
  wr32(sp + 0x34, (u32)j);
  wr32(sp + 0x40, accY);
  wr32(sp + 0x44, dstRow);
  cpu_pc = LOAD_BASE + STRETCH_EXIT;
}

// Graphic::DrawImageBlendingClip565, 4-bit image without flip: one row of pixel pairs.
#define BLEND4_LOOP 0x5d204u
#define BLEND4_EXIT 0x5d448u
static void hle_blend4_loop(void) {
  u32 sp = R[13];
  u32 n = rd32(sp + 0x34);
  u32 src = rd32(sp + 0x38) + rd32(sp + 0x3c);
  u32 m5 = R[3], lut = R[4] + 0x6d, pal = R[6], key = R[8];
  u32 A = rd8(sp + 0xac), A1 = rd8(sp + 0xad), A2 = rd8(sp + 0xae);
  u32 d0 = R[1], d1 = R[0];
  for (u32 i = 0; i < n; i++, d0 += 4, d1 += 4) {
    u32 b = rd8(src + i);
    u32 c0 = rd16(pal + (b >> 4) * 2), c1 = rd16(pal + (b & 15) * 2);
    if (c0 != key) blend_px(lut, m5, A, A1, A2, c0, d0);
    if (c1 != key) blend_px(lut, m5, A, A1, A2, c1, d1);
  }
  R[0] = d1;
  R[1] = d0;
  R[2] = n;
  R[11] = n;
  cpu_pc = LOAD_BASE + BLEND4_EXIT;
}

// Graphic::DrawImageBlendingClip565, 8-bit image (mode 16): one row.
#define BLEND8_LOOP 0x5d908u
#define BLEND8_EXIT 0x5da24u
static void hle_blend8_loop(void) {
  u32 sp = R[13];
  u32 n = R[11];
  u32 src = rd32(sp + 0x68) + rd32(sp + 0x3c);
  u32 pal = rd32(sp + 0x34), key = rd32(sp + 0x38);
  u32 m5 = R[0], lut = R[4] + 0x6d;
  u32 A = rd8(sp + 0xac), A1 = rd8(sp + 0xad), A2 = rd8(sp + 0xae);
  u32 d = R[2];
  for (u32 i = 0; i < n; i++, d += 2) {
    u32 c = rd16(pal + rd8(src + i) * 2);
    if (c != key) blend_px(lut, m5, A, A1, A2, c, d);
  }
  R[2] = d;
  R[3] = n;
  R[12] += n;
  cpu_pc = LOAD_BASE + BLEND8_EXIT;
}

// Graphic::DrawImageMirrorClip565 without flip (plain copy with colour key), 8-bit image: one row.
#define MIRROR8_LOOP 0x572bcu
#define MIRROR8_EXIT 0x572e4u
static void hle_mirror8_loop(void) {
  u32 n = R[12], src = R[1] + R[10], pal = R[7], key = R[11], d = R[0];
  for (u32 i = 0; i < n; i++, d += 2) {
    u32 c = rd16(pal + rd8(src + i) * 2);
    if (c != key) wr16(d, (u16)c);
  }
  R[0] = d;
  R[2] = n;
  cpu_pc = LOAD_BASE + MIRROR8_EXIT;
}

// Graphic::DrawImageMirrorClip565 without flip, 4-bit image: one row of pixel pairs.
#define MIRROR4_LOOP 0x57468u
#define MIRROR4_EXIT 0x574acu
static void hle_mirror4_loop(void) {
  u32 n = R[4], src = R[10] + R[8], pal = R[7], key = R[12], d0 = R[1], d1 = R[0];
  for (u32 i = 0; i < n; i++, d0 += 4, d1 += 4) {
    u32 b = rd8(src + i);
    u32 c0 = rd16(pal + (b >> 4) * 2), c1 = rd16(pal + (b & 15) * 2);
    if (c0 != key) wr16(d0, (u16)c0);
    if (c1 != key) wr16(d1, (u16)c1);
  }
  R[0] = d1;
  R[1] = d0;
  R[3] = n;
  cpu_pc = LOAD_BASE + MIRROR4_EXIT;
}

// Graphic::FillRectAlpha on an RGB565 frame buffer: one row.
#define FILLA_LOOP 0x52394u
#define FILLA_EXIT 0x523e8u
static void hle_filla_loop(void) {
  u32 n = R[6], row = R[5], inv = R[4], ab = R[8], ar = R[9], ag = R[10];
  for (u32 i = 0; i < n; i++) {
    u32 p = rd16(row + i * 2);
    u32 g = (inv * ((p & 0x7e0) >> 3) + ag) >> 5;
    u32 r = inv * ((p & 0xf800) >> 8) + ar;
    u32 b = inv * ((p << 3) & 255) + ab;
    wr16(row + i * 2, (u16)((r & 0xf800) | (g & 0x7e0) | ((b << 16) >> 27)));
  }
  R[1] = n;
  R[3] = n * 2;
  cpu_pc = LOAD_BASE + FILLA_EXIT;
}

static void hook_at(u32 addr, Hle fn, const char *name) {
  if (nimports >= MAX_IMPORTS) return;
  int idx = nimports++;
  import_fn[idx] = fn;
  import_name[idx] = name;
  s32 off = ((s32)(TRAP_BASE + idx * 4) - (s32)(addr + 8)) >> 2;
  wr32(addr, 0xea000000u | ((u32)off & 0xffffff));
}

static void hook(const char *sym, Hle fn) {
  u32 a = find_symbol(sym);
  if (!a || nimports >= MAX_IMPORTS) { logf("hook: %s not found", sym); return; }
  int idx = nimports++;
  import_fn[idx] = fn;
  import_name[idx] = sym;
  s32 off = ((s32)(TRAP_BASE + idx * 4) - (s32)(a + 8)) >> 2;
  wr32(a, 0xea000000u | ((u32)off & 0xffffff));
}

// Watch points: the routine's first instruction is replaced by a branch to a trap that reports the
// call to the page and then executes the displaced instruction in place.
#define MAX_WATCH 32
typedef struct { u32 addr, insn; int id; } Watch;
static Watch watches[MAX_WATCH];
static int nwatches;
void exec_displaced(u32 insn, u32 addr);

static void watch_dispatch(int w) {
  Watch *wt = &watches[w];
  host_event(100 + wt->id, (int)R[0], (int)R[1], (int)R[2]);
  exec_displaced(wt->insn, wt->addr);
}
#define WATCH_FN(n) static void watch_##n(void) { watch_dispatch(n); }
WATCH_FN(0) WATCH_FN(1) WATCH_FN(2) WATCH_FN(3) WATCH_FN(4) WATCH_FN(5) WATCH_FN(6) WATCH_FN(7)
WATCH_FN(8) WATCH_FN(9) WATCH_FN(10) WATCH_FN(11) WATCH_FN(12) WATCH_FN(13) WATCH_FN(14) WATCH_FN(15)
static const Hle watch_fns[16] = {watch_0, watch_1, watch_2, watch_3, watch_4, watch_5, watch_6, watch_7,
                                  watch_8, watch_9, watch_10, watch_11, watch_12, watch_13, watch_14, watch_15};

EXPORT(watch_symbol) int watch_symbol(const char *sym, int id) {
  u32 a = find_symbol(sym);
  if (!a || nwatches >= 16 || nimports >= MAX_IMPORTS) { logf("watch: %s not found", sym); return -1; }
  int w = nwatches++;
  watches[w].addr = a;
  watches[w].insn = rd32(a);
  watches[w].id = id;
  int idx = nimports++;
  import_fn[idx] = watch_fns[w];
  import_name[idx] = "watch";
  s32 off = ((s32)(TRAP_BASE + idx * 4) - (s32)(a + 8)) >> 2;
  wr32(a, 0xea000000u | ((u32)off & 0xffffff));
  return 0;
}

static void hook_loop(u32 off, u32 insn, Hle fn, const char *name) {
  if (rd32(LOAD_BASE + off) == insn) hook_at(LOAD_BASE + off, fn, name);
}

static void hook_blitters(void) {
  // only for the exact library build the loop offsets were taken from
  if (find_symbol("_ZN7Graphic23DrawImageStretchClip565EiiiiiP8GbmImageiihiihhi") != LOAD_BASE + 0x5a188u) return;
  if (find_symbol("_ZN7Graphic24DrawImageBlendingClip565EiiiiiP8GbmImageiihhhi") != LOAD_BASE + 0x5cae8u) return;
  hook_loop(STRETCH_LOOP, 0xe59d3034u, hle_stretch_loop, "stretch565_loop");
  hook_loop(BLEND4_LOOP, 0xe59d503cu, hle_blend4_loop, "blend565_4_loop");
  hook_loop(BLEND8_LOOP, 0xe59d1068u, hle_blend8_loop, "blend565_8_loop");
  if (find_symbol("_ZN7Graphic22DrawImageMirrorClip565EiiiiiP8GbmImageiihi") == LOAD_BASE + 0x56e18u) {
    hook_loop(MIRROR8_LOOP, 0xe0824001u, hle_mirror8_loop, "mirror565_8_loop");
    hook_loop(MIRROR4_LOOP, 0xe083200au, hle_mirror4_loop, "mirror565_4_loop");
  }
  if (find_symbol("_ZN7Graphic13FillRectAlphaEiiiiihi") == LOAD_BASE + 0x52224u) hook_loop(FILLA_LOOP, 0xe19520b3u, hle_filla_loop, "fillalpha565_loop");
}

EXPORT(set_native_hooks) void set_native_hooks(int on) {
  if (!on) return;
  hook("_Z26internalGrpCopyFrameBufferiiiiiiiiP14_MC_GrpContexth", hle_copy_frame_buffer);
  hook("MC_grpFillRect", hle_fill_rect);
  hook_blitters();
}

// =============================================================================================
// Entry points used by the page
static u32 native_fn(const char *name) {
  char buf[128];
  hsnprintf(buf, sizeof buf, "Java_co_kr_eamobile_CletEntry_%s", name);
  u32 a = find_symbol(buf);
  if (!a) logf("missing native %s", buf);
  return a;
}

static u32 top_call(const char *name, int nargs, u32 *args) {
  u32 f = native_fn(name);
  if (!f || cpu_halt) return 0;
  u32 r = call_guest(f, nargs, args);
  jni_end_frame();
  return r;
}

static u32 fn_loop, fn_touch, fn_key;

EXPORT(app_start) int app_start(int screen_w, int screen_h, int lcd_w, int lcd_h, float mag, int view_mode) {
  u32 env = jni_env_addr, thiz = jni_this_object();
  trace_java = 1;
  u32 a0[2] = {env, thiz};
  top_call("nativeInitKernel", 2, a0);
  u32 magbits;
  __builtin_memcpy(&magbits, &mag, 4);
  // (w, h, r, g, b, a, lcdW, lcdH, marginX, marginY, colorType, mag, filter, viewMode, sublayer, sublayerType)
  u32 a1[18] = {env, thiz, (u32)screen_w, (u32)screen_h, 5, 6, 5, 0, (u32)lcd_w, (u32)lcd_h, 0, 0, 0, magbits, 1, (u32)view_mode, 0, 0};
  u32 margin = top_call("nativeInitDisplay", 18, a1);
  logf("nativeInitDisplay -> %d", margin);
  u32 a2[4] = {env, thiz, jni_new_string("/data/data/co.kr.eamobile.HeroesLore5/files"), jni_new_string("/sdcard/Android/data/co.kr.eamobile.HeroesLore5/files")};
  top_call("nativeInitFileStorage", 4, a2);
  int vfs_fd = fs_open_external("/apk/data.vfs");
  extern double vfs_size;
  u64 len = (u64)vfs_size;
  // (env, thiz, FileDescriptor, long start, long length): the longs are 8-byte aligned on the stack
  u32 a3[8] = {env, thiz, jni_fd_object(vfs_fd), 0, 0, 0, (u32)len, (u32)(len >> 32)};
  top_call("nativeInitVFS", 8, a3);
  u32 a4[4] = {env, thiz, 202400, 0};
  top_call("nativeInitAudioConfiguration", 4, a4);
  top_call("nativeStartApp", 2, a0);
  fn_loop = native_fn("nativeLoop");
  fn_touch = native_fn("nativeTouchHandleEvent");
  fn_key = native_fn("nativeKeyHandleEvent");
  trace_java = 0;
  return cpu_halt ? -1 : 0;
}

double vfs_size;
EXPORT(set_vfs_size) void set_vfs_size(double size) {
  vfs_size = size;
  extern void fs_mount_external(const char *path, double size);
  fs_mount_external("/apk/data.vfs", size);
}

EXPORT(app_loop) int app_loop(void) {
  if (cpu_halt) return -1;
  u32 a[2] = {jni_env_addr, jni_this_object()};
  call_guest(fn_loop, 2, a);
  jni_end_frame();
  return cpu_halt ? -1 : 0;
}

EXPORT(app_touch) void app_touch(int type, int x, int y, int id) {
  if (cpu_halt) return;
  u32 a[6] = {jni_env_addr, jni_this_object(), (u32)type, (u32)x, (u32)y, (u32)id};
  call_guest(fn_touch, 6, a);
  jni_end_frame();
}

EXPORT(app_key) void app_key(int type, int code) {
  if (cpu_halt) return;
  u32 a[5] = {jni_env_addr, jni_this_object(), (u32)type, (u32)code, 0};
  call_guest(fn_key, 5, a);
  jni_end_frame();
}

EXPORT(app_call) int app_call(const char *name) {
  u32 a[2] = {jni_env_addr, jni_this_object()};
  top_call(name, 2, a);
  return cpu_halt ? -1 : 0;
}

EXPORT(app_mtx_result) void app_mtx_result(int r) {
  (void)r;
}

EXPORT(frame_info) FrameInfo *frame_info(void) { return &frame; }
EXPORT(guest_base) u8 *guest_base(void) { return G; }
EXPORT(host_alloc) void *host_alloc(u32 n) { return hmalloc(n); }
EXPORT(host_free) void host_free_export(void *p) { hfree(p); }
EXPORT(insn_count) double insn_count(void) { return (double)cpu_insns; }
EXPORT(heap_in_use) u32 heap_in_use(void) { return guest_heap_in_use(); }
EXPORT(heap_top) u32 heap_top(void) { return guest_heap_top(); }
EXPORT(set_logging) void set_logging(int on) { log_enabled = on; }
EXPORT(cpu_state) u32 *cpu_state(void) { return R; }
EXPORT(is_halted) int is_halted(void) { return (int)cpu_halt; }
