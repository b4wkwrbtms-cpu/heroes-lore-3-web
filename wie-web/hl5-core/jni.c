// A small JNI environment: just enough of JNIEnv/JavaVM for the Midas wrapper, plus the Java side
// of co.kr.eamobile.CletEntry implemented on the host.
#include "base.h"

int guest_vformat(char *buf, int cap, u32 gfmt, u32 gap);
int fs_open_external(const char *path);

#define JNI_TRAP_BASE 0x1000 // trap indices for JNIEnv functions
#define JVM_TRAP_BASE 0x1200 // trap indices for JavaVM functions
#define NJNI 233

u32 jni_env_addr, jni_vm_addr;

// ---------------------------------------------------------------------------------------------
// Objects
enum { OBJ_FREE, OBJ_CLASS, OBJ_STRING, OBJ_BYTES, OBJ_FD, OBJ_THIS, OBJ_OTHER };
#define MAX_OBJS 4096
#define HANDLE_BASE 0x00001000u
typedef struct {
  u8 kind, global, keep;
  u32 gaddr, len;
  int fd;
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
  if (o->kind == OBJ_STRING || o->kind == OBJ_BYTES) gfree(o->gaddr);
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

u32 jni_new_string(const char *s) {
  u32 h = obj_new(OBJ_STRING);
  Obj *o = obj_get(h);
  if (!o) return 0;
  o->len = hstrlen(s);
  o->gaddr = gstrdup_host(s);
  return h;
}

static u32 jni_new_string_guest(u32 g) {
  u32 h = obj_new(OBJ_STRING);
  Obj *o = obj_get(h);
  if (!o) return 0;
  o->len = gstrlen(g);
  o->gaddr = gmalloc(o->len + 1);
  memcpy(gptr(o->gaddr), gptr(g), o->len + 1);
  return h;
}

u32 jni_this_object(void) {
  static u32 h;
  if (!h) { h = obj_new(OBJ_THIS); obj_get(h)->keep = 1; }
  return h;
}

u32 jni_fd_object(int fd) {
  u32 h = obj_new(OBJ_FD);
  Obj *o = obj_get(h);
  o->fd = fd;
  o->keep = 1;
  return h;
}

static void copy_str(Obj *o, char *out, int cap) {
  int n = 0;
  if (o && o->kind == OBJ_STRING) {
    for (; n < cap - 1 && n < (int)o->len; n++) out[n] = (char)rd8(o->gaddr + n);
  }
  out[n] = 0;
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
    if (t == 'F') { float f; u32 b = (u32)v; __builtin_memcpy(&f, &b, 4); double d = f; u64 o; __builtin_memcpy(&o, &d, 8); return o; }
    return (u32)v;
  }
  if (t == 'J' || t == 'D' || t == 'F') {
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
// Java methods of CletEntry
#define METHODS(X) \
  X(attachBufferIDtoResourceID) X(clipFree) X(clipFreeMusic) X(clipFreeSound) X(clipPause) X(clipPauseMusic) \
  X(clipPauseSound) X(clipPlay) X(clipPlayMusic) X(clipPlaySound) X(clipResume) X(clipResumeMusic) \
  X(clipResumeSound) X(clipStop) X(clipStopMusic) X(clipStopSound) X(detachBufferIDfromResourceID) X(exitApp) \
  X(freeMemory) X(getAssetSize) X(getAvailableExternalMemorySize) X(getAvailableInternalMemorySize) \
  X(getClipStatus) X(getIMEI) X(getIMSI) X(getManufacturer) X(getMin) X(getModel) X(getMusicVolume) \
  X(getOSVersion) X(getOpenGLESVersion) X(getSoundVolume) X(getTotalExternalMemorySize) \
  X(getTotalInternalMemorySize) X(getUniqueAssetNameFromID) X(getUniqueNumberFromStrings) X(getVolume) \
  X(initMTX) X(isAirplaneModeOn) X(isFBOSupported) X(isNetworkAvailable) X(isNetworkRoaming) X(loadAsset) \
  X(loadWebpage) X(phnCallPlace) X(putClip) X(putMusicClip) X(putSoundClip) X(requestMTX) X(setMusicVolume) \
  X(setSoundVolume) X(setVolume) X(totalMemory) X(vibration)

#define ENUM_ITEM(n) M_##n,
enum { M_NONE, METHODS(ENUM_ITEM) M_COUNT };
#define NAME_ITEM(n) #n,
static const char *method_names[] = {"?", METHODS(NAME_ITEM)};

typedef struct {
  int id;
  char sig[64];
} MethodRec;
#define MAX_METHODS 128
static MethodRec methods[MAX_METHODS];
static int nmethods;

static u32 method_id(u32 gname, u32 gsig) {
  char name[64], sig[64];
  int i;
  for (i = 0; i < 63 && rd8(gname + i); i++) name[i] = (char)rd8(gname + i);
  name[i] = 0;
  for (i = 0; i < 63 && rd8(gsig + i); i++) sig[i] = (char)rd8(gsig + i);
  sig[i] = 0;
  int id = M_NONE;
  for (int k = 1; k < M_COUNT; k++)
    if (!hstrcmp(method_names[k], name)) { id = k; break; }
  if (id == M_NONE) logf("jni: unknown method %s%s", name, sig);
  if (nmethods >= MAX_METHODS) return 0;
  methods[nmethods].id = id;
  memcpy(methods[nmethods].sig, sig, sizeof sig);
  nmethods++;
  return (u32)nmethods; // jmethodID = index + 1
}

enum { AUD_PUT = 1, AUD_PLAY, AUD_STOP, AUD_PAUSE, AUD_RESUME, AUD_FREE, AUD_STATUS, AUD_SETVOL, AUD_GETVOL, AUD_PUTBUF };
enum { KIND_MEDIA = 0, KIND_MUSIC = 1, KIND_SOUND = 2 };
static int aud(int verb, int kind, double key, double a, double b, int c) { return host_audio(verb * 4 + kind, key, a, b, c); }

int trace_java;
#define MAX_ASSET_NAMES 4096
static char *asset_names[MAX_ASSET_NAMES];
static int nasset_names;

static u64 java_invoke(u32 mid, ArgReader *ar) {
  if (mid == 0 || mid > (u32)nmethods) { logf("jni: bad method id %u", mid); return 0; }
  MethodRec *m = &methods[mid - 1];
  u64 a[12] = {0};
  int n = 0;
  const char *s = m->sig + 1;
  while (*s && *s != ')' && n < 12) {
    char t = *s;
    if (t == 'L') { while (*s && *s != ';') s++; }
    else if (t == '[') { while (*s == '[') s++; if (*s == 'L') while (*s && *s != ';') s++; t = 'L'; }
    a[n++] = next_arg(ar, t);
    s++;
  }
  if (trace_java) logf("java %s%s (%x, %x, %x, %x)", method_names[m->id], m->sig, (u32)a[0], (u32)a[1], (u32)a[2], (u32)a[3]);
  double k = (double)a[0];
  switch (m->id) {
  case M_getModel: return jni_new_string("SHW-M110S");
  case M_getManufacturer: return jni_new_string("SAMSUNG");
  case M_getMin: return jni_new_string("01012345678");
  case M_getIMEI: return jni_new_string("356789012345678");
  case M_getIMSI: return jni_new_string("450050123456789");
  case M_getOpenGLESVersion: return jni_new_string("OpenGL ES-CM 1.1");
  case M_getOSVersion: return 8;
  case M_isFBOSupported: return 0;
  case M_freeMemory: return 24u << 20;
  case M_totalMemory: return 48u << 20;
  case M_getTotalExternalMemorySize:
  case M_getTotalInternalMemorySize: return 1ull << 30;
  case M_getAvailableExternalMemorySize:
  case M_getAvailableInternalMemorySize: return 512ull << 20;
  case M_isNetworkAvailable: return (u64)host_event(4, 0, 0, 0);
  case M_isNetworkRoaming: return 0;
  case M_isAirplaneModeOn: return 0;
  case M_vibration: host_event(1, (int)a[0], (int)a[1], 0); return 0;
  case M_exitApp: host_event(2, 0, 0, 0); return 0;
  case M_loadWebpage:
  case M_phnCallPlace: return (u64)-1;
  case M_initMTX: return 0;
  case M_requestMTX: {
    char x[64], y[64], z[64];
    copy_str(obj_get((u32)a[0]), x, 64);
    copy_str(obj_get((u32)a[1]), y, 64);
    copy_str(obj_get((u32)a[2]), z, 64);
    logf("requestMTX %s %s %s", x, y, z);
    return (u64)host_event(3, 0, 0, 0);
  }
  case M_getAssetSize: {
    char x[96];
    copy_str(obj_get((u32)a[0]), x, 96);
    logf("getAssetSize %s", x);
    return (u64)-1;
  }
  case M_getUniqueNumberFromStrings: {
    // sequential ids per distinct asset name, like the Java Hashtable
    char x[128];
    copy_str(obj_get((u32)a[0]), x, 128);
    for (int i = 0; i < nasset_names; i++)
      if (!hstrcmp(asset_names[i], x)) return (u64)(i + 1);
    if (nasset_names >= MAX_ASSET_NAMES) return 0;
    int n = hstrlen(x);
    asset_names[nasset_names] = hmalloc(n + 1);
    memcpy(asset_names[nasset_names], x, n + 1);
    return (u64)++nasset_names;
  }
  case M_getUniqueAssetNameFromID: {
    s32 id = (s32)a[0];
    if (id < 1 || id > nasset_names) return 0;
    return jni_new_string(asset_names[id - 1]);
  }
  case M_loadAsset: return (u64)-1;
  case M_attachBufferIDtoResourceID:
  case M_detachBufferIDfromResourceID: return 0;
  case M_putSoundClip: return (u64)(s64)aud(AUD_PUT, KIND_SOUND, k, (double)a[1], (double)a[2], (int)a[3]);
  case M_putMusicClip: return (u64)(s64)aud(AUD_PUT, KIND_MUSIC, k, (double)a[1], (double)a[2], 0);
  case M_putClip: {
    // (long key, int type, int ?, byte[] data, int offset, int length, ...) - media from a buffer
    Obj *o = obj_get((u32)a[3]);
    logf("putClip key=%u %d %d len=%u %d %d %d %d %d", (u32)a[0], (int)a[1], (int)a[2], o ? o->len : 0, (int)a[4], (int)a[5], (int)a[6], (int)a[7], (int)a[8]);
    if (!o) return (u64)-1;
    return (u64)(s64)host_audio(AUD_PUTBUF * 4 + KIND_MEDIA, k, (double)(o->gaddr + (u32)a[4]), (double)a[5], (int)a[1]);
  }
  case M_clipPlay: return (u64)(s64)aud(AUD_PLAY, KIND_MEDIA, k, (double)(a[1] & 0xff), 0, 0);
  case M_clipPlayMusic: return (u64)(s64)aud(AUD_PLAY, KIND_MUSIC, k, (double)(a[1] & 0xff), 0, 0);
  case M_clipPlaySound: return (u64)(s64)aud(AUD_PLAY, KIND_SOUND, k, (double)(a[1] & 0xff), 0, 0);
  case M_clipStop: return (u64)(s64)aud(AUD_STOP, KIND_MEDIA, k, 0, 0, 0);
  case M_clipStopMusic: return (u64)(s64)aud(AUD_STOP, KIND_MUSIC, k, 0, 0, 0);
  case M_clipStopSound: return (u64)(s64)aud(AUD_STOP, KIND_SOUND, k, 0, 0, 0);
  case M_clipPause: return (u64)(s64)aud(AUD_PAUSE, KIND_MEDIA, k, 0, 0, 0);
  case M_clipPauseMusic: return (u64)(s64)aud(AUD_PAUSE, KIND_MUSIC, k, 0, 0, 0);
  case M_clipPauseSound: return (u64)(s64)aud(AUD_PAUSE, KIND_SOUND, k, 0, 0, 0);
  case M_clipResume: return (u64)(s64)aud(AUD_RESUME, KIND_MEDIA, k, 0, 0, 0);
  case M_clipResumeMusic: return (u64)(s64)aud(AUD_RESUME, KIND_MUSIC, k, 0, 0, 0);
  case M_clipResumeSound: return (u64)(s64)aud(AUD_RESUME, KIND_SOUND, k, 0, 0, 0);
  case M_clipFree: return (u64)(s64)aud(AUD_FREE, KIND_MEDIA, k, 0, 0, 0);
  case M_clipFreeMusic: return (u64)(s64)aud(AUD_FREE, KIND_MUSIC, k, 0, 0, 0);
  case M_clipFreeSound: return (u64)(s64)aud(AUD_FREE, KIND_SOUND, k, 0, 0, 0);
  case M_getClipStatus: return (u64)(s64)aud(AUD_STATUS, KIND_MEDIA, k, 0, 0, 0);
  case M_setVolume: aud(AUD_SETVOL, KIND_MEDIA, 0, (double)(s32)a[0], 0, 0); return 0;
  case M_setMusicVolume: aud(AUD_SETVOL, KIND_MUSIC, 0, (double)(s32)a[0], 0, 0); return 0;
  case M_setSoundVolume: aud(AUD_SETVOL, KIND_SOUND, 0, (double)(s32)a[0], 0, 0); return 0;
  case M_getVolume: return (u64)(s64)aud(AUD_GETVOL, KIND_MEDIA, 0, 0, 0, 0);
  case M_getMusicVolume: return (u64)(s64)aud(AUD_GETVOL, KIND_MUSIC, 0, 0, 0, 0);
  case M_getSoundVolume: return (u64)(s64)aud(AUD_GETVOL, KIND_SOUND, 0, 0, 0, 0);
  default: logf("jni: unhandled method %s%s", method_names[m->id], m->sig); return 0;
  }
}

static const char *jni_names[NJNI] = {
    "reserved0", "reserved1", "reserved2", "reserved3", "GetVersion", "DefineClass", "FindClass",
    "FromReflectedMethod", "FromReflectedField", "ToReflectedMethod", "GetSuperclass", "IsAssignableFrom",
    "ToReflectedField", "Throw", "ThrowNew", "ExceptionOccurred", "ExceptionDescribe", "ExceptionClear",
    "FatalError", "PushLocalFrame", "PopLocalFrame", "NewGlobalRef", "DeleteGlobalRef", "DeleteLocalRef",
    "IsSameObject", "NewLocalRef", "EnsureLocalCapacity", "AllocObject", "NewObject", "NewObjectV", "NewObjectA",
    "GetObjectClass", "IsInstanceOf", "GetMethodID"};

static void set_ret64(u64 v) {
  R[0] = (u32)v;
  R[1] = (u32)(v >> 32);
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
  case 6: { // FindClass
    char name[64];
    int i;
    for (i = 0; i < 63 && rd8(R[1] + i); i++) name[i] = (char)rd8(R[1] + i);
    name[i] = 0;
    R[0] = class_handle(name);
    return;
  }
  case 13: case 14: R[0] = 0; return; // Throw, ThrowNew
  case 15: R[0] = 0; return;          // ExceptionOccurred
  case 16: case 17: return;           // ExceptionDescribe, ExceptionClear
  case 18: logf("JNI FatalError"); cpu_halt = 1; return;
  case 19: R[0] = 0; return;    // PushLocalFrame
  case 20: R[0] = R[1]; return; // PopLocalFrame
  case 21: { Obj *o = obj_get(R[1]); if (o) o->global = 1; R[0] = R[1]; return; }
  case 22: { Obj *o = obj_get(R[1]); if (o) o->global = 0; return; }
  case 23: { Obj *o = obj_get(R[1]); if (o && !o->global && !o->keep) obj_free(o); return; }
  case 24: R[0] = R[1] == R[2]; return;
  case 25: R[0] = R[1]; return;
  case 26: R[0] = 0; return;
  case 31: { // GetObjectClass
    Obj *o = obj_get(R[1]);
    R[0] = class_handle(o && o->kind == OBJ_FD ? "java/io/FileDescriptor" : o && o->kind == OBJ_STRING ? "java/lang/String" : "co/kr/eamobile/CletEntry");
    return;
  }
  case 32: R[0] = 1; return;
  case 33: case 113: R[0] = method_id(R[2], R[3]); return; // GetMethodID, GetStaticMethodID
  case 94: case 144: { // GetFieldID / GetStaticFieldID
    char name[32];
    int i;
    for (i = 0; i < 31 && rd8(R[2] + i); i++) name[i] = (char)rd8(R[2] + i);
    name[i] = 0;
    R[0] = !hstrcmp(name, "descriptor") ? 1 : 2;
    if (R[0] != 1) logf("jni: field %s", name);
    return;
  }
  case 100: { // GetIntField
    Obj *o = obj_get(R[1]);
    R[0] = (o && o->kind == OBJ_FD && R[2] == 1) ? (u32)o->fd : 0;
    return;
  }
  case 163: R[0] = jni_new_string(""); return;
  case 164: case 168: { Obj *o = obj_get(R[1]); R[0] = o ? o->len : 0; return; } // GetStringLength, UTFLength
  case 167: R[0] = R[1] ? jni_new_string_guest(R[1]) : 0; return;                // NewStringUTF
  case 169: { // GetStringUTFChars
    Obj *o = obj_get(R[1]);
    if (R[2]) wr8(R[2], 0);
    R[0] = o ? o->gaddr : 0;
    return;
  }
  case 170: return; // ReleaseStringUTFChars
  case 171: { Obj *o = obj_get(R[1]); R[0] = o ? o->len : 0; return; }
  case 176: { // NewByteArray
    u32 h = obj_new(OBJ_BYTES);
    Obj *o = obj_get(h);
    o->len = R[1];
    o->gaddr = gcalloc(R[1] ? R[1] : 1);
    R[0] = h;
    return;
  }
  case 184: case 222: { // GetByteArrayElements, GetPrimitiveArrayCritical
    Obj *o = obj_get(R[1]);
    if (R[2]) wr8(R[2], 0);
    R[0] = o ? o->gaddr : 0;
    return;
  }
  case 192: case 223: return; // ReleaseByteArrayElements, ReleasePrimitiveArrayCritical
  case 200: { // GetByteArrayRegion(env, arr, start, len, buf)
    Obj *o = obj_get(R[1]);
    u32 buf = rd32(R[13]);
    if (o) memmove(gptr(buf), gptr(o->gaddr + R[2]), R[3]);
    return;
  }
  case 208: { // SetByteArrayRegion
    Obj *o = obj_get(R[1]);
    u32 buf = rd32(R[13]);
    if (o) memmove(gptr(o->gaddr + R[2]), gptr(buf), R[3]);
    return;
  }
  case 217: case 218: R[0] = 0; return; // MonitorEnter/Exit
  case 219: wr32(R[1], jni_vm_addr); R[0] = 0; return; // GetJavaVM
  case 228: R[0] = 0; return; // ExceptionCheck
  default:
    logf("jni: unimplemented %s (#%u)", idx < 34 ? jni_names[idx] : "?", idx);
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
