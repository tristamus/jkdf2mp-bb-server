// packaging/wasm/unzip.js of tristamus/OpenJKDF2 (web-mp 0651055e), the page's own unzipper, without its
// worker part and with an export, for the Level Library's job (src/levels-read.js). Keep it the same
// as the page's when that changes: tools/vendor-unzip.sh makes it again.

// Unpacks the zip entries the browser can't by itself: every compression
// method mods are zipped with besides stored and deflated, which index.html
// opens itself (zipRead, with DecompressionStream). The page runs this file
// in a worker when a zip needs it, so a big mod doesn't stall the page; the
// tests load it in Node (packaging/wasm/test/unzip-test.mjs).
//
// Methods (PKWARE's APPNOTE.TXT, 4.4.5):
//   1 Shrink, 2-5 Reduce, 6 Implode   PKZIP 1.x; ported from hwzip 2.4 by
//                                     Hans Wennborg (public domain)
//   8 Deflate, 9 Deflate64            RFC 1951, and its 64 KiB window
//   12 BZip2                          bzip2 1.0's format
//   14 LZMA, 95 XZ                    the LZMA SDK's LZMA, LZMA2 and the
//                                     .xz container (LZMA2 with delta or x86)
//   93 Zstandard                      fzstd 0.1.1 by Arjun Barrett (MIT, below)
//   98 PPMd                           PPMd var.I rev.1, ported from 7-Zip's
//                                     Ppmd8 by Igor Pavlov (public domain)
// Each entry is checked against the CRC-32 its zip gives, so a decoder's
// mistake leaves the zip closed rather than a mod with a broken file.
//
// In a worker: post { id, method, flags, data, size, crc } with data an
// ArrayBuffer of the entry's compressed bytes and size its unpacked size;
// the answer is { id, data } with an ArrayBuffer of exactly size bytes, or
// { id, error }.

