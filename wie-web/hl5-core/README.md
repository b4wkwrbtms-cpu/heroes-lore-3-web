# hl5-core

The engine behind `wie-web/public/hl5/`, the iPhone player for 영웅서기5 (EA Mobile, Android).

The Android release is a thin Java shell around one native library (`lib/armeabi/libHeroesLore5.so`) that
contains EA Mobile Korea's WIPI-C kernel ("Midas") and the game. This core runs that library directly:

- `cpu.c` — ARMv5TE interpreter (the library has no Thumb code).
- `hle.c` — ELF loader and the imported functions: libc, libm, liblog and the small GLES 1.x subset the kernel
  uses to show its software-rendered screen. Also native versions of two hot kernel routines
  (`internalGrpCopyFrameBuffer`, `MC_grpFillRect`) that produce identical pixels, and watch points the page
  uses for hit feedback and for confirming the start-up server popups. The innermost pixel loops of the game's
  own blitters (`Graphic::DrawImageBlendingClip565`, `DrawImageMirrorClip565`, `DrawImageStretchClip565`,
  `FillRectAlpha`) also run natively: each takes over at a loop head, finishes the loop and continues at its
  exit with the registers the original leaves live, and only for the exact library build it was read from.
  The output is the same pixel for pixel.
- `interp.c` — snapshot and restore of the guest state, and drawing the current state into a separate buffer.
  The page uses it for in-between frames: it moves the camera and characters part of the way between two
  game frames, lets the game draw once more and restores everything, so the game itself never sees it.
- `jni.c` — a minimal JNIEnv/JavaVM and the Java side of `co.kr.eamobile.CletEntry` (sound, device info, assets).
- `fs.c` — the file system behind the guest's libc; `data.vfs` is read from the page on demand and every
  file the game writes is reported to the page, which keeps it in IndexedDB.

- `tweaks.c` — rule changes the player asked for, each checked against the exact instruction words of this
  library build: twice the stat points and three times the skill points on level up, twice the experience,
  extra drops of the best equipment for the hero's class and level from field and story bosses, critical +25
  for every equipped accessory, hero buffs that do not run out, a free revival on the game-over screen, and a cash shop that hands out its
  items (or what its boxes hold) for free, since buying needed EA's servers.

Build (clang with the wasm32 target and wasm-ld): `./build.sh ../public/hl5/hl5core.wasm`

No game files are part of this repository: the page asks for the player's own zip or apk and keeps it on the device.
