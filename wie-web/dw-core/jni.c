// A small JNI environment: just enough of JNIEnv/JavaVM for the game's native glue, plus the Java
// side of com.gamedoli.DarkWorldGoogle.Native implemented on the host.
#include "base.h"

IMPORT(host_asset) int host_asset(const char *name, int nlen, void *dst, int cap);
IMPORT(host_sound) void host_sound(int op, const char *name, int nlen, int loop);

void java_update_canvas(void);
void java_update_screen_buffer(void);
extern int title_state, timer_interval;

#define JNI_TRAP_BASE 0x1000 // trap indices for JNIEnv functions
#define JVM_TRAP_BASE 0x1200 // trap indices for JavaVM functions
#define NJNI 233

u32 jni_env_addr, jni_vm_addr;

// ---------------------------------------------------------------------------------------------
// Objects
enum { OBJ_FREE, OBJ_CLASS, OBJ_STRING, OBJ_BYTES, OBJ_SHORTS, OBJ_THIS };
#define MAX_OBJS 4096
#define HANDLE_BASE 0x00001000u
typedef struct {
  u8 kind, global, keep;
  u32 gaddr, len; // array: element count; string: byte length
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
  if (o->kind == OBJ_STRING || o->kind == OBJ_BYTES || o->kind == OBJ_SHORTS) gfree(o->gaddr);
  o->kind = OBJ_FREE;
}

// free local references when the outermost native call returns
void jni_end_frame(void) {
  for (int i = 1; i < MAX_OBJS; i++) {
    Obj *o = &objs[i];
    if (o->kind != OBJ_FREE && !o->global && !o->keep) obj_free(o);
  }
}

static u32 class_handle(const char *name) {
  for (int i = 1; i < MAX_OBJS; i++)
    if (objs[i].kind == OBJ_CLASS && !hstrcmp(objs[i].name, name)) return HANDLE_BASE + i * 8;
  u32 h = obj_new(OBJ_CLASS);
  Obj *o = obj_get(h);
  o->keep = 1;
  int n = hstrlen(name);
  if (n > 63) n = 63;
  memcpy(o->name, name, n);
  o->name[n] = 0;
  return h;
}

static u32 new_string_bytes(const u8 *s, u32 n) {
  u32 h = obj_new(OBJ_STRING);
  Obj *o = obj_get(h);
  if (!o) return 0;
  o->len = n;
  o->gaddr = gmalloc(n + 1);
  memcpy(gptr(o->gaddr), s, n);
  wr8(o->gaddr + n, 0);
  return h;
}

static u32 new_array(int kind, u32 n, int elem) {
  u32 h = obj_new(kind);
  Obj *o = obj_get(h);
  if (!o) return 0;
  o->len = n;
  o->gaddr = gcalloc(n * elem ? n * elem : 1);
  return h;
}
static u32 new_bytes_host(const char *s, u32 n) {
  u32 h = new_array(OBJ_BYTES, n, 1);
  Obj *o = obj_get(h);
  if (o) memcpy(gptr(o->gaddr), s, n);
  return h;
}

// arrays the Java side keeps for the whole run (screen and network buffers)
u32 jni_new_shorts(u32 n) { u32 h = new_array(OBJ_SHORTS, n, 2); obj_get(h)->keep = 1; return h; }
u32 jni_new_bytes(u32 n) { u32 h = new_array(OBJ_BYTES, n, 1); obj_get(h)->keep = 1; return h; }
u32 jni_array_addr(u32 h) { Obj *o = obj_get(h); return o ? o->gaddr : 0; }

u32 jni_this_object(void) {
  static u32 h;
  if (!h) { h = obj_new(OBJ_THIS); obj_get(h)->keep = 1; }
  return h;
}

