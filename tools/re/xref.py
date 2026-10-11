"""Find the functions in foundation.exe that reference a string, and list the other strings they use.

usage: xref.py "<text>" ["<text>" ...]
"""
import struct
import sys

PATH = r"C:/Program Files (x86)/Steam/steamapps/common/Foundation/foundation.exe"
data = open(PATH, "rb").read()

pe = struct.unpack_from("<I", data, 0x3C)[0]
nsec = struct.unpack_from("<H", data, pe + 6)[0]
opt_size = struct.unpack_from("<H", data, pe + 20)[0]
sections = []
for i in range(nsec):
    o = pe + 24 + opt_size + i * 40
    name = data[o:o + 8].rstrip(b"\0").decode()
    vsize, vaddr, rsize, raw = struct.unpack_from("<IIII", data, o + 8)
    sections.append((name, vaddr, vsize, raw, rsize))
text = next(s for s in sections if s[0] == ".text")
pdata = next(s for s in sections if s[0] == ".pdata")
functions = [struct.unpack_from("<II", data, o) for o in range(pdata[3], pdata[3] + pdata[4], 12)]
functions = [f for f in functions if f[0]]


def rva_to_off(rva):
    for name, vaddr, vsize, raw, rsize in sections:
        if vaddr <= rva < vaddr + rsize:
            return raw + (rva - vaddr)
    return None


def off_to_rva(off):
    for name, vaddr, vsize, raw, rsize in sections:
        if raw <= off < raw + rsize:
            return vaddr + (off - raw)
    return None


def string_at(rva):
    off = rva_to_off(rva)
    if off is None:
        return None
    end = data.find(b"\0", off, off + 240)
    raw = data[off:end]
    if len(raw) >= 3 and all(32 <= c < 127 for c in raw):
        return raw.decode()
    try:
        wide = data[off:off + 400].decode("utf-16le").split("\0")[0]
        if len(wide) >= 3 and all(32 <= ord(c) < 127 for c in wide):
            return "L:" + wide
    except UnicodeDecodeError:
        pass
    return None


def function_of(rva):
    lo, hi = 0, len(functions) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        begin, end = functions[mid]
        if rva < begin:
            hi = mid - 1
        elif rva >= end:
            lo = mid + 1
        else:
            return begin, end
    return None


def strings_in(begin, end):
    code = data[rva_to_off(begin):rva_to_off(begin) + (end - begin)]
    out = []
    for i in range(len(code) - 7):
        if code[i] in (0x48, 0x4C) and code[i + 1] == 0x8D and (code[i + 2] & 0xC7) == 0x05:
            target = begin + i + 7 + struct.unpack_from("<i", code, i + 3)[0]
            found = string_at(target)
            if found and found not in out:
                out.append(found)
    return out


code = data[text[3]:text[3] + text[4]]


def references_to(target_rva):
    """RVAs of RIP-relative LEA instructions that load target_rva."""
    hits = []
    pos = 0
    while True:
        pos = code.find(b"\x8D", pos)
        if pos < 0:
            break
        if pos >= 1 and code[pos - 1] in (0x48, 0x4C) and pos + 6 <= len(code) and (code[pos + 1] & 0xC7) == 0x05:
            rva = text[1] + pos - 1
            if rva + 7 + struct.unpack_from("<i", code, pos + 2)[0] == target_rva:
                hits.append(rva)
        pos += 1
    return hits


for needle in sys.argv[1:]:
    print(f"=== {needle!r}")
    for encoded, kind in ((needle.encode() + b"\0", "ascii"), (needle.encode("utf-16le") + b"\0\0", "utf16")):
        start = 0
        while True:
            off = data.find(encoded, start)
            if off < 0:
                break
            start = off + 1
            # must be the start of a string, not the tail of a longer one
            previous = data[off - 1:off] if kind == "ascii" else data[off - 2:off]
            if previous.strip(b"\0"):
                continue
            rva = off_to_rva(off)
            if rva is None:
                continue
            refs = references_to(rva)
            print(f"  {kind} at rva {rva:#x}: {len(refs)} code reference(s)")
            for ref in refs[:6]:
                fn = function_of(ref)
                if not fn:
                    print(f"    {ref:#x} (no function)")
                    continue
                print(f"    {ref:#x} in function {fn[0]:#x}..{fn[1]:#x} (size {fn[1] - fn[0]:#x}); strings: {strings_in(*fn)[:14]}")
