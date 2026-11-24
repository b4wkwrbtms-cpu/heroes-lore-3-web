#!/usr/bin/env python3
# Ahead-of-time translation of Thumb-2 functions of libgameDSO.so into C.
# Each guest instruction becomes a call of the interpreter's own exec_t16/exec_t32 with constant operands,
# which the C compiler folds into straight-line code; the semantics stay in thumb2.inc.
# Usage: aot.py libgameDSO.so aot_gen.c [aot_functions.txt]
# The output holds code made from the game and is not to be published; see README.md.
import struct, sys

LOAD_BASE = 0x100000
NORETURN = {'abort', '__stack_chk_fail', 'raise', '__aeabi_idiv0', '__cxa_throw', '_Unwind_Resume',
            '_Unwind_Resume_or_Rethrow', '__cxa_end_cleanup', '__cxa_rethrow', '__cxa_call_unexpected'}

def load(path):
    d = open(path, 'rb').read()
    shoff, = struct.unpack_from('<I', d, 32)
    shentsize, shnum, shstrndx = struct.unpack_from('<HHH', d, 46)
    secs = []
    for i in range(shnum):
        secs.append(struct.unpack_from('<IIIIIIIIII', d, shoff + i * shentsize))
    strtab = secs[shstrndx]
    def sname(off):
        s = strtab[4] + off
        return d[s:d.index(b'\0', s)].decode()
    out = {}
    for s in secs:
        out[sname(s[0])] = s
    dynsym, dynstr = out['.dynsym'], out['.dynstr']
    syms = {}
    for i in range(dynsym[5] // 16):
        nm, val, size, info, other, shndx = struct.unpack_from('<IIIBBH', d, dynsym[4] + i * 16)
        if shndx == 0 or (info & 15) != 2 or not val: continue
        n = d[dynstr[4] + nm:d.index(b'\0', dynstr[4] + nm)].decode()
        syms.setdefault(val, (n, size))
    text = out['.text']
    return d, syms, text, out.get('.plt')

def decode_fn(d, start, size, noreturn_addrs):
    """recursive descent from start (even address, file offset == vaddr for this lib). Returns
    dict addr -> (len, hw1, hw2, itcond or None, kind, targets) or None if untranslatable."""
    end = start + size
    ins = {}
    cover = {}
    work = [(start, None)]
    itq = {}  # addr -> cond for instructions inside IT blocks
    while work:
        a, _ = work.pop()
        while True:
            if a < start or a >= end: break
            if a in ins: break
            if a in cover and cover[a] != a: return None  # decoded into the middle of an instruction
            hw = struct.unpack_from('<H', d, a)[0]
            l = 4 if hw >= 0xe800 else 2
            if a + l > end: return None
            hw2 = struct.unpack_from('<H', d, a + 2)[0] if l == 4 else 0
            for k in range(0, l, 2):
                if (a + k) in cover and cover[a + k] != a: return None
                cover[a + k] = a
            kind, targets, term = classify(hw, hw2, a, d)
            if kind == 'it':
                firstcond = (hw >> 4) & 15
                mask = hw & 15
                # instructions following: up to 4
                n = 4 - ((mask & -mask).bit_length() - 1)
                b = a + 2
                for k in range(n):
                    h = struct.unpack_from('<H', d, b)[0]
                    bit = (mask >> (4 - k)) & 1 if k > 0 else 0
                    c = firstcond if k == 0 else ((firstcond & 0xe) | ((mask >> (4 - k)) & 1))
                    if b in itq and itq[b] != c: return None
                    itq[b] = c
                    b += 4 if h >= 0xe800 else 2
            cond = itq.get(a)
            if kind == 'call' and targets and targets[0] in noreturn_addrs and cond is None:
                term = True
            ins[a] = (l, hw, hw2, kind, targets)
            for t in targets:
                if kind != 'call' and start <= t < end: work.append((t, None))
            if term and cond is None: break
            a += l
    # verify IT bookkeeping: every itq address must be an instruction
    for b in itq:
        if b not in ins and start <= b < end:
            pass
    return ins, itq

def sx(v, bits):
    return v - (1 << bits) if v & (1 << (bits - 1)) else v

def classify(i, hw2, a, d):
    pc = a + 4
    if i < 0xe800:
        if (i & 0xff00) == 0xbf00 and (i & 15): return 'it', [], False
        if (i & 0xf000) == 0xd000:
            c = (i >> 8) & 15
            if c >= 14: return 'trap', [], True
            return 'br', [pc + sx(i & 0xff, 8) * 2], False
        if (i & 0xf800) == 0xe000: return 'br', [pc + sx(i & 0x7ff, 11) * 2], True
        if (i & 0xf500) == 0xb100:  # CBZ/CBNZ
            off = (((i >> 9) & 1) << 6) | (((i >> 3) & 31) << 1)
            return 'br', [pc + off], False
        if (i & 0xff87) == 0x4700: return 'ret', [], True  # BX
        if (i & 0xff87) == 0x4780: return 'call', [], False  # BLX reg
        if (i & 0xff00) == 0xbd00: return 'ret', [], True  # POP {.., pc}
        if (i & 0xff87) == 0x4687 or (i & 0xff87) == 0x4487: return 'ret', [], True  # MOV/ADD pc
        if (i & 0xff00) == 0xbe00 or (i & 0xff00) == 0xde00: return 'trap', [], True
        return 'op', [], False
    h1 = i
    if (h1 & 0xf800) == 0xf000 and (hw2 & 0x8000):
        s = (h1 >> 10) & 1
        j1, j2 = (hw2 >> 13) & 1, (hw2 >> 11) & 1
        k = ((hw2 >> 12) & 1) | (((hw2 >> 14) & 1) << 1)
        if k == 0:
            if ((h1 >> 7) & 7) != 7:
                imm = (s << 20) | (j2 << 19) | (j1 << 18) | ((h1 & 63) << 12) | ((hw2 & 0x7ff) << 1)
                return 'br', [pc + sx(imm, 21)], False
            return 'op', [], False
        i1, i2 = 1 - (j1 ^ s), 1 - (j2 ^ s)
        imm = (s << 24) | (i1 << 23) | (i2 << 22) | ((h1 & 0x3ff) << 12) | ((hw2 & 0x7ff) << 1)
        off = sx(imm, 25)
        if k == 1: return 'br', [pc + off], True
        if k == 3: return 'call', [pc + off], False
        return 'call', [((pc & ~3) + off) & ~3], False  # BLX to ARM
    # TBB/TBH
    if (h1 & 0xfff0) == 0xe8d0 and (hw2 & 0xffe0) == 0xf000:
        h = (hw2 >> 4) & 1
        base = pc
        tg = []
        mn = None
        p = pc
        while mn is None or p < mn:
            v = struct.unpack_from('<H' if h else '<B', d, p)[0]
            t = pc + 2 * v
            tg.append(t)
            mn = t if mn is None else min(mn, t)
            p += 2 if h else 1
            if len(tg) > 512: break
        return 'tb', sorted(set(tg)), True
    # LDM/POP.W with pc
    if (h1 & 0xffd0) in (0xe890, 0xe910) and (hw2 & 0x8000): return 'ret', [], True
    # LDR.W pc
    if (h1 & 0xfff0) in (0xf8d0, 0xf850, 0xf85f & 0xfff0) and (hw2 >> 12) == 15: return 'ret', [], True
    if (h1 & 0xff7f) == 0xf85f and (hw2 >> 12) == 15: return 'ret', [], True
    return 'op', [], False

def emit(fname, start, ins, itq, out, entry_set):
    L = LOAD_BASE
    lab = lambda a: 'L_%x' % (a + L)
    w = out.write
    w('static void %s(void) {\n' % fname)
    w('  goto %s;\n' % lab(start))
    for a in sorted(ins):
        l, hw, hw2, kind, targets = ins[a]
        ga = a + L
        nxt = ga + l
        if kind == 'it':
            w('%s: ;\n' % lab(a))
            continue
        if l == 2: ex = 'exec_t16(0x%04x, 0x%x);' % (hw, ga)
        else: ex = 'exec_t32(0x%04x, 0x%04x, 0x%x);' % (hw, hw2, ga)
        if kind == 'call': ex += ' aot_call(0x%x);' % nxt
        c = itq.get(a)
        if c is not None:
            ex = 'if (cond_pass(%d)) { t_in_it = 1; %s t_in_it = 0; }' % (c, ex)
        if kind == 'trap':
            ex = 'cpu_pc = 0x%x; return;' % ga  # let the interpreter report it
            w('%s: %s\n' % (lab(a), ex))
            continue
        w('%s: R[15] = 0x%x; cpu_pc = 0x%x; %s if (cpu_pc != 0x%x) goto dispatch;\n' % (lab(a), ga + 4, nxt, ex, nxt))
        # fall through to an address that was not decoded: leave
        if (a + l) not in ins:
            w('  return;\n')
    w('dispatch:\n  if (!fT) return;\n  switch (cpu_pc) {\n')
    for a in sorted(ins):
        if ins[a][3] == 'it': continue
        w('  case 0x%x: goto %s;\n' % (a + L, lab(a)))
    w('  default: return;\n  }\n}\n')

def main():
    lib, outp = sys.argv[1], sys.argv[2]
    only = None
    if len(sys.argv) > 3:
        only = set(l.strip() for l in open(sys.argv[3]) if l.strip())
    d, syms, text, plt = load(lib)
    # PLT no-return targets: entries of .plt in relocation order
    import subprocess, re
    rel = subprocess.run(['readelf', '-W', '-r', lib], capture_output=True, text=True).stdout
    slots = re.findall(r'R_ARM_JUMP_SLOT\s+[0-9a-f]+\s+(\S+)', rel)
    noret = set()
    plt_start = plt[3] + 20 if plt else 0  # entries follow the 20-byte PLT header
    for k, n in enumerate(slots):
        if n.split('@')[0] in NORETURN: noret.add(plt_start + 12 * k)
    for v, (n, s) in syms.items():
        if n in NORETURN: noret.add(v & ~1)
    out = open(outp, 'w')
    out.write('// Generated by aot.py from libgameDSO.so: do not edit.\n#include "cpu_core.h"\n')
    entries = []
    skipped = 0
    for v in sorted(syms):
        n, size = syms[v]
        if not (v & 1) or size < 4: continue
        if only is not None and n not in only: continue
        start = v & ~1
        r = decode_fn(d, start, size, noret)
        if r is None:
            skipped += 1
            sys.stderr.write('skip %s\n' % n)
            continue
        ins, itq = r
        fname = 'aot_%x' % (start + LOAD_BASE)
        emit(fname, start, ins, itq, out, None)
        entries.append((start + LOAD_BASE, fname))
    out.write('typedef struct { u32 addr; void (*fn)(void); } AotEntry;\nconst AotEntry aot_entries[] = {\n')
    for a, f in entries:
        out.write('  {0x%x, %s},\n' % (a, f))
    out.write('};\nconst int aot_count = %d;\n' % len(entries))
    # the translations are only valid for this exact library: FNV-1a over its .text, checked at load
    lo, hi = text[3], text[3] + text[5]
    h = 2166136261
    for b in d[text[4]:text[4] + text[5]]:
        h = ((h ^ b) * 16777619) & 0xffffffff
    out.write('const u32 aot_text_lo = 0x%x, aot_text_hi = 0x%x, aot_text_hash = 0x%08x;\n' % (lo + LOAD_BASE, hi + LOAD_BASE, h))
    sys.stderr.write('translated %d functions, skipped %d\n' % (len(entries), skipped))

main()
