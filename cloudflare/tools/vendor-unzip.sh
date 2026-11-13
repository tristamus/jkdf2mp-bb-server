#!/usr/bin/env bash
# Makes src/vendor/jkunzip.js again from the page's unzip.js (tristamus/OpenJKDF2,
# packaging/wasm/unzip.js): the same file without its worker part, plus an export.
#   bash tools/vendor-unzip.sh <OpenJKDF2 checkout>
set -euo pipefail
U="$1/packaging/wasm/unzip.js"
N=$(grep -n "^if (typeof WorkerGlobalScope" "$U" | cut -d: -f1)
OUT="$(dirname "$0")/../src/vendor/jkunzip.js"
{
  echo "// packaging/wasm/unzip.js of tristamus/OpenJKDF2 (web-mp $(git -C "$1" rev-parse --short=8 HEAD)), the page's own unzipper, without its"
  echo "// worker part and with an export, for the Level Library's job (src/levels-read.js). Keep it the same"
  echo "// as the page's when that changes: tools/vendor-unzip.sh makes it again."
  echo
  head -n $((N-1)) "$U"
  echo "export { JkUnzip };"
} > "$OUT"
