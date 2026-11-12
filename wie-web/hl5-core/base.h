// Shared definitions for the HL5 (EA Mobile "Midas" Android) runtime compiled to WebAssembly.
#pragma once

typedef unsigned char u8;
typedef signed char s8;
typedef unsigned short u16;
typedef short s16;
typedef unsigned int u32;
typedef int s32;
typedef unsigned long long u64;
typedef long long s64;
typedef unsigned long size_t;

#define EXPORT(name) __attribute__((export_name(#name)))
#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

// Guest address space: 64 MiB, addresses wrap with this mask so a bad pointer never traps the host.
#define GUEST_SIZE 0x04000000u
#define GUEST_MASK (GUEST_SIZE - 1)

// Fixed guest layout.
#define TRAP_BASE 0x00010000u // HLE entry points, 4 bytes apart
#define TRAP_COUNT 0x4000u
#define TRAP_END (TRAP_BASE + TRAP_COUNT * 4)
#define RETURN_MAGIC (TRAP_END - 4) // LR used when the host calls into the guest
#define DATA_BASE 0x00030000u       // small runtime data (JNI tables, errno, FILE structs, strings)
#define DATA_END 0x00100000u
#define LOAD_BASE 0x00100000u // where the .so is mapped
#define HEAP_BASE 0x00400000u
#define STACK_TOP 0x03FF0000u
#define STACK_SIZE 0x00200000u
#define HEAP_END (STACK_TOP - STACK_SIZE)

extern u8 G[]; // guest memory

static inline u32 rd32(u32 a) {
  u32 v;
  __builtin_memcpy(&v, G + (a & GUEST_MASK), 4);
  return v;
}
static inline u16 rd16(u32 a) {
  u16 v;
  __builtin_memcpy(&v, G + (a & GUEST_MASK), 2);
  return v;
}
static inline u8 rd8(u32 a) { return G[a & GUEST_MASK]; }
static inline void wr32(u32 a, u32 v) { __builtin_memcpy(G + (a & GUEST_MASK), &v, 4); }
static inline void wr16(u32 a, u16 v) { __builtin_memcpy(G + (a & GUEST_MASK), &v, 2); }
static inline void wr8(u32 a, u8 v) { G[a & GUEST_MASK] = v; }
static inline u8 *gptr(u32 a) { return G + (a & GUEST_MASK); }

// CPU state
extern u32 R[16];
extern u32 fN, fZ, fC, fV, fQ;
extern u32 cpu_pc;  // address of the next instruction
extern u32 cpu_halt; // non-zero stops the run loop (fatal error)
extern u64 cpu_insns;

u32 call_guest(u32 addr, int nargs, const u32 *args);
void cpu_run_until_return(void);

// HLE
void hle_dispatch(u32 index);

// host imports
IMPORT(host_log) void host_log(const char *s, int len);
IMPORT(host_now) double host_now(void);
IMPORT(host_pow) double host_pow(double a, double b);
IMPORT(host_vfs_read) int host_vfs_read(double offset, void *dst, int len);
IMPORT(host_audio) int host_audio(int op, double key, double a, double b, int c);
IMPORT(host_file_saved) void host_file_saved(const char *path, int plen, const void *data, int len);
IMPORT(host_file_deleted) void host_file_deleted(const char *path, int plen);
IMPORT(host_event) int host_event(int kind, int a, int b, int c);

// tiny libc for the host side
void *memcpy(void *d, const void *s, size_t n);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t hstrlen(const char *s);
int hstrcmp(const char *a, const char *b);
void logf(const char *fmt, ...);
int hsnprintf(char *buf, int cap, const char *fmt, ...);

// host heap
void *hmalloc(u32 n);
void hfree(void *p);
// guest heap
u32 gmalloc(u32 n);
void gfree(u32 a);
u32 gcalloc(u32 n);
u32 gstrdup_host(const char *s);
int gstrlen(u32 a);
