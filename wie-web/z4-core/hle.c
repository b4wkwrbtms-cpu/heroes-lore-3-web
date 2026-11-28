// ELF loader, the libc/libm/liblog/GLES functions the game imports and the entry points the page drives.
#include "base.h"

void heaps_init(void);
int guest_vformat(char *buf, int cap, u32 gfmt, u32 gap);
int jni_dispatch(u32 trap);
void jni_init(u32 (*data_alloc)(u32));
void jni_end_frame(void);
u32 jni_this_object(void);
void java_timers_run(void);
void net_poll(void);
extern u32 jni_env_addr, jni_vm_addr;
extern u32 guest_errno_addr;
u32 guest_heap_in_use(void);
u32 guest_heap_top(void);
int fs_open(u32 gpath, int flags);
int fs_close(int fd);
int fs_read(int fd, u32 buf, u32 len);
int fs_write(int fd, u32 buf, u32 len);
s64 fs_lseek(int fd, s64 off, int whence);
int fs_stat(u32 gpath, u32 st);
int fs_access(u32 gpath);
int fs_unlink(u32 gpath, int dir);
int fs_rename(u32 from, u32 to);

static u32 data_top = DATA_BASE;
static u32 data_alloc(u32 n) {
  u32 a = (data_top + 7) & ~7u;
  data_top = a + n;
  memset(gwptr(a, n), 0, n);
  return a;
}
static u32 data_str(const char *s) {
  u32 n = hstrlen(s) + 1;
  u32 a = data_alloc(n);
  memcpy(gwptr(a, n), s, n);
  return a;
}

static inline u32 arg(int i) { return i < 4 ? R[i] : rd32(R[13] + (i - 4) * 4); }
static inline float arg_flt(int i) {
  u32 v = arg(i);
  float f;
  __builtin_memcpy(&f, &v, 4);
  return f;
}
static inline void ret_flt(float f) { __builtin_memcpy(&R[0], &f, 4); }

// =============================================================================================
// GLES 1.x: the game draws in software into a 16-bit buffer and uploads it as a texture each frame.
u16 *screen_buf;   // what the page shows, RGB565
u32 scr_w, scr_h;  // size of the game's buffer (and of screen_buf)
u32 frame_count;   // frames uploaded so far
u16 *paint_out;    // set while motion.c draws an in-between frame: the picture goes there instead
static void f_glTexSubImage2D(void) {
  // (target, level, xoff, yoff, w, h, format, type, pixels)
  u32 w = arg(4), h = arg(5), px = arg(8);
  if (paint_out) {
    if (px && w == scr_w && h == scr_h) memcpy(paint_out, gptr(px), w * h * 2);
    return;
  }
  if (!screen_buf || w != scr_w || h != scr_h) {
    if (screen_buf) hfree(screen_buf);
    scr_w = w;
    scr_h = h;
    screen_buf = hmalloc(w * h * 2);
    logf("screen %ux%u", w, h);
  }
  if (screen_buf && px) memcpy(screen_buf, gptr(px), w * h * 2);
  frame_count++;
}
static void f_glGenTextures(void) {
  for (u32 i = 0; i < R[0]; i++) wr32(R[1] + i * 4, i + 1);
}
static void f_gl_ignore(void) {}

// =============================================================================================
// libc
static u32 stack_guard_addr, sf_addr, strerror_str, tm_buf, tls_slots;
static u32 exidx_start, exidx_count;

// FILE: {magic, fd, eof, error}
static u32 file_struct(int fd) {
  u32 f = gcalloc(16);
  wr32(f, 0x454c4946);
  wr32(f + 4, (u32)fd);
  return f;
}
static int file_fd(u32 f) {
  if (f >= sf_addr && f < sf_addr + 3 * 84) return (int)((f - sf_addr) / 84);
  return (int)rd32(f + 4);
}

