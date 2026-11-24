# dw-core

The engine behind `wie-web/public/darkworld/`, the iPhone player for 다크월드 (Gamedoli, Android).

The Android release is a small Java shell (`com.gamedoli.DarkWorldGoogle`) around one native library
(`lib/armeabi/libDarkWorld.so`, mostly Thumb code). The shell hands the library a 16-bit screen buffer, forwards
touches and keys, calls it on a timer and plays the sounds it names. This core runs the library directly:

- `cpu.c`, `thumb.inc` — ARMv5TE interpreter with the Thumb instruction set and ARM/Thumb interworking.
- `hle.c` — ELF loader and the imported libc/liblog/libstdc++ functions, plus the Java game loop: copy the title
  background (which the Java side paints) into the screen, call `timerCallbackN`, present the buffer.
  The game's server check (KTH) is gone, so a first start writes the `_confirm.sav` marker the game looks for.
- `jni.c` — a minimal JNIEnv/JavaVM and the Java methods the library calls (assets, sound, timer, purchases).
  Purchases are always reported as failed.
- `fast.c` — native versions of the hottest drawing routines (copying the frame buffer, the blend tables,
  palette reads, the inner pixel loops of `DrawGBM`/`DrawGBMEx`, `MC_grpFillRect` rows, `DM_SetPixelAlpha`,
  `__divsi3`, `Abs`). Each replaces the first instruction of the routine or loop with a UDF instruction the
  interpreter hands to C, gives the same pixels, and is installed only when the instruction words match
  this library build. A case a fast path does not cover runs the original code.
- `fs.c` — the file system behind the guest's libc; every file the game writes is reported to the page, which
  keeps it in IndexedDB.

Build (clang with the wasm32 target and wasm-ld): `./build.sh ../public/darkworld/dwcore.wasm`
