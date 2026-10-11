"""Locate the crash address in foundation.exe and see what the surrounding function references."""
import struct
import sys

path = r"C:/Program Files (x86)/Steam/steamapps/common/Foundation/foundation.exe"
crash_rva = int(sys.argv[1], 16)
data = open(path, "rb").read()

pe = struct.unpack_from("<I", data, 0x3C)[0]
nsec = struct.unpack_from("<H", data, pe + 6)[0]
opt_size = struct.unpack_from("<H", data, pe + 20)[0]
sec_off = pe + 24 + opt_size
sections = []
for i in range(nsec):
    o = sec_off + i * 40
    name = data[o:o + 8].rstrip(b"\0").decode()
    vsize, vaddr, rsize, raw = struct.unpack_from("<IIII", data, o + 8)
    sections.append((name, vaddr, vsize, raw, rsize))
    print(f"{name:8} rva={vaddr:#x} vsize={vsize:#x} raw={raw:#x}")


def rva_to_off(rva):
    for name, vaddr, vsize, raw, rsize in sections:
        if vaddr <= rva < vaddr + max(vsize, rsize):
            return raw + (rva - vaddr)
    raise ValueError(hex(rva))


def off_to_rva(off):
    for name, vaddr, vsize, raw, rsize in sections:
        if raw <= off < raw + rsize:
            return vaddr + (off - raw)
    return None


def string_at(rva):
    try:
        off = rva_to_off(rva)
    except ValueError:
        return None
    end = data.find(b"\0", off, off + 200)
    raw = data[off:end]
    if 4 <= len(raw) and all(32 <= c < 127 for c in raw):
        return raw.decode()
    # UTF-16?
    wide = data[off:off + 160]
    try:
        text = wide.decode("utf-16le").split("\0")[0]
        if len(text) >= 4 and all(32 <= ord(c) < 127 for c in text):
            return "L:" + text
    except UnicodeDecodeError:
        pass
    return None


# Function bounds from the exception directory (.pdata): entries of (begin, end, unwind).
pdata = next(s for s in sections if s[0] == ".pdata")
begin = end = None
for o in range(pdata[3], pdata[3] + pdata[4], 12):
    b, e, _ = struct.unpack_from("<III", data, o)
    if b <= crash_rva < e:
        begin, end = b, e
        break
print(f"\ncrash rva {crash_rva:#x} is in function {begin:#x}..{end:#x} (+{crash_rva - begin:#x}, size {end - begin:#x})")

# Scan the function, and a little around it, for RIP-relative references to strings.
def refs(lo, hi):
    code = data[rva_to_off(lo):rva_to_off(lo) + (hi - lo)]
    found = []
    for i in range(len(code) - 7):
        # lea reg, [rip+disp32]  => 48/4C 8D modrm(00 reg 101)
        if code[i] in (0x48, 0x4C) and code[i + 1] == 0x8D and (code[i + 2] & 0xC7) == 0x05:
            disp = struct.unpack_from("<i", code, i + 3)[0]
            target = lo + i + 7 + disp
            text = string_at(target)
            if text:
                found.append((lo + i, text))
    return found


print("\nstrings referenced in the crashing function:")
for rva, text in refs(begin, end):
    print(f"  {rva:#x}{' <-- after crash' if rva > crash_rva else ''}: {text[:110]}")

print("\nbytes at crash:", data[rva_to_off(crash_rva) - 16:rva_to_off(crash_rva) + 16].hex(" "))

# Who calls this function? Direct call rel32 (E8) targets.
callers = []
text_sec = next(s for s in sections if s[0] == ".text")
code = data[text_sec[3]:text_sec[3] + text_sec[4]]
target = begin
pos = 0
while True:
    pos = code.find(b"\xE8", pos)
    if pos < 0 or pos + 5 > len(code):
        break
    rel = struct.unpack_from("<i", code, pos + 1)[0]
    if text_sec[1] + pos + 5 + rel == target:
        callers.append(text_sec[1] + pos)
    pos += 1
print(f"\n{len(callers)} direct callers; first few:", [hex(c) for c in callers[:12]])


def func_of(rva):
    for o in range(pdata[3], pdata[3] + pdata[4], 12):
        b, e, _ = struct.unpack_from("<III", data, o)
        if b <= rva < e:
            return b, e
    return None


seen = set()
for c in callers[:12]:
    f = func_of(c)
    if not f or f in seen:
        continue
    seen.add(f)
    strings = [t for _, t in refs(*f)][:6]
    print(f"  caller function {f[0]:#x}..{f[1]:#x}: {strings}")
