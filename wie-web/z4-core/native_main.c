// Native test harness: runs the core on a computer with an extracted APK and writes frames as PPM.
// Build with build_native.sh. Paths: Z4_LIB (libgameDSO.so), Z4_ASSETS (the apk's assets/ folder, with a
// trailing slash), Z4_OUT (folder for frames and saves). Usage: z4native frames [script], where the
// script has lines "frame t x y" (tap), "frame d|m|u x y" (touch down, move, up), "frame s" (screenshot).
// Checks: SUMS=1 prints a checksum of every frame; AOT=n picks what runs translated or native (1 translated
// functions, 2 division helpers, 4 drawing routines); MOTION=f draws an in-between frame f/1024 of the way
// after every frame that moved (PAINTSHOT=frame writes a few of them); FX=1 turns on the hit reports.
#include "base.h"
int printf(const char *, ...);
int puts(const char *);
typedef struct _IO_FILE FILE;
FILE *fopen(const char *, const char *);
int fclose(FILE *);
size_t fread(void *, size_t, size_t, FILE *);
size_t fwrite(const void *, size_t, size_t, FILE *);
int fseek(FILE *, long, int);
long ftell(FILE *);
int fprintf(FILE *, const char *, ...);
int snprintf(char *, size_t, const char *, ...);
void *malloc(size_t);
int atoi(const char *);
char *getenv(const char *);
void exit(int);
extern FILE *stdout;
int fflush(FILE *);
#ifdef PROFILE
void dump_profile(void);
#endif

int load_library(const u8 *elf, u32 len);
int app_start(int w, int h);
int app_frame(void);
void app_event(int type, int p1, int p2, int p3);
u16 *screen(void);
extern u32 scr_w, scr_h, frame_count;
extern u32 expected_sig_hash_addr;
void set_trace_imports(int on);
void set_trace_java(int on);
void tweaks_apply(void);

static double now_ms = 1700000000000.0;
static const char *asset_root = "assets/";
static const char *out_dir = ".";
static int quiet;

void host_log(const char *s, int len) {
  if (quiet) return;
  printf("[log] %.*s\n", len, s);
}
static long now_calls;
double host_now(void) { now_calls++; now_ms += 0.05; return now_ms; }
void host_file_saved(const char *path, int plen, const void *data, int len) {
  printf("[save] %.*s (%d bytes)\n", plen, path, len);
  char p[512];
  int base = snprintf(p, sizeof p, "%s/savefs/", out_dir);
  snprintf(p + base, sizeof p - base, "%.*s", plen, path);
  for (char *c = p + base; *c; c++) if (*c == '/') *c = '_';
  FILE *f = fopen(p, "wb");
  if (f) { fwrite(data, 1, len, f); fclose(f); }
}
void host_file_deleted(const char *path, int plen) { printf("[delete] %.*s\n", plen, path); }
int host_event(int kind, int a, int b, int c) {
  printf("[event] %d %d %d %d\n", kind, a, b, c);
  return 0;
}
int host_asset(const char *name, int nlen, void *dst, int cap) {
  char path[512];
  snprintf(path, sizeof path, "%s%.*s", asset_root, nlen, name);
  FILE *f = fopen(path, "rb");
  if (!f) return -1;
  fseek(f, 0, 2);
  long n = ftell(f);
  if (dst) {
    fseek(f, 0, 0);
    fread(dst, 1, n < cap ? n : cap, f);
  }
  fclose(f);
  return (int)n;
}
void host_sound(int op, int id, int vol, int loop) {
  if (!quiet) printf("[sound] op %d id %d vol %d loop %d\n", op, id, vol, loop);
}
static float text_size = 12;
int host_text(int op, int a, int b, void *buf, int len) {
  (void)b; (void)buf; (void)len;
  switch (op) {
  case 1: {
    if (getenv("TEXT")) {
      char out[1024]; char *ip = (char *)buf, *op_ = out; size_t il = len, ol = sizeof out - 1;
      typedef void *iconv_t; iconv_t iconv_open(const char *, const char *); size_t iconv(iconv_t, char **, size_t *, char **, size_t *); int iconv_close(iconv_t);
      iconv_t cd = iconv_open("UTF-8", a == 2 ? "EUC-KR" : a == 3 ? "UTF-16LE" : "UTF-8");
      iconv(cd, &ip, &il, &op_, &ol); iconv_close(cd); *op_ = 0;
      printf("[text] %s\n", out);
    }
    return 0;
  }
  case 2: __builtin_memcpy(&text_size, &a, 4); return 0;
  case 7: return (11 << 16) | 3;
  case 12: { int v; __builtin_memcpy(&v, &text_size, 4); return v; }
  case 13: return (int)text_size;
  case 14: return (int)text_size;
  default: return 0;
  }
}

