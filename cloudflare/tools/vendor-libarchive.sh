#!/usr/bin/env bash
# Makes src/vendor/libarchive.js and src/vendor/libarchive.wasm again from the
# npm package libarchive-wasm (ofk/libarchive-wasm, MIT), whose wasm is
# libarchive with zlib, liblzma and bzip2 built in: it opens .7z and .rar
# (RAR 4 and 5), which the Level Library's job unpacks (src/levels-unpack.js).
#   npm pack libarchive-wasm@1.2.0 && tar xzf libarchive-wasm-1.2.0.tgz
#   bash tools/vendor-libarchive.sh package
# The package's src/libarchive.js is emscripten's loader. It's changed so it
# runs in a Worker: no Node.js or browser paths (a Worker is neither, and
# would bundle the Node.js requires), the wasm memory's cap from
# Module.maxHeap (so an archive too big to unpack fails to allocate rather
# than taking the Durable Object's 128 MB) and Module.heapFull set when it
# couldn't grow, and an ES module export. src/vendor/libarchive-LICENSES.txt
# has the licenses of what the wasm is built from: check it for a new version.
set -euo pipefail
P="$1"
OUT="$(dirname "$0")/../src/vendor"
VER=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$P/package.json" | head -1)
python3 - "$P/src/libarchive.js" "$OUT/libarchive.js" "$VER" <<'EOF'
import sys
src, out, ver = sys.argv[1], sys.argv[2], sys.argv[3]
js = open(src, encoding="utf-8").read()
def swap(old, new):
    global js
    n = js.count(old)
    if n != 1:
        sys.exit(f"{src}: {old!r} is there {n} times, not once: the loader has changed, check this script")
    js = js.replace(old, new)
swap('var ENVIRONMENT_IS_WEB=typeof window=="object";', 'var ENVIRONMENT_IS_WEB=false;')
swap('var ENVIRONMENT_IS_WORKER=typeof WorkerGlobalScope!="undefined";', 'var ENVIRONMENT_IS_WORKER=false;')
swap('var ENVIRONMENT_IS_NODE=typeof process=="object"&&typeof process.versions=="object"&&typeof process.versions.node=="string"&&process.type!="renderer";',
     'var ENVIRONMENT_IS_NODE=false;')
swap('require("fs")', 'null')
swap('require("path")', 'null')
swap('require("crypto")', 'null')
swap('getHeapMax=()=>2147483648;', 'getHeapMax=()=>Module["maxHeap"]||2147483648;')
# Says when the memory couldn't grow (Module.heapFull, the size asked for):
# libarchive doesn't always say so itself.
swap('if(requestedSize>maxHeapSize){return false}', 'if(requestedSize>maxHeapSize){Module["heapFull"]=requestedSize;return false}')
swap('if(replacement){return true}}return false};', 'if(replacement){return true}}Module["heapFull"]=requestedSize;return false};')
tail = js.rfind("if (typeof exports === 'object' && typeof module === 'object')")
if tail < 0:
    sys.exit(f"{src}: no CommonJS export at its end: the loader has changed, check this script")
js = js[:tail].rstrip() + "\nexport default libarchive;\n"
head = (f"// src/libarchive.js of the npm package libarchive-wasm {ver} (ofk/libarchive-wasm, MIT;\n"
        "// libarchive 3.7.7, BSD-2-Clause; zlib 1.3.1, zlib License; liblzma 5.6.4, 0BSD; bzip2 1.0.8,\n"
        "// bzip2 License), emscripten's loader for libarchive.wasm beside it. Changed to run in a Worker:\n"
        "// no Node.js or browser paths, the wasm memory capped at Module.maxHeap (Module.heapFull says\n"
        "// when it couldn't grow), an ES module export.\n"
        "// tools/vendor-libarchive.sh makes it again.\n\n")
open(out, "w", encoding="utf-8").write(head + js)
EOF
cp "$P/src/libarchive.wasm" "$OUT/libarchive.wasm"
echo "src/vendor/libarchive.js and libarchive.wasm from libarchive-wasm $VER"
