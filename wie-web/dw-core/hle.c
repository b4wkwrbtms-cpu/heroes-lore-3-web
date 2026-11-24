// ELF loader, the libc/liblog/libstdc++ functions the game imports and the entry points the page drives.
#include "base.h"

void heaps_init(void);
int guest_vformat(char *buf, int cap, u32 gfmt, u32 gap);
int jni_dispatch(u32 trap);
void jni_init(u32 (*data_alloc)(u32));
void jni_end_frame(void);
u32 jni_new_shorts(u32 n);
u32 jni_new_bytes(u32 n);
u32 jni_array_addr(u32 h);
u32 jni_this_object(void);
extern u32 jni_env_addr, jni_vm_addr;
extern u32 guest_errno_addr;
extern u32 call_ret_hi;
u32 guest_heap_in_use(void);
u32 guest_heap_top(void);
int fs_open(u32 gpath, int flags);
int fs_close(int fd);
int fs_read(int fd, u32 buf, u32 len);
int fs_write(int fd, u32 buf, u32 len);
s64 fs_lseek(int fd, s64 off, int whence);
int fs_unlink(u32 gpath, int dir);
int fs_exists(const char *path);
void fs_put(const char *path, const u8 *data, u32 len);

static u32 data_top = DATA_BASE;
static u32 data_alloc(u32 n) {
  u32 a = (data_top + 7) & ~7u;
  data_top = a + n;
  memset(gptr(a), 0, n);
  return a;
}

static inline u32 arg(int i) { return i < 4 ? R[i] : rd32(R[13] + (i - 4) * 4); }

// =============================================================================================
// Imports
typedef void (*Hle)(void);

static u32 stack_guard_addr;
static u32 exidx_start, exidx_count;

// FILE: {magic, fd, eof, error}
static u32 file_struct(int fd) {
  u32 f = gcalloc(16);
  wr32(f, 0x454c4946);
  wr32(f + 4, (u32)fd);
  return f;
}