static int copy_str(Obj *o, char *out, int cap) {
  int n = 0;
  if (o && o->kind == OBJ_STRING) {
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
// Java methods of Native
#define METHODS(X) \
  X(ChangeTitleState) X(CreateImage) X(DestroyImage) X(DrawVersion) X(GetHeight) X(GetImageBuffer) \
  X(GetKeyCode) X(GetTime_MilliSec) X(GetWidth) X(GoBannerSite) X(LGTBillGetChargeSlotID) X(LGT_BillConnect) \
  X(LGT_BillWrite) X(QtPlaySound) X(QtStopSound) X(QtVibrate) X(buyItem) X(charge) X(chargeLGT) X(getData) \
  X(getResource) X(getResourceSize) X(getTelephoneModel) X(getTelephoneNumber) X(handleCletEvent) \
  X(setGameState) X(setTimer) X(startClet) X(timerCallback) X(updateCanvas) X(updateScreenBuffer)

#define ENUM_ITEM(n) M_##n,
enum { M_NONE, METHODS(ENUM_ITEM) M_COUNT };
#define NAME_ITEM(n) #n,
static const char *method_names[] = {"?", METHODS(NAME_ITEM)};

typedef struct {
  int id;
  char name[48];
  char sig[64];
} MethodRec;
#define MAX_METHODS 128
static MethodRec methods[MAX_METHODS];
static int nmethods;

static u32 method_id(u32 gname, u32 gsig) {
  char name[48], sig[64];
  int i;
  for (i = 0; i < 47 && rd8(gname + i); i++) name[i] = (char)rd8(gname + i);
  name[i] = 0;
  for (i = 0; i < 63 && rd8(gsig + i); i++) sig[i] = (char)rd8(gsig + i);
  sig[i] = 0;
  for (int k = 0; k < nmethods; k++)
    if (!hstrcmp(methods[k].name, name) && !hstrcmp(methods[k].sig, sig)) return (u32)(k + 1);
  int id = M_NONE;
  for (int k = 1; k < M_COUNT; k++)
    if (!hstrcmp(method_names[k], name)) { id = k; break; }
  if (id == M_NONE) logf("jni: unknown method %s%s", name, sig);
  if (nmethods >= MAX_METHODS) return 0;
  methods[nmethods].id = id;
  memcpy(methods[nmethods].name, name, sizeof name);
  memcpy(methods[nmethods].sig, sig, sizeof sig);
  nmethods++;
  return (u32)nmethods; // jmethodID = index + 1
}

int trace_java;
EXPORT(set_trace_java) void set_trace_java(int on) { trace_java = on; }

static const char phone_model[] = "SHW-M250S";
static const char phone_number[] = "01012341234";

static int asset_of(Obj *o, char *name) {
  int n = copy_str(o, name, 160);
  // like Native.CreateImage/getResource: a leading slash is dropped
  if (name[0] == '/') { memmove(name, name + 1, n); n--; }
  return n;
}

static u64 java_invoke(u32 mid, ArgReader *ar) {
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
  if (trace_java) logf("java %s%s (%x, %x, %x)", m->name, m->sig, (u32)a[0], (u32)a[1], (u32)a[2]);
  switch (m->id) {
  case M_ChangeTitleState: title_state = (int)a[0]; return 0;
  case M_GetTime_MilliSec: return (u64)host_now();
  case M_GetKeyCode: return 0;
  case M_setTimer:
    if ((int)a[0] > 0 && (int)a[0] != timer_interval) { timer_interval = (int)a[0]; host_event(3, timer_interval, 0, 0); }
    return 0;
  case M_updateCanvas: java_update_canvas(); return 0;
  case M_updateScreenBuffer: java_update_screen_buffer(); return 0;
  case M_getResourceSize: {
    char name[160];
    int len = asset_of(obj_get((u32)a[0]), name);
    int size = host_asset(name, len, 0, 0);
    return (u64)(s64)(size < 0 ? 0 : size);
  }
  case M_getResource:
  case M_getData: {
    char name[160];
    int len = asset_of(obj_get((u32)a[0]), name);
    int size = host_asset(name, len, 0, 0);
    if (size < 0) { logf("missing resource %s", name); return 0; }
    u32 h = new_array(OBJ_BYTES, (u32)size, 1);
    Obj *o = obj_get(h);
    if (o) host_asset(name, len, gptr(o->gaddr), size);
    return h;
  }
  case M_QtPlaySound: {
    char name[64];
    int len = copy_str(obj_get((u32)a[0]), name, 64);
    host_sound(1, name, len, (int)a[1] == 1);
    return 0;
  }
  case M_QtStopSound: host_sound(2, 0, 0, 0); return 0;
  case M_QtVibrate: host_event(1, 200, 0, 0); return 0;
  case M_getTelephoneModel: return new_bytes_host(phone_model, sizeof phone_model - 1);
  case M_getTelephoneNumber: return new_bytes_host(phone_number, sizeof phone_number - 1);
  case M_LGT_BillConnect: return 0;
  case M_buyItem: {
    char item[64];
    copy_str(obj_get((u32)a[0]), item, 64);
    logf("buyItem %s %d", item, (int)a[1]);
    host_event(4, (int)a[1], 0, 0);
    return 0;
  }
  case M_CreateImage:
  case M_DestroyImage: {
    char name[160];
    asset_of(obj_get((u32)a[0]), name);
    logf("%s %s", m->name, name);
    return 0;
  }
  case M_GetWidth:
  case M_GetHeight:
  case M_GetImageBuffer:
  case M_DrawVersion:
  case M_GoBannerSite:
  case M_LGT_BillWrite:
  case M_LGTBillGetChargeSlotID:
  case M_setGameState:
    return 0;
  default: logf("jni: unhandled method %s%s", m->name, m->sig); return 0;
  }
}

static void set_ret64(u64 v) {
  R[0] = (u32)v;
  R[1] = (u32)(v >> 32);
}

static void read_name(u32 g, char *out, int cap) {
  int i;
  for (i = 0; i < cap - 1 && rd8(g + i); i++) out[i] = (char)rd8(g + i);
  out[i] = 0;
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
    u64 v = java_invoke(mid, &ar);
    if (type == 6 || type == 8) set_ret64(v);
    else R[0] = (u32)v;
    return;
  }
  switch (idx) {
  case 4: R[0] = 0x00010004; return; // GetVersion
  case 6: { char name[64]; read_name(R[1], name, 64); R[0] = class_handle(name); return; } // FindClass
  case 13: case 14: R[0] = 0; return; // Throw, ThrowNew
  case 15: R[0] = 0; return;          // ExceptionOccurred
  case 16: case 17: return;           // ExceptionDescribe, ExceptionClear
  case 18: logf("JNI FatalError"); cpu_halt = 1; return;
  case 19: R[0] = 0; return;    // PushLocalFrame
  case 20: R[0] = R[1]; return; // PopLocalFrame
  case 21: { Obj *o = obj_get(R[1]); if (o) o->global = 1; R[0] = R[1]; return; } // NewGlobalRef
  case 22: { Obj *o = obj_get(R[1]); if (o) o->global = 0; return; }              // DeleteGlobalRef
  case 23: { Obj *o = obj_get(R[1]); if (o && !o->global && !o->keep) obj_free(o); return; }
  case 24: R[0] = R[1] == R[2]; return;
  case 25: R[0] = R[1]; return;
  case 26: R[0] = 0; return;
  case 31: { // GetObjectClass
    Obj *o = obj_get(R[1]);
    R[0] = class_handle(o && o->kind == OBJ_STRING ? "java/lang/String" : "com/gamedoli/DarkWorldGoogle/Native");
    return;
  }
  case 32: R[0] = 1; return;
  case 33: case 113: R[0] = method_id(R[2], R[3]); return; // GetMethodID, GetStaticMethodID
  case 94: case 144: { char name[32]; read_name(R[2], name, 32); logf("jni: field %s", name); R[0] = 1; return; }
  case 163: R[0] = new_string_bytes((const u8 *)"", 0); return;
  case 164: case 168: { Obj *o = obj_get(R[1]); R[0] = o ? o->len : 0; return; } // GetStringLength, UTFLength
  case 167: R[0] = R[1] ? new_string_bytes(gptr(R[1]), (u32)gstrlen(R[1])) : 0; return; // NewStringUTF
  case 169: { // GetStringUTFChars
    Obj *o = obj_get(R[1]);
    if (R[2]) wr8(R[2], 0);
    R[0] = o ? o->gaddr : 0;
    return;
  }
  case 170: return; // ReleaseStringUTFChars
  case 171: { Obj *o = obj_get(R[1]); R[0] = o ? o->len : 0; return; } // GetArrayLength
  case 176: R[0] = new_array(OBJ_BYTES, R[1], 1); return;               // NewByteArray
  case 178: R[0] = new_array(OBJ_SHORTS, R[1], 2); return;              // NewShortArray
  case 183: case 184: case 186: case 222: { // Get<Boolean|Byte|Short>ArrayElements, GetPrimitiveArrayCritical
    Obj *o = obj_get(R[1]);
    if (R[2]) wr8(R[2], 0);
    R[0] = o ? o->gaddr : 0;
    return;
  }
  case 191: case 192: case 194: case 223: return; // Release...ArrayElements, ReleasePrimitiveArrayCritical
  case 199: case 200: case 202: { // Get<Boolean|Byte|Short>ArrayRegion(env, arr, start, len, buf)
    Obj *o = obj_get(R[1]);
    u32 buf = rd32(R[13]), el = idx == 202 ? 2 : 1;
    if (o) memmove(gptr(buf), gptr(o->gaddr + R[2] * el), R[3] * el);
    return;
  }
  case 207: case 208: case 210: { // Set<Boolean|Byte|Short>ArrayRegion
    Obj *o = obj_get(R[1]);
    u32 buf = rd32(R[13]), el = idx == 210 ? 2 : 1;
    if (o) memmove(gptr(o->gaddr + R[2] * el), gptr(buf), R[3] * el);
    return;
  }
  case 215: R[0] = 0; return; // RegisterNatives
  case 217: case 218: R[0] = 0; return; // MonitorEnter/Exit
  case 219: wr32(R[1], jni_vm_addr); R[0] = 0; return; // GetJavaVM
  case 228: R[0] = 0; return; // ExceptionCheck
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
