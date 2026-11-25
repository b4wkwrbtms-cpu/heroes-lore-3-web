// The translated functions (aot_gen.c, made by aot.py from the player's own copy of the library) as a
// module of their own: the page loads it next to the site's core, which keeps every other part (and its
// updates), and hands the table over with aot_attach. Never committed with aot_gen.c.
#include "cpu_core.h"
typedef struct { u32 addr; void (*fn)(void); } AotEntry;
extern const AotEntry aot_entries[];
extern const int aot_count;
extern const u32 aot_text_lo, aot_text_hi, aot_text_hash;
// out: the table, its length, the library text range and checksum, the interpreter build (AOT_ABI)
EXPORT(aot_side) void aot_side(u32 *out) {
  out[0] = (u32)aot_entries;
  out[1] = (u32)aot_count;
  out[2] = aot_text_lo;
  out[3] = aot_text_hi;
  out[4] = aot_text_hash;
  out[5] = AOT_ABI;
}