static void f_malloc(void) { R[0] = gmalloc(R[0]); }
static void f_free(void) { gfree(R[0]); }
static void f_memcpy(void) { memmove(gptr(R[0]), gptr(R[1]), R[2]); }
static void f_memset(void) { memset(gptr(R[0]), (int)R[1], R[2]); }
static void f_strlen(void) { R[0] = (u32)gstrlen(R[0]); }
static void f_strcmp(void) {
  u32 a = R[0], b = R[1];
  for (;;) {
    u8 x = rd8(a++), y = rd8(b++);
    if (x != y || !x) { R[0] = (u32)(x - y); return; }
  }
}
static void f_strcpy(void) {
  u32 d = R[0], s = R[1];
  u8 c;
  do { c = rd8(s++); wr8(d++, c); } while (c);
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
static void f_sprintf(void) {
  // (buf, fmt, ...) - varargs start at r2
  u32 base = R[13] - 16;
  for (int i = 0; i < 4; i++) wr32(base + i * 4, R[i]);
  char tmp[2048];
  int n = guest_vformat(tmp, sizeof tmp, R[1], base + 8);
  int m = n < (int)sizeof tmp - 1 ? n : (int)sizeof tmp - 1;
  memcpy(gptr(R[0]), tmp, m);
  wr8(R[0] + m, 0);
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
static void f_puts(void) {
  if (log_enabled) { int n = gstrlen(R[0]); host_log((const char *)gptr(R[0]), n < 1024 ? n : 1024); }
  R[0] = 1;
}
static void f_zero(void) { R[0] = 0; }
static void f_minus_one(void) {
  wr32(guest_errno_addr, 101); // ENETUNREACH: there is no network here
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
static void f_time(void) {
  u32 t = (u32)(host_now() / 1000);
  if (R[0]) wr32(R[0], t);
  R[0] = t;
}
// struct tm in a static buffer, in Korean time (UTC+9)
static u32 tm_buf;
static void f_localtime(void) {
  s64 t = (s64)(s32)rd32(R[0]) + 9 * 3600;
  s64 days = t / 86400, rem = t % 86400;
  if (rem < 0) { rem += 86400; days--; }
  u32 hour = (u32)(rem / 3600), min = (u32)(rem % 3600 / 60), sec = (u32)(rem % 60);
  s32 wday = (s32)((days + 4) % 7);
  if (wday < 0) wday += 7;
  // civil from days (Howard Hinnant)
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
  int fd = (int)rd32(R[3] + 4);
  if (!size || !n) { R[0] = 0; return; }
  int got = fs_read(fd, R[0], size * n);
  R[0] = got <= 0 ? 0 : (u32)got / size;
  if (got >= 0 && (u32)got < size * n) wr32(R[3] + 8, 1);
}
static void f_fwrite(void) {
  u32 size = R[1], n = R[2];
  int fd = (int)rd32(R[3] + 4);
  if (!size || !n) { R[0] = 0; return; }
  int put = fs_write(fd, R[0], size * n);
  R[0] = put <= 0 ? 0 : (u32)put / size;
}
static void f_fseek(void) {
  int fd = (int)rd32(R[0] + 4);
  s64 r = fs_lseek(fd, (s32)R[1], (int)R[2]);
  wr32(R[0] + 8, 0);
  R[0] = r < 0 ? (u32)-1 : 0;
}
static void f_fclose(void) {
  if (!R[0]) { R[0] = (u32)-1; return; }
  int fd = (int)rd32(R[0] + 4);
  gfree(R[0]);
  R[0] = (u32)fs_close(fd);
}
static void f_close(void) { R[0] = (u32)fs_close((int)R[0]); }
static void f_remove(void) { R[0] = (u32)fs_unlink(R[0], 0); }
static void f_unwind_find_exidx(void) {
  wr32(R[1], exidx_count);
  R[0] = exidx_start;
}
static void f_cxa(void) { logf("C++ exception runtime called lr=%08x", R[14]); cpu_halt = 1; }

typedef struct {
  const char *name;
  Hle fn;
} ImportDef;

static const ImportDef import_defs[] = {
    {"malloc", f_malloc}, {"free", f_free}, {"memcpy", f_memcpy}, {"memset", f_memset}, {"strlen", f_strlen},
    {"strcmp", f_strcmp}, {"strcpy", f_strcpy}, {"strcat", f_strcat}, {"strstr", f_strstr}, {"atoi", f_atoi},
    {"abort", f_abort}, {"raise", f_raise}, {"__stack_chk_fail", f_stack_chk_fail}, {"sprintf", f_sprintf},
    {"__android_log_print", f_android_log_print}, {"puts", f_puts}, {"time", f_time}, {"localtime", f_localtime},
    {"socket", f_minus_one}, {"connect", f_minus_one}, {"recv", f_minus_one}, {"send", f_minus_one},
    {"inet_addr", f_inet_addr}, {"close", f_close}, {"fopen", f_fopen}, {"fread", f_fread}, {"fwrite", f_fwrite},
    {"fseek", f_fseek}, {"fclose", f_fclose}, {"remove", f_remove},
    {"__gnu_Unwind_Find_exidx", f_unwind_find_exidx}, {"__cxa_begin_cleanup", f_cxa},
    {"__cxa_call_unexpected", f_cxa}, {"__cxa_type_match", f_cxa}, {"__cxa_finalize", f_zero},
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
  (void)len;
  heaps_init();
  guest_errno_addr = data_alloc(4);
  stack_guard_addr = data_alloc(4);
  wr32(stack_guard_addr, 0x5a17c0de);
  tm_buf = data_alloc(48);
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
// The Java side of the game loop (AndDark/Native): a timer calls ProcessGame, which paints the
// title background into the screen bitmap while the title asks for it and then runs the native
// timer callback; UpdateGame then copies the native screen buffer into the bitmap that is shown.
static u32 n_start, n_event, n_timer, n_charge;
static u32 scr_array, net_array;
u32 scr_w, scr_h;        // size of the screen buffer the native draws into
u32 bmp_w, bmp_h;        // size of the Java screen bitmap
u16 *bitmap;             // what the view shows
static u16 *title_bg[2]; // backgrounds the title asks for, already scaled to the bitmap
int title_state;
int timer_interval = 62;

static void present_from_buffer(void) {
  u32 a = jni_array_addr(scr_array);
  if (a) memcpy(bitmap, gptr(a), bmp_w * bmp_h * 2);
}
void java_update_canvas(void) { present_from_buffer(); }
void java_update_screen_buffer(void) {
  u32 a = jni_array_addr(scr_array);
  if (a) memcpy(gptr(a), bitmap, bmp_w * bmp_h * 2);
}

EXPORT(set_title_bg) u16 *set_title_bg(int i) {
  if (i < 0 || i > 1) return 0;
  if (!title_bg[i]) title_bg[i] = hmalloc(bmp_w * bmp_h * 2);
  return title_bg[i];
}

EXPORT(app_start) int app_start(int screen_w, int screen_h) {
  // like AndDark.onCreate: devices 800 wide or more get a 400x240 bitmap scaled up, others draw 1:1
  scr_w = (u32)screen_w;
  scr_h = (u32)screen_h;
  bmp_w = screen_w >= 800 ? 400 : (u32)screen_w;
  bmp_h = screen_w >= 800 ? 240 : (u32)screen_h;
  bitmap = hmalloc(bmp_w * bmp_h * 2);
  memset(bitmap, 0, bmp_w * bmp_h * 2);
  n_start = find_symbol("Java_com_gamedoli_DarkWorldGoogle_Native_startCletN");
  n_event = find_symbol("Java_com_gamedoli_DarkWorldGoogle_Native_handleCletEventN");
  n_timer = find_symbol("Java_com_gamedoli_DarkWorldGoogle_Native_timerCallbackN");
  n_charge = find_symbol("Java_com_gamedoli_DarkWorldGoogle_Native_chargeN");
  u32 onload = find_symbol("JNI_OnLoad");
  if (!n_start || !n_event || !n_timer) { logf("entry points missing"); return -1; }
  if (onload) {
    u32 a[2] = {jni_vm_addr, 0};
    call_guest(onload, 2, a);
    jni_end_frame();
  }
  // The title asks once to confirm the player with KTH's server, which no longer answers: without the
  // confirmation file the game goes back to the title after every failed attempt. The game only checks
  // that the file exists, so it is written here the way MakeConfirmFile leaves it after a confirmation.
  static const char confirm[] = "/data/data/com.gamedoli.DarkWorldGoogle/_confirm.sav";
  if (!fs_exists(confirm)) {
    u8 zero[28] = {0};
    fs_put(confirm, zero, sizeof zero);
  }
  scr_array = jni_new_shorts(scr_w * scr_h);
  net_array = jni_new_bytes(100);
  // the Java side fills the first screen with white before the game starts
  u32 sa = jni_array_addr(scr_array);
  memset(gptr(sa), 0xff, scr_w * scr_h * 2);
  memset(bitmap, 0xff, bmp_w * bmp_h * 2);
  u32 a[6] = {jni_env_addr, jni_this_object(), scr_array, net_array, scr_w, scr_h};
  call_guest(n_start, 6, a);
  jni_end_frame();
  return cpu_halt ? -1 : 0;
}

EXPORT(app_tick) int app_tick(void) {
  if (cpu_halt) return -1;
  if (title_state > 0 && title_bg[title_state == 1 ? 0 : 1]) {
    memcpy(bitmap, title_bg[title_state == 1 ? 0 : 1], bmp_w * bmp_h * 2);
    java_update_screen_buffer();
  }
  u32 a[2] = {jni_env_addr, jni_this_object()};
  call_guest(n_timer, 2, a);
  jni_end_frame();
  present_from_buffer();
  return cpu_halt ? -1 : 0;
}

// touch: 23 down, 24 up, 25 move, in bitmap coordinates
EXPORT(app_touch) void app_touch(int type, int x, int y) {
  if (cpu_halt) return;
  u32 a[5] = {jni_env_addr, jni_this_object(), (u32)(type & 0xff), (u32)x, (u32)y};
  call_guest(n_event, 5, a);
  jni_end_frame();
}

// result of an in-app purchase (Native.charge): there is no store here, so the page reports failure
EXPORT(app_charge) void app_charge(int ok) {
  if (cpu_halt || !n_charge) return;
  u32 a[3] = {jni_env_addr, jni_this_object(), (u32)(ok ? 1 : 0)};
  call_guest(n_charge, 3, a);
  jni_end_frame();
}

EXPORT(screen) u16 *screen(void) { return bitmap; }
EXPORT(screen_w) u32 screen_w_export(void) { return bmp_w; }
EXPORT(screen_h) u32 screen_h_export(void) { return bmp_h; }
EXPORT(interval) int interval(void) { return timer_interval; }
EXPORT(guest_base) u8 *guest_base(void) { return G; }
EXPORT(host_alloc) void *host_alloc(u32 n) { return hmalloc(n); }
EXPORT(host_free) void host_free_export(void *p) { hfree(p); }
EXPORT(insn_count) double insn_count(void) { return (double)cpu_insns; }
EXPORT(heap_in_use) u32 heap_in_use(void) { return guest_heap_in_use(); }
EXPORT(heap_top) u32 heap_top(void) { return guest_heap_top(); }
EXPORT(set_logging) void set_logging(int on) { log_enabled = on; }
EXPORT(cpu_state) u32 *cpu_state(void) { return R; }
EXPORT(is_halted) int is_halted(void) { return (int)cpu_halt; }