var JkUnzip = (function() {
    'use strict';

    function bad(what) {
        return new Error(what || 'corrupt data');
    }

    // ---- CRC-32, as zip uses it.

    var CRC_TABLE = (function() {
        var t = new Int32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++)
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c;
        }
        return t;
    })();

    function crc32(bytes) {
        var c = -1, t = CRC_TABLE;
        for (var i = 0, n = bytes.length; i < n; i++)
            c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ -1) >>> 0;
    }

    // ---- Bits, least significant first (Deflate and the PKZIP 1.x methods).
    // Past the end they read as zeros; over() says whether any were.

    function Bits(src) {
        this.src = src;
        this.pos = 0;
        this.buf = 0;
        this.cnt = 0;
    }
    Bits.prototype.fill = function(n) {
        while (this.cnt < n) {
            this.buf |= (this.pos < this.src.length ? this.src[this.pos] : 0) << this.cnt;
            this.pos++;
            this.cnt += 8;
        }
    };
    // n is at most 24.
    Bits.prototype.get = function(n) {
        if (!n)
            return 0;
        this.fill(n);
        var v = this.buf & ((1 << n) - 1);
        this.buf >>>= n;
        this.cnt -= n;
        return v;
    };
    Bits.prototype.peek = function(n) {
        this.fill(n);
        return this.buf & ((1 << n) - 1);
    };
    Bits.prototype.skip = function(n) {
        this.buf >>>= n;
        this.cnt -= n;
    };
    Bits.prototype.align = function() {
        this.skip(this.cnt & 7);
    };
    // Whole bytes read so far, counting a part of one.
    Bits.prototype.used = function() {
        return this.pos - (this.cnt >> 3);
    };
    Bits.prototype.over = function() {
        return this.used() > this.src.length;
    };

    // A prefix code from its code lengths, as Deflate assigns them (shorter
    // codes first, and in symbol order within a length), for codes read a
    // bit at a time from the low end: t[the next b bits] is the symbol times
    // 32 plus its length, or 0 where no code is. Throws for lengths that
    // can't be a prefix code; complete says the code must use every bit
    // pattern (Implode's must).
    function huffman(lens, n, complete) {
        var count = new Int32Array(17), next = new Int32Array(17), max = 0, i;
        for (i = 0; i < n; i++) {
            count[lens[i]]++;
            if (lens[i] > max)
                max = lens[i];
        }
        count[0] = 0;
        var left = 1;
        for (i = 1; i <= 16; i++) {
            left = (left << 1) - count[i];
            if (left < 0)
                throw bad();
        }
        if (complete && left)
            throw bad();
        var t = new Int32Array(1 << max);
        for (i = 1; i <= max; i++)
            next[i] = (next[i - 1] + count[i - 1]) << 1;
        for (var s = 0; s < n; s++) {
            var l = lens[s];
            if (!l)
                continue;
            var c = next[l]++, r = 0;
            for (var k = 0; k < l; k++, c >>= 1)
                r = (r << 1) | (c & 1);
            for (var j = r; j < t.length; j += 1 << l)
                t[j] = (s << 5) | l;
        }
        return { t: t, b: max };
    }

    function decodeSym(r, h) {
        var e = h.t[r.peek(h.b)];
        if (!(e & 31))
            throw bad();
        r.skip(e & 31);
        return e >> 5;
    }

    // ---- Inflate: Deflate (RFC 1951), or Deflate64 (d64), which has a 64 KiB
    // window, 16 extra bits for length code 285, and distance codes 30 and 31.

    var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163,
                    195, 227, 258];
    var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
                     3073, 4097, 6145, 8193, 12289, 16385, 24577, 32769, 49153];
    var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
                      14, 14];
    var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    var fixed = null;

    function fixedCodes() {
        if (!fixed) {
            var l = new Uint8Array(288), d = new Uint8Array(32);
            l.fill(8, 0, 144);
            l.fill(9, 144, 256);
            l.fill(7, 256, 280);
            l.fill(8, 280, 288);
            d.fill(5);
            fixed = { lit: huffman(l, 288), dist: huffman(d, 32) };
        }
        return fixed;
    }

    function inflate(src, size, d64) {
        var out = new Uint8Array(size), op = 0;
        var r = new Bits(src);
        var nd = d64 ? 32 : 30;
        for (;;) {
            var last = r.get(1), type = r.get(2);
            if (type === 0) {
                r.align();
                var len = r.get(16), nlen = r.get(16);
                if ((len ^ 0xffff) !== nlen || op + len > size)
                    throw bad();
                // Byte-aligned now, with nothing left in the bit buffer.
                var at = r.used();
                if (at + len > src.length)
                    throw bad();
                out.set(src.subarray(at, at + len), op);
                op += len;
                r.pos = at + len;
                r.buf = r.cnt = 0;
            } else if (type === 1 || type === 2) {
                var lit, dist;
                if (type === 1) {
                    lit = fixedCodes().lit;
                    dist = fixed.dist;
                } else {
                    var hlit = r.get(5) + 257, hdist = r.get(5) + 1, hclen = r.get(4) + 4;
                    var cl = new Uint8Array(19);
                    for (var i = 0; i < hclen; i++)
                        cl[CL_ORDER[i]] = r.get(3);
                    var clh = huffman(cl, 19);
                    var lens = new Uint8Array(hlit + hdist);
                    for (var i = 0; i < hlit + hdist;) {
                        var sym = decodeSym(r, clh);
                        if (sym < 16) {
                            lens[i++] = sym;
                            continue;
                        }
                        var rep, val = 0;
                        if (sym === 16) {
                            if (!i)
                                throw bad();
                            val = lens[i - 1];
                            rep = 3 + r.get(2);
                        } else if (sym === 17) {
                            rep = 3 + r.get(3);
                        } else {
                            rep = 11 + r.get(7);
                        }
                        if (i + rep > hlit + hdist)
                            throw bad();
                        lens.fill(val, i, i + rep);
                        i += rep;
                    }
                    if (!lens[256])
                        throw bad();
                    lit = huffman(lens.subarray(0, hlit), hlit);
                    dist = huffman(lens.subarray(hlit), hdist);
                }
                for (;;) {
                    var sym = decodeSym(r, lit);
                    if (sym < 256) {
                        if (op >= size)
                            throw bad();
                        out[op++] = sym;
                        continue;
                    }
                    if (sym === 256)
                        break;
                    sym -= 257;
                    if (sym >= 29)
                        throw bad();
                    var len = d64 && sym === 28 ? 3 + r.get(16) : LEN_BASE[sym] + r.get(LEN_EXTRA[sym]);
                    var ds = decodeSym(r, dist);
                    if (ds >= nd)
                        throw bad();
                    var d = DIST_BASE[ds] + r.get(DIST_EXTRA[ds]);
                    if (d > op || op + len > size)
                        throw bad();
                    for (var from = op - d, end = op + len; op < end;)
                        out[op++] = out[from++];
                }
            } else {
                throw bad();
            }
            if (r.over())
                throw bad();
            if (last)
                break;
        }
        if (op !== size)
            throw bad();
        return out;
    }

    // ---- Unshrink (method 1): LZW with codes of 9 to 13 bits, where code
    // 256 then 1 makes them a bit longer and 256 then 2 frees the codes that
    // aren't a prefix of another (a partial clear). Ported from hwzip's
    // hwunshrink.

    var SH_MAX = 8191, SH_CONTROL = 256, SH_INVALID = 0xffff, SH_UNKNOWN = 0xffff;

    function unshrink(src, size) {
        var out = new Uint8Array(size), op = 0;
        var prefix = new Uint16Array(SH_MAX + 1), ext = new Uint8Array(SH_MAX + 1);
        var lens = new Uint16Array(SH_MAX + 1), lastPos = new Float64Array(SH_MAX + 1);
        var queue = new Uint16Array(SH_MAX - SH_CONTROL + 2), qNext = 0;
        var i;
        for (i = 0; i <= 255; i++) {
            prefix[i] = i;
            ext[i] = i;
            lens[i] = 1;
        }
        for (; i <= SH_MAX; i++)
            prefix[i] = SH_INVALID;
        var q = 0;
        for (i = SH_CONTROL + 1; i <= SH_MAX; i++)
            queue[q++] = i;
        queue[q] = SH_INVALID;

        var r = new Bits(src), totalBits = src.length * 8, bitsRead = 0, codeSize = 9;

        function partialClear() {
            var isPrefix = new Uint8Array(SH_MAX + 1), n = 0, k;
            for (k = SH_CONTROL + 1; k <= SH_MAX; k++) {
                if (prefix[k] !== SH_INVALID)
                    isPrefix[prefix[k]] = 1;
            }
            for (k = SH_CONTROL + 1; k <= SH_MAX; k++) {
                if (!isPrefix[k]) {
                    prefix[k] = SH_INVALID;
                    queue[n++] = k;
                }
            }
            queue[n] = SH_INVALID;
            qNext = 0;
        }

        // The next code, -1 at the end of the input, or SH_INVALID for a
        // control code that makes no sense.
        function readCode() {
            for (;;) {
                if (totalBits - bitsRead < codeSize)
                    return -1;
                var code = r.get(codeSize);
                bitsRead += codeSize;
                if (code !== SH_CONTROL)
                    return code;
                if (totalBits - bitsRead < codeSize)
                    return SH_INVALID;
                var control = r.get(codeSize);
                bitsRead += codeSize;
                if (control === 1 && codeSize < 13)
                    codeSize++;
                else if (control === 2)
                    partialClear();
                else
                    return SH_INVALID;
            }
        }

        function copy(from, to, n) {
            for (var k = 0; k < n; k++)
                out[to + k] = out[from + k];
        }

        var first;
        // The string for code at op: its length, with its first byte in first.
        function output(code, prevCode) {
            if (code <= 255) {
                first = code;
                out[op] = code;
                return 1;
            }
            if (prefix[code] === SH_INVALID || prefix[code] === code)
                throw bad();
            if (lens[code] !== SH_UNKNOWN) {
                if (size - op < lens[code])
                    throw bad();
                copy(lastPos[code], op, lens[code]);
                first = out[op];
                return lens[code];
            }
            // A code whose prefix was cleared when it was added: its string is
            // known once that prefix is in the table again.
            var pc = prefix[code];
            if (pc === queue[qNext]) {
                prefix[pc] = prevCode;
                ext[pc] = first;
                lens[pc] = lens[prevCode] + 1;
                lastPos[pc] = lastPos[prevCode];
                out[op] = first;
            } else if (prefix[pc] === SH_INVALID) {
                throw bad();
            }
            var len = lens[pc] + 1;
            if (size - op < len)
                throw bad();
            copy(lastPos[pc], op, lens[pc]);
            out[op + len - 1] = ext[code];
            first = out[op];
            lens[code] = len;
            lastPos[code] = op;
            return len;
        }

        var cur = readCode();
        if (cur < 0) {
            if (size)
                throw bad();
            return out;
        }
        if (cur > 255 || !size)
            throw bad();
        first = cur;
        out[op] = cur;
        lastPos[cur] = op;
        op++;
        var prev = cur;
        while ((cur = readCode()) >= 0) {
            if (cur === SH_INVALID || op === size)
                throw bad();
            // The code just about to be added, used already (KwKwK).
            if (cur === queue[qNext]) {
                if (prefix[prev] === SH_INVALID)
                    throw bad();
                prefix[cur] = prev;
                ext[cur] = first;
                lens[cur] = lens[prev] + 1;
                lastPos[cur] = lastPos[prev];
                out[op] = first;
            }
            var len = output(cur, prev);
            var nc = queue[qNext];
            if (nc !== SH_INVALID) {
                qNext++;
                prefix[nc] = prev;
                ext[nc] = first;
                lens[nc] = prefix[prev] === SH_INVALID ? SH_UNKNOWN : lens[prev] + 1;
                lastPos[nc] = lastPos[prev];
            }
            lastPos[cur] = op;
            op += len;
            prev = cur;
        }
        if (op !== size)
            throw bad();
        return out;
    }

    // ---- Expand (methods 2 to 5, Reduce with factor 1 to 4): bytes coded by
    // the byte before them, then runs after a DLE (144) byte. Ported from
    // hwzip's hwexpand.

    function expand(src, size, factor) {
        var out = new Uint8Array(size), op = 0;
        var r = new Bits(src);
        var fsize = new Uint8Array(256), fbits = new Uint8Array(256), followers = new Uint8Array(256 * 32);
        for (var i = 255; i >= 0; i--) {
            var n = r.get(6);
            if (n > 32)
                throw bad();
            fsize[i] = n;
            fbits[i] = n > 16 ? 5 : n > 8 ? 4 : n > 4 ? 3 : n > 2 ? 2 : n > 0 ? 1 : 0;
            for (var j = 0; j < n; j++)
                followers[i * 32 + j] = r.get(8);
        }
        var cur = 0;
        function next() {
            if (!fsize[cur])
                return (cur = r.get(8));
            if (r.get(1))
                return (cur = r.get(8));
            var k = r.get(fbits[cur]);
            if (k >= fsize[cur])
                throw bad();
            return (cur = followers[cur * 32 + k]);
        }
        var lenBits = 8 - factor;
        while (op < size) {
            if (next() !== 144) {
                out[op++] = cur;
                continue;
            }
            var v = next();
            if (!v) {
                out[op++] = 144;
                continue;
            }
            var len = v & ((1 << lenBits) - 1);
            if (len === (1 << lenBits) - 1)
                len += next();
            len += 3;
            var dist = (v >> lenBits) * 256 + next() + 1;
            if (len > size - op)
                throw bad();
            // Before the start reads as zeros.
            for (var end = op + len; op < end; op++)
                out[op] = dist > op ? 0 : out[op - dist];
        }
        if (r.over())
            throw bad();
        return out;
    }

    // ---- Explode (method 6, Implode): LZ77 with Shannon-Fano codes, a 4 or
    // 8 KiB window (flag 2) and literals raw or coded (flag 4). PKZIP 1.01 and
    // 1.02 took the shortest match from the window instead of the literals,
    // which hwzip tells apart by whether the result comes out right; so does
    // this. Ported from hwzip's hwexplode.

    function readSF(r, n) {
        var lens = new Uint8Array(n), k = 0;
        for (var count = r.get(8) + 1; count > 0; count--) {
            var b = r.get(8), len = (b & 15) + 1, run = (b >> 4) + 1;
            if (k + run > n)
                throw bad();
            lens.fill(len, k, k + run);
            k += run;
        }
        if (k < n)
            throw bad();
        return huffman(lens, n, true);
    }

    // Implode's codes are Deflate's with every bit flipped.
    function decodeSF(r, h) {
        var e = h.t[~r.peek(h.b) & ((1 << h.b) - 1)];
        r.skip(e & 31);
        return e >> 5;
    }

    function explodeOnce(src, size, large, litTree, pk101) {
        var out = new Uint8Array(size), op = 0;
        var r = new Bits(src);
        var lit = litTree ? readSF(r, 256) : null;
        var lenCode = readSF(r, 64), distCode = readSF(r, 64);
        var minLen = pk101 ? (large ? 3 : 2) : (litTree ? 3 : 2);
        var distBits = large ? 7 : 6;
        while (op < size) {
            if (r.get(1)) {
                out[op++] = lit ? decodeSF(r, lit) : r.get(8);
                continue;
            }
            var dist = r.get(distBits);
            dist = (dist | (decodeSF(r, distCode) << distBits)) + 1;
            var sym = decodeSF(r, lenCode), len = sym + minLen;
            if (sym === 63)
                len += r.get(8);
            if (len > size - op)
                throw bad();
            for (var end = op + len; op < end; op++)
                out[op] = dist > op ? 0 : out[op - dist];
        }
        if (r.used() !== src.length)
            throw bad();
        return out;
    }

    function explode(src, size, flags) {
        var large = !!(flags & 2), litTree = !!(flags & 4);
        try {
            return explodeOnce(src, size, large, litTree, false);
        } catch (e) {
            return explodeOnce(src, size, large, litTree, true);
        }
    }

    // ---- BZip2 (method 12): bzip2's own format, of one or more streams back
    // to back. Blocks bzip2 0.9.0 and older "randomised" aren't read.

    function BitsMSB(src) {
        this.src = src;
        this.pos = 0;
        this.buf = 0;
        this.cnt = 0;
    }
    // n is at most 24.
    BitsMSB.prototype.fill = function(n) {
        while (this.cnt < n) {
            this.buf = (this.buf << 8) | (this.pos < this.src.length ? this.src[this.pos] : 0);
            this.pos++;
            this.cnt += 8;
        }
    };
    BitsMSB.prototype.get = function(n) {
        this.fill(n);
        this.cnt -= n;
        var v = (this.buf >>> this.cnt) & ((1 << n) - 1);
        this.buf &= (1 << this.cnt) - 1;
        return v;
    };
    BitsMSB.prototype.peek = function(n) {
        this.fill(n);
        return (this.buf >>> (this.cnt - n)) & ((1 << n) - 1);
    };
    BitsMSB.prototype.skip = function(n) {
        this.cnt -= n;
        this.buf &= (1 << this.cnt) - 1;
    };
    BitsMSB.prototype.over = function() {
        return this.pos - (this.cnt >> 3) > this.src.length;
    };

    var BZ_FAST = 10;

    // bzip2's prefix codes (lengths 1 to 20, read from the high bit), with a
    // table for codes of up to BZ_FAST bits and bzip2's limits for the rest.
    function bzCode(lens, n) {
        var minLen = 32, maxLen = 0, i, len;
        for (i = 0; i < n; i++) {
            if (lens[i] > maxLen)
                maxLen = lens[i];
            if (lens[i] < minLen)
                minLen = lens[i];
        }
        var perm = new Int32Array(n), base = new Int32Array(23), limit = new Int32Array(22), pp = 0;
        for (len = minLen; len <= maxLen; len++) {
            for (i = 0; i < n; i++) {
                if (lens[i] === len)
                    perm[pp++] = i;
            }
        }
        for (i = 0; i < n; i++)
            base[lens[i] + 1]++;
        for (i = 1; i < 23; i++)
            base[i] += base[i - 1];
        var vec = 0;
        for (len = minLen; len <= maxLen; len++) {
            vec += base[len + 1] - base[len];
            limit[len] = vec - 1;
            vec <<= 1;
        }
        for (len = minLen + 1; len <= maxLen; len++)
            base[len] = ((limit[len - 1] + 1) << 1) - base[len];
        // The fast table, from the same codes.
        var fast = Math.min(maxLen, BZ_FAST), t = new Int32Array(1 << fast), code = 0;
        pp = 0;
        for (len = minLen; len <= maxLen; len++) {
            if (len > minLen)
                code <<= 1;
            for (; pp < n && lens[perm[pp]] === len; pp++, code++) {
                if (len <= fast) {
                    var at = code << (fast - len);
                    t.fill((perm[pp] << 5) | len, at, at + (1 << (fast - len)));
                }
            }
        }
        return { t: t, fast: fast, minLen: minLen, maxLen: maxLen, perm: perm, base: base, limit: limit };
    }

    function bzSym(r, c) {
        var e = c.t[r.peek(c.fast)];
        if (e) {
            r.skip(e & 31);
            return e >> 5;
        }
        var len = c.fast, v = r.get(len);
        while (len < c.maxLen && v > c.limit[len]) {
            v = (v << 1) | r.get(1);
            len++;
        }
        if (v > c.limit[len] || v - c.base[len] < 0 || v - c.base[len] >= c.perm.length)
            throw bad();
        return c.perm[v - c.base[len]];
    }

    function bunzip2(src, size) {
        var out = new Uint8Array(size), op = 0;
        var r = new BitsMSB(src);
        var tt = null;
        var streams = 0;
        while (op < size || !streams) {
            if (r.get(8) !== 0x42 || r.get(8) !== 0x5a || r.get(8) !== 0x68)
                throw bad();
            var level = r.get(8) - 0x30;
            if (level < 1 || level > 9)
                throw bad();
            var maxBlock = level * 100000;
            if (!tt || tt.length < maxBlock)
                tt = new Uint32Array(maxBlock);
            streams++;
            for (;;) {
                var m1 = r.get(24), m2 = r.get(24);
                if (m1 === 0x177245 && m2 === 0x385090) {
                    r.get(16);
                    r.get(16);
                    r.skip(r.cnt & 7);
                    break;
                }
                if (m1 !== 0x314159 || m2 !== 0x265359)
                    throw bad();
                r.get(16);
                r.get(16);
                if (r.get(1))
                    throw bad('randomised bzip2 block');
                var origPtr = r.get(24);
                var used = r.get(16), unseq = new Uint8Array(256), nInUse = 0, i, j;
                for (i = 0; i < 16; i++) {
                    if (used & (0x8000 >> i)) {
                        var bits = r.get(16);
                        for (j = 0; j < 16; j++) {
                            if (bits & (0x8000 >> j))
                                unseq[nInUse++] = i * 16 + j;
                        }
                    }
                }
                if (!nInUse)
                    throw bad();
                var alpha = nInUse + 2;
                var nGroups = r.get(3), nSel = r.get(15);
                if (nGroups < 2 || nGroups > 6 || !nSel)
                    throw bad();
                var mtfG = [0, 1, 2, 3, 4, 5], sel = new Uint8Array(nSel);
                for (i = 0; i < nSel; i++) {
                    for (j = 0; r.get(1); j++) {
                        if (j + 1 >= nGroups)
                            throw bad();
                    }
                    var g = mtfG[j];
                    for (; j > 0; j--)
                        mtfG[j] = mtfG[j - 1];
                    sel[i] = mtfG[0] = g;
                }
                // bzip2 1.0.8 ignores selectors past the most a block can use.
                if (nSel > 18002)
                    nSel = 18002;
                var codes = [];
                for (var t = 0; t < nGroups; t++) {
                    var lens = new Uint8Array(alpha), cur = r.get(5);
                    for (i = 0; i < alpha; i++) {
                        for (;;) {
                            if (cur < 1 || cur > 20)
                                throw bad();
                            if (!r.get(1))
                                break;
                            cur += r.get(1) ? -1 : 1;
                        }
                        lens[i] = cur;
                    }
                    codes.push(bzCode(lens, alpha));
                }
                // The move-to-front values, with runs of the front one coded
                // in RUNA (0) and RUNB (1) as a number in bijective base 2.
                var mtf = new Uint8Array(256), counts = new Int32Array(256);
                for (i = 0; i < 256; i++)
                    mtf[i] = i;
                var eob = nInUse + 1, nblock = 0, group = -1, left = 0, code = null;
                var run = 0, runBit = 1;
                for (;;) {
                    if (!left) {
                        if (++group >= nSel)
                            throw bad();
                        code = codes[sel[group]];
                        left = 50;
                    }
                    left--;
                    var sym = bzSym(r, code);
                    if (sym <= 1) {
                        run += runBit << sym;
                        runBit <<= 1;
                        if (run > maxBlock)
                            throw bad();
                        continue;
                    }
                    if (run) {
                        var b = unseq[mtf[0]];
                        if (nblock + run > maxBlock)
                            throw bad();
                        counts[b] += run;
                        tt.fill(b, nblock, nblock + run);
                        nblock += run;
                        run = 0;
                        runBit = 1;
                    }
                    if (sym === eob)
                        break;
                    if (nblock >= maxBlock)
                        throw bad();
                    var k = sym - 1, v = mtf[k];
                    for (; k > 0; k--)
                        mtf[k] = mtf[k - 1];
                    mtf[0] = v;
                    var b = unseq[v];
                    counts[b]++;
                    tt[nblock++] = b;
                }
                if (origPtr >= nblock || r.over())
                    throw bad();
                // Undo the Burrows-Wheeler transform: each entry's high bits
                // say where the next byte is.
                var cf = new Int32Array(256);
                for (i = 0, j = 0; i < 256; i++) {
                    cf[i] = j;
                    j += counts[i];
                }
                for (i = 0; i < nblock; i++) {
                    var b = tt[i] & 0xff;
                    tt[cf[b]++] |= i << 8;
                }
                // Then the runs: four of a byte and the count of more.
                var pos = tt[origPtr] >>> 8, same = 0, last = -1;
                for (i = 0; i < nblock; i++) {
                    var e = tt[pos];
                    var ch = e & 0xff;
                    pos = e >>> 8;
                    if (same === 4) {
                        if (op + ch > size)
                            throw bad();
                        out.fill(last, op, op + ch);
                        op += ch;
                        same = 0;
                        last = -1;
                        continue;
                    }
                    if (ch === last) {
                        same++;
                    } else {
                        same = 1;
                        last = ch;
                    }
                    if (op >= size)
                        throw bad();
                    out[op++] = ch;
                }
            }
            if (r.over())
                throw bad();
            // Another stream may follow.
            if (op < size && r.pos - (r.cnt >> 3) >= src.length)
                throw bad();
        }
        if (op !== size)
            throw bad();
        return out;
    }

    // ---- LZMA (method 14) and LZMA2, as the LZMA SDK's LzmaSpec.cpp decodes
    // them. The whole file is the dictionary: out holds it all.

    var LZ_IS_MATCH = 0, LZ_IS_REP = 192, LZ_IS_REP_G0 = 204, LZ_IS_REP_G1 = 216, LZ_IS_REP_G2 = 228,
        LZ_IS_REP0_LONG = 240, LZ_POS_SLOT = 432, LZ_SPEC_POS = 688, LZ_ALIGN = 802, LZ_LEN = 818,
        LZ_REP_LEN = 1332, LZ_LITERAL = 1846;

    function lzmaProps(d) {
        if (d >= 9 * 5 * 5)
            throw bad();
        return { lc: d % 9, lp: ((d / 9) | 0) % 5, pb: (d / 45) | 0 };
    }

    function Lzma(out) {
        this.out = out;
        this.op = 0;
        this.start = 0;   // where the dictionary starts: an LZMA2 reset
        this.probs = null;
        this.state = 0;
        this.reps = [0, 0, 0, 0];
        this.ended = false;
    }

    Lzma.prototype.setProps = function(p) {
        this.lc = p.lc;
        this.lp = p.lp;
        this.pb = p.pb;
        var n = LZ_LITERAL + (0x300 << (p.lc + p.lp));
        if (!this.probs || this.probs.length !== n)
            this.probs = new Uint16Array(n);
    };

    Lzma.prototype.reset = function() {
        this.probs.fill(1024);
        this.state = 0;
        this.reps = [0, 0, 0, 0];
    };

    // Decodes the range-coded src[ip, end) until out is filled up to stop,
    // or an end marker. Returns where in src it got to. The range decoder is
    // written out in full at every bit (the same six lines each time), with
    // everything in local variables: this is where the time goes, and that
    // makes it a few times faster than calling a function for each bit.
    Lzma.prototype.decode = function(src, ip, end, stop) {
        var out = this.out, probs = this.probs, op = this.op, start = this.start;
        var lc = this.lc, lpMask = (1 << this.lp) - 1, pbMask = (1 << this.pb) - 1;
        var state = this.state, rep0 = this.reps[0], rep1 = this.reps[1], rep2 = this.reps[2], rep3 = this.reps[3];
        var range = 0xffffffff, code = 0, i = 0, p = 0, bound = 0, b = 0, m = 0, k = 0;
        var posState, len, lenBase, tb, tn, rs;

        if ((ip < end ? src[ip] : 0) !== 0)
            throw bad();
        ip++;
        for (k = 0; k < 4; k++, ip++)
            code = code * 256 + (ip < end ? src[ip] : 0);
        if (code === range)
            throw bad();

        while (op < stop) {
            posState = (op - start) & pbMask;
            i = LZ_IS_MATCH + (state << 4) + posState;
            p = probs[i];
            bound = (range >>> 11) * p;
            if (code < bound) {
                range = bound;
                probs[i] = p + ((2048 - p) >>> 5);
                b = 0;
            } else {
                range -= bound;
                code -= bound;
                probs[i] = p - (p >>> 5);
                b = 1;
            }
            if (range < 16777216) {
                range *= 256;
                code = code * 256 + (ip < end ? src[ip] : 0);
                ip++;
            }
            if (!b) {
                var base = LZ_LITERAL + 0x300 * ((((op - start) & lpMask) << lc) +
                                                 ((op > start ? out[op - 1] : 0) >> (8 - lc)));
                m = 1;
                if (state >= 7) {
                    var mb = out[op - rep0 - 1];
                    do {
                        var mbit = (mb >> 7) & 1;
                        mb <<= 1;
                        i = base + ((1 + mbit) << 8) + m;
                        p = probs[i];
                        bound = (range >>> 11) * p;
                        if (code < bound) {
                            range = bound;
                            probs[i] = p + ((2048 - p) >>> 5);
                            b = 0;
                        } else {
                            range -= bound;
                            code -= bound;
                            probs[i] = p - (p >>> 5);
                            b = 1;
                        }
                        if (range < 16777216) {
                            range *= 256;
                            code = code * 256 + (ip < end ? src[ip] : 0);
                            ip++;
                        }
                        m = (m << 1) | b;
                        if (mbit !== b)
                            break;
                    } while (m < 0x100);
                }
                while (m < 0x100) {
                    i = base + m;
                    p = probs[i];
                    bound = (range >>> 11) * p;
                    if (code < bound) {
                        range = bound;
                        probs[i] = p + ((2048 - p) >>> 5);
                        b = 0;
                    } else {
                        range -= bound;
                        code -= bound;
                        probs[i] = p - (p >>> 5);
                        b = 1;
                    }
                    if (range < 16777216) {
                        range *= 256;
                        code = code * 256 + (ip < end ? src[ip] : 0);
                        ip++;
                    }
                    m = (m << 1) | b;
                }
                out[op++] = m - 0x100;
                state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
                continue;
            }
            i = LZ_IS_REP + state;
            p = probs[i];
            bound = (range >>> 11) * p;
            if (code < bound) {
                range = bound;
                probs[i] = p + ((2048 - p) >>> 5);
                b = 0;
            } else {
                range -= bound;
                code -= bound;
                probs[i] = p - (p >>> 5);
                b = 1;
            }
            if (range < 16777216) {
                range *= 256;
                code = code * 256 + (ip < end ? src[ip] : 0);
                ip++;
            }
            if (b) {
                if (op === start)
                    throw bad();
                i = LZ_IS_REP_G0 + state;
                p = probs[i];
                bound = (range >>> 11) * p;
                if (code < bound) {
                    range = bound;
                    probs[i] = p + ((2048 - p) >>> 5);
                    b = 0;
                } else {
                    range -= bound;
                    code -= bound;
                    probs[i] = p - (p >>> 5);
                    b = 1;
                }
                if (range < 16777216) {
                    range *= 256;
                    code = code * 256 + (ip < end ? src[ip] : 0);
                    ip++;
                }
                if (!b) {
                    i = LZ_IS_REP0_LONG + (state << 4) + posState;
                    p = probs[i];
                    bound = (range >>> 11) * p;
                    if (code < bound) {
                        range = bound;
                        probs[i] = p + ((2048 - p) >>> 5);
                        b = 0;
                    } else {
                        range -= bound;
                        code -= bound;
                        probs[i] = p - (p >>> 5);
                        b = 1;
                    }
                    if (range < 16777216) {
                        range *= 256;
                        code = code * 256 + (ip < end ? src[ip] : 0);
                        ip++;
                    }
                    if (!b) {
                        state = state < 7 ? 9 : 11;
                        out[op] = out[op - rep0 - 1];
                        op++;
                        continue;
                    }
                } else {
                    var dist;
                    i = LZ_IS_REP_G1 + state;
                    p = probs[i];
                    bound = (range >>> 11) * p;
                    if (code < bound) {
                        range = bound;
                        probs[i] = p + ((2048 - p) >>> 5);
                        b = 0;
                    } else {
                        range -= bound;
                        code -= bound;
                        probs[i] = p - (p >>> 5);
                        b = 1;
                    }
                    if (range < 16777216) {
                        range *= 256;
                        code = code * 256 + (ip < end ? src[ip] : 0);
                        ip++;
                    }
                    if (!b) {
                        dist = rep1;
                    } else {
                        i = LZ_IS_REP_G2 + state;
                        p = probs[i];
                        bound = (range >>> 11) * p;
                        if (code < bound) {
                            range = bound;
                            probs[i] = p + ((2048 - p) >>> 5);
                            b = 0;
                        } else {
                            range -= bound;
                            code -= bound;
                            probs[i] = p - (p >>> 5);
                            b = 1;
                        }
                        if (range < 16777216) {
                            range *= 256;
                            code = code * 256 + (ip < end ? src[ip] : 0);
                            ip++;
                        }
                        if (!b) {
                            dist = rep2;
                        } else {
                            dist = rep3;
                            rep3 = rep2;
                        }
                        rep2 = rep1;
                    }
                    rep1 = rep0;
                    rep0 = dist;
                }
                lenBase = LZ_REP_LEN;
                state = state < 7 ? 8 : 11;
            } else {
                rep3 = rep2;
                rep2 = rep1;
                rep1 = rep0;
                lenBase = LZ_LEN;
                state = state < 7 ? 7 : 10;
            }

            // The length, less 2: 3 bits for 0 to 7, 3 more for 8 to 15, or 8
            // for 16 to 271.
            i = lenBase;
            p = probs[i];
            bound = (range >>> 11) * p;
            if (code < bound) {
                range = bound;
                probs[i] = p + ((2048 - p) >>> 5);
                b = 0;
            } else {
                range -= bound;
                code -= bound;
                probs[i] = p - (p >>> 5);
                b = 1;
            }
            if (range < 16777216) {
                range *= 256;
                code = code * 256 + (ip < end ? src[ip] : 0);
                ip++;
            }
            if (!b) {
                tb = lenBase + 2 + posState * 8;
                tn = 3;
                len = 0;
            } else {
                i = lenBase + 1;
                p = probs[i];
                bound = (range >>> 11) * p;
                if (code < bound) {
                    range = bound;
                    probs[i] = p + ((2048 - p) >>> 5);
                    b = 0;
                } else {
                    range -= bound;
                    code -= bound;
                    probs[i] = p - (p >>> 5);
                    b = 1;
                }
                if (range < 16777216) {
                    range *= 256;
                    code = code * 256 + (ip < end ? src[ip] : 0);
                    ip++;
                }
                if (!b) {
                    tb = lenBase + 130 + posState * 8;
                    tn = 3;
                    len = 8;
                } else {
                    tb = lenBase + 258;
                    tn = 8;
                    len = 16;
                }
            }
            for (m = 1, k = 0; k < tn; k++) {
                i = tb + m;
                p = probs[i];
                bound = (range >>> 11) * p;
                if (code < bound) {
                    range = bound;
                    probs[i] = p + ((2048 - p) >>> 5);
                    b = 0;
                } else {
                    range -= bound;
                    code -= bound;
                    probs[i] = p - (p >>> 5);
                    b = 1;
                }
                if (range < 16777216) {
                    range *= 256;
                    code = code * 256 + (ip < end ? src[ip] : 0);
                    ip++;
                }
                m = (m << 1) | b;
            }
            len += m - (1 << tn);

            // A new distance: a 6-bit slot, then the bits below its top two.
            if (lenBase === LZ_LEN) {
                tb = LZ_POS_SLOT + ((len < 3 ? len : 3) << 6);
                for (m = 1, k = 0; k < 6; k++) {
                    i = tb + m;
                    p = probs[i];
                    bound = (range >>> 11) * p;
                    if (code < bound) {
                        range = bound;
                        probs[i] = p + ((2048 - p) >>> 5);
                        b = 0;
                    } else {
                        range -= bound;
                        code -= bound;
                        probs[i] = p - (p >>> 5);
                        b = 1;
                    }
                    if (range < 16777216) {
                        range *= 256;
                        code = code * 256 + (ip < end ? src[ip] : 0);
                        ip++;
                    }
                    m = (m << 1) | b;
                }
                var slot = m - 64;
                if (slot < 4) {
                    rep0 = slot;
                } else {
                    var nd = (slot >> 1) - 1;
                    var d = (2 | (slot & 1)) * (1 << nd);
                    if (slot < 14) {
                        tb = LZ_SPEC_POS + d - slot;
                        tn = nd;
                    } else {
                        // Bits without probabilities, then 4 more with.
                        var v = 0;
                        for (k = nd - 4; k > 0; k--) {
                            range = range >>> 1;
                            b = code >= range ? 1 : 0;
                            if (b)
                                code -= range;
                            v = v * 2 + b;
                            if (range < 16777216) {
                                range *= 256;
                                code = code * 256 + (ip < end ? src[ip] : 0);
                                ip++;
                            }
                        }
                        d += v * 16;
                        tb = LZ_ALIGN;
                        tn = 4;
                    }
                    // Least significant bit first.
                    for (m = 1, rs = 0, k = 0; k < tn; k++) {
                        i = tb + m;
                        p = probs[i];
                        bound = (range >>> 11) * p;
                        if (code < bound) {
                            range = bound;
                            probs[i] = p + ((2048 - p) >>> 5);
                            b = 0;
                        } else {
                            range -= bound;
                            code -= bound;
                            probs[i] = p - (p >>> 5);
                            b = 1;
                        }
                        if (range < 16777216) {
                            range *= 256;
                            code = code * 256 + (ip < end ? src[ip] : 0);
                            ip++;
                        }
                        m = (m << 1) | b;
                        rs |= b << k;
                    }
                    rep0 = d + rs;
                    if (rep0 === 0xffffffff) {
                        // The end marker, after which the range coder has
                        // nothing left.
                        if (code !== 0)
                            throw bad();
                        this.ended = true;
                        break;
                    }
                }
                if (rep0 >= op - start)
                    throw bad();
            }
            len += 2;
            if (len > stop - op)
                throw bad();
            var from = op - rep0 - 1;
            if (len > 32 && rep0 >= len) {
                out.copyWithin(op, from, from + len);
                op += len;
            } else {
                for (var to = op + len; op < to;)
                    out[op++] = out[from++];
            }
        }
        if (ip > end)
            throw bad();
        this.op = op;
        this.state = state;
        this.reps = [rep0, rep1, rep2, rep3];
        return ip;
    };

    // Zip's LZMA: a version (2 bytes), the properties' size (2 bytes, 5),
    // then the properties and the range-coded data, with an end marker after
    // it if flag 2 is set.
    function unlzma(src, size) {
        if (src.length < 9 || (src[2] | (src[3] << 8)) !== 5)
            throw bad();
        var out = new Uint8Array(size);
        var lz = new Lzma(out);
        lz.setProps(lzmaProps(src[4]));
        lz.reset();
        lz.decode(src, 9, src.length, size);
        if (lz.op !== size)
            throw bad();
        return out;
    }

    // LZMA2 chunks from src[ip] to out[op] on, up to their end (a 0 byte).
    // Returns { ip, op } after them.
    function unlzma2(src, ip, out, op) {
        var lz = new Lzma(out);
        lz.op = lz.start = op;
        var end = src.length;
        for (;;) {
            if (ip >= end)
                throw bad();
            var c = src[ip++];
            if (!c)
                break;
            if (c === 1 || c === 2) {
                if (ip + 2 > end)
                    throw bad();
                var n = ((src[ip] << 8) | src[ip + 1]) + 1;
                ip += 2;
                if (c === 1)
                    lz.start = lz.op;
                if (ip + n > end || lz.op + n > out.length)
                    throw bad();
                out.set(src.subarray(ip, ip + n), lz.op);
                ip += n;
                lz.op += n;
                continue;
            }
            if (c < 0x80 || ip + 4 > end)
                throw bad();
            var unpacked = ((c & 0x1f) << 16) + (src[ip] << 8) + src[ip + 1] + 1;
            var packed = (src[ip + 2] << 8) + src[ip + 3] + 1;
            ip += 4;
            var reset = (c >> 5) & 3;
            if (reset === 3)
                lz.start = lz.op;
            if (reset >= 2) {
                var p = lzmaProps(src[ip++]);
                if (p.lc + p.lp > 4)
                    throw bad();
                lz.setProps(p);
            } else if (!lz.probs) {
                throw bad();
            }
            if (reset >= 1)
                lz.reset();
            if (ip + packed > end || lz.op + unpacked > out.length)
                throw bad();
            var stop = lz.op + unpacked;
            lz.decode(src, ip, ip + packed, stop);
            if (lz.op !== stop || lz.ended)
                throw bad();
            ip += packed;
        }
        return { ip: ip, op: lz.op };
    }

    // ---- XZ (method 95): the .xz container, of one or more streams.

    function vli(src, at) {
        var v = 0, mul = 1;
        for (var k = 0; k < 9; k++) {
            if (at >= src.length)
                throw bad();
            var b = src[at++];
            v += (b & 0x7f) * mul;
            mul *= 128;
            if (!(b & 0x80))
                return { v: v, at: at };
        }
        throw bad();
    }

    var XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

    // The x86 branch filter (xz's simple/x86.c), undone in place over
    // out[from, to).
    function unX86(out, from, to, startPos) {
        var allowed = [true, true, true, false, true, false, false, false];
        var bitNumber = [0, 1, 2, 2, 3, 3, 3, 3];
        var prevMask = 0, prevPos = startPos - 5, size = to - from;
        if (size < 5)
            return;
        var limit = size - 5;
        var test = function(b) { return b === 0 || b === 0xff; };
        for (var i = 0; i <= limit;) {
            var b = out[from + i];
            if (b !== 0xe8 && b !== 0xe9) {
                i++;
                continue;
            }
            var nowPos = startPos + i;
            var offset = nowPos - prevPos;
            prevPos = nowPos;
            if (offset > 5) {
                prevMask = 0;
            } else {
                for (var k = 0; k < offset; k++) {
                    prevMask &= 0x77;
                    prevMask <<= 1;
                }
            }
            b = out[from + i + 4];
            if (test(b) && allowed[(prevMask >>> 1) & 7] && (prevMask >>> 1) < 0x10) {
                var src = ((b << 24) | (out[from + i + 3] << 16) | (out[from + i + 2] << 8) | out[from + i + 1]) >>> 0;
                var dest;
                for (;;) {
                    dest = (src - (nowPos + 5)) >>> 0;
                    if (!prevMask)
                        break;
                    var bn = bitNumber[prevMask >>> 1];
                    b = (dest >>> (24 - bn * 8)) & 0xff;
                    if (!test(b))
                        break;
                    src = (dest ^ (Math.pow(2, 32 - bn * 8) - 1)) >>> 0;
                }
                out[from + i + 4] = ~(((dest >>> 24) & 1) - 1) & 0xff;
                out[from + i + 3] = (dest >>> 16) & 0xff;
                out[from + i + 2] = (dest >>> 8) & 0xff;
                out[from + i + 1] = dest & 0xff;
                i += 5;
                prevMask = 0;
            } else {
                i++;
                prevMask |= 1;
                if (test(b))
                    prevMask |= 0x10;
            }
        }
    }

    function unxz(src, size) {
        var out = new Uint8Array(size), op = 0, ip = 0;
        while (ip < src.length) {
            for (var k = 0; k < 6; k++) {
                if (src[ip + k] !== XZ_MAGIC[k])
                    throw bad();
            }
            var check = src[ip + 7] & 15;
            if (src[ip + 6] || src[ip + 7] > 15)
                throw bad();
            var checkSize = check ? 4 << (((check - 1) / 3) | 0) : 0;
            ip += 12;
            for (;;) {
                if (ip >= src.length)
                    throw bad();
                var hs = src[ip];
                if (!hs)
                    break;
                var blockAt = ip, headerEnd = ip + (hs + 1) * 4;
                var bf = src[ip + 1];
                if (bf & 0x3c)
                    throw bad();
                var at = ip + 2, x;
                if (bf & 0x40)
                    at = vli(src, at).at;
                if (bf & 0x80)
                    at = vli(src, at).at;
                var filters = [];
                for (var f = (bf & 3) + 1; f > 0; f--) {
                    var id = vli(src, at);
                    var ps = vli(src, id.at);
                    filters.push({ id: id.v, props: src.subarray(ps.at, ps.at + ps.v) });
                    at = ps.at + ps.v;
                }
                if (at > headerEnd - 4 || filters[filters.length - 1].id !== 0x21)
                    throw bad();
                var from = op;
                x = unlzma2(src, headerEnd, out, op);
                ip = x.ip;
                op = x.op;
                // The filters before LZMA2, last first.
                for (var f = filters.length - 2; f >= 0; f--) {
                    var flt = filters[f];
                    if (flt.id === 0x03 && flt.props.length === 1) {
                        var dist = flt.props[0] + 1;
                        for (var i = from + dist; i < op; i++)
                            out[i] = (out[i] + out[i - dist]) & 0xff;
                    } else if (flt.id === 0x04 && (flt.props.length === 0 || flt.props.length === 4)) {
                        var startPos = flt.props.length ?
                            (flt.props[0] | (flt.props[1] << 8) | (flt.props[2] << 16) | (flt.props[3] << 24)) >>> 0 : 0;
                        unX86(out, from, op, startPos);
                    } else {
                        throw bad('xz filter ' + flt.id + ' not supported');
                    }
                }
                while ((ip - blockAt) & 3) {
                    if (src[ip++])
                        throw bad();
                }
                ip += checkSize;
            }
            // The index, then the footer.
            var indexAt = ip;
            var records = vli(src, ip + 1);
            ip = records.at;
            for (var n = 0; n < records.v; n++)
                ip = vli(src, vli(src, ip).at).at;
            while ((ip - indexAt) & 3)
                ip++;
            ip += 4 + 12;
            if (ip > src.length || src[ip - 2] !== 0x59 || src[ip - 1] !== 0x5a)
                throw bad();
            while (ip < src.length && !src[ip])
                ip++;
        }
        if (op !== size)
            throw bad();
        return out;
    }

    // ---- PPMd (method 98): PPMd var.I rev.1 with 7-Zip's range coder, the
    // order, memory and restore method in 2 bytes first, as 7-Zip writes it.
    // Ported from 7-Zip's Ppmd8.c and Ppmd8Dec.c. The model lives in one
    // block of memory, as there; offsets into it stand for its pointers.
    //
    //   state (6 bytes):    symbol, freq, successor (4)
    //   context (12 bytes): numStats, flags, summFreq (2) or one state's
    //                       symbol and freq, stats (4) or that state's
    //                       successor, suffix (4)
    //   free node (12):     stamp (4), next (4), nu (4)

    var PPMD_NUM_INDEXES = 38, PPMD_MAX_FREQ = 124, PPMD_UNIT = 12, PPMD_EMPTY = 0xffffffff;
    var PPMD_INT_BITS = 7, PPMD_PERIOD_BITS = 7, PPMD_BIN_SCALE = 1 << 14;
    var PPMD_EXP_ESCAPE = [25, 14, 9, 7, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2];
    var PPMD_INIT_BIN_ESC = [0x3CDD, 0x1F3F, 0x59BF, 0x48F3, 0x64A1, 0x5ABC, 0x6632, 0x6051];
    var FLAG_RESCALED = 4, FLAG_PREV_HIGH = 16;

    function unppmd(src, size) {
        if (src.length < 2)
            throw bad();
        var props = src[0] | (src[1] << 8);
        var maxOrder = (props & 15) + 1, memSize = (((props >> 4) & 0xff) + 1) << 20, restoreMethod = props >> 12;
        if (maxOrder < 2 || restoreMethod > 1)
            throw bad('PPMd variant not supported');

        var mem = new Uint8Array(memSize + PPMD_UNIT);
        var dv = new DataView(mem.buffer);
        function u16(o) { return dv.getUint16(o, true); }
        function u32(o) { return dv.getUint32(o, true); }
        function set16(o, v) { dv.setUint16(o, v & 0xffff, true); }
        function set32(o, v) { dv.setUint32(o, v >>> 0, true); }
        function copyUnits(to, from, nu) { mem.copyWithin(to, from, from + nu * PPMD_UNIT); }
        function copyState(to, from) {
            mem[to] = mem[from];
            mem[to + 1] = mem[from + 1];
            mem[to + 2] = mem[from + 2];
            mem[to + 3] = mem[from + 3];
            mem[to + 4] = mem[from + 4];
            mem[to + 5] = mem[from + 5];
        }
        function swapStates(a, b) {
            for (var k = 0; k < 6; k++) {
                var t = mem[a + k];
                mem[a + k] = mem[b + k];
                mem[b + k] = t;
            }
        }
        var tmpState = new Uint8Array(6);

        var indx2Units = new Uint8Array(PPMD_NUM_INDEXES), units2Indx = new Uint8Array(128);
        var ns2BSIndx = new Uint8Array(256), ns2Indx = new Uint8Array(260);
        var freeList = new Float64Array(PPMD_NUM_INDEXES), stamps = new Float64Array(PPMD_NUM_INDEXES);
        var DUMMY_SEE = 24 * 32;
        var seeSumm = new Uint16Array(DUMMY_SEE + 1), seeShift = new Uint8Array(DUMMY_SEE + 1),
            seeCount = new Uint8Array(DUMMY_SEE + 1);
        var binSumm = new Uint16Array(25 * 64);
        var charMask = new Uint8Array(256);

        var minContext = 0, maxContext = 0, foundState = 0;
        var orderFall = 0, initEsc = 0, prevSuccess = 0, runLength = 0, initRL = 0;
        var glueCount = 0, loUnit = 0, hiUnit = 0, text = 0, unitsStart = 0;
        var range = 0, code = 0, low = 0, ip = 2;

        (function() {
            var i, k, m;
            for (i = 0, k = 0; i < PPMD_NUM_INDEXES; i++) {
                var step = i >= 12 ? 4 : (i >> 2) + 1;
                do { units2Indx[k++] = i; } while (--step);
                indx2Units[i] = k;
            }
            ns2BSIndx[0] = 0;
            ns2BSIndx[1] = 2;
            ns2BSIndx.fill(4, 2, 11);
            ns2BSIndx.fill(6, 11);
            for (i = 0; i < 5; i++)
                ns2Indx[i] = i;
            for (m = i, k = 1; i < 260; i++) {
                ns2Indx[i] = m;
                if (--k === 0)
                    k = (++m) - 4;
            }
        })();

        function I2U(indx) { return indx2Units[indx]; }
        function U2I(nu) { return units2Indx[nu - 1]; }
        function U2B(nu) { return nu * PPMD_UNIT; }

        // ---- The allocator.

        function insertNode(node, indx) {
            set32(node, PPMD_EMPTY);
            set32(node + 4, freeList[indx]);
            set32(node + 8, I2U(indx));
            freeList[indx] = node;
            stamps[indx]++;
        }

        function removeNode(indx) {
            var node = freeList[indx];
            freeList[indx] = u32(node + 4);
            stamps[indx]--;
            return node;
        }

        function splitBlock(ptr, oldIndx, newIndx) {
            var nu = I2U(oldIndx) - I2U(newIndx);
            ptr += U2B(I2U(newIndx));
            var i = U2I(nu);
            if (I2U(i) !== nu) {
                var k = I2U(--i);
                insertNode(ptr + U2B(k), nu - k - 1);
            }
            insertNode(ptr, i);
        }

        function glueFreeBlocks() {
            glueCount = 1 << 13;
            stamps.fill(0);
            if (loUnit !== hiUnit)
                set32(loUnit, 0);
            // The chain of every free node, with each one's NU grown over the
            // free ones right after it. prev is where the next link goes: -1
            // for n, else a node's next field.
            var n = 0, prev = -1;
            function link(v) {
                if (prev < 0)
                    n = v;
                else
                    set32(prev, v);
            }
            for (var i = 0; i < PPMD_NUM_INDEXES; i++) {
                var next = freeList[i];
                freeList[i] = 0;
                while (next) {
                    var node = next, nu = u32(node + 8);
                    link(next);
                    next = u32(node + 4);
                    if (nu) {
                        prev = node + 4;
                        var node2;
                        while (u32(node2 = node + nu * PPMD_UNIT) === PPMD_EMPTY) {
                            nu += u32(node2 + 8);
                            set32(node2 + 8, 0);
                            set32(node + 8, nu);
                        }
                    }
                }
            }
            link(0);
            while (n) {
                var node = n, nu = u32(node + 8);
                n = u32(node + 4);
                if (!nu)
                    continue;
                for (; nu > 128; nu -= 128, node += 128 * PPMD_UNIT)
                    insertNode(node, PPMD_NUM_INDEXES - 1);
                var i = U2I(nu);
                if (I2U(i) !== nu) {
                    var k = I2U(--i);
                    insertNode(node + k * PPMD_UNIT, nu - k - 1);
                }
                insertNode(node, i);
            }
        }

        function allocUnitsRare(indx) {
            if (!glueCount) {
                glueFreeBlocks();
                if (freeList[indx])
                    return removeNode(indx);
            }
            var i = indx;
            do {
                if (++i === PPMD_NUM_INDEXES) {
                    var numBytes = U2B(I2U(indx)), us = unitsStart;
                    glueCount--;
                    return us - text > numBytes ? (unitsStart = us - numBytes) : 0;
                }
            } while (!freeList[i]);
            var block = removeNode(i);
            splitBlock(block, i, indx);
            return block;
        }

        function allocUnits(indx) {
            if (freeList[indx])
                return removeNode(indx);
            var numBytes = U2B(I2U(indx)), lo = loUnit;
            if (hiUnit - lo >= numBytes) {
                loUnit = lo + numBytes;
                return lo;
            }
            return allocUnitsRare(indx);
        }

        function shrinkUnits(oldPtr, oldNU, newNU) {
            var i0 = U2I(oldNU), i1 = U2I(newNU);
            if (i0 === i1)
                return oldPtr;
            if (freeList[i1]) {
                var ptr = removeNode(i1);
                copyUnits(ptr, oldPtr, newNU);
                insertNode(oldPtr, i0);
                return ptr;
            }
            splitBlock(oldPtr, i0, i1);
            return oldPtr;
        }

        function freeUnits(ptr, nu) {
            insertNode(ptr, U2I(nu));
        }

        function specialFreeUnit(ptr) {
            if (ptr !== unitsStart)
                insertNode(ptr, 0);
            else
                unitsStart += PPMD_UNIT;
        }

        function expandTextArea() {
            var count = new Float64Array(PPMD_NUM_INDEXES);
            if (loUnit !== hiUnit)
                set32(loUnit, 0);
            var node = unitsStart;
            while (u32(node) === PPMD_EMPTY) {
                var nu = u32(node + 8);
                set32(node, 0);
                count[U2I(nu)]++;
                node += nu * PPMD_UNIT;
            }
            unitsStart = node;
            for (var i = 0; i < PPMD_NUM_INDEXES; i++) {
                var cnt = count[i];
                if (!cnt)
                    continue;
                // prev: -1 for freeList[i], else a node's next field.
                var prev = -1, n = freeList[i];
                stamps[i] -= cnt;
                for (;;) {
                    var nd = n;
                    n = u32(nd + 4);
                    if (u32(nd) !== 0) {
                        prev = nd + 4;
                        continue;
                    }
                    if (prev < 0)
                        freeList[i] = n;
                    else
                        set32(prev, n);
                    if (--cnt === 0)
                        break;
                }
            }
        }

        // ---- The model.

        function hiBits3(sym) { return ((sym + 0xc0) >> 5) & 8; }
        function hiBits4(sym) { return ((sym + 0xc0) >> 4) & 16; }

        function restartModel() {
            freeList.fill(0);
            stamps.fill(0);
            text = 0;
            hiUnit = text + memSize;
            loUnit = unitsStart = hiUnit - Math.floor(Math.floor(memSize / 8) / PPMD_UNIT) * 7 * PPMD_UNIT;
            glueCount = 0;
            orderFall = maxOrder;
            runLength = initRL = -(maxOrder < 12 ? maxOrder : 12) - 1;
            prevSuccess = 0;
            hiUnit -= PPMD_UNIT;
            var mc = hiUnit, s = loUnit;
            loUnit += U2B(256 / 2);
            maxContext = minContext = mc;
            foundState = s;
            mem[mc + 1] = 0;
            mem[mc] = 255;
            set16(mc + 2, 257);
            set32(mc + 4, s);
            set32(mc + 8, 0);
            for (var i = 0; i < 256; i++, s += 6) {
                mem[s] = i;
                mem[s + 1] = 1;
                set32(s + 2, 0);
            }
            var m, k;
            for (i = m = 0; m < 25; m++) {
                while (ns2Indx[i] === m)
                    i++;
                for (k = 0; k < 8; k++) {
                    var val = PPMD_BIN_SCALE - Math.floor(PPMD_INIT_BIN_ESC[k] / (i + 1));
                    for (var r = 0; r < 64; r += 8)
                        binSumm[m * 64 + k + r] = val;
                }
            }
            for (i = m = 0; m < 24; m++) {
                while (ns2Indx[i + 3] === m + 3)
                    i++;
                var summ = (2 * i + 5) << (PPMD_PERIOD_BITS - 4);
                for (k = 0; k < 32; k++) {
                    seeSumm[m * 32 + k] = summ;
                    seeShift[m * 32 + k] = PPMD_PERIOD_BITS - 4;
                    seeCount[m * 32 + k] = 7;
                }
            }
            seeSumm[DUMMY_SEE] = 0;
            seeShift[DUMMY_SEE] = PPMD_PERIOD_BITS;
            seeCount[DUMMY_SEE] = 64;
        }

        function refresh(ctx, oldNU, scale) {
            var i = mem[ctx];
            var s = shrinkUnits(u32(ctx + 4), oldNU, (i + 2) >> 1);
            set32(ctx + 4, s);
            scale |= u16(ctx + 2) >= 32768 ? 1 : 0;
            var flags = mem[s] + 0xc0;
            var freq = mem[s + 1];
            var escFreq = u16(ctx + 2) - freq;
            freq = (freq + scale) >> scale;
            var sumFreq = freq;
            mem[s + 1] = freq;
            do {
                s += 6;
                freq = mem[s + 1];
                escFreq -= freq;
                freq = (freq + scale) >> scale;
                sumFreq += freq;
                mem[s + 1] = freq;
                flags |= mem[s] + 0xc0;
            } while (--i);
            set16(ctx + 2, sumFreq + ((escFreq + scale) >> scale));
            mem[ctx + 1] = (mem[ctx + 1] & (FLAG_PREV_HIGH + FLAG_RESCALED * scale)) + ((flags >> 5) & 8);
        }

        function cutOff(ctx, order) {
            var ns = mem[ctx];
            if (!ns) {
                var s = ctx + 2;
                var successor = u32(s + 2);
                if (successor >= unitsStart) {
                    successor = order < maxOrder ? cutOff(successor, order + 1) : 0;
                    set32(s + 2, successor);
                    if (successor || order <= 9)
                        return ctx;
                }
                specialFreeUnit(ctx);
                return 0;
            }
            var nu = (ns + 2) >> 1;
            var indx = U2I(nu);
            var stats = u32(ctx + 4);
            if (stats >= unitsStart && stats - unitsStart <= (1 << 14) && stats <= freeList[indx]) {
                var ptr = removeNode(indx);
                set32(ctx + 4, ptr);
                copyUnits(ptr, stats, nu);
                if (stats !== unitsStart)
                    insertNode(stats, indx);
                else
                    unitsStart += U2B(I2U(indx));
                stats = ptr;
            }
            var s = stats + ns * 6;
            do {
                var successor = u32(s + 2);
                if (successor < unitsStart) {
                    var s2 = stats + (ns--) * 6;
                    if (order) {
                        if (s !== s2)
                            copyState(s, s2);
                    } else {
                        swapStates(s, s2);
                        set32(s2 + 2, 0);
                    }
                } else {
                    set32(s + 2, order < maxOrder ? cutOff(successor, order + 1) : 0);
                }
                s -= 6;
            } while (s >= stats);
            if (ns !== mem[ctx] && order) {
                if (ns < 0) {
                    freeUnits(stats, nu);
                    specialFreeUnit(ctx);
                    return 0;
                }
                mem[ctx] = ns;
                if (!ns) {
                    var sym = mem[stats];
                    mem[ctx + 1] = (mem[ctx + 1] & FLAG_PREV_HIGH) + hiBits3(sym);
                    mem[ctx + 2] = sym;
                    mem[ctx + 3] = (mem[stats + 1] + 11) >> 3;
                    set16(ctx + 4, u16(stats + 2));
                    set16(ctx + 6, u16(stats + 4));
                    freeUnits(stats, nu);
                } else {
                    refresh(ctx, nu, u16(ctx + 2) > 16 * ns ? 1 : 0);
                }
            }
            return ctx;
        }

        function usedMemory() {
            var v = 0;
            for (var i = 0; i < PPMD_NUM_INDEXES; i++)
                v += stamps[i] * I2U(i);
            return memSize - (hiUnit - loUnit) - (unitsStart - text) - U2B(v);
        }

        function restoreModel(ctxError) {
            text = 0;
            var c, s;
            for (c = maxContext; c !== ctxError; c = u32(c + 8)) {
                mem[c] = mem[c] - 1;
                if (!mem[c]) {
                    s = u32(c + 4);
                    mem[c + 1] = (mem[c + 1] & FLAG_PREV_HIGH) + hiBits3(mem[s]);
                    mem[c + 2] = mem[s];
                    mem[c + 3] = (mem[s + 1] + 11) >> 3;
                    set16(c + 4, u16(s + 2));
                    set16(c + 6, u16(s + 4));
                    specialFreeUnit(s);
                } else {
                    refresh(c, (mem[c] + 3) >> 1, 0);
                }
            }
            for (; c !== minContext; c = u32(c + 8)) {
                if (!mem[c]) {
                    mem[c + 3] = (mem[c + 3] + 1) >> 1;
                } else {
                    var sf = (u16(c + 2) + 4) & 0xffff;
                    set16(c + 2, sf);
                    if (sf > 128 + 4 * mem[c])
                        refresh(c, (mem[c] + 2) >> 1, 1);
                }
            }
            if (restoreMethod === 0 || usedMemory() < (memSize >> 1)) {
                restartModel();
            } else {
                while (u32(maxContext + 8))
                    maxContext = u32(maxContext + 8);
                do {
                    cutOff(maxContext, 0);
                    expandTextArea();
                } while (usedMemory() > 3 * (memSize >> 2));
                glueCount = 0;
                orderFall = maxOrder;
            }
            minContext = maxContext;
        }

        var ps = new Float64Array(64);

        function createSuccessors(skip, s1, c) {
            var upBranch = u32(foundState + 2);
            var numPs = 0, s;
            if (!skip)
                ps[numPs++] = foundState;
            while (u32(c + 8)) {
                c = u32(c + 8);
                if (s1) {
                    s = s1;
                    s1 = 0;
                } else if (mem[c]) {
                    var sym = mem[foundState];
                    for (s = u32(c + 4); mem[s] !== sym; s += 6);
                    if (mem[s + 1] < PPMD_MAX_FREQ - 9) {
                        mem[s + 1]++;
                        set16(c + 2, u16(c + 2) + 1);
                    }
                } else {
                    var temp = mem[u32(c + 8)] ? 0 : 1;
                    s = c + 2;
                    mem[s + 1] = mem[s + 1] + (temp & (mem[s + 1] < 24 ? 1 : 0));
                }
                var successor = u32(s + 2);
                if (successor !== upBranch) {
                    c = successor;
                    if (!numPs)
                        return c;
                    break;
                }
                if (numPs >= ps.length)
                    throw bad();
                ps[numPs++] = s;
            }
            var newSym = mem[upBranch];
            upBranch++;
            var flags = hiBits4(mem[foundState]) + hiBits3(newSym);
            var newFreq;
            if (!mem[c]) {
                newFreq = mem[c + 3];
            } else {
                for (s = u32(c + 4); mem[s] !== newSym; s += 6);
                var cf = mem[s + 1] - 1;
                var s0 = (u16(c + 2) - mem[c] - cf) >>> 0;
                newFreq = (1 + (2 * cf <= s0 ? (5 * cf > s0 ? 1 : 0) : Math.floor(((cf + 2 * s0 - 3) >>> 0) / s0))) & 0xff;
            }
            do {
                var c1;
                if (hiUnit !== loUnit) {
                    hiUnit -= PPMD_UNIT;
                    c1 = hiUnit;
                } else if (freeList[0]) {
                    c1 = removeNode(0);
                } else {
                    c1 = allocUnitsRare(0);
                    if (!c1)
                        return 0;
                }
                mem[c1 + 1] = flags;
                mem[c1] = 0;
                mem[c1 + 2] = newSym;
                mem[c1 + 3] = newFreq;
                set32(c1 + 4, upBranch);
                set32(c1 + 8, c);
                set32(ps[--numPs] + 2, c1);
                c = c1;
            } while (numPs);
            return c;
        }

        function reduceOrder(s1, c) {
            var s = 0, c1 = c, upBranch = text;
            set32(foundState + 2, upBranch);
            orderFall++;
            for (;;) {
                if (s1) {
                    c = u32(c + 8);
                    s = s1;
                    s1 = 0;
                } else {
                    if (!u32(c + 8))
                        return c;
                    c = u32(c + 8);
                    if (mem[c]) {
                        s = u32(c + 4);
                        if (mem[s] !== mem[foundState]) {
                            do { s += 6; } while (mem[s] !== mem[foundState]);
                        }
                        if (mem[s + 1] < PPMD_MAX_FREQ - 9) {
                            mem[s + 1] += 2;
                            set16(c + 2, u16(c + 2) + 2);
                        }
                    } else {
                        s = c + 2;
                        mem[s + 1] = mem[s + 1] + (mem[s + 1] < 32 ? 1 : 0);
                    }
                }
                if (u32(s + 2))
                    break;
                set32(s + 2, upBranch);
                orderFall++;
            }
            if (u32(s + 2) <= upBranch) {
                var s2 = foundState;
                foundState = s;
                var successor = createSuccessors(false, 0, c);
                set32(s + 2, successor || 0);
                foundState = s2;
            }
            var successor = u32(s + 2);
            if (orderFall === 1 && c1 === maxContext) {
                set32(foundState + 2, successor);
                text--;
            }
            return successor || 0;
        }

        function updateModel() {
            var maxSuccessor, minSuccessor = u32(foundState + 2);
            var c, fFreq = mem[foundState + 1], fSymbol = mem[foundState];
            var s = 0;
            if (fFreq < PPMD_MAX_FREQ / 4 && u32(minContext + 8)) {
                c = u32(minContext + 8);
                if (!mem[c]) {
                    s = c + 2;
                    if (mem[s + 1] < 32)
                        mem[s + 1]++;
                } else {
                    var sym = fSymbol;
                    s = u32(c + 4);
                    if (mem[s] !== sym) {
                        do { s += 6; } while (mem[s] !== sym);
                        if (mem[s + 1] >= mem[s - 6 + 1]) {
                            swapStates(s, s - 6);
                            s -= 6;
                        }
                    }
                    if (mem[s + 1] < PPMD_MAX_FREQ - 9) {
                        mem[s + 1] += 2;
                        set16(c + 2, u16(c + 2) + 2);
                    }
                }
            }
            c = maxContext;
            if (!orderFall && minSuccessor) {
                var cs = createSuccessors(true, s, minContext);
                if (!cs) {
                    set32(foundState + 2, 0);
                    restoreModel(c);
                    return;
                }
                set32(foundState + 2, cs);
                minContext = maxContext = cs;
                return;
            }
            mem[text++] = fSymbol;
            if (text >= unitsStart) {
                restoreModel(c);
                return;
            }
            maxSuccessor = text;
            if (!minSuccessor) {
                var cs = reduceOrder(s, minContext);
                if (!cs) {
                    restoreModel(c);
                    return;
                }
                minSuccessor = cs;
            } else if (minSuccessor < unitsStart) {
                var cs = createSuccessors(false, s, minContext);
                if (!cs) {
                    restoreModel(c);
                    return;
                }
                minSuccessor = cs;
            }
            if (--orderFall === 0) {
                maxSuccessor = minSuccessor;
                text -= maxContext !== minContext ? 1 : 0;
            }

            var flag = hiBits3(fSymbol);
            var ns = mem[minContext];
            var s0 = (u16(minContext + 2) - ns - fFreq) >>> 0;
            for (; c !== minContext; c = u32(c + 8)) {
                var ns1 = mem[c], sum;
                if (ns1) {
                    if (ns1 & 1) {
                        var oldNU = (ns1 + 1) >> 1;
                        var i = U2I(oldNU);
                        if (i !== U2I(oldNU + 1)) {
                            var ptr = allocUnits(i + 1);
                            if (!ptr) {
                                restoreModel(c);
                                return;
                            }
                            var oldPtr = u32(c + 4);
                            copyUnits(ptr, oldPtr, oldNU);
                            insertNode(oldPtr, i);
                            set32(c + 4, ptr);
                        }
                    }
                    sum = u16(c + 2);
                    sum += 3 * ns1 + 1 < ns ? 1 : 0;
                } else {
                    var st = allocUnits(0);
                    if (!st) {
                        restoreModel(c);
                        return;
                    }
                    var freq = mem[c + 3];
                    mem[st] = mem[c + 2];
                    set16(st + 2, u16(c + 4));
                    set16(st + 4, u16(c + 6));
                    set32(c + 4, st);
                    if (freq < PPMD_MAX_FREQ / 4 - 1)
                        freq <<= 1;
                    else
                        freq = PPMD_MAX_FREQ - 4;
                    mem[st + 1] = freq;
                    sum = freq + initEsc + (ns > 2 ? 1 : 0);
                }
                var s = u32(c + 4) + (ns1 + 1) * 6;
                var cf = (2 * (sum + 6) * fFreq) >>> 0;
                var sf = (s0 + sum) >>> 0;
                mem[s] = fSymbol;
                mem[c] = ns1 + 1;
                set32(s + 2, maxSuccessor);
                mem[c + 1] |= flag;
                if (cf < (Math.imul(6, sf) >>> 0)) {
                    cf = 1 + (cf > sf ? 1 : 0) + (cf >= (Math.imul(4, sf) >>> 0) ? 1 : 0);
                    sum += 4;
                } else {
                    cf = 4 + (cf > (Math.imul(9, sf) >>> 0) ? 1 : 0) + (cf > (Math.imul(12, sf) >>> 0) ? 1 : 0) +
                         (cf > (Math.imul(15, sf) >>> 0) ? 1 : 0);
                    sum += cf;
                }
                set16(c + 2, sum);
                mem[s + 1] = cf;
            }
            maxContext = minContext = minSuccessor;
        }

        function rescale() {
            var stats = u32(minContext + 4), s = foundState;
            if (s !== stats) {
                tmpState.set(mem.subarray(s, s + 6));
                do {
                    copyState(s, s - 6);
                    s -= 6;
                } while (s !== stats);
                mem.set(tmpState, s);
            }
            var sumFreq = mem[s + 1];
            var escFreq = u16(minContext + 2) - sumFreq;
            var adder = orderFall ? 1 : 0;
            sumFreq = (sumFreq + 4 + adder) >> 1;
            var i = mem[minContext];
            mem[s + 1] = sumFreq;
            do {
                s += 6;
                var freq = mem[s + 1];
                escFreq -= freq;
                freq = (freq + adder) >> 1;
                sumFreq += freq;
                mem[s + 1] = freq;
                if (freq > mem[s - 6 + 1]) {
                    tmpState.set(mem.subarray(s, s + 6));
                    var s1 = s;
                    do {
                        copyState(s1, s1 - 6);
                        s1 -= 6;
                    } while (s1 !== stats && freq > mem[s1 - 6 + 1]);
                    mem.set(tmpState, s1);
                }
            } while (--i);
            if (!mem[s + 1]) {
                i = 0;
                do {
                    i++;
                    s -= 6;
                } while (!mem[s + 1]);
                escFreq += i;
                var mc = minContext;
                var numStats = mem[mc], numStatsNew = numStats - i;
                mem[mc] = numStatsNew;
                var n0 = (numStats + 2) >> 1;
                if (!numStatsNew) {
                    var freq = Math.floor((2 * mem[stats + 1] + escFreq - 1) / escFreq);
                    if (freq > PPMD_MAX_FREQ / 3)
                        freq = Math.floor(PPMD_MAX_FREQ / 3);
                    mem[mc + 1] = (mem[mc + 1] & FLAG_PREV_HIGH) + hiBits3(mem[stats]);
                    s = mc + 2;
                    copyState(s, stats);
                    mem[s + 1] = freq;
                    foundState = s;
                    insertNode(stats, U2I(n0));
                    return;
                }
                var n1 = (numStatsNew + 2) >> 1;
                if (n0 !== n1)
                    set32(mc + 4, shrinkUnits(stats, n0, n1));
            }
            var mc = minContext;
            set16(mc + 2, sumFreq + escFreq - (escFreq >> 1));
            mem[mc + 1] |= FLAG_RESCALED;
            foundState = u32(mc + 4);
        }

        // Sets escFreq and returns the SEE context used.
        var escFreq = 0;
        function makeEscFreq(numMasked) {
            var mc = minContext, numStats = mem[mc];
            if (numStats !== 0xff) {
                var see = (ns2Indx[numStats + 2] - 3) * 32 +
                          (u16(mc + 2) > 11 * (numStats + 1) ? 1 : 0) +
                          2 * (2 * numStats < mem[u32(mc + 8)] + numMasked ? 1 : 0) +
                          mem[mc + 1];
                var summ = seeSumm[see], r = summ >> seeShift[see];
                seeSumm[see] = summ - r;
                escFreq = r + (r === 0 ? 1 : 0);
                return see;
            }
            escFreq = 1;
            return DUMMY_SEE;
        }

        function nextContext() {
            var c = u32(foundState + 2);
            if (!orderFall && c >= unitsStart)
                maxContext = minContext = c;
            else
                updateModel();
        }

        function update1() {
            var s = foundState, freq = mem[s + 1] + 4;
            set16(minContext + 2, u16(minContext + 2) + 4);
            mem[s + 1] = freq;
            if (freq > mem[s - 6 + 1]) {
                swapStates(s, s - 6);
                foundState = s -= 6;
                if (freq > PPMD_MAX_FREQ)
                    rescale();
            }
            nextContext();
        }

        function update1_0() {
            var s = foundState, mc = minContext, freq = mem[s + 1], summFreq = u16(mc + 2);
            prevSuccess = 2 * freq >= summFreq ? 1 : 0;
            runLength += prevSuccess;
            set16(mc + 2, summFreq + 4);
            freq += 4;
            mem[s + 1] = freq;
            if (freq > PPMD_MAX_FREQ)
                rescale();
            nextContext();
        }

        function update2() {
            var s = foundState, freq = mem[s + 1] + 4;
            runLength = initRL;
            set16(minContext + 2, u16(minContext + 2) + 4);
            mem[s + 1] = freq;
            if (freq > PPMD_MAX_FREQ)
                rescale();
            updateModel();
        }

        // ---- The range decoder (7-Zip's for PPMd var.I, without carries).

        function inByte() {
            return ip < src.length ? src[ip++] : (ip++, 0);
        }

        function normalize() {
            for (;;) {
                if (((low ^ (low + range)) >>> 0) >= 1 << 24) {
                    if (range >= 1 << 15)
                        return;
                    range = (0 - low) & ((1 << 15) - 1);
                }
                code = ((code << 8) | inByte()) >>> 0;
                range = (range << 8) >>> 0;
                low = (low << 8) >>> 0;
            }
        }

        function rcDecode(start, size) {
            start = Math.imul(start, range) >>> 0;
            low = (low + start) >>> 0;
            code = (code - start) >>> 0;
            range = Math.imul(range, size) >>> 0;
        }

        function threshold(total) {
            range = Math.floor(range / total) >>> 0;
            return Math.floor(code / range) >>> 0;
        }

        // A byte, or -1 for the end marker, -2 for bad data.
        function decodeSymbol() {
            var s, i, count, hiCnt, sym;
            if (mem[minContext]) {
                s = u32(minContext + 4);
                var summFreq = u16(minContext + 2);
                if (summFreq > range)
                    summFreq = range;
                count = threshold(summFreq);
                hiCnt = count;
                if ((count -= mem[s + 1]) < 0) {
                    rcDecode(0, mem[s + 1]);
                    normalize();
                    foundState = s;
                    sym = mem[s];
                    update1_0();
                    return sym;
                }
                prevSuccess = 0;
                i = mem[minContext];
                do {
                    s += 6;
                    if ((count -= mem[s + 1]) < 0) {
                        rcDecode(hiCnt - count - mem[s + 1], mem[s + 1]);
                        normalize();
                        foundState = s;
                        sym = mem[s];
                        update1();
                        return sym;
                    }
                } while (--i);
                if (hiCnt >= summFreq)
                    return -2;
                hiCnt -= count;
                rcDecode(hiCnt, summFreq - hiCnt);
                var s2 = u32(minContext + 4);
                charMask.fill(0xff);
                charMask[mem[s]] = 0;
                do {
                    charMask[mem[s2]] = 0;
                    charMask[mem[s2 + 6]] = 0;
                    s2 += 12;
                } while (s2 < s);
            } else {
                s = minContext + 2;
                var bi = ns2Indx[mem[minContext + 3] - 1] * 64 + prevSuccess + ((runLength >> 26) & 0x20) +
                         ns2BSIndx[mem[u32(minContext + 8)]] + mem[minContext + 1];
                var pr = binSumm[bi];
                var size0 = (range >>> 14) * pr;
                pr = pr - ((pr + (1 << (PPMD_PERIOD_BITS - 2))) >> PPMD_PERIOD_BITS);
                if (code < size0) {
                    binSumm[bi] = pr + (1 << PPMD_INT_BITS);
                    range = size0;
                    normalize();
                    var freq = mem[s + 1], c = u32(s + 2);
                    sym = mem[s];
                    foundState = s;
                    prevSuccess = 1;
                    runLength++;
                    mem[s + 1] = freq + (freq < 196 ? 1 : 0);
                    if (!orderFall && c >= unitsStart)
                        maxContext = minContext = c;
                    else
                        updateModel();
                    return sym;
                }
                binSumm[bi] = pr;
                initEsc = PPMD_EXP_ESCAPE[pr >> 10];
                low = (low + size0) >>> 0;
                code = (code - size0) >>> 0;
                range = ((range & ~(PPMD_BIN_SCALE - 1)) >>> 0) - size0;
                charMask.fill(0xff);
                charMask[mem[s]] = 0;
                prevSuccess = 0;
            }
            for (;;) {
                normalize();
                var mc = minContext, numMasked = mem[mc];
                do {
                    orderFall++;
                    if (!u32(mc + 8))
                        return -1;
                    mc = u32(mc + 8);
                } while (mem[mc] === numMasked);
                s = u32(mc + 4);
                var num = mem[mc] + 1, num2 = num >> 1;
                num &= 1;
                hiCnt = num ? mem[s + 1] & charMask[mem[s]] : 0;
                s += num * 6;
                minContext = mc;
                do {
                    hiCnt += mem[s + 1] & charMask[mem[s]];
                    hiCnt += mem[s + 7] & charMask[mem[s + 6]];
                    s += 12;
                } while (--num2);
                var see = makeEscFreq(numMasked);
                var freqSum = escFreq + hiCnt;
                var freqSum2 = freqSum > range ? range : freqSum;
                count = threshold(freqSum2);
                if (count < hiCnt) {
                    s = u32(minContext + 4);
                    hiCnt = count;
                    for (;;) {
                        count -= mem[s + 1] & charMask[mem[s]];
                        s += 6;
                        if (count < 0)
                            break;
                    }
                    s -= 6;
                    rcDecode(hiCnt - count - mem[s + 1], mem[s + 1]);
                    normalize();
                    if (seeShift[see] < PPMD_PERIOD_BITS && --seeCount[see] === 0) {
                        seeSumm[see] = seeSumm[see] << 1;
                        seeCount[see] = 3 << seeShift[see]++;
                    }
                    foundState = s;
                    sym = mem[s];
                    update2();
                    return sym;
                }
                if (count >= freqSum2)
                    return -2;
                rcDecode(hiCnt, freqSum2 - hiCnt);
                seeSumm[see] = seeSumm[see] + freqSum;
                s = u32(minContext + 4);
                var end = s + (mem[minContext] + 1) * 6;
                do {
                    charMask[mem[s]] = 0;
                    s += 6;
                } while (s !== end);
            }
        }

        range = 0xffffffff;
        for (var k = 0; k < 4; k++)
            code = ((code << 8) | inByte()) >>> 0;
        if (code === 0xffffffff)
            throw bad();
        restartModel();

        var out = new Uint8Array(size);
        for (var op = 0; op < size; op++) {
            var sym = decodeSymbol();
            if (sym < 0 || ip > src.length + 4)
                throw bad();
            out[op] = sym;
        }
        return out;
    }

    // ---- Zstandard (method 93): fzstd 0.1.1's decoder
    // (https://github.com/101arrowz/fzstd), unchanged but for the streaming
    // part this doesn't need.
    //
    // MIT License
    //
    // Copyright (c) 2020 Arjun Barrett
    //
    // Permission is hereby granted, free of charge, to any person obtaining a copy
    // of this software and associated documentation files (the "Software"), to deal
    // in the Software without restriction, including without limitation the rights
    // to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    // copies of the Software, and to permit persons to whom the Software is
    // furnished to do so, subject to the following conditions:
    //
    // The above copyright notice and this permission notice shall be included in all
    // copies or substantial portions of the Software.
    //
    // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    // IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    // FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    // AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    // LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    // OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    // SOFTWARE.

    var fzstd = (function() {
        // Some numerical data is initialized as -1 even when it doesn't need initialization to help the JIT infer types
    // aliases for shorter compressed code (most minifers don't do this)
    var ab = ArrayBuffer, u8 = Uint8Array, u16 = Uint16Array, i16 = Int16Array, u32 = Uint32Array, i32 = Int32Array;
    var slc = function (v, s, e) {
        if (u8.prototype.slice)
            return u8.prototype.slice.call(v, s, e);
        if (s == null || s < 0)
            s = 0;
        if (e == null || e > v.length)
            e = v.length;
        var n = new u8(e - s);
        n.set(v.subarray(s, e));
        return n;
    };
    var fill = function (v, n, s, e) {
        if (u8.prototype.fill)
            return u8.prototype.fill.call(v, n, s, e);
        if (s == null || s < 0)
            s = 0;
        if (e == null || e > v.length)
            e = v.length;
        for (; s < e; ++s)
            v[s] = n;
        return v;
    };
    var cpw = function (v, t, s, e) {
        if (u8.prototype.copyWithin)
            return u8.prototype.copyWithin.call(v, t, s, e);
        if (s == null || s < 0)
            s = 0;
        if (e == null || e > v.length)
            e = v.length;
        while (s < e) {
            v[t++] = v[s++];
        }
    };
    /**
     * Codes for errors generated within this library
     */
    var ZstdErrorCode = {
        InvalidData: 0,
        WindowSizeTooLarge: 1,
        InvalidBlockType: 2,
        FSEAccuracyTooHigh: 3,
        DistanceTooFarBack: 4,
        UnexpectedEOF: 5
    };
    // error codes
    var ec = [
        'invalid zstd data',
        'window size too large (>2046MB)',
        'invalid block type',
        'FSE accuracy too high',
        'match distance too far back',
        'unexpected EOF'
    ];
    var err = function (ind, msg, nt) {
        var e = new Error(msg || ec[ind]);
        e.code = ind;
        if (Error.captureStackTrace)
            Error.captureStackTrace(e, err);
        if (!nt)
            throw e;
        return e;
    };
    var rb = function (d, b, n) {
        var i = 0, o = 0;
        for (; i < n; ++i)
            o |= d[b++] << (i << 3);
        return o;
    };
    var b4 = function (d, b) { return (d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24)) >>> 0; };
    // read Zstandard frame header
    var rzfh = function (dat, w) {
        var n3 = dat[0] | (dat[1] << 8) | (dat[2] << 16);
        if (n3 == 0x2FB528 && dat[3] == 253) {
            // Zstandard
            var flg = dat[4];
            //    single segment       checksum             dict flag     frame content flag
            var ss = (flg >> 5) & 1, cc = (flg >> 2) & 1, df = flg & 3, fcf = flg >> 6;
            if (flg & 8)
                err(0);
            // byte
            var bt = 6 - ss;
            // dict bytes
            var db = df == 3 ? 4 : df;
            // dictionary id
            var di = rb(dat, bt, db);
            bt += db;
            // frame size bytes
            var fsb = fcf ? (1 << fcf) : ss;
            // frame source size
            var fss = rb(dat, bt, fsb) + ((fcf == 1) && 256);
            // window size
            var ws = fss;
            if (!ss) {
                // window descriptor
                var wb = 1 << (10 + (dat[5] >> 3));
                ws = wb + (wb >> 3) * (dat[5] & 7);
            }
            if (ws > 2145386496)
                err(1);
            var buf = new u8((w == 1 ? (fss || ws) : w ? 0 : ws) + 12);
            buf[0] = 1, buf[4] = 4, buf[8] = 8;
            return {
                b: bt + fsb,
                y: 0,
                l: 0,
                d: di,
                w: (w && w != 1) ? w : buf.subarray(12),
                e: ws,
                o: new i32(buf.buffer, 0, 3),
                u: fss,
                c: cc,
                m: Math.min(131072, ws)
            };
        }
        else if (((n3 >> 4) | (dat[3] << 20)) == 0x184D2A5) {
            // skippable
            return b4(dat, 4) + 8;
        }
        err(0);
    };
    // most significant bit for nonzero
    var msb = function (val) {
        var bits = 0;
        for (; (1 << bits) <= val; ++bits)
            ;
        return bits - 1;
    };
    // read finite state entropy
    var rfse = function (dat, bt, mal) {
        // table pos
        var tpos = (bt << 3) + 4;
        // accuracy log
        var al = (dat[bt] & 15) + 5;
        if (al > mal)
            err(3);
        // size
        var sz = 1 << al;
        // probabilities symbols  repeat   index   high threshold
        var probs = sz, sym = -1, re = -1, i = -1, ht = sz;
        // optimization: single allocation is much faster
        var buf = new ab(512 + (sz << 2));
        var freq = new i16(buf, 0, 256);
        // same view as freq
        var dstate = new u16(buf, 0, 256);
        var nstate = new u16(buf, 512, sz);
        var bb1 = 512 + (sz << 1);
        var syms = new u8(buf, bb1, sz);
        var nbits = new u8(buf, bb1 + sz);
        while (sym < 255 && probs > 0) {
            var bits = msb(probs + 1);
            var cbt = tpos >> 3;
            // mask
            var msk = (1 << (bits + 1)) - 1;
            var val = ((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (tpos & 7)) & msk;
            // mask (1 fewer bit)
            var msk1fb = (1 << bits) - 1;
            // max small value
            var msv = msk - probs - 1;
            // small value
            var sval = val & msk1fb;
            if (sval < msv)
                tpos += bits, val = sval;
            else {
                tpos += bits + 1;
                if (val > msk1fb)
                    val -= msv;
            }
            freq[++sym] = --val;
            if (val == -1) {
                probs += val;
                syms[--ht] = sym;
            }
            else
                probs -= val;
            if (!val) {
                do {
                    // repeat byte
                    var rbt = tpos >> 3;
                    re = ((dat[rbt] | (dat[rbt + 1] << 8)) >> (tpos & 7)) & 3;
                    tpos += 2;
                    sym += re;
                } while (re == 3);
            }
        }
        if (sym > 255 || probs)
            err(0);
        var sympos = 0;
        // sym step (coprime with sz - formula from zstd source)
        var sstep = (sz >> 1) + (sz >> 3) + 3;
        // sym mask
        var smask = sz - 1;
        for (var s = 0; s <= sym; ++s) {
            var sf = freq[s];
            if (sf < 1) {
                dstate[s] = -sf;
                continue;
            }
            // This is split into two loops in zstd to avoid branching, but as JS is higher-level that is unnecessary
            for (i = 0; i < sf; ++i) {
                syms[sympos] = s;
                do {
                    sympos = (sympos + sstep) & smask;
                } while (sympos >= ht);
            }
        }
        // After spreading symbols, should be zero again
        if (sympos)
            err(0);
        for (i = 0; i < sz; ++i) {
            // next state
            var ns = dstate[syms[i]]++;
            // num bits
            var nb = nbits[i] = al - msb(ns);
            nstate[i] = (ns << nb) - sz;
        }
        return [(tpos + 7) >> 3, {
                b: al,
                s: syms,
                n: nbits,
                t: nstate
            }];
    };
    // read huffman
    var rhu = function (dat, bt) {
        //  index  weight count
        var i = 0, wc = -1;
        //    buffer             header byte
        var buf = new u8(292), hb = dat[bt];
        // huffman weights
        var hw = buf.subarray(0, 256);
        // rank count
        var rc = buf.subarray(256, 268);
        // rank index
        var ri = new u16(buf.buffer, 268);
        // NOTE: at this point bt is 1 less than expected
        if (hb < 128) {
            // end byte, fse decode table
            var _a = rfse(dat, bt + 1, 6), ebt = _a[0], fdt = _a[1];
            bt += hb;
            var epos = ebt << 3;
            // last byte
            var lb = dat[bt];
            if (!lb)
                err(0);
            //  state1   state2   state1 bits   state2 bits
            var st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1;
            // fse pos
            // pre-increment to account for original deficit of 1
            var fpos = (++bt << 3) - 8 + msb(lb);
            for (;;) {
                fpos -= btr1;
                if (fpos < epos)
                    break;
                var cbt = fpos >> 3;
                st1 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr1) - 1);
                hw[++wc] = fdt.s[st1];
                fpos -= btr2;
                if (fpos < epos)
                    break;
                cbt = fpos >> 3;
                st2 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr2) - 1);
                hw[++wc] = fdt.s[st2];
                btr1 = fdt.n[st1];
                st1 = fdt.t[st1];
                btr2 = fdt.n[st2];
                st2 = fdt.t[st2];
            }
            if (++wc > 255)
                err(0);
        }
        else {
            wc = hb - 127;
            for (; i < wc; i += 2) {
                var byte = dat[++bt];
                hw[i] = byte >> 4;
                hw[i + 1] = byte & 15;
            }
            ++bt;
        }
        // weight exponential sum
        var wes = 0;
        for (i = 0; i < wc; ++i) {
            var wt = hw[i];
            // bits must be at most 11, same as weight
            if (wt > 11)
                err(0);
            wes += wt && (1 << (wt - 1));
        }
        // max bits
        var mb = msb(wes) + 1;
        // table size
        var ts = 1 << mb;
        // remaining sum
        var rem = ts - wes;
        // must be power of 2
        if (rem & (rem - 1))
            err(0);
        hw[wc++] = msb(rem) + 1;
        for (i = 0; i < wc; ++i) {
            var wt = hw[i];
            ++rc[hw[i] = wt && (mb + 1 - wt)];
        }
        // huf buf
        var hbuf = new u8(ts << 1);
        //    symbols                      num bits
        var syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
        ri[mb] = 0;
        for (i = mb; i > 0; --i) {
            var pv = ri[i];
            fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << (mb - i)));
        }
        if (ri[0] != ts)
            err(0);
        for (i = 0; i < wc; ++i) {
            var bits = hw[i];
            if (bits) {
                var code = ri[bits];
                fill(syms, i, code, ri[bits] = code + (1 << (mb - bits)));
            }
        }
        return [bt, {
                n: nb,
                b: mb,
                s: syms
            }];
    };
    // Tables generated using this:
    // https://gist.github.com/101arrowz/a979452d4355992cbf8f257cbffc9edd
    // default literal length table
    var dllt = /*#__PURE__*/ rfse(/*#__PURE__*/ new u8([
        81, 16, 99, 140, 49, 198, 24, 99, 12, 33, 196, 24, 99, 102, 102, 134, 70, 146, 4
    ]), 0, 6)[1];
    // default match length table
    var dmlt = /*#__PURE__*/ rfse(/*#__PURE__*/ new u8([
        33, 20, 196, 24, 99, 140, 33, 132, 16, 66, 8, 33, 132, 16, 66, 8, 33, 68, 68, 68, 68, 68, 68, 68, 68, 36, 9
    ]), 0, 6)[1];
    // default offset code table
    var doct = /*#__PURE__ */ rfse(/*#__PURE__*/ new u8([
        32, 132, 16, 66, 102, 70, 68, 68, 68, 68, 36, 73, 2
    ]), 0, 5)[1];
    // bits to baseline
    var b2bl = function (b, s) {
        var len = b.length, bl = new i32(len);
        for (var i = 0; i < len; ++i) {
            bl[i] = s;
            s += 1 << b[i];
        }
        return bl;
    };
    // literal length bits
    var llb = /*#__PURE__ */ new u8(( /*#__PURE__ */new i32([
        0, 0, 0, 0, 16843009, 50528770, 134678020, 202050057, 269422093
    ])).buffer, 0, 36);
    // literal length baseline
    var llbl = /*#__PURE__ */ b2bl(llb, 0);
    // match length bits
    var mlb = /*#__PURE__ */ new u8(( /*#__PURE__ */new i32([
        0, 0, 0, 0, 0, 0, 0, 0, 16843009, 50528770, 117769220, 185207048, 252579084, 16
    ])).buffer, 0, 53);
    // match length baseline
    var mlbl = /*#__PURE__ */ b2bl(mlb, 3);
    // decode huffman stream
    var dhu = function (dat, out, hu) {
        var len = dat.length, ss = out.length, lb = dat[len - 1], msk = (1 << hu.b) - 1, eb = -hu.b;
        if (!lb)
            err(0);
        var st = 0, btr = hu.b, pos = (len << 3) - 8 + msb(lb) - btr, i = -1;
        for (; pos > eb && i < ss;) {
            var cbt = pos >> 3;
            var val = (dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (pos & 7);
            st = ((st << btr) | val) & msk;
            out[++i] = hu.s[st];
            pos -= (btr = hu.n[st]);
        }
        if (pos != eb || i + 1 != ss)
            err(0);
    };
    // decode huffman stream 4x
    // TODO: use workers to parallelize
    var dhu4 = function (dat, out, hu) {
        var bt = 6;
        var ss = out.length, sz1 = (ss + 3) >> 2, sz2 = sz1 << 1, sz3 = sz1 + sz2;
        dhu(dat.subarray(bt, bt += dat[0] | (dat[1] << 8)), out.subarray(0, sz1), hu);
        dhu(dat.subarray(bt, bt += dat[2] | (dat[3] << 8)), out.subarray(sz1, sz2), hu);
        dhu(dat.subarray(bt, bt += dat[4] | (dat[5] << 8)), out.subarray(sz2, sz3), hu);
        dhu(dat.subarray(bt), out.subarray(sz3), hu);
    };
    // read Zstandard block
    var rzb = function (dat, st, out) {
        var _a;
        var bt = st.b;
        //    byte 0        block type
        var b0 = dat[bt], btype = (b0 >> 1) & 3;
        st.l = b0 & 1;
        var sz = (b0 >> 3) | (dat[bt + 1] << 5) | (dat[bt + 2] << 13);
        // end byte for block
        var ebt = (bt += 3) + sz;
        if (btype == 1) {
            if (bt >= dat.length)
                return;
            st.b = bt + 1;
            if (out) {
                fill(out, dat[bt], st.y, st.y += sz);
                return out;
            }
            return fill(new u8(sz), dat[bt]);
        }
        if (ebt > dat.length)
            return;
        if (btype == 0) {
            st.b = ebt;
            if (out) {
                out.set(dat.subarray(bt, ebt), st.y);
                st.y += sz;
                return out;
            }
            return slc(dat, bt, ebt);
        }
        if (btype == 2) {
            //    byte 3        lit btype     size format
            var b3 = dat[bt], lbt = b3 & 3, sf = (b3 >> 2) & 3;
            // lit src size  lit cmp sz 4 streams
            var lss = b3 >> 4, lcs = 0, s4 = 0;
            if (lbt < 2) {
                if (sf & 1)
                    lss |= (dat[++bt] << 4) | ((sf & 2) && (dat[++bt] << 12));
                else
                    lss = b3 >> 3;
            }
            else {
                s4 = sf;
                if (sf < 2)
                    lss |= ((dat[++bt] & 63) << 4), lcs = (dat[bt] >> 6) | (dat[++bt] << 2);
                else if (sf == 2)
                    lss |= (dat[++bt] << 4) | ((dat[++bt] & 3) << 12), lcs = (dat[bt] >> 2) | (dat[++bt] << 6);
                else
                    lss |= (dat[++bt] << 4) | ((dat[++bt] & 63) << 12), lcs = (dat[bt] >> 6) | (dat[++bt] << 2) | (dat[++bt] << 10);
            }
            ++bt;
            // add literals to end - can never overlap with backreferences because unused literals always appended
            var buf = out ? out.subarray(st.y, st.y + st.m) : new u8(st.m);
            // starting point for literals
            var spl = buf.length - lss;
            if (lbt == 0)
                buf.set(dat.subarray(bt, bt += lss), spl);
            else if (lbt == 1)
                fill(buf, dat[bt++], spl);
            else {
                // huffman table
                var hu = st.h;
                if (lbt == 2) {
                    var hud = rhu(dat, bt);
                    // subtract description length
                    lcs += bt - (bt = hud[0]);
                    st.h = hu = hud[1];
                }
                else if (!hu)
                    err(0);
                (s4 ? dhu4 : dhu)(dat.subarray(bt, bt += lcs), buf.subarray(spl), hu);
            }
            // num sequences
            var ns = dat[bt++];
            if (ns) {
                if (ns == 255)
                    ns = (dat[bt++] | (dat[bt++] << 8)) + 0x7F00;
                else if (ns > 127)
                    ns = ((ns - 128) << 8) | dat[bt++];
                // symbol compression modes
                var scm = dat[bt++];
                if (scm & 3)
                    err(0);
                var dts = [dmlt, doct, dllt];
                for (var i = 2; i > -1; --i) {
                    var md = (scm >> ((i << 1) + 2)) & 3;
                    if (md == 1) {
                        // rle buf
                        var rbuf = new u8([0, 0, dat[bt++]]);
                        dts[i] = {
                            s: rbuf.subarray(2, 3),
                            n: rbuf.subarray(0, 1),
                            t: new u16(rbuf.buffer, 0, 1),
                            b: 0
                        };
                    }
                    else if (md == 2) {
                        // accuracy log 8 for offsets, 9 for others
                        _a = rfse(dat, bt, 9 - (i & 1)), bt = _a[0], dts[i] = _a[1];
                    }
                    else if (md == 3) {
                        if (!st.t)
                            err(0);
                        dts[i] = st.t[i];
                    }
                }
                var _b = st.t = dts, mlt = _b[0], oct = _b[1], llt = _b[2];
                var lb = dat[ebt - 1];
                if (!lb)
                    err(0);
                var spos = (ebt << 3) - 8 + msb(lb) - llt.b, cbt = spos >> 3, oubt = 0;
                var lst = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << llt.b) - 1);
                cbt = (spos -= oct.b) >> 3;
                var ost = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << oct.b) - 1);
                cbt = (spos -= mlt.b) >> 3;
                var mst = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << mlt.b) - 1);
                for (++ns; --ns;) {
                    var llc = llt.s[lst];
                    var lbtr = llt.n[lst];
                    var mlc = mlt.s[mst];
                    var mbtr = mlt.n[mst];
                    var ofc = oct.s[ost];
                    var obtr = oct.n[ost];
                    cbt = (spos -= ofc) >> 3;
                    var ofp = 1 << ofc;
                    var off = ofp + (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16) | (dat[cbt + 3] << 24)) >>> (spos & 7)) & (ofp - 1));
                    cbt = (spos -= mlb[mlc]) >> 3;
                    var ml = mlbl[mlc] + (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (spos & 7)) & ((1 << mlb[mlc]) - 1));
                    cbt = (spos -= llb[llc]) >> 3;
                    var ll = llbl[llc] + (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (spos & 7)) & ((1 << llb[llc]) - 1));
                    cbt = (spos -= lbtr) >> 3;
                    lst = llt.t[lst] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << lbtr) - 1));
                    cbt = (spos -= mbtr) >> 3;
                    mst = mlt.t[mst] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << mbtr) - 1));
                    cbt = (spos -= obtr) >> 3;
                    ost = oct.t[ost] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << obtr) - 1));
                    if (off > 3) {
                        st.o[2] = st.o[1];
                        st.o[1] = st.o[0];
                        st.o[0] = off -= 3;
                    }
                    else {
                        var idx = off - (ll != 0);
                        if (idx) {
                            off = idx == 3 ? st.o[0] - 1 : st.o[idx];
                            if (idx > 1)
                                st.o[2] = st.o[1];
                            st.o[1] = st.o[0];
                            st.o[0] = off;
                        }
                        else
                            off = st.o[0];
                    }
                    for (var i = 0; i < ll; ++i) {
                        buf[oubt + i] = buf[spl + i];
                    }
                    oubt += ll, spl += ll;
                    var stin = oubt - off;
                    if (stin < 0) {
                        var len = -stin;
                        var bs = st.e + stin;
                        if (len > ml)
                            len = ml;
                        for (var i = 0; i < len; ++i) {
                            buf[oubt + i] = st.w[bs + i];
                        }
                        oubt += len, ml -= len, stin = 0;
                    }
                    for (var i = 0; i < ml; ++i) {
                        buf[oubt + i] = buf[stin + i];
                    }
                    oubt += ml;
                }
                if (oubt != spl) {
                    while (spl < buf.length) {
                        buf[oubt++] = buf[spl++];
                    }
                }
                else
                    oubt = buf.length;
                if (out)
                    st.y += oubt;
                else
                    buf = slc(buf, 0, oubt);
            }
            else if (out) {
                st.y += lss;
                if (spl) {
                    for (var i = 0; i < lss; ++i) {
                        buf[i] = buf[spl + i];
                    }
                }
            }
            else if (spl)
                buf = slc(buf, spl);
            st.b = ebt;
            return buf;
        }
        err(2);
    };
    // concat
    var cct = function (bufs, ol) {
        if (bufs.length == 1)
            return bufs[0];
        var buf = new u8(ol);
        for (var i = 0, b = 0; i < bufs.length; ++i) {
            var chk = bufs[i];
            buf.set(chk, b);
            b += chk.length;
        }
        return buf;
    };
    /**
     * Decompresses Zstandard data
     * @param dat The input data
     * @param buf The output buffer. If unspecified, the function will allocate
     *            exactly enough memory to fit the decompressed data. If your
     *            data has multiple frames and you know the output size, specifying
     *            it will yield better performance.
     * @returns The decompressed data
     */
    function decompress(dat, buf) {
        var bufs = [], nb = +!buf;
        var bt = 0, ol = 0;
        for (; dat.length;) {
            var st = rzfh(dat, nb || buf);
            if (typeof st == 'object') {
                if (nb) {
                    buf = null;
                    if (st.w.length == st.u) {
                        bufs.push(buf = st.w);
                        ol += st.u;
                    }
                }
                else {
                    bufs.push(buf);
                    st.e = 0;
                }
                for (; !st.l;) {
                    var blk = rzb(dat, st, buf);
                    if (!blk)
                        err(5);
                    if (buf)
                        st.e = st.y;
                    else {
                        bufs.push(blk);
                        ol += blk.length;
                        cpw(st.w, 0, blk.length);
                        st.w.set(blk, st.w.length - blk.length);
                    }
                }
                bt = st.b + (st.c * 4);
            }
            else
                bt = st;
            dat = dat.subarray(bt);
        }
        return cct(bufs, ol);
    }
        return { decompress: decompress };
    })();

    function unzstd(src, size) {
        var out = fzstd.decompress(src);
        if (out.length !== size)
            throw bad();
        return out;
    }

    // ---- The methods.

    var METHODS = {
        1: function(d, n) { return unshrink(d, n); },
        2: function(d, n) { return expand(d, n, 1); },
        3: function(d, n) { return expand(d, n, 2); },
        4: function(d, n) { return expand(d, n, 3); },
        5: function(d, n) { return expand(d, n, 4); },
        6: function(d, n, f) { return explode(d, n, f); },
        8: function(d, n) { return inflate(d, n, false); },
        9: function(d, n) { return inflate(d, n, true); },
        12: function(d, n) { return bunzip2(d, n); },
        14: function(d, n) { return unlzma(d, n); },
        93: function(d, n) { return unzstd(d, n); },
        95: function(d, n) { return unxz(d, n); },
        98: function(d, n) { return unppmd(d, n); }
    };

    // An entry's bytes, unpacked: exactly size of them, matching crc when
    // it's given. Throws if they can't be.
    function unzip(method, flags, data, size, crc) {
        var out;
        if (method === 0) {
            if (data.length !== size)
                throw bad();
            out = data;
        } else if (METHODS[method]) {
            out = METHODS[method](data, size, flags);
        } else {
            throw bad('compression method ' + method + ' not supported');
        }
        if (out.length !== size)
            throw bad();
        if (crc !== undefined && crc32(out) !== crc >>> 0)
            throw bad('CRC mismatch');
        return out;
    }

    return {
        unzip: unzip,
        crc32: crc32,
        methods: Object.keys(METHODS).map(Number).concat([0]).sort(function(a, b) { return a - b; })
    };
})();

export { JkUnzip };
