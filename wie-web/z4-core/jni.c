// A small JNI environment: enough of JNIEnv/JavaVM for Gamevil's Nexus2 glue, plus the Java side of
// com.gamevil.nexus2.Natives, NexusFont (text drawn by the page) and the signature check in NexusGLActivity.
#include "base.h"

// where saveFile/loadFile keep the game's saves (Android: SharedPreferences "gameSave")
static const char SAVE_DIR[] = "/gameSave/";

IMPORT(host_asset) int host_asset(const char *name, int nlen, void *dst, int cap);
IMPORT(host_sound) void host_sound(int op, int id, int vol, int loop);
// text drawn by the page in place of Android's Paint/Canvas (NexusFont); the operations are listed where
// the page implements host_text
IMPORT(host_text) int host_text(int op, int a, int b, void *buf, int len);

void native_timer_callback(int idx, int stamp);
extern u32 frame_count;

#define JNI_TRAP_BASE 0x1000 // trap indices for JNIEnv functions
#define JVM_TRAP_BASE 0x1200 // trap indices for JavaVM functions
#define NJNI 233

u32 jni_env_addr, jni_vm_addr;

// ---------------------------------------------------------------------------------------------
// Objects
enum { OBJ_FREE, OBJ_CLASS, OBJ_STRING, OBJ_BYTES, OBJ_SHORTS, OBJ_INTS, OBJ_FLOATS, OBJ_OBJECT, OBJ_OBJARRAY };
#define MAX_OBJS 4096
#define HANDLE_BASE 0x00001000u
typedef struct {
  u8 kind, global, keep;
  u32 gaddr, len; // array: element count; string: byte length (UTF-8)
  char name[64];
} Obj;
static Obj objs[MAX_OBJS];
static int obj_hint = 1;

static u32 obj_new(int kind) {
  for (int n = 0; n < MAX_OBJS; n++) {
    int i = (obj_hint + n) % MAX_OBJS;
    if (i == 0) continue;
    if (objs[i].kind == OBJ_FREE) {
      memset(&objs[i], 0, sizeof objs[i]);
      objs[i].kind = (u8)kind;
      obj_hint = i + 1;
      return HANDLE_BASE + i * 8;
    }
  }
  logf("jni: out of object handles");
  return 0;
}
static Obj *obj_get(u32 h) {
  if (h < HANDLE_BASE) return 0;
  u32 i = (h - HANDLE_BASE) / 8;
  if (i >= MAX_OBJS || objs[i].kind == OBJ_FREE) return 0;
  return &objs[i];
}
static void obj_free(Obj *o) {
  if (o->kind >= OBJ_STRING && o->kind <= OBJ_FLOATS && o->gaddr) gfree(o->gaddr);
  if (o->kind == OBJ_OBJARRAY && o->gaddr) gfree(o->gaddr);
  o->kind = OBJ_FREE;
}

// free local references when the outermost native call returns
void jni_end_frame(void) {
  for (int i = 1; i < MAX_OBJS; i++) {
    Obj *o = &objs[i];
    if (o->kind != OBJ_FREE && !o->global && !o->keep) obj_free(o);
  }
}

static void set_name(Obj *o, const char *name) {
  int n = hstrlen(name);
  if (n > 63) n = 63;
  memcpy(o->name, name, n);
  o->name[n] = 0;
}

static u32 class_handle(const char *name) {
  for (int i = 1; i < MAX_OBJS; i++)
    if (objs[i].kind == OBJ_CLASS && !hstrcmp(objs[i].name, name)) return HANDLE_BASE + i * 8;
  u32 h = obj_new(OBJ_CLASS);
  Obj *o = obj_get(h);
  o->keep = 1;
  set_name(o, name);
  return h;
}

static u32 new_object(const char *name) {
  u32 h = obj_new(OBJ_OBJECT);
  Obj *o = obj_get(h);
  if (o) set_name(o, name);
  return h;
}

static u32 new_string_bytes(const u8 *s, u32 n) {
  u32 h = obj_new(OBJ_STRING);
  Obj *o = obj_get(h);
  if (!o) return 0;
  o->len = n;
  o->gaddr = gmalloc(n + 1);
  memcpy(gwptr(o->gaddr, n), s, n);
  wr8(o->gaddr + n, 0);
  return h;
}
static u32 new_string(const char *s) { return new_string_bytes((const u8 *)s, hstrlen(s)); }

