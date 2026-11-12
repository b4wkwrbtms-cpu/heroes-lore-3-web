#!/bin/sh
# Builds hl5core.wasm (clang with the wasm32 target and wasm-ld).
set -e
cd "$(dirname "$0")"
clang --target=wasm32 $CFLAGS -O3 -nostdlib -ffreestanding -mbulk-memory -mnontrapping-fptoint -msign-ext \
  -Wall -Wno-unused-function -Wno-misleading-indentation \
  -Wl,--no-entry -Wl,-z,stack-size=1048576 -Wl,--strip-all \
  -o "${1:-hl5core.wasm}" cpu.c util.c fs.c jni.c hle.c interp.c tweaks.c
