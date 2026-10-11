"""Scan foundation.exe for reflected property registrations.

Each property has a small registration function that stores a vtable, the
property name, a display name and (sometimes) flags into a descriptor object.
Output: props.json with one entry per registration function.
"""
import json
import re
import struct
import sys

from capstone import Cs, CS_ARCH_X86, CS_MODE_64

PATH = r"C:/Program Files (x86)/Steam/steamapps/common/Foundation/foundation.exe"
data = open(PATH, "rb").read()
pe = struct.unpack_from("<I", data, 0x3C)[0]
nsec = struct.unpack_from("<H", data, pe + 6)[0]
opt = struct.unpack_from("<H", data, pe + 20)[0]
image_base = struct.unpack_from("<Q", data, pe + 24 + 24)[0]
sections = []
for i in range(nsec):
    o = pe + 24 + opt + i * 40
    name = data[o:o + 8].rstrip(b"\0").decode()
    vsize, vaddr, rsize, raw = struct.unpack_from("<IIII", data, o + 8)
    sections.append((name, vaddr, vsize, raw, rsize))
text = next(s for s in sections if s[0] == ".text")
pdata = next(s for s in sections if s[0] == ".pdata")
functions = sorted(struct.unpack_from("<II", data, o) for o in range(pdata[3], pdata[3] + pdata[4], 12))
functions = [f for f in functions if f[0]]


def off(rva):
    for _, vaddr, vsize, raw, rsize in sections:
        if vaddr <= rva < vaddr + rsize:
            return raw + rva - vaddr
    return None


def to_rva(file_offset):
    for _, vaddr, vsize, raw, rsize in sections:
        if raw <= file_offset < raw + rsize:
            return vaddr + file_offset - raw
    return None


def cstring(rva, limit=200):
    o = off(rva)
    if o is None:
        return None
    end = data.find(b"\0", o, o + limit)
    raw = data[o:end]
    if len(raw) >= 1 and all(32 <= c < 127 for c in raw):
        return raw.decode()
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


def rtti_name(vtable_rva):
    """Class name from MSVC RTTI: vtable[-1] -> complete object locator -> type descriptor."""
    o = off(vtable_rva - 8)
    if o is None:
        return None
    locator_va = struct.unpack_from("<Q", data, o)[0]
    locator = off(locator_va - image_base)
    if locator is None:
        return None
    signature, _, _, type_rva = struct.unpack_from("<IIII", data, locator)
    if signature != 1:
        return None
    return cstring(type_rva + 0x10, 400)


# Every registration function logs through this string when the property is empty.
marker = to_rva(data.find(b"ComCPropertyContainer::set\0"))
code = data[text[3]:text[3] + text[4]]
referrers = set()
pos = 0
while True:
    pos = code.find(b"\x8D", pos)
    if pos < 0:
        break
    if pos >= 1 and code[pos - 1] in (0x48, 0x4C) and pos + 6 <= len(code) and (code[pos + 1] & 0xC7) == 0x05:
        rva = text[1] + pos - 1
        if rva + 7 + struct.unpack_from("<i", code, pos + 2)[0] == marker:
            fn = function_of(rva)
            if fn:
                referrers.add(fn)
    pos += 1
print(len(referrers), "functions reference the marker", file=sys.stderr)

md = Cs(CS_ARCH_X86, CS_MODE_64)
out = []
for begin, end in sorted(referrers):
    body = data[off(begin):off(begin) + min(end - begin, 0x140)]
    strings, flags, vtable = [], 0, None
    for ins in md.disasm(body, begin):
        m = re.search(r"\[rip ([+-]) (0x[0-9a-f]+)\]", ins.op_str)
        if ins.mnemonic == "lea" and m:
            target = ins.address + ins.size + (int(m.group(2), 16) if m.group(1) == "+" else -int(m.group(2), 16))
            text_value = cstring(target)
            if text_value is not None and text_value != "property should not been empty":
                strings.append(text_value)
            elif vtable is None and ins.op_str.startswith("rax"):
                vtable = target
        m = re.match(r"dword ptr \[rbx \+ 0x60\], (0x[0-9a-f]+|\d+)", ins.op_str)
        if ins.mnemonic == "or" and m:
            flags |= int(m.group(1), 0)
        if "property should not been empty" in (cstring(0) or ""):
            break
        if len(strings) >= 2 and ins.mnemonic == "cmp" and "qword ptr [rbx], 0" in ins.op_str:
            break
    if not strings:
        continue
    out.append({
        "function": begin,
        "name": strings[0],
        "display": strings[1] if len(strings) > 1 else None,
        "flags": flags,
        "vtable": vtable,
        "rtti": rtti_name(vtable) if vtable else None,
    })
json.dump(out, open(sys.argv[1], "w"), indent=0)
print(len(out), "properties written", file=sys.stderr)
