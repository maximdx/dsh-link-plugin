import json, struct, sys, pathlib

src = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
want = sys.argv[3] if len(sys.argv) > 3 else None

with open(src, 'rb') as f:
    _, size = struct.unpack('<II', f.read(8))
    header = f.read(size).decode('utf-8', 'replace')
    base_off = 8 + size
    json_start = header.find('{')
    tree, _ = json.JSONDecoder().raw_decode(header[json_start:])
    print('header json bytes:', size)

    count = 0
    def walk(node, prefix):
        global count
        if 'files' in node:
            for name, child in node['files'].items():
                walk(child, prefix + name + '/')
        else:
            sz = node.get('size', 0)
            offset = node.get('offset')
            if want and not prefix.startswith(want):
                return
            dest = out / prefix
            dest.parent.mkdir(parents=True, exist_ok=True)
            if node.get('unpacked'):
                dest.with_suffix(dest.suffix + '.UNPACKED').write_text('')
                return
            with open(src, 'rb') as f2:
                f2.seek(base_off + int(offset))
                dest.write_bytes(f2.read(sz))
            count += 1

    walk(tree, '')
print('files written:', count)
