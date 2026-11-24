#!/bin/sh
# Builds the WebAssembly core (clang with the wasm32 target and wasm-ld).
#   ./build.sh out.wasm            interpreter only: what the repository ships, no game code in it
#   AOT=1 ./build.sh out.wasm      with the translated functions of aot_gen.c (made by aot.py from the
#                                  player's own copy of the library); never committed, the page takes it
#                                  as a file the player adds next to the apk
set -e
cd "$(dirname "$0")"
FLAGS="--target=wasm32 $CFLAGS -O2 -nostdlib -ffreestanding -fno-builtin -mbulk-memory -mnontrapping-fptoint -msign-ext -ffp-contract=off -Wall -Wno-unused-function -Wno-misleading-indentation -Wno-unused-label"
LINK="-Wl,--no-entry -Wl,-z,stack-size=2097152 -Wl,--strip-all"
if [ -n "$AOT" ]; then
  if [ ! -f aot_gen.wasm.o ] || [ aot_gen.c -nt aot_gen.wasm.o ] || [ cpu_core.h -nt aot_gen.wasm.o ] || [ thumb2.inc -nt aot_gen.wasm.o ] || [ vfp.inc -nt aot_gen.wasm.o ] || [ base.h -nt aot_gen.wasm.o ]; then
    clang $FLAGS -DAOT -w -c aot_gen.c -o aot_gen.wasm.o
  fi
  clang $FLAGS -DAOT $LINK -o "${1:-z4fast.wasm}" cpu.c util.c fs.c jni.c hle.c cow.c motion.c tweaks.c input.c aot_gen.wasm.o
else
  clang $FLAGS $LINK -o "${1:-z4core.wasm}" cpu.c util.c fs.c jni.c hle.c cow.c motion.c tweaks.c input.c
fi
