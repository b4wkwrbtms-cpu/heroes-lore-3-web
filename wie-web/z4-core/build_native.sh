#!/bin/sh
# Native test build. With CFLAGS containing -DAOT the translated functions (aot_gen.c) are compiled once
# into aot_gen.native.o and reused until aot_gen.c changes.
cd "$(dirname "$0")"
FLAGS="-DNATIVE $CFLAGS -O2 -fno-builtin -fno-strict-aliasing -ffp-contract=off -Wall -Wno-unused-function -Wno-misleading-indentation -Wno-unused-label"
EXTRA=""
case "$CFLAGS" in *-DAOT*)
  if [ ! -f aot_gen.native.o ] || [ aot_gen.c -nt aot_gen.native.o ] || [ cpu_core.h -nt aot_gen.native.o ] || [ thumb2.inc -nt aot_gen.native.o ] || [ vfp.inc -nt aot_gen.native.o ] || [ base.h -nt aot_gen.native.o ]; then
    clang $FLAGS -w -c aot_gen.c -o aot_gen.native.o || exit 1
  fi
  EXTRA=aot_gen.native.o ;;
esac
clang $FLAGS -o ${1:-z4native} cpu.c util.c fs.c jni.c hle.c cow.c motion.c tweaks.c input.c native_main.c $EXTRA -lm
