#!/usr/bin/env python3
"""
rcedit 无法修改 electron-builder 生成的 portable 7z-SFX 时,
用 pefile 直接修正 RT_GROUP_ICON 目录里的 icon ID 顺序。
electron-builder 对 portable 会把 group icon 条目按 16,32,48,64,128,256 排列,
但对应 RT_ICON 资源 ID 却被写成 6,5,4,3,2,1(完全倒序),导致 Explorer 显示默认图标。
本脚本把 group 目录里的 id 字段修正为 1,2,3,4,5,6。
"""
import sys
import struct
import pefile


def fix(exe_path):
    pe = pefile.PE(exe_path)
    group = None
    for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if entry.id == pefile.RESOURCE_TYPE["RT_GROUP_ICON"]:
            group = entry.directory.entries[0]
            break
    if not group:
        print("no RT_GROUP_ICON")
        return 1

    data_entry = group.directory.entries[0].data
    rva = data_entry.struct.OffsetToData
    size = data_entry.struct.Size
    # Convert RVA to file offset
    offset = pe.get_offset_from_rva(rva)

    with open(exe_path, "r+b") as f:
        f.seek(offset)
        header = f.read(6)
        reserved, typ, count = struct.unpack("<HHH", header)
        print(f"{exe_path}: count={count}")
        for i in range(count):
            entry_off = offset + 6 + i * 14
            f.seek(entry_off)
            entry = f.read(14)
            w, h, colors, reserved, planes, bpp, bytes_in_res, icon_id = struct.unpack(
                "<BBBBHHIH", entry
            )
            new_id = i + 1
            if icon_id != new_id:
                f.seek(entry_off + 12)
                f.write(struct.pack("<H", new_id))
                print(f"  entry {i} {w}x{h}: id {icon_id} -> {new_id}")
            else:
                print(f"  entry {i} {w}x{h}: id {icon_id} already ok")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: fix-portable-icon.py <exe>")
        sys.exit(1)
    sys.exit(fix(sys.argv[1]))
