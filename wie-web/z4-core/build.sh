#!/bin/sh
# Builds the WebAssembly core (clang with the wasm32 target and wasm-ld).
#   ./build.sh out.wasm            the core: what the repository ships, no game code in it
#   SIDE=1 ./build.sh out.wasm     the translated functions of aot_gen.c (made by aot.py from the player's
#                                  own copy of the library) as a module of their own, which the page loads
#                                  next to the site's core (aot_side.c); never committed, the player adds it
#                                  next to the apk once, and it keeps fitting newer cores until the
#                                  interpreter's instruction code below changes (AOT_ABI)
#   AOT=1 ./build.sh out.wasm      the core with the translations linked in
set -e
cd "$(dirname "$0")"
# the build of the interpreter's instruction code, which the translations carry inside them
ABI=0x$(cat cpu_core.h base.h thumb2.inc vfp.inc | cksum | awk '{printf "%08x", $1}')
FLAGS="--target=wasm32 $CFLAGS -O2 -nostdlib -ffreestanding -fno-builtin -mbulk-memory -mnontrapping-fptoint -msign-ext -ffp-contract=off -DAOT_ABI=$ABI -Wall -Wno-unused-function -Wno-misleading-indentation -Wno-unused-label"
LINK="-Wl,--no-entry -Wl,-z,stack-size=2097152 -Wl,--strip-all"
# what a translations module takes from the core
SHARE="-Wl,--export-table -Wl,--growable-table -Wl,--export=__stack_pointer"
for s in G R V cpu_pc fN fZ fC fV fQ fT t_in_it cow_on cow_bits aot_call cow_save_page; do SHARE="$SHARE -Wl,--export=$s"; done
SRC="cpu.c util.c fs.c jni.c hle.c cow.c motion.c tweaks.c input.c netsim.c"
stale() { [ ! -f "$1" ] || [ aot_gen.c -nt "$1" ] || [ cpu_core.h -nt "$1" ] || [ thumb2.inc -nt "$1" ] || [ vfp.inc -nt "$1" ] || [ base.h -nt "$1" ]; }
if [ -n "$SIDE" ]; then
  if stale aot_gen.pic.o; then clang $FLAGS -fPIC -DAOT -w -c aot_gen.c -o aot_gen.pic.o; fi
  clang $FLAGS -fPIC -c aot_side.c -o aot_side.pic.o
  wasm-ld --experimental-pic -shared --no-entry --strip-all -o "${1:-z4aot.wasm}" aot_gen.pic.o aot_side.pic.o
elif [ -n "$AOT" ]; then
  if stale aot_gen.wasm.o; then clang $FLAGS -DAOT -w -c aot_gen.c -o aot_gen.wasm.o; fi
  clang $FLAGS -DAOT $LINK $SHARE -o "${1:-z4fast.wasm}" $SRC aot_gen.wasm.o
else
  clang $FLAGS $LINK $SHARE -o "${1:-z4core.wasm}" $SRC
fi
