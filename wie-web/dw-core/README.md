# dw-core

The engine behind `wie-web/public/darkworld/`, the iPhone player for 다크월드 (Gamedoli, Android), and behind
`wie-web/public/darkworld-web/`, which runs a modified build of the same library (the 1.57 web build).

The Android release is a small Java shell (`com.gamedoli.DarkWorldGoogle`) around one native library
(`lib/armeabi/libDarkWorld.so`, mostly Thumb code). The shell hands the library a 16-bit screen buffer, forwards
touches and keys, calls it on a timer and plays the sounds it names. This core runs the library directly:

- `cpu.c`, `thumb.inc` — ARMv5TE interpreter with the Thumb instruction set and ARM/Thumb interworking.
- Memory: the library is mapped at guest address 0x10000000, as the 1.57 build's own runtime does: code that build
  adds uses absolute addresses made for that place (its own variables, the HUD layer at 0x10200000). With the library
  anywhere else those accesses landed in the game's code and broke it (for example the slash of an attack facing up
  did not appear). The runtime data and HLE entry points sit above the library (`base.h`). `/darkworld/` still
  ships the build from before this change, whose page reads game addresses with the library at 0x100000.
- `thumb2.inc` — 32-bit Thumb-2 instructions and IT blocks, and in `cpu.c` the ARMv6/v7 media instructions
  (divide, bitfields, byte reverse, extend, saturate, MOVW/MOVT). The original library never uses them; modified
  builds add a segment of code compiled for ARMv7 and branch into it.
- `hle.c` — ELF loader and the imported libc/liblog/libstdc++ functions, plus the Java game loop: copy the title
  background (which the Java side paints) into the screen, call `timerCallbackN`, present the buffer.
  The game's server check (KTH) is gone, so a first start writes the `_confirm.sav` marker the game looks for.
- `jni.c` — a minimal JNIEnv/JavaVM and the Java methods the library calls (assets, sound, timer, purchases).
  Purchases are always reported as failed. The edit box some modified builds open to ask for a number is reported
  to the page (event 11), which passes the answer to `Native.charge` (`app_charge`).
- `fast.c` — native versions of the hottest drawing routines (copying the frame buffer, the blend tables,
  palette reads, the inner pixel loops of `DrawGBM`/`DrawGBMEx` (also scaled and rotated), `MC_grpFillRect` and
  alpha `DM_FillRect` rows, `DM_SetPixelAlpha`, `GetAngle`, `__divsi3`, `Abs`). Each replaces the first instruction of the routine or loop with a UDF instruction the
  interpreter hands to C, gives the same pixels, and is installed only when the routine it stands in (or, for a
  loop, the loop with its set-up and exit) is byte for byte the one it was read from; a modified build keeps the
  ones whose routines it left alone. A case a fast path does not cover runs the original code. Some entries only
  watch: `CheckViewFX`, and three calls (a 32-bit BL, through whatever wrapper a modified build puts there):
  `PAINT_GAME_MAIN`'s call to `DrawView` for the in-between frames, and the calls to `EM_SetDamageEffect` from
  `MOB_SetMonDamage` and `Hero_SetDamage` (a damage number appears), reported to the page for its hit effects.
- `interp.c` — in-between frames: the state each field frame is drawn from is saved when `PAINT_GAME_MAIN`
  reaches `DrawView`; the page can then have the field drawn again with the hero, the monsters and the
  camera part of the way between the last two frames, after which every byte of guest state (the library's
  writable segments, the runtime data, the heap, and the JNI object table) is put back. Drawn with nothing moved it is the game's own frame, pixel for pixel.
- `fs.c` — the file system behind the guest's libc; every file the game writes is reported to the page, which
  keeps it in IndexedDB.

Build (clang with the wasm32 target and wasm-ld): `./build.sh ../public/darkworld/dwcore.wasm`
