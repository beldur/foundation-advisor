import struct, sys, re
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
PATH = r"C:/Program Files (x86)/Steam/steamapps/common/Foundation/foundation.exe"
data = open(PATH, "rb").read()
pe = struct.unpack_from("<I", data, 0x3C)[0]
nsec = struct.unpack_from("<H", data, pe + 6)[0]
opt = struct.unpack_from("<H", data, pe + 20)[0]
secs = []
for i in range(nsec):
    o = pe + 24 + opt + i * 40
    name = data[o:o+8].rstrip(b"\0").decode()
    vsize, vaddr, rsize, raw = struct.unpack_from("<IIII", data, o + 8)
    secs.append((name, vaddr, vsize, raw, rsize))
text = next(s for s in secs if s[0] == ".text")
def off(rva):
    for _, vaddr, vsize, raw, rsize in secs:
        if vaddr <= rva < vaddr + rsize: return raw + rva - vaddr
def sec_of(rva):
    for name, vaddr, vsize, raw, rsize in secs:
        if vaddr <= rva < vaddr + max(vsize, rsize): return name
code = data[text[3]:text[3] + text[4]]
target = int(sys.argv[1], 16)
md = Cs(CS_ARCH_X86, CS_MODE_64)
pos = 0
found = 0
while found < 4:
    pos = code.find(b"\xE8", pos)
    if pos < 0: break
    rva = text[1] + pos
    if rva + 5 + struct.unpack_from("<i", code, pos + 1)[0] == target:
        found += 1
        print(f"--- call at {rva:#x}")
        start = rva - 0x60
        for ins in md.disasm(data[off(start):off(start) + 0x60 + 5 + 0x30], start):
            note = ""
            m = re.search(r"\[rip ([+-]) (0x[0-9a-f]+)\]", ins.op_str)
            if m:
                t = ins.address + ins.size + (int(m.group(2), 16) if m.group(1) == "+" else -int(m.group(2), 16))
                note = f"   ; {t:#x} in {sec_of(t)}"
            if ins.address >= rva - 0x38: print(f"  {ins.address:#x}: {ins.mnemonic} {ins.op_str}{note}")
    pos += 1
print("callers found:", found)