static void f_malloc(void) { R[0] = gmalloc(R[0] ? R[0] : 1); }
static void f_calloc(void) { u32 n = R[0] * R[1]; R[0] = gcalloc(n ? n : 1); }
static void f_free(void) { if (R[0]) gfree(R[0]); }
static void f_realloc(void) {
  u32 p = R[0], n = R[1];
  if (!p) { R[0] = gmalloc(n); return; }
  if (!n) { gfree(p); R[0] = 0; return; }
  u32 old = gmalloc_usable(p);
  if (old >= n) { R[0] = p; return; }
  u32 q = gmalloc(n);
  if (q) { memcpy(gwptr(q, old), gptr(p), old); gfree(p); }
  R[0] = q;
}
static void f_memcpy(void) { memmove(gwptr(R[0], R[2]), gptr(R[1]), R[2]); }
static void f_memset(void) { memset(gwptr(R[0], R[2]), (int)R[1], R[2]); }
static void f_memcmp(void) {
  u32 a = R[0], b = R[1], n = R[2];
  for (u32 k = 0; k < n; k++) {
    u8 x = rd8(a + k), y = rd8(b + k);
    if (x != y) { R[0] = (u32)(x - y); return; }
  }
  R[0] = 0;
}
static void f_memchr(void) {
  u32 p = R[0], c = R[1] & 0xff, n = R[2];
  for (u32 k = 0; k < n; k++)
    if (rd8(p + k) == c) { R[0] = p + k; return; }
  R[0] = 0;
}
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
  for (u32 k = 0; k < n; k++) {
    u8 x = rd8(a + k), y = rd8(b + k);
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
  u32 d = R[0], s = R[1], n = R[2], k = 0;
  for (; k < n; k++) { u8 c = rd8(s + k); wr8(d + k, c); if (!c) break; }
  for (; k < n; k++) wr8(d + k, 0);
}
static void f_strcat(void) {
  u32 d = R[0] + gstrlen(R[0]), s = R[1];
  u8 c;
  do { c = rd8(s++); wr8(d++, c); } while (c);
}
static void f_strncat(void) {
  u32 d = R[0] + gstrlen(R[0]), s = R[1], n = R[2];
  for (u32 k = 0; k < n; k++) { u8 c = rd8(s + k); if (!c) break; wr8(d++, c); }
  wr8(d, 0);
}
static void f_strchr(void) {
  u32 p = R[0];
  u8 c = (u8)R[1];
  for (;; p++) {
    u8 x = rd8(p);
    if (x == c) { R[0] = p; return; }
    if (!x) { R[0] = 0; return; }
  }
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
static u32 strtok_save;
static void f_strtok(void) {
  u32 s = R[0] ? R[0] : strtok_save, delim = R[1];
  if (!s) { R[0] = 0; return; }
  int dl = gstrlen(delim);
#define IS_DELIM(ch) ({ int _d = 0; for (int _k = 0; _k < dl; _k++) if (rd8(delim + _k) == (ch)) _d = 1; _d; })
  while (rd8(s) && IS_DELIM(rd8(s))) s++;
  if (!rd8(s)) { strtok_save = 0; R[0] = 0; return; }
  u32 start = s;
  while (rd8(s) && !IS_DELIM(rd8(s))) s++;
  if (rd8(s)) { wr8(s, 0); strtok_save = s + 1; }
  else strtok_save = 0;
#undef IS_DELIM
  R[0] = start;
}
static void f_atoi(void) {
  u32 p = R[0];
  while (rd8(p) == ' ' || (rd8(p) >= 9 && rd8(p) <= 13)) p++;
  int neg = 0;
  if (rd8(p) == '-' || rd8(p) == '+') neg = rd8(p++) == '-';
  s32 v = 0;
  while (rd8(p) >= '0' && rd8(p) <= '9') v = v * 10 + (rd8(p++) - '0');
  R[0] = (u32)(neg ? -v : v);
}
static void f_abort(void) { logf("guest abort() lr=%08x", R[14]); cpu_halt = 1; }
static void f_raise(void) { logf("guest raise(%d) lr=%08x", R[0], R[14]); cpu_halt = 1; }
static void f_stack_chk_fail(void) { logf("stack check failed lr=%08x", R[14]); cpu_halt = 1; }
static void f_errno(void) { R[0] = guest_errno_addr; }
static void f_strerror(void) { R[0] = strerror_str; }
static void format_to_guest(u32 dst, u32 fmt, u32 ap) {
  char tmp[2048];
  int n = guest_vformat(tmp, sizeof tmp, fmt, ap);
  int m = n < (int)sizeof tmp - 1 ? n : (int)sizeof tmp - 1;
  memcpy(gwptr(dst, (u32)m), tmp, m);
  wr8(dst + m, 0);
  R[0] = (u32)n;
}
static void f_sprintf(void) {
  // (buf, fmt, ...) - varargs start at r2
  u32 base = R[13] - 16;
  for (int i = 0; i < 4; i++) wr32(base + i * 4, R[i]);
  format_to_guest(R[0], R[1], base + 8);
}
static void f_vsprintf(void) { format_to_guest(R[0], R[1], R[2]); }
int log_enabled = 1;
static void log_formatted(u32 fmt, u32 ap) {
  if (!log_enabled) return;
  char tmp[1024];
  int n = guest_vformat(tmp, sizeof tmp, fmt, ap);
  if (n > (int)sizeof tmp - 1) n = sizeof tmp - 1;
  while (n > 0 && (tmp[n - 1] == '\n' || tmp[n - 1] == '\r')) n--;
  if (n > 0) host_log(tmp, n);
}
static void f_printf(void) {
  u32 base = R[13] - 16;
  for (int i = 0; i < 4; i++) wr32(base + i * 4, R[i]);
  log_formatted(R[0], base + 4);
  R[0] = 1;
}
static void f_vprintf(void) { log_formatted(R[0], R[1]); R[0] = 1; }
static void f_android_log_print(void) {
  u32 base = R[13] - 16;
  for (int i = 0; i < 4; i++) wr32(base + i * 4, R[i]);
  log_formatted(R[2], base + 12);
  R[0] = 1;
}
static void f_fputs(void) {
  if (log_enabled) { int n = gstrlen(R[0]); while (n > 0 && rd8(R[0] + n - 1) == '\n') n--; if (n) host_log((const char *)gptr(R[0]), n < 1024 ? n : 1024); }
  R[0] = 1;
}
static void f_one(void) { R[0] = 1; }
static void f_zero(void) { R[0] = 0; }
static void f_minus_one(void) {
  wr32(guest_errno_addr, 101); // ENETUNREACH: there is no network here
  R[0] = (u32)-1;
}
static void f_time(void) {
  u32 t = (u32)(host_now() / 1000);
  if (R[0]) wr32(R[0], t);
  R[0] = t;
}
static void f_gettimeofday(void) {
  double ms = host_now();
  u64 us = (u64)(ms * 1000.0);
  if (R[0]) { wr32(R[0], (u32)(us / 1000000)); wr32(R[0] + 4, (u32)(us % 1000000)); }
  R[0] = 0;
}
// struct tm in a static buffer, in Korean time (UTC+9)
static void f_localtime(void) {
  s64 t = (s64)(s32)rd32(R[0]) + 9 * 3600;
  s64 days = t / 86400, rem = t % 86400;
  if (rem < 0) { rem += 86400; days--; }
  u32 hour = (u32)(rem / 3600), min = (u32)(rem % 3600 / 60), sec = (u32)(rem % 60);
  s32 wday = (s32)((days + 4) % 7);
  if (wday < 0) wday += 7;
  s64 z = days + 719468, era = (z >= 0 ? z : z - 146096) / 146097;
  u32 doe = (u32)(z - era * 146097);
  u32 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  s64 y = (s64)yoe + era * 400;
  u32 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  u32 mp = (5 * doy + 2) / 153;
  u32 d = doy - (153 * mp + 2) / 5 + 1;
  u32 m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y++;
  static const u16 cum[12] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
  int leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
  u32 yday = cum[m - 1] + d - 1 + (leap && m > 2);
  u32 v[11] = {sec, min, hour, d, m - 1, (u32)(y - 1900), (u32)wday, yday, 0, 9 * 3600, 0};
  for (int i = 0; i < 11; i++) wr32(tm_buf + i * 4, v[i]);
  R[0] = tm_buf;
}
static void f_ceilf(void) { ret_flt(__builtin_ceilf(arg_flt(0))); }
static void f_syscall(void) {
  if (R[0] == 224) { R[0] = 1000; return; } // gettid
  logf("syscall %u", R[0]);
  R[0] = 0;
}

// stdio over the virtual file system
static void f_fopen(void) {
  u32 mode = R[1];
  char m0 = (char)rd8(mode);
  int plus = 0;
  for (u32 p = mode; rd8(p); p++) if (rd8(p) == '+') plus = 1;
  int flags = m0 == 'r' ? (plus ? 2 : 0) : m0 == 'w' ? (plus ? 2 : 1) | 0x40 | 0x200 : (plus ? 2 : 1) | 0x40 | 0x400;
  int fd = fs_open(R[0], flags);
  R[0] = fd < 0 ? 0 : file_struct(fd);
}
static void f_fread(void) {
  u32 size = R[1], n = R[2];
  int fd = file_fd(R[3]);
  if (!size || !n) { R[0] = 0; return; }
  int got = fs_read(fd, R[0], size * n);
  R[0] = got <= 0 ? 0 : (u32)got / size;
}
static void f_fwrite(void) {
  u32 size = R[1], n = R[2];
  int fd = file_fd(R[3]);
  if (!size || !n) { R[0] = 0; return; }
  if (fd <= 2) { R[0] = n; return; }
  int put = fs_write(fd, R[0], size * n);
  R[0] = put <= 0 ? 0 : (u32)put / size;
}
static void f_fputc(void) { R[0] = R[0] & 0xff; }
static void f_fseek(void) {
  int fd = file_fd(R[0]);
  s64 r = fs_lseek(fd, (s32)R[1], (int)R[2]);
  R[0] = r < 0 ? (u32)-1 : 0;
}
static void f_ftell(void) { R[0] = (u32)fs_lseek(file_fd(R[0]), 0, 1); }
static void f_fclose(void) {
  if (!R[0]) { R[0] = (u32)-1; return; }
  int fd = file_fd(R[0]);
  gfree(R[0]);
  R[0] = (u32)fs_close(fd);
}
static void f_close(void) { R[0] = (u32)fs_close((int)R[0]); }
static void f_write(void) {
  if ((int)R[0] <= 2) { R[0] = R[2]; return; }
  R[0] = (u32)fs_write((int)R[0], R[1], R[2]);
}
static void f_stat(void) { R[0] = (u32)fs_stat(R[0], R[1]); }
static void f_access(void) { R[0] = (u32)fs_access(R[0]); }
static void f_unlink(void) { R[0] = (u32)fs_unlink(R[0], 0); }
static void f_rename(void) { R[0] = (u32)fs_rename(R[0], R[1]); }
static void f_unwind_find_exidx(void) {
  wr32(R[1], exidx_count);
  R[0] = exidx_start;
}
// pthread: one thread, keys in a small table
static u32 next_key;
static void f_key_create(void) {
  if (next_key >= 32) { R[0] = 11; return; }
  wr32(R[0], next_key++);
  R[0] = 0;
}
static void f_getspecific(void) { R[0] = R[0] < 32 ? rd32(tls_slots + R[0] * 4) : 0; }
static void f_setspecific(void) {
  if (R[0] < 32) wr32(tls_slots + R[0] * 4, R[1]);
  R[0] = 0;
}

typedef void (*Hle)(void);
typedef struct {
  const char *name;
  Hle fn;
} ImportDef;

static const ImportDef import_defs[] = {
    {"malloc", f_malloc}, {"calloc", f_calloc}, {"free", f_free}, {"realloc", f_realloc},
    {"memcpy", f_memcpy}, {"memmove", f_memcpy}, {"memset", f_memset}, {"memcmp", f_memcmp}, {"memchr", f_memchr},
    {"strlen", f_strlen}, {"strcmp", f_strcmp}, {"strncmp", f_strncmp}, {"strcpy", f_strcpy}, {"strncpy", f_strncpy},
    {"strcat", f_strcat}, {"strncat", f_strncat}, {"strchr", f_strchr}, {"strstr", f_strstr}, {"strtok", f_strtok},
    {"atoi", f_atoi}, {"abort", f_abort}, {"raise", f_raise}, {"__stack_chk_fail", f_stack_chk_fail},
    {"__errno", f_errno}, {"strerror", f_strerror}, {"sprintf", f_sprintf}, {"vsprintf", f_vsprintf},
    {"printf", f_printf}, {"vprintf", f_vprintf}, {"__android_log_print", f_android_log_print},
    {"putchar", f_one}, {"fputs", f_fputs}, {"fputc", f_fputc},
    {"time", f_time}, {"gettimeofday", f_gettimeofday}, {"localtime", f_localtime}, {"ceilf", f_ceilf},
    {"syscall", f_syscall}, {"socket", f_minus_one}, {"connect", f_minus_one}, {"recv", f_minus_one},
    {"send", f_minus_one}, {"select", f_minus_one}, {"shutdown", f_minus_one}, {"inet_addr", f_minus_one},
    {"fcntl", f_zero}, {"close", f_close}, {"write", f_write}, {"fopen", f_fopen}, {"fread", f_fread},
    {"fwrite", f_fwrite}, {"fseek", f_fseek}, {"ftell", f_ftell}, {"fclose", f_fclose}, {"stat", f_stat},
    {"access", f_access}, {"unlink", f_unlink}, {"rename", f_rename},
    {"pthread_mutex_lock", f_zero}, {"pthread_mutex_unlock", f_zero}, {"pthread_key_create", f_key_create},
    {"pthread_key_delete", f_zero}, {"pthread_getspecific", f_getspecific}, {"pthread_setspecific", f_setspecific},
    {"pthread_create", f_minus_one},
    {"__google_potentially_blocking_region_begin", f_zero}, {"__google_potentially_blocking_region_end", f_zero},
    {"__gnu_Unwind_Find_exidx", f_unwind_find_exidx}, {"__cxa_atexit", f_zero}, {"__cxa_finalize", f_zero},
    {"glTexSubImage2D", f_glTexSubImage2D}, {"glGenTextures", f_glGenTextures},
};
#define NIMPORT_DEFS (sizeof import_defs / sizeof import_defs[0])

// trap index -> handler for imports
#define MAX_IMPORTS 256
static Hle import_fn[MAX_IMPORTS];
static const char *import_name[MAX_IMPORTS];
static int nimports;

static const char *unimpl_name;
static void f_unimpl(void) {
  logf("unimplemented import %s called from %08x", unimpl_name ? unimpl_name : "?", R[14]);
  R[0] = 0;
}

int trace_imports;
EXPORT(set_trace_imports) void set_trace_imports(int on) { trace_imports = on; }

void hle_dispatch(u32 index) {
  if (index < (u32)nimports) {
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
  if (!hstrcmp(name, "__sF")) return sf_addr;
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
  if (import_fn[idx] == f_unimpl && name[0] == 'g' && name[1] == 'l') import_fn[idx] = f_gl_ignore;
  if (import_fn[idx] == f_unimpl) logf("import without implementation: %s", name);
  return TRAP_BASE + idx * 4;
}

EXPORT(find_symbol) u32 find_symbol(const char *name) {
  char buf[160];
  for (u32 i = 1; i < nsyms; i++) {
    if (rd16(dynsym + i * 16 + 14) == 0) continue;
    if (!hstrcmp(sym_name_host(i, buf, sizeof buf), name)) return LOAD_BASE + rd32(dynsym + i * 16 + 4);
  }
  return 0;
}

static u32 init_array, init_array_sz;

EXPORT(load_library) int load_library(const u8 *elf, u32 len) {
  (void)len;
  heaps_init();
  guest_errno_addr = data_alloc(4);
  stack_guard_addr = data_alloc(4);
  wr32(stack_guard_addr, 0x5a17c0de);
  sf_addr = data_alloc(3 * 84);
  strerror_str = data_str("error");
  tm_buf = data_alloc(48);
  tls_slots = data_alloc(32 * 4);
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
          char buf[160];
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
  { void aot_enable(int on); aot_enable(7); } // translated functions, native division helpers and drawing routines
  for (u32 i = 0; i < init_array_sz / 4; i++) {
    u32 f = rd32(init_array + i * 4);
    if (f && f != 0xffffffff) call_guest(f, 0, 0);
  }
  return cpu_halt ? -1 : 0;
}

// =============================================================================================
// The Java side of the game loop (NexusGLSurfaceView renderer c): surfaceCreated starts the clet with
// the buffer size, surfaceChanged reports the view size, every frame hands one queued input event to
// the native side and then renders.
static u32 n_init_buf, n_device, n_resize, n_render, n_event, n_timer, n_resume, n_pause, n_globalref, n_nexusone;
u32 buf_w, buf_h; // NexusGLActivity.d/e: the size the game is created with

static void call_native(u32 fn, int n, const u32 *extra) {
  u32 a[8] = {jni_env_addr, jni_this_object()};
  for (int i = 0; i < n && i < 6; i++) a[2 + i] = extra[i];
  call_guest(fn, 2 + n, a);
  jni_end_frame();
}

EXPORT(app_start) int app_start(int w, int h) {
  buf_w = (u32)w;
  buf_h = (u32)h;
  n_init_buf = find_symbol("Java_com_gamevil_nexus2_Natives_NativeInitWithBufferSize");
  n_device = find_symbol("Java_com_gamevil_nexus2_Natives_NativeInitDeviceInfo");
  n_resize = find_symbol("Java_com_gamevil_nexus2_Natives_NativeResize");
  n_render = find_symbol("Java_com_gamevil_nexus2_Natives_NativeRender");
  n_event = find_symbol("Java_com_gamevil_nexus2_Natives_handleCletEvent");
  n_timer = find_symbol("Java_com_gamevil_nexus2_Natives_NativeAsyncTimerCallBackTimeStemp");
  n_resume = find_symbol("Java_com_gamevil_nexus2_Natives_NativeResumeClet");
  n_pause = find_symbol("Java_com_gamevil_nexus2_Natives_NativePauseClet");
  n_globalref = find_symbol("Java_com_gamevil_nexus2_Natives_InitializeJNIGlobalRef");
  n_nexusone = find_symbol("Java_com_gamevil_nexus2_Natives_NativeIsNexusOne");
  u32 onload = find_symbol("JNI_OnLoad");
  if (!n_init_buf || !n_render || !n_event) { logf("entry points missing"); return -1; }
  // the signature check (getGL) compares Signature.hashCode() with a word the library keeps: find it
  // through the literal the check loads, after making sure the code is the one this was read from
  u32 gl = find_symbol("getGL") & ~1u;
  extern u32 expected_sig_hash_addr;
  if (gl && rd32(gl + 0x142) == 0x4b1c447b && rd16(gl + 0x146) == 0x681b) {
    u32 lit = rd32(gl + 0x1b4);
    expected_sig_hash_addr = rd32(gl + 0x148 + lit);
  }
  if (onload) {
    u32 a[2] = {jni_vm_addr, 0};
    call_guest(onload, 2, a);
    jni_end_frame();
  }
  if (n_globalref) call_native(n_globalref, 0, 0);
  if (n_nexusone) { u32 z = 0; call_native(n_nexusone, 1, &z); }
  // surfaceCreated -> renderer c.c(): NativeInitWithBufferSize(d, e) (starts the clet)
  u32 a[2] = {buf_w, buf_h};
  call_native(n_init_buf, 2, a);
  if (cpu_halt) return -1;
  // surfaceChanged -> renderer c.a(w, h): NativeInitDeviceInfo(d, e), NativeResize(w, h)
  call_native(n_device, 2, a);
  call_native(n_resize, 2, a);
  return cpu_halt ? -1 : 0;
}

// one frame of the GL thread: an input event (if any) and NativeRender
EXPORT(app_frame) int app_frame(void) {
  if (cpu_halt) return -1;
  java_timers_run();
  if (cpu_halt) return -1;
  net_poll();
  if (cpu_halt) return -1;
  call_native(n_render, 0, 0);
  return cpu_halt ? -1 : 0;
}

// handleCletEvent(type, p1, p2, p3) with the three longs as the Java side passes them
EXPORT(app_event) void app_event(int type, int p1, int p2, int p3) {
  if (cpu_halt) return;
  // the 64-bit arguments are 8-byte aligned: r2 = type, r3 unused, stack: p1, p2, p3
  u32 args[10] = {jni_env_addr, jni_this_object(), (u32)type, 0, (u32)p1, (u32)(p1 >> 31), (u32)p2, (u32)(p2 >> 31), (u32)p3, (u32)(p3 >> 31)};
  call_guest(n_event, 10, args);
  jni_end_frame();
}

void native_timer_callback(int idx, int stamp) {
  if (!n_timer) return;
  u32 a[2] = {(u32)idx, (u32)stamp};
  call_native(n_timer, 2, a);
}

EXPORT(app_pause) void app_pause(int pause) {
  if (cpu_halt) return;
  if (pause && n_pause) call_native(n_pause, 0, 0);
  if (!pause && n_resume) call_native(n_resume, 0, 0);
}

EXPORT(screen) u16 *screen(void) { return screen_buf; }
EXPORT(screen_w) u32 screen_w_export(void) { return scr_w; }
EXPORT(screen_h) u32 screen_h_export(void) { return scr_h; }
EXPORT(frames) u32 frames(void) { return frame_count; }
EXPORT(guest_base) u8 *guest_base(void) { return G; }
EXPORT(host_alloc) void *host_alloc(u32 n) { return hmalloc(n); }
EXPORT(host_free) void host_free_export(void *p) { hfree(p); }
EXPORT(insn_count) double insn_count(void) { return (double)cpu_insns; }
EXPORT(heap_in_use) u32 heap_in_use(void) { return guest_heap_in_use(); }
EXPORT(heap_top) u32 heap_top(void) { return guest_heap_top(); }
EXPORT(set_logging) void set_logging(int on) { log_enabled = on; }
EXPORT(cpu_state) u32 *cpu_state(void) { return R; }
EXPORT(is_halted) int is_halted(void) { return (int)cpu_halt; }