static void write_ppm(const char *path) {
  u16 *s = screen();
  if (!s) return;
  FILE *f = fopen(path, "wb");
  fprintf(f, "P6\n%u %u\n255\n", scr_w, scr_h);
  for (u32 i = 0; i < scr_w * scr_h; i++) {
    u16 p = s[i];
    u8 rgb[3] = {(u8)(((p >> 11) & 31) * 255 / 31), (u8)(((p >> 5) & 63) * 255 / 63), (u8)((p & 31) * 255 / 31)};
    fwrite(rgb, 1, 3, f);
  }
  fclose(f);
}

// script: lines "frame action args" read from a file: t x y (tap), d/m/u x y (touch down/move/up), s N (shot)
u32 find_symbol(const char *);
typedef void (*sighandler_t)(int);
sighandler_t signal(int, sighandler_t);
static void on_int(int sig) {
  (void)sig;
  printf("interrupted: pc=%08x (lib+%x) lr=%08x sp=%08x\n", cpu_pc, cpu_pc - LOAD_BASE, R[14], R[13]);
#ifdef PROFILE
  dump_profile();
#endif
  fflush(stdout);
  exit(1);
}
static u32 samples[0x200000 >> 2];
static void on_prof(int sig) {
  (void)sig;
  u32 off = cpu_pc - LOAD_BASE;
  if (off < 0x200000) samples[off >> 2]++;
}
static void dump_samples(void) {
  char p[512];
  snprintf(p, sizeof p, "%s/prof.bin", out_dir);
  FILE *f = fopen(p, "wb");
  fwrite(samples, 4, 0x200000 >> 2, f);
  fclose(f);
}
u32 find_symbol(const char *);
typedef void (*sighandler_t)(int);
sighandler_t signal(int, sighandler_t);
unsigned alarm(unsigned);
static void watchdog(int sig) {
  (void)sig;
  extern u32 cpu_pc;
  u32 lb = (find_symbol("JNI_OnLoad") & ~1u) - 0x94764;
  printf("watchdog: pc %x lr %x sp %x r0 %x r1 %x r2 %x r3 %x\n", cpu_pc - lb, (R[14] & ~1u) - lb, R[13], R[0], R[1], R[2], R[3]);
  printf("r4 %x r5 %x r6 %x r7 %x r8 %x:", R[4], R[5], R[6], R[7], R[8]);
  for (int i = 0; i < 48; i++) printf(" %02x", rd8(R[6] + i));
  printf("\n");
  for (int i = 0; i < 200; i++) { u32 v = rd32(R[13] + 4 * i); if (v - lb < 0x200000) printf("  stack %x\n", v - lb); }
  fflush(stdout);
  exit(3);
}
int main(int argc, char **argv) {
  if (getenv("WATCHDOG")) { signal(14, watchdog); alarm(atoi(getenv("WATCHDOG"))); }
  signal(2, on_int);
  int sample_from = getenv("SAMPLE") ? atoi(getenv("SAMPLE")) : -1;
  signal(27, on_prof);
  const char *lib = getenv("Z4_LIB") ? getenv("Z4_LIB") : "libgameDSO.so";
  if (getenv("Z4_ASSETS")) asset_root = getenv("Z4_ASSETS");
  if (getenv("Z4_OUT")) out_dir = getenv("Z4_OUT");
  int frames = argc > 1 ? atoi(argv[1]) : 300;
  int w = getenv("W") ? atoi(getenv("W")) : 800, h = getenv("H") ? atoi(getenv("H")) : 480;
  int shot_every = getenv("SHOT") ? atoi(getenv("SHOT")) : 50;
  quiet = getenv("QUIET") != 0;
  FILE *f = fopen(lib, "rb");
  fseek(f, 0, 2);
  long n = ftell(f);
  fseek(f, 0, 0);
  u8 *elf = malloc(n);
  fread(elf, 1, n, f);
  fclose(f);
  if (getenv("TRACE_IMPORTS")) set_trace_imports(1);
  if (getenv("TRACE_JAVA")) set_trace_java(1);
  if (load_library(elf, (u32)n)) { puts("load failed"); return 1; }
  { void aot_enable(int); aot_enable(getenv("AOT") ? atoi(getenv("AOT")) : 7); }
  if (getenv("LOADSAVE")) {
    // restore files saved by an earlier run (names keep '/' as '_')
    extern void fs_put(const char *path, const u8 *data, u32 len);
    typedef struct __dirstream DIR; struct dirent { unsigned long d_ino; long d_off; unsigned short d_reclen; unsigned char d_type; char d_name[256]; };
    DIR *opendir(const char *); struct dirent *readdir(DIR *); int closedir(DIR *);
    char sd[512];
    snprintf(sd, sizeof sd, "%s/savefs", out_dir);
    DIR *d = opendir(sd);
    struct dirent *e;
    while (d && (e = readdir(d))) {
      if (e->d_name[0] != '_') continue;
      char p[512];
      snprintf(p, sizeof p, "%s/%s", sd, e->d_name);
      FILE *f = fopen(p, "rb");
      fseek(f, 0, 2); long n = ftell(f); fseek(f, 0, 0);
      u8 *buf = malloc(n + 1); fread(buf, 1, n, f); fclose(f);
      char real[256]; snprintf(real, sizeof real, "%s", e->d_name);
      for (char *c = real, k = 0; *c && k < 2; c++) if (*c == '_') { *c = '/'; k++; } // _dir_name -> /dir/name
      fs_put(real, buf, (u32)n);
      printf("[restore] %s (%ld)\n", real, n);
    }
    if (d) closedir(d);
  }
  if (app_start(w, h)) { puts("start failed"); return 1; }
  if (getenv("FX")) { int fx_enable(int); printf("fx_enable %d\n", fx_enable(1)); }
  if (getenv("MONEY")) { int money_unlimited(int); printf("money_unlimited %d\n", money_unlimited(1)); }
  if (getenv("DPAD")) { int dpad_enable(void); printf("dpad_enable %d\n", dpad_enable()); }
  if (getenv("REFINE")) { int refine_easy(int); printf("refine_easy %d\n", refine_easy(1)); }
  if (getenv("CRITZOOM")) { int crit_zoom(int); printf("crit_zoom %d\n", crit_zoom(atoi(getenv("CRITZOOM")))); }
  { void net_trace_setup(void); net_trace_setup(); }
  if (getenv("NET")) { int net_enable(int); printf("net_enable %d\n", net_enable(1)); }
  if (getenv("SPMAX")) { int sp_unlimited(int); printf("sp_unlimited %d\n", sp_unlimited(1)); }
  if (getenv("DAMAGE")) { int damage_uncapped(int); printf("damage_uncapped %d\n", damage_uncapped(1)); }
  if (getenv("STATS")) { int stat_rules(int, int); printf("stat_rules %d\n", stat_rules(1, atoi(getenv("STATS")))); }
  // input script
  static int sc_frame[4096], sc_type[4096], sc_x[4096], sc_y[4096];
  int nsc = 0;
  if (argc > 2) {
    FILE *s = fopen(argv[2], "r");
    char line[128];
    extern char *fgets(char *, int, FILE *);
    extern int sscanf(const char *, const char *, ...);
    while (s && fgets(line, sizeof line, s) && nsc < 4096) {
      char c;
      int fr, x = 0, y = 0;
      if (sscanf(line, "%d %c %d %d", &fr, &c, &x, &y) >= 2) {
        sc_frame[nsc] = fr; sc_type[nsc] = c; sc_x[nsc] = x; sc_y[nsc] = y; nsc++;
      }
    }
  }
  int si = 0;
  for (int i = 0; i < frames; i++) {
    now_ms += 1000.0 / 30;
    while (si < nsc && sc_frame[si] <= i) {
      int t = sc_type[si];
      if (t == 't') { app_event(23, sc_x[si], sc_y[si], 0); app_frame(); now_ms += 33; app_event(24, sc_x[si], sc_y[si], 0); }
      else if (t == 'd') app_event(23, sc_x[si], sc_y[si], 0);
      else if (t == 'm') app_event(25, sc_x[si], sc_y[si], 0);
      else if (t == 'u') app_event(24, sc_x[si], sc_y[si], 0);
      else if (t == 'k') app_event(sc_x[si], sc_y[si], 0, 0);
      else if (t == 's') { char p[64]; snprintf(p, sizeof p, "%s/f%05d.ppm", out_dir, i); write_ppm(p); }
      si++;
    }
    if (i == sample_from) {
      struct itv { long a, b, c, d; } t = {0, 500, 0, 500};
      int setitimer(int, const void *, void *);
      setitimer(2, &t, 0);
    }
    if (getenv("TIMING") && i % 100 == 99) {
      struct ts { long s, ns; } t;
      int clock_gettime(int, struct ts *);
      static double last;
      clock_gettime(1, &t);
      double now = t.s * 1000.0 + t.ns / 1e6;
      if (last) printf("frames %d-%d: %.2f ms/frame, %ld clock reads/frame\n", i - 98, i + 1, (now - last) / 100, now_calls / 100);
      now_calls = 0;
      last = now;
    }
    if (getenv("PROGRESS") && i % 20 == 0) { printf("frame %d\n", i); fflush(stdout); }
    if (app_frame()) { printf("halted at frame %d\n", i); break; }
    if (getenv("SEQ") && i >= atoi(getenv("SEQ")) && i < atoi(getenv("SEQ")) + (getenv("SEQN") ? atoi(getenv("SEQN")) : 30)) {
      // test: what the page shows between this frame and the last, in thirds (in-between frames where it
      // makes them, else the game's frame), as s<frame>_<k>.ppm
      int motion_enable(int), motion_state(void), motion_paint(int, u16 *);
      static int on;
      static u16 *sbuf;
      if (!sbuf) sbuf = malloc(2048 * 1024 * 2);
      if (!on) { on = 1; motion_enable(1); }
      for (int k = 1; k <= 3; k++) {
        int st = motion_state(), r = -1;
        if (k < 3 && st > 0) r = motion_paint(k * 341, sbuf);
        u16 *src = r ? screen() : sbuf;
        char p[512];
        snprintf(p, sizeof p, "%s/s%05d_%d.ppm", out_dir, i, k);
        FILE *f = fopen(p, "wb");
        fprintf(f, "P6\n%u %u\n255\n", scr_w, scr_h);
        for (u32 q = 0; q < scr_w * scr_h; q++) {
          u16 v = src[q];
          u8 rgb[3] = {(u8)(((v >> 11) & 31) * 255 / 31), (u8)(((v >> 5) & 63) * 255 / 63), (u8)((v & 31) * 255 / 31)};
          fwrite(rgb, 1, 3, f);
        }
        fclose(f);
        if (k < 3) printf("seq %d.%d state %d %s\n", i, k, st, r ? "game frame" : "between");
      }
    }
    if (getenv("MOTION")) {
      int motion_enable(int), motion_state(void), motion_paint(int, u16 *);
      static int on;
      static u16 *pbuf;
      if (!on) { on = 1; printf("motion_enable %d\n", motion_enable(1)); }
      int st = motion_state();
      static int hist[3];
      hist[st + 1]++;
      if (i % 500 == 0) { u32 motion_pages(int); printf("motion states at %d: none-usable %d still %d moving %d (log pages %u)\n", i, hist[0], hist[1], hist[2], motion_pages(0)); }
      if (st > 0) {
        if (!pbuf) pbuf = malloc(2048 * 1024 * 2);
        int r = motion_paint(atoi(getenv("MOTION")), pbuf);
        static int painted, failed;
        if (r) failed++; else painted++;
        if (i % 100 == 0) printf("motion frame %d: painted %d failed %d\n", i, painted, failed);
        if (getenv("PAINTSHOT") && i >= atoi(getenv("PAINTSHOT")) && i < atoi(getenv("PAINTSHOT")) + 4 && !r) {
          char p[512];
          snprintf(p, sizeof p, "%s/p%05d.ppm", out_dir, i);
          FILE *f = fopen(p, "wb");
          fprintf(f, "P6\n%u %u\n255\n", scr_w, scr_h);
          for (u32 k = 0; k < scr_w * scr_h; k++) { u16 v = pbuf[k]; u8 rgb[3] = {(u8)(((v >> 11) & 31) * 255 / 31), (u8)(((v >> 5) & 63) * 255 / 63), (u8)((v & 31) * 255 / 31)}; fwrite(rgb, 1, 3, f); }
          fclose(f);
        }
      }
    }
    if (getenv("DPAD") && i % atoi(getenv("DPAD")) == 0) {
      int dpad_geom(s32 *);
      s32 g[4];
      int r = dpad_geom(g);
      if (r) printf("dpad at %d: off\n", i); else printf("dpad at %d: (%d,%d) inner %d outer %d\n", i, g[0], g[1], g[2], g[3]);
    }
    if (getenv("DMGTEST") && i == atoi(getenv("DMGTEST"))) {
      // test: the hero's attack damage on itself (CMvPlayer::CalcAttackDamage, vtable +0x1c4), a few rolls
      u32 find_symbol(const char *), call_guest(u32, int, const u32 *), gmalloc(u32);
      u32 as = find_symbol("_ZN12CMvStateMenu11OnApplyStatEb") & ~1u;
      u32 g = rd32(rd32(as + 0xc + rd32(as + 0x184))), player = g ? rd32(g + 8) : 0;
      u32 crit = gmalloc(4);
      printf("damage at %d:", i);
      for (int k = 0; k < 12 && player; k++) {
        wr32(crit, 0);
        u32 a[4] = {player, player, crit, 0xffffffffu};
        printf(" %d%s", (int)call_guest(rd32(rd32(player) + 0x1c4), 4, a), rd8(crit) ? "!" : "");
      }
      printf("\n");
    }
    if (getenv("HEROLOG") && i >= atoi(getenv("HEROLOG"))) {
      // test: the hero's map position each frame (the object manager's +8)
      u32 find_symbol(const char *);
      u32 md = find_symbol("_ZN6CMvMap4DrawEb") & ~1u;
      u32 mgr = rd32(rd32(md + 0x14 + rd32(md + 0x288) + rd32(md + 0x28c)));
      u32 h = mgr ? rd32(mgr + 8) : 0;
      if (h) printf("hero %d: %d %d\n", i, (s16)rd16(h + 0x36), (s16)rd16(h + 0x38));
    }
    if (getenv("HITTEST") && i == atoi(getenv("HITTEST"))) {
      // test: the hero takes a blow (CMvCharacter::SetDamage), to watch the number it shows
      u32 find_symbol(const char *), call_guest(u32, int, const u32 *);
      u32 as = find_symbol("_ZN12CMvStateMenu11OnApplyStatEb") & ~1u;
      u32 g = rd32(rd32(as + 0xc + rd32(as + 0x184))), player = g ? rd32(g + 8) : 0;
      u32 a[3] = {player, getenv("HITN") ? (u32)atoi(getenv("HITN")) : 127, 0};
      if (player) call_guest(find_symbol("_ZN12CMvCharacter9SetDamageEib"), 3, a);
      printf("hit at %d\n", i);
    }
    if (getenv("SPTEST") && i == atoi(getenv("SPTEST"))) {
      // test: empty the hero's SP, then ask whether a skill costing 100 can go off
      u32 find_symbol(const char *), call_guest(u32, int, const u32 *);
      u32 as = find_symbol("_ZN12CMvStateMenu11OnApplyStatEb") & ~1u;
      u32 g = rd32(rd32(as + 0xc + rd32(as + 0x184))), player = g ? rd32(g + 8) : 0;
      u32 xr = find_symbol("_Z13GsGetXorValueIiET_S0_");
      u32 a[3] = {player, 0, 1};
      call_guest(find_symbol("_ZN9CMvPlayer5SetSPEib"), 3, a);
      u32 v = rd32(player + 0x5c0), before = call_guest(xr, 1, &v);
      a[1] = 100;
      int ok = (int)call_guest(find_symbol("_ZN12CMvCharacter10IsEnoughSPEi"), 2, a);
      v = rd32(player + 0x5c0);
      printf("sp test at %d: sp %u, enough %d, sp now %u\n", i, before, ok, call_guest(xr, 1, &v));
    }
    if (getenv("SKILLS") && i == atoi(getenv("SKILLS"))) { int skills_max(void); printf("skills_max at %d: %d\n", i, skills_max()); }
    if (getenv("BOOST") && i == atoi(getenv("BOOST"))) {
      // test: put BOOSTN * 60000 points into STR (stat 0) the way the status window does
      u32 find_symbol(const char *), call_guest(u32, int, const u32 *);
      u32 as = find_symbol("_ZN12CMvStateMenu11OnApplyStatEb") & ~1u;
      u32 g = rd32(rd32(as + 0xc + rd32(as + 0x184))), player = g ? rd32(g + 8) : 0;
      u32 set = find_symbol("_ZN9CMvPlayer16SetMainStatPointEi"), use = find_symbol("_ZN9CMvPlayer16UseMainStatPointE8EnumStati");
      int n = getenv("BOOSTN") ? atoi(getenv("BOOSTN")) : 10;
      for (int k = 0; k < n && player; k++) {
        u32 a[3] = {player, 60000, 0};
        call_guest(set, 2, a);
        a[1] = 0; a[2] = (u32)-60000;
        call_guest(use, 3, a);
      }
      printf("boost at %d: player %x, +%d STR\n", i, player, n * 60000);
    }
    if (getenv("REFINETEST") && i == atoi(getenv("REFINETEST"))) {
      // DoRefine on the first bag slot with no helper item, with and without the easier refining
      int refine_easy(int);
      u32 find_symbol(const char *);
      u32 menu = gcalloc(0x400), dr = find_symbol("_ZN13CMvRefineMenu8DoRefineEv");
      u32 gri = find_symbol("_ZN13CMvRefineMenu13GetRefineItemEi");
      wr32(menu + 0x1dc, 0);
      u32 a2[2] = {menu, 0};
      u32 item = call_guest(gri, 2, a2);
      u8 keep = rd8(item + 7);
      for (u32 b = 0; b < 256; b += 15) {
        int ok[2] = {0, 0};
        for (int on = 0; on < 2; on++) {
          refine_easy(on);
          for (int k = 0; k < 300; k++) { wr8(item + 7, (u8)b); wr32(menu + 0x1dc, 0); wr32(menu + 0x1e0, 0xffffffffu); if (call_guest(dr, 1, &menu) == 0) ok[on]++; }
        }
        printf("refine test, level byte %02x: %d%% off, %d%% on\n", b, ok[0] / 3, ok[1] / 3);
      }
      wr8(item + 7, keep);
    }
    if (getenv("SUMS") && screen()) { u32 h = 2166136261u; u16 *sp = screen(); for (u32 k = 0; k < scr_w * scr_h; k++) h = (h ^ sp[k]) * 16777619u; printf("sum %d %08x\n", i, h); }
    if (shot_every && i % shot_every == 0) {
      char p[512];
      snprintf(p, sizeof p, "%s/f%05d.ppm", out_dir, i);
      write_ppm(p);
    }
  }
  printf("frames uploaded %u\n", frame_count);
  if (getenv("SAMPLE")) dump_samples();
#ifdef PROFILE
  { void dump_profile(void); dump_profile(); }
#endif
#ifdef STATS
  { extern u64 cpu_insns; printf("insns %llu (%.1f M/frame)\n", cpu_insns, cpu_insns / 1e6 / frames); }
#endif
  { char p[512]; snprintf(p, sizeof p, "%s/last.ppm", out_dir); write_ppm(p); }
  return 0;
}
#ifdef PROFILE
u32 *prof_buf(void);
void dump_profile(void) {
  char p[512];
  snprintf(p, sizeof p, "%s/prof.bin", out_dir);
  FILE *f = fopen(p, "wb");
  fwrite(prof_buf(), 4, 0x200000 >> 2, f);
  fclose(f);
}
#endif
