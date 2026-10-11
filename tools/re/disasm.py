import struct, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
PATH = r"C:/Program Files (x86)/Steam/steamapps/common/Foundation/foundation.exe"
data = open(PATH, "rb").read()
pe = struct.unpack_from("<I", data, 0x3C)[0]
nsec = struct.unpack_from("<H", data, pe + 6)[0]
opt = struct.unpack_from("<H", data, pe + 20)[0]
secs = []
for i in range(nsec):
    o = pe + 24 + opt + i * 40
    vsize, vaddr, rsize, raw = struct.unpack_from("<IIII", data, o + 8)
    secs.append((vaddr, rsize, raw))
def off(rva):
    for vaddr, rsize, raw in secs:
        if vaddr <= rva < vaddr + rsize: return raw + rva - vaddr
def s_at(rva):
    o = off(rva)
    if o is None: return None
    raw = data[o:data.find(b"\0", o, o + 120)]
    if len(raw) >= 3 and all(32 <= c < 127 for c in raw): return raw.decode()
    try:
        w = data[o:o + 240].decode("utf-16le").split("\0")[0]
        if len(w) >= 3 and all(32 <= ord(c) < 127 for c in w): return "L:" + w
    except Exception: pass
start, end = int(sys.argv[1], 16), int(sys.argv[2], 16)
md = Cs(CS_ARCH_X86, CS_MODE_64)
for ins in md.disasm(data[off(start):off(start) + end - start], start):
    note = ""
    if "rip" in ins.op_str:
        import re
        m = re.search(r"rip ([+-]) (0x[0-9a-f]+)", ins.op_str)
        if m:
            t = ins.address + ins.size + (int(m.group(2), 16) if m.group(1) == "+" else -int(m.group(2), 16))
            s = s_at(t) if ins.mnemonic == "lea" else None
            note = f"  ; {t:#x}" + (f" {s!r}" if s else "")
    print(f"{ins.address:#x}: {ins.mnemonic} {ins.op_str}{note}")