static int elem_size(int kind) { return kind == OBJ_BYTES ? 1 : kind == OBJ_SHORTS ? 2 : 4; }
static u32 new_array(int kind, u32 n) {
  u32 h = obj_new(kind);
  Obj *o = obj_get(h);
  if (!o) return 0;
  o->len = n;
  u32 bytes = n * elem_size(kind);
  o->gaddr = gcalloc(bytes + 4); // a few zero bytes past the end, for code that reads arrays as C strings
  return h;
}
static u32 new_bytes(const void *s, u32 n) {
  u32 h = new_array(OBJ_BYTES, n);
  Obj *o = obj_get(h);
  if (o && n) memcpy(gwptr(o->gaddr, n), s, n);
  return h;
}

u32 jni_this_object(void) {
  static u32 h;
  if (!h) { h = class_handle("com/gamevil/nexus2/Natives"); }
  return h;
}

static int copy_str(Obj *o, char *out, int cap) {
  int n = 0;
  if (o && (o->kind == OBJ_STRING || o->kind == OBJ_BYTES)) {
    for (; n < cap - 1 && n < (int)o->len; n++) out[n] = (char)rd8(o->gaddr + n);
  }
  out[n] = 0;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Arguments of Call*Method: varargs (spilled registers + stack), va_list, or jvalue array.
typedef struct {
  int form; // 0 varargs/va_list (memory with 8-byte alignment for 64-bit), 2 jvalue array
  u32 p;
} ArgReader;

static u64 next_arg(ArgReader *r, char t) {
  if (r->form == 2) {
    u64 v = (u64)rd32(r->p) | ((u64)rd32(r->p + 4) << 32);
    r->p += 8;
    if (t == 'J' || t == 'D') return v;
    return (u32)v;
  }
  if (t == 'J' || t == 'D') {
    r->p = (r->p + 7) & ~7u;
    u64 v = (u64)rd32(r->p) | ((u64)rd32(r->p + 4) << 32);
    r->p += 8;
    return v;
  }
  if (t == 'F') { // varargs promote float to double
    r->p = (r->p + 7) & ~7u;
    u64 bits = (u64)rd32(r->p) | ((u64)rd32(r->p + 4) << 32);
    r->p += 8;
    double d;
    __builtin_memcpy(&d, &bits, 8);
    float f = (float)d;
    u32 fb;
    __builtin_memcpy(&fb, &f, 4);
    return fb;
  }
  u32 v = rd32(r->p);
  r->p += 4;
  return v;
}

// spill r0-r3 so register and stack varargs form one array; first vararg is register index `first`
static ArgReader varargs_from(int first) {
  u32 base = R[13] - 16;
  for (int i = 0; i < 4; i++) wr32(base + i * 4, R[i]);
  ArgReader r = {0, base + first * 4};
  return r;
}

// ---------------------------------------------------------------------------------------------
// Java methods
typedef struct {
  char name[48];
  char sig[96];
} MethodRec;
#define MAX_METHODS 256
static MethodRec methods[MAX_METHODS];
static int nmethods;

static void read_name(u32 g, char *out, int cap) {
  int i;
  for (i = 0; i < cap - 1 && rd8(g + i); i++) out[i] = (char)rd8(g + i);
  out[i] = 0;
}

static u32 method_id(u32 gname, u32 gsig) {
  char name[48], sig[96];
  read_name(gname, name, sizeof name);
  read_name(gsig, sig, sizeof sig);
  for (int k = 0; k < nmethods; k++)
    if (!hstrcmp(methods[k].name, name) && !hstrcmp(methods[k].sig, sig)) return (u32)(k + 1);
  if (nmethods >= MAX_METHODS) return 0;
  memcpy(methods[nmethods].name, name, sizeof name);
  memcpy(methods[nmethods].sig, sig, sizeof sig);
  nmethods++;
  return (u32)nmethods; // jmethodID = index + 1
}

int trace_java;
EXPORT(set_trace_java) void set_trace_java(int on) { trace_java = on; }

static int streq(const char *a, const char *b) { return !hstrcmp(a, b); }

// --- async timers (NexusGLActivity.a(II) / OnAsyncTimerSet): fire after their time-out on the GL thread
#define MAX_TIMERS 8
static struct { int used, idx, stamp; double due; } timers[MAX_TIMERS];
static void timer_set(int timeout, int idx, int stamp) {
  for (int k = 0; k < MAX_TIMERS; k++)
    if (timers[k].used && timers[k].idx == idx) timers[k].used = 0;
  for (int k = 0; k < MAX_TIMERS; k++)
    if (!timers[k].used) {
      timers[k].used = 1;
      timers[k].idx = idx;
      timers[k].stamp = stamp;
      timers[k].due = host_now() + (timeout > 0 ? timeout : 0);
      return;
    }
}
void java_timers_run(void) {
  double now = host_now();
  for (int k = 0; k < MAX_TIMERS; k++)
    if (timers[k].used && timers[k].due <= now) {
      timers[k].used = 0;
      native_timer_callback(timers[k].idx, timers[k].stamp);
    }
}

// --- the signature check compares Signature.hashCode() with a value the library keeps
u32 expected_sig_hash_addr;

// --- NexusFont: one bitmap that text is drawn into, read back as 16- or 32-bit pixels
static u32 font_pixels;   // guest array handle (kept)
static u32 font_bpp = 32, font_w, font_h, font_colorkey;
static int font_cur = -1;
static u32 measure_rect, measure_size; // float[4], float[2]

static u32 f32bits(float f) { u32 v; __builtin_memcpy(&v, &f, 4); return v; }
static float bitsf32(u32 v) { float f; __builtin_memcpy(&f, &v, 4); return f; }


static u64 java_invoke(u32 mid, ArgReader *ar, u32 self) {
  if (mid == 0 || mid > (u32)nmethods) { logf("jni: bad method id %u", mid); return 0; }
  MethodRec *m = &methods[mid - 1];
  u64 a[8] = {0};
  int n = 0;
  const char *s = m->sig + 1;
  while (*s && *s != ')' && n < 8) {
    char t = *s;
    if (t == 'L') { while (*s && *s != ';') s++; }
    else if (t == '[') { while (*s == '[') s++; if (*s == 'L') while (*s && *s != ';') s++; t = 'L'; }
    a[n++] = next_arg(ar, t);
    s++;
  }
  const char *nm = m->name;
  if (trace_java) logf("java %s%s (%x, %x, %x, %x, %x, %x)", nm, m->sig, (u32)a[0], (u32)a[1], (u32)a[2], (u32)a[3], (u32)a[4], (u32)a[5]);
  (void)self;

  // ---- assets and saves
  if (streq(nm, "isAssetExist") || streq(nm, "readAssete")) {
    char name[160];
    int len = copy_str(obj_get((u32)a[0]), name, sizeof name);
    int size = host_asset(name, len, 0, 0);
    if (nm[0] == 'i') return size < 0 ? 0 : (u64)size;
    if (size < 0) { logf("missing asset %s", name); return 0; }
    u32 h = new_array(OBJ_BYTES, (u32)size);
    Obj *o = obj_get(h);
    if (o) host_asset(name, len, gwptr(o->gaddr, (u32)size), size);
    return h;
  }
  if (streq(nm, "isFileExist") || streq(nm, "loadFile") || streq(nm, "saveFile") || streq(nm, "deleteFile")) {
    char name[160], path[200];
    copy_str(obj_get((u32)a[0]), name, sizeof name);
    // Android keeps these in SharedPreferences ("gameSave"), apart from getAbsolueFilePath's directory where
    // the old file API (MC_fs) lives: at every start CMvApp::FileConvertToAndroidFile moves any old-API save
    // into this store and removes the old file, so the two must not be the same place (it removed the save)
    hsnprintf(path, sizeof path, "%s%s", SAVE_DIR, name);
    u32 gp = gstrdup_host(path);
    extern int fs_open(u32, int); extern int fs_close(int); extern int fs_read(int, u32, u32);
    extern int fs_write(int, u32, u32); extern s64 fs_lseek(int, s64, int); extern int fs_unlink(u32, int);
    u64 ret = 0;
    if (nm[0] == 'i') {
      int fd = fs_open(gp, 0);
      if (fd >= 0) { ret = (u64)fs_lseek(fd, 0, 2); fs_close(fd); }
    } else if (nm[0] == 'l') {
      int fd = fs_open(gp, 0);
      if (fd >= 0) {
        u32 size = (u32)fs_lseek(fd, 0, 2);
        fs_lseek(fd, 0, 0);
        u32 h = new_array(OBJ_BYTES, size);
        Obj *o = obj_get(h);
        if (o) fs_read(fd, o->gaddr, size);
        fs_close(fd);
        ret = h;
      }
    } else if (nm[0] == 's') {
      Obj *o = obj_get((u32)a[1]);
      int fd = fs_open(gp, 1 | 0x40 | 0x200);
      if (fd >= 0 && o) { fs_write(fd, o->gaddr, o->len); ret = o->len; }
      if (fd >= 0) fs_close(fd);
    } else {
      ret = fs_unlink(gp, 0) == 0;
    }
    gfree(gp);
    return ret;
  }
  if (streq(nm, "getAbsolueFilePath")) return new_string("/save/");

  // ---- timers, sound, events
  if (streq(nm, "OnAsyncTimerSet")) {
    timer_set((int)a[0], (int)a[1], n > 2 ? (int)a[2] : 0);
    return 0;
  }
  if (streq(nm, "OnSoundPlay")) { host_sound(1, (int)a[0], (int)a[1], (int)a[2]); return 0; }
  if (streq(nm, "OnStopSound")) { host_sound(2, (int)a[0], 0, 0); return 0; }
  if (streq(nm, "OnVibrate")) { host_event(1, (int)a[0], 0, 0); return 0; }
  if (streq(nm, "OnUIStatusChange")) { host_event(2, (int)a[0], 0, 0); return 0; }
  if (streq(nm, "OnEvent")) { host_event(3, (int)a[0], 0, 0); return 0; }
  if (streq(nm, "SetSpeed")) { host_event(5, (int)a[0], 0, 0); return 0; }
  if (streq(nm, "requestIAP")) { logf("requestIAP %d", (int)a[0]); host_event(4, (int)a[0], 0, 0); return 0; }

  // ---- device information (the return type follows the signature the library asked for)
  {
    static const char *const info[][2] = {
        {"getLanguage", "ko_KR"}, {"getPhoneModel", "SHV-E210S"}, {"getDeviceType", "SHV-E210S"},
        {"getOsVersion", "4.4.2"}, {"getPhoneNumber", "01000000000"}, {"getOldPhoneNumber", "01000000000"},
        {"getDeviceID", "000000000000000"}, {"getAndroidID", "0000000000000000"}, {"getSimSerialNumber", "0"},
        {"getMacAddress", "00:00:00:00:00:00"}, {"getInetHostAddress", "127.0.0.1"}, {"getCarrierName", "SKT"},
        {"getCompany", "SKT"}, {"getVersion", "1.2.6"}, {0, 0}};
    for (int k = 0; info[k][0]; k++)
      if (streq(nm, info[k][0])) {
        const char *ret = m->sig + hstrlen(m->sig) - 2;
        if (ret[0] == '[' && ret[1] == 'B') return new_bytes(info[k][1], hstrlen(info[k][1]));
        if (ret[1] == 'I' || ret[1] == 'Z' || ret[1] == 'J') return 0;
        return new_string(info[k][1]);
      }
  }
  if (streq(nm, "getLocaleID")) return 1; // Locale.KOREA
  if (streq(nm, "getTotalMemory") || streq(nm, "getMaxMemory")) return 512ull << 20;
  if (streq(nm, "getFreeMemory")) return 256ull << 20;
  if (streq(nm, "getUsedMemory")) return 64ull << 20;
  if (streq(nm, "getGLOptionLinear")) return 1;
  if (streq(nm, "isDomestic")) return 1;
  if (streq(nm, "getPlayerNameByte") || streq(nm, "getPlayerNumberByte")) return new_bytes("", 0);
  if (streq(nm, "getGamevilLiveID") || streq(nm, "getGamevilLivePW") || streq(nm, "getGamevilGiftString"))
    return new_bytes("", 0);

  // ---- signature check (NexusGLActivity.getPackageManager().getPackageInfo(...).signatures[0].hashCode())
  if (streq(nm, "getPackageManager")) return new_object("android/content/pm/PackageManager");
  if (streq(nm, "getPackageName")) return new_string("com.gamevil.zenonia4.global");
  if (streq(nm, "getPackageInfo")) return new_object("android/content/pm/PackageInfo");
  if (streq(nm, "hashCode")) return expected_sig_hash_addr ? rd32(expected_sig_hash_addr) : 0;

  // ---- NexusFont: the page draws the text (see host_text in the page for the operations)
  if (nm[0] == 'G' && nm[1] == 'F' && nm[2] == 'A') {
    const char *f = nm + 4;
    if (streq(f, "Init")) { // (w, h, bpp, colorkey, antialias, locale)
      font_w = (u32)a[0];
      font_h = (u32)a[1];
      font_bpp = (u32)a[2] == 16 ? 16 : 32;
      font_colorkey = (u32)a[3];
      if (!font_pixels) {
        font_pixels = new_array(font_bpp == 16 ? OBJ_SHORTS : OBJ_INTS, font_w * font_h);
        obj_get(font_pixels)->keep = 1;
        measure_rect = new_array(OBJ_FLOATS, 4);
        obj_get(measure_rect)->keep = 1;
        measure_size = new_array(OBJ_FLOATS, 2);
        obj_get(measure_size)->keep = 1;
      }
      host_text(6, (int)font_w, (int)font_h, 0, (int)(font_bpp | ((a[4] & 1) << 8)));
      host_text(18, (int)font_colorkey, 0, 0, 0);
      return 1;
    }
    if (streq(f, "IsInitialized")) return font_pixels != 0;
    if (streq(f, "SetAntiAlias")) { host_text(20, (int)a[0], 0, 0, 0); return 0; }
    if (streq(f, "Release") || streq(f, "ReleaseFont") || streq(f, "SetLocale") || streq(f, "SetTextAlign")) return 0;
    if (streq(f, "CreateFont")) return 0;
    if (streq(f, "SetFont")) { font_cur = (int)a[0]; return a[0]; }
    if (streq(f, "GetCurrentFont")) return (u64)(u32)font_cur;
    if (streq(f, "SetString")) {
      Obj *o = obj_get((u32)a[0]);
      host_text(1, 0, (int)a[1], o ? gptr(o->gaddr) : 0, o ? (int)o->len : 0);
      return 0;
    }
    if (streq(f, "SetStringFromKSC5601") || streq(f, "SetStringFromUnicode")) {
      Obj *o = obj_get((u32)a[0]);
      host_text(1, f[13] == 'K' ? 2 : 3, 0, o ? gptr(o->gaddr) : 0, o ? (int)o->len : 0);
      return 0;
    }
    if (streq(f, "GetStringLength")) return (u64)(u32)host_text(10, 0, 0, 0, 0);
    if (streq(f, "SetColor")) { host_text(3, (int)a[0], 0, 0, 0); return 0; }
    if (streq(f, "GetColor")) return (u64)(u32)host_text(11, 0, 0, 0, 0);
    if (streq(f, "SetTextSize")) { host_text(2, (int)a[0], 0, 0, 0); return 0; }
    if (streq(f, "GetTextSize")) return (u64)(u32)host_text(12, 0, 0, 0, 0);
    if (streq(f, "GetAscent")) return (u64)(u32)(host_text(7, 0, 0, 0, 0) >> 16);
    if (streq(f, "GetDescent")) return (u64)(u32)(host_text(7, 0, 0, 0, 0) & 0xffff);
    if (streq(f, "CharHeight")) return (u64)(u32)host_text(13, 0, 0, 0, 0);
    if (streq(f, "CharWidth")) return (u64)(u32)host_text(14, 0, 0, 0, 0);
    if (streq(f, "GetTextWidths")) { // (String, len) -> width of the first len characters
      Obj *o = obj_get((u32)a[0]);
      host_text(1, 0, (int)a[1], o ? gptr(o->gaddr) : 0, o ? (int)o->len : 0);
      return (u64)(u32)host_text(5, 0, 0, 0, 0);
    }
    if (streq(f, "DrawFont") || streq(f, "DrawText")) {
      Obj *px = obj_get(font_pixels), *r = obj_get(measure_rect);
      float rect[4] = {0, 0, 0, 0};
      u8 *pp = px ? gwptr(px->gaddr, font_w * font_h * (font_bpp / 8)) : 0;
      if (f[4] == 'F') host_text(4, 0, 0, pp, 0);
      else host_text(21, (int)a[0], (int)a[1], pp, (int)a[3]);
      host_text(15, 0, 0, rect, 4);
      if (r) for (int k = 0; k < 4; k++) wr32(r->gaddr + k * 4, f32bits(rect[k]));
      return measure_rect;
    }
    if (streq(f, "MeasureText")) { // (line spacing?, max width) -> {width, height}
      Obj *r = obj_get(measure_size);
      float sz[2] = {0, 0};
      host_text(16, (int)a[0], (int)a[1], sz, 2);
      if (r) for (int k = 0; k < 2; k++) wr32(r->gaddr + k * 4, f32bits(sz[k]));
      return measure_size;
    }
    if (streq(f, "GetPixels16") || streq(f, "GetPixels32")) return font_pixels;
    if (streq(f, "GetWordwrapPosition")) return (u64)(u32)host_text(22, (int)a[0], (int)a[1], 0, 0);
    if (streq(f, "GetWordwrapPositionEx")) { // (max width, int[] out) -> number of breaks, positions in out
      Obj *o = obj_get((u32)a[1]);
      return (u64)(u32)host_text(9, (int)a[0], o ? (int)o->len : 0, o ? gwptr(o->gaddr, o->len * 4) : 0, 0);
    }
    logf("jni: unhandled font method %s%s", nm, m->sig);
    return 0;
  }
  (void)bitsf32;

  // ---- everything else is UI, network, billing or analytics with no effect here
  if (streq(nm, "isNetAvailable") || streq(nm, "isGamevilLiveLogined") || streq(nm, "isOfferwallEnabled") ||
      streq(nm, "isUserAcceptC2dm"))
    return 0;
  if (streq(nm, "netConnect") || streq(nm, "netSocket") || streq(nm, "netBillcomSocketConnect") ||
      streq(nm, "netBillcomSocketWrite"))
    return (u64)(u32)-1;
  if (streq(nm, "netBillcomSocketRead")) return 0;
  if (streq(nm, "IsNexusSensorShakeDevice") || nm[0] == 'I' || (nm[0] == 'G' && nm[1] == 'e' && nm[2] == 't')) return 0;
  static const char *quiet[] = {"NexusTouchGestureEnable", "NexusTouchInitGestureName", "NexusTouchSimpleFlingEnable",
                                "NexusTouchSetShowGestureLine", "NexusSensorEnable", "NexusSensorOrientationType",
                                "NexusTouchSetCheckGestureBuilder", "NexusTouchSetUseCustomeGesture", "NexusSetBlockText",
                                "NexusSetEngInput", "clearPlayerName", "clearNumber", "NexusSetMaxLengthTextInput",
                                "NexusSetMaxLengthNumberInput", "NexusSetText", "setLocalPushNotification",
                                "cancelLocalPushNotification", "setUserAcceptC2dm", "netBillcomSocketClose",
                                "showLoadingDialog", "hideLoadingDialog", "showTitleComponent", "hideTitleComponent",
                                "showComponent", "hideComponent", "blinkSButton", "showMylSButton",
                                "openStoreWithProductId", "openUrl", "trackPageViewDispatch", "trackEventDispatch",
                                "reqestGamevilLiveLogin", "reqestGamevilLiveApp", "requestOfferwall", "requestGamevilGift",
                                "showTermsButton", "hideTermsButton", "saveGLOptionLinear", "updateDialogue",
                                "showReplyEventComponent", "hideReplyEventComponent", "showBuyShopButton",
                                "hideBuyShopButton", "showBuy", "closeBuy", "setPurchaseChange", 0};
  for (int k = 0; quiet[k]; k++)
    if (streq(nm, quiet[k])) { if (trace_java) logf("java (ignored) %s", nm); return 0; }
  logf("jni: unhandled method %s%s", nm, m->sig);
  return 0;
}

static void set_ret64(u64 v) {
  R[0] = (u32)v;
  R[1] = (u32)(v >> 32);
}

// fields: static fields of NexusGLActivity and PackageManager, and PackageInfo.signatures
typedef struct { char name[32]; } FieldRec;
static FieldRec fields[32];
static int nfields;
static u32 field_id(u32 gname) {
  char name[32];
  read_name(gname, name, sizeof name);
  for (int k = 0; k < nfields; k++)
    if (!hstrcmp(fields[k].name, name)) return (u32)(k + 1);
  if (nfields >= 32) return 0;
  memcpy(fields[nfields].name, name, sizeof name);
  return (u32)++nfields;
}
static u32 field_object(u32 fid) {
  const char *nm = fid && fid <= (u32)nfields ? fields[fid - 1].name : "";
  if (streq(nm, "myActivity")) return new_object("com/gamevil/nexus2/NexusGLActivity");
  if (streq(nm, "signatures")) {
    u32 h = obj_new(OBJ_OBJARRAY);
    Obj *o = obj_get(h);
    o->len = 1;
    o->gaddr = gcalloc(4);
    wr32(o->gaddr, new_object("android/content/pm/Signature"));
    return h;
  }
  logf("jni: object field %s", nm);
  return 0;
}
static u32 field_int(u32 fid) {
  const char *nm = fid && fid <= (u32)nfields ? fields[fid - 1].name : "";
  if (streq(nm, "GET_SIGNATURES")) return 64;
  logf("jni: int field %s", nm);
  return 0;
}

static u32 obj_kind_for_type(u32 idx) { // New<Type>Array, 175..182
  switch (idx) {
  case 175: case 176: return OBJ_BYTES;
  case 177: case 178: return OBJ_SHORTS;
  case 181: return OBJ_FLOATS;
  default: return OBJ_INTS;
  }
}

static void jni_call(u32 idx) {
  // Call<Type>Method family
  if ((idx >= 34 && idx <= 93) || (idx >= 114 && idx <= 143)) {
    int first; // register index of the first Java argument
    u32 base, mid;
    int nonvirt = idx >= 64 && idx <= 93;
    if (idx >= 114) { base = 114; mid = R[2]; first = 3; }
    else if (nonvirt) { base = 64; mid = R[3]; first = 4; }
    else { base = 34; mid = R[2]; first = 3; }
    int form = (idx - base) % 3;
    int type = (idx - base) / 3; // Object Boolean Byte Char Short Int Long Float Double Void
    ArgReader ar;
    if (form == 0) ar = varargs_from(first);
    else {
      u32 p = first < 4 ? R[first] : rd32(R[13] + (first - 4) * 4);
      ar.form = form == 1 ? 0 : 2;
      ar.p = p;
    }
    u64 v = java_invoke(mid, &ar, R[1]);
    if (type == 6 || type == 8) set_ret64(v);
    else R[0] = (u32)v;
    return;
  }
  switch (idx) {
  case 4: R[0] = 0x00010006; return; // GetVersion
  case 6: { char name[64]; read_name(R[1], name, 64); R[0] = class_handle(name); return; } // FindClass
  case 13: case 14: R[0] = 0; return; // Throw, ThrowNew
  case 15: R[0] = 0; return;          // ExceptionOccurred
  case 16: case 17: return;           // ExceptionDescribe, ExceptionClear
  case 18: logf("JNI FatalError"); cpu_halt = 1; return;
  case 19: R[0] = 0; return;    // PushLocalFrame
  case 20: R[0] = R[1]; return; // PopLocalFrame
  case 21: case 226: { Obj *o = obj_get(R[1]); if (o) o->global = 1; R[0] = R[1]; return; } // NewGlobalRef
  case 22: case 227: { Obj *o = obj_get(R[1]); if (o) o->global = 0; return; }              // DeleteGlobalRef
  case 23: { Obj *o = obj_get(R[1]); if (o && !o->global && !o->keep) obj_free(o); return; }
  case 24: R[0] = R[1] == R[2]; return;
  case 25: R[0] = R[1]; return;
  case 26: R[0] = 0; return;
  case 31: { // GetObjectClass
    Obj *o = obj_get(R[1]);
    R[0] = class_handle(o && o->kind == OBJ_OBJECT ? o->name : o && o->kind == OBJ_STRING ? "java/lang/String" : "java/lang/Object");
    return;
  }
  case 32: R[0] = 1; return;
  case 33: case 113: R[0] = method_id(R[2], R[3]); return; // GetMethodID, GetStaticMethodID
  case 94: case 144: R[0] = field_id(R[2]); return;        // GetFieldID, GetStaticFieldID
  case 95: case 145: R[0] = field_object(R[2]); return;    // Get(Static)ObjectField
  case 100: case 150: R[0] = field_int(R[2]); return;      // Get(Static)IntField
  case 96: case 97: case 98: case 99: case 146: case 147: case 148: case 149: R[0] = 0; return;
  case 104: case 105: case 106: case 107: case 108: case 109: case 110: case 111: case 112:
  case 154: case 155: case 156: case 157: case 158: case 159: case 160: case 161: case 162: return; // Set*Field
  case 163: R[0] = new_string(""); return; // NewString
  case 164: case 168: { Obj *o = obj_get(R[1]); R[0] = o ? o->len : 0; return; } // GetStringLength, UTFLength
  case 167: R[0] = R[1] ? new_string_bytes(gptr(R[1]), (u32)gstrlen(R[1])) : 0; return; // NewStringUTF
  case 165: case 169: case 224: { // GetStringChars / GetStringUTFChars / GetStringCritical
    Obj *o = obj_get(R[1]);
    if (R[2]) wr8(R[2], 0);
    R[0] = o ? o->gaddr : 0;
    return;
  }
  case 166: case 170: case 225: return; // Release...
  case 171: { Obj *o = obj_get(R[1]); R[0] = o ? o->len : 0; return; } // GetArrayLength
  case 172: { // NewObjectArray(len, class, init)
    u32 h = obj_new(OBJ_OBJARRAY);
    Obj *o = obj_get(h);
    if (o) { o->len = R[1]; o->gaddr = gcalloc(R[1] * 4 + 4); for (u32 k = 0; k < R[1]; k++) wr32(o->gaddr + k * 4, R[3]); }
    R[0] = h;
    return;
  }
  case 173: { Obj *o = obj_get(R[1]); R[0] = o && o->kind == OBJ_OBJARRAY && R[2] < o->len ? rd32(o->gaddr + R[2] * 4) : 0; return; }
  case 174: { Obj *o = obj_get(R[1]); if (o && o->kind == OBJ_OBJARRAY && R[2] < o->len) wr32(o->gaddr + R[2] * 4, R[3]); return; }
  case 175: case 176: case 177: case 178: case 179: case 180: case 181: case 182:
    R[0] = new_array(obj_kind_for_type(idx), R[1]);
    return;
  case 183: case 184: case 185: case 186: case 187: case 188: case 189: case 190: case 222: { // Get<T>ArrayElements
    Obj *o = obj_get(R[1]);
    if (R[2]) wr8(R[2], 0);
    R[0] = o ? o->gaddr : 0;
    return;
  }
  case 191: case 192: case 193: case 194: case 195: case 196: case 197: case 198: case 223: return;
  case 199: case 200: case 201: case 202: case 203: case 204: case 205: case 206: { // Get<T>ArrayRegion
    Obj *o = obj_get(R[1]);
    u32 buf = rd32(R[13]), el = o ? elem_size(o->kind) : 1;
    if (o) memmove(gwptr(buf, R[3] * el), gptr(o->gaddr + R[2] * el), R[3] * el);
    return;
  }
  case 207: case 208: case 209: case 210: case 211: case 212: case 213: case 214: { // Set<T>ArrayRegion
    Obj *o = obj_get(R[1]);
    u32 buf = rd32(R[13]), el = o ? elem_size(o->kind) : 1;
    if (o) memmove(gwptr(o->gaddr + R[2] * el, R[3] * el), gptr(buf), R[3] * el);
    return;
  }
  case 215: R[0] = 0; return;           // RegisterNatives
  case 217: case 218: R[0] = 0; return; // MonitorEnter/Exit
  case 219: wr32(R[1], jni_vm_addr); R[0] = 0; return; // GetJavaVM
  case 228: R[0] = 0; return;                          // ExceptionCheck
  case 232: R[0] = 1; return;                          // GetObjectRefType
  default:
    logf("jni: unimplemented function #%u from %08x", idx, R[14]);
    R[0] = 0;
    return;
  }
}

static void jvm_call(u32 idx) {
  switch (idx) {
  case 3: R[0] = 0; return; // DestroyJavaVM
  case 4: case 7: wr32(R[1], jni_env_addr); R[0] = 0; return; // AttachCurrentThread(AsDaemon)
  case 5: R[0] = 0; return; // DetachCurrentThread
  case 6: wr32(R[1], jni_env_addr); R[0] = 0; return; // GetEnv
  default: R[0] = (u32)-1; return;
  }
}

int jni_dispatch(u32 trap) {
  if (trap >= JNI_TRAP_BASE && trap < JNI_TRAP_BASE + NJNI) { jni_call(trap - JNI_TRAP_BASE); return 1; }
  if (trap >= JVM_TRAP_BASE && trap < JVM_TRAP_BASE + 8) { jvm_call(trap - JVM_TRAP_BASE); return 1; }
  return 0;
}

void jni_init(u32 (*data_alloc)(u32)) {
  u32 table = data_alloc(NJNI * 4);
  for (u32 i = 0; i < NJNI; i++) wr32(table + i * 4, TRAP_BASE + (JNI_TRAP_BASE + i) * 4);
  jni_env_addr = data_alloc(4);
  wr32(jni_env_addr, table);
  u32 vt = data_alloc(8 * 4);
  for (u32 i = 0; i < 8; i++) wr32(vt + i * 4, TRAP_BASE + (JVM_TRAP_BASE + i) * 4);
  jni_vm_addr = data_alloc(4);
  wr32(jni_vm_addr, vt);
}

// the object table, saved and put back around an in-between frame (motion.c)
u32 jni_state_size(void) { return sizeof objs + sizeof obj_hint; }
void jni_state(u8 *buf, int save) {
  if (save) { memcpy(buf, objs, sizeof objs); memcpy(buf + sizeof objs, &obj_hint, sizeof obj_hint); }
  else { memcpy(objs, buf, sizeof objs); memcpy(&obj_hint, buf + sizeof objs, sizeof obj_hint); }
}

// The directory of the game's own save store (saveFile/loadFile), apart from the old file API's: the page
// asks for it to know a core keeps saves where the game's start-up conversion leaves them alone.
EXPORT(save_store) const char *save_store(void) { return SAVE_DIR; }
