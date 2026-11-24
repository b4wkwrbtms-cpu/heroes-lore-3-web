# z4-core

The engine behind `wie-web/public/z4/`, the iPhone player for 제노니아4 (Zenonia 4, GAMEVIL, Android).

The Android release is a Java shell (`com.gamevil.nexus2`) around one native library
(`lib/armeabi-v7a/libgameDSO.so`, ARMv7 Thumb-2 with VFPv3 floating point). The library draws every frame in
software into a 16-bit buffer and hands it to OpenGL ES as a texture; the Java side runs the GL thread,
passes touches (with a pointer id per finger) and draws text with Android's Paint. This core runs that
library directly:

- `cpu.c`, `cpu_core.h`, `thumb2.inc`, `vfp.inc` — ARMv7-A interpreter: ARM and Thumb-2 (IT blocks, all the
  32-bit encodings compilers emit), VFPv3-D16, interworking. `native_helpers.inc` stands in for libgcc's
  division routines.
- `hle.c` — ELF loader and the imported libc/liblog/GLES functions. `glTexSubImage2D` takes the finished
  frame. The entry points the page drives follow the Java renderer: `NativeInitWithBufferSize` starts the
  game with the buffer size, then each frame hands over input (`handleCletEvent`) and calls `NativeRender`.
  The game lays itself out for any width (HUD at the edges, wider field), so the page creates it 480 high
  and as wide as the phone's shape.
- `jni.c` — a JNIEnv/JavaVM and the Java side the library calls: assets (`readAssete`), saves (`loadFile`/
  `saveFile`), the async timer, sounds, device info (a Korean locale), the signature check (answered with
  the value the library expects) and NexusFont, whose drawing is done by the page (`host_text`). Saves go to
  `/gameSave/` (Android: SharedPreferences), apart from `getAbsolueFilePath`'s directory (`/save/`): at every
  start `CMvApp::FileConvertToAndroidFile` copies any file of the old API found there into the save store and
  removes it, so sharing one directory removed the saves.
- `fs.c`, `util.c` — the file system behind the guest's libc (saves are reported to the page, which keeps
  them in IndexedDB), heaps and formatting.
- `blit_helpers.inc` — native stand-ins for the drawing routines that take most of a frame (sprite
  decompression into the 16-bit buffer, alpha and level blending, grey, flipped sprites, screen fades and
  tints). Each is installed only when the routine's bytes hash to the value it was written against, and was
  checked by comparing a checksum of every frame with and without it. The two screen effects that are a
  fixed function of the pixel per step build a table once by running the game's own routine over all 65536
  values.
- `cow.c`, `motion.c` — in-between frames and hit reports. While the game's `CMvApp::Draw` runs, the first
  write to each 4 KiB page saves the page (guest stores and host writes through `gwptr` are both seen), and
  the camera and object positions are noted. `motion_paint` winds memory back to before that draw, moves the
  camera and the objects part of the way from the frame before, lets the game draw once more into a separate
  picture and restores every page and the host-side tables, so the game never sees the extra frame (checked
  the same way: identical frame checksums with paints after every frame). `CMvCharacter::SetDamage` reports
  where a blow landed (host event 10) for the page's hit effects.
- `tweaks.c` — rules the player can switch in the page: unlimited Zen and gold (each look at the money first
  fills it to the game's own limit through the game's setter, which keeps its checksum right) and easier
  refining (a success chance of at least 80, the helper item kept), stat points that do not run out and a
  chosen number of points per press of + in the status window, `GetPercentValue` in 64 bits (the game's
  32-bit product wraps for large attacks, so blows did nothing; results that did not wrap are the same) and
  every skill at its highest level (`skills_max`).
- `input.c` — where the touch d-pad's dial is and whether it is on screen (`dpad_geom`), read from the
  game's own keypad (`CZnTouchKeypad::GetTouchKeyPadRect`, and the checks `DrawTouchKeypadPattern` makes
  before it draws the dial), so the page can steer a finger that starts on the dial into the ring the game
  reads directions from.

Build (clang with the wasm32 target and wasm-ld): `./build.sh ../public/z4/z4core.wasm`

## Translated functions (the accelerated core)

Interpreting costs about ten times what the phone has for a frame in the busy drawing routines. `aot.py`
translates chosen Thumb-2 functions into C: every instruction becomes a call of the interpreter's own
`exec_t16`/`exec_t32` with the instruction word as a constant, which the compiler folds into straight
code, so the semantics stay in one place (`thumb2.inc`). Calls, returns and branches the translation does
not know go back to the run loop. The functions are listed in `aot_functions.txt` (the drawing routines and
whatever a profile of menus, cutscenes and the field showed busy); they run about eight times faster.

    python3 aot.py libgameDSO.so aot_gen.c aot_functions.txt
    AOT=1 ./build.sh z4fast.wasm

The output is made from the game's code, so neither `aot_gen.c` nor `z4fast.wasm` is part of this
repository: the player makes it from their own copy of the library and adds it in the page next to the
apk. The translations carry a checksum of the library's code and switch themselves off for any other build.

## Testing on a computer

`build_native.sh` builds `native_main.c`, which runs the core with an extracted apk and writes frames:

    Z4_LIB=lib/armeabi-v7a/libgameDSO.so Z4_ASSETS=assets/ Z4_OUT=out ./z4native 600 script.txt

`CFLAGS=-DAOT` adds the translations, `-DPROFILE` counts interpreted instructions per address
(`out/prof.bin`), `SAMPLE=<frame>` samples the guest PC from that frame on (works inside translated code).
`SUMS=1` prints a checksum per frame, `AOT=n` picks what runs translated or native (1 translations, 2 division
helpers, 4 drawing routines), `MOTION=f` draws an in-between frame after each frame that moved, `FX=1` turns
on the hit reports: comparing the checksums of two runs shows whether any of these changed the game.

No game files are part of this repository: the page asks for the player's own apk and keeps it on the device.
