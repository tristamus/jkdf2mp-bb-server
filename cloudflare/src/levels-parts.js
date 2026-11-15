// The parts of models that Massassi's 3D preview leaves out of a level.
//
// A model (.3do) is a tree of parts: its hierarchy's nodes, each with a mesh.
// Massassi's 3D preview (jkview, by Stephan Reiter) makes a level's 3D data
// with a reader that keeps only a model's LAST top-level node (a node whose
// parent is -1) and the nodes under it. jkview's own code has taken every
// top-level node since its commit b7b8227 (9 Oct 2024), but the preview's
// data is still made the old way. A model saved with each of its parts at the
// top loses all but the last: The Death Star's Millennium Falcon has 9, and
// only its sensors (51 of its 753 faces) are in the data. The game draws them
// all. None of the games' own models has more than one top-level node; the
// models a level ships are the ones cut (197 of the library's first 1,290
// levels have one).
//
// levelParts() reads a level's .jkl and models as jkview does (its jkl.py,
// threedo.py and loader.py) and gives the surfaces of the parts it leaves
// out, placed and textured as jkview places and textures the rest, so the
// page can draw them with the preview's own data. levelParts(..., "kept")
// gives the parts jkview does keep, the same way: checked against the
// preview's data on all 217 maps of the levels it cuts (195 match exactly;
// on the other 3, 22 surfaces differ only in a texture).
//
// The regular expressions and reading rules below are jkview's, under its
// license:
//
// BSD 2-Clause License
//
// Copyright (c) 2019, Stephan Reiter
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

// Python's \s, \S and float() on bytes, for the regular expressions jkview
// uses: only ASCII whitespace.
const W = "[ \\t\\n\\r\\f\\v]", NW = "[^ \\t\\n\\r\\f\\v]";
const F = "-?\\d*(?:\\.\\d+)?(?:[eE][-+]?\\d+)?";
const re = (s, flags) => new RegExp(s.replace(/\\s/g, W).replace(/\\S/g, NW), flags);

const MAT_RE = re(String.raw`^(\d+):\s+(\S+)`);
const INTEGER_VALUE_RE = re(String.raw`^([\D ]*)\s+(-?\d+)$`);
const VERTEX_XYZI_RE = re(String.raw`^(\d+):\s+(${F})\s+(${F})\s+(${F})\s+(${F})`);
const VERTEX_UV_RE = re(String.raw`^(\d+):\s+(${F})\s+(${F})`);
const NORMAL_RE = re(String.raw`^(\d+):\s+(${F})\s+(${F})\s+(${F})`);
const FACE_RE = re(String.raw`^(\d+):\s+(-?\d+?)\s+(0x[0-9a-fA-F]+)\s+(-?\d+?)\s+(-?\d+?)\s+(-?\d+?)\s+(${F})\s+(\d+)`);
const NODE_RE = re(String.raw`^(\d+):\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)` +
                   String.raw`\s+(${F})\s+(${F})\s+(${F})\s+(${F})\s+(${F})\s+(${F})\s+(${F})\s+(${F})\s+(${F})\s+(\D+)`);
const IDENT = "[^0-9 \\t\\n\\r\\f\\v]" + NW + "+";
const TEMPLATE_RE = re(String.raw`^(${IDENT})\s+(${IDENT})\s+(\D.+)$`, "s");
const THING_RE = re(String.raw`^(\d+):\s+(${IDENT})\s+(\S+)\s+(${F})\s+(${F})\s+(${F})\s+(${F})\s+(${F})\s+(${F})\s+(-?\d+)(\s+-?\d+)?\s*(.*)$`, "s");
const SECTOR_RE = re(String.raw`^SECTOR\s+(\d+)`);

const restRes = new Map();
function faceRestRe(n) {
    let r = restRes.get(n);
    if (!r) {
        r = re(String.raw`^\s+` + String.raw`(-?\d+),\s*(-?\d+)\s+`.repeat(Math.max(0, n - 1)) + String.raw`(-?\d+),\s*(-?\d+)`);
        restRes.set(n, r);
    }
    return r;
}

function pyFloat(s) {
    if (s === "" || s === "-" || s == null)
        throw new Error("not a number");
    return Number(s);
}

function pyStrip(s) {
    return s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
}

function pySplit(s) {
    return pyStrip(s).split(/[ \t\n\r\f\v]+/).filter(Boolean);
}

// A file's lines by section, as jkview reads .jkl and .3do files: comments
// (from #) and the space around each line taken off, empty lines left out.
function sections(text) {
    const strip = line => {
        const at = line.indexOf("#");
        return pyStrip(at >= 0 ? line.slice(0, at) : line);
    };
    const defines = line => line.length > 8 && line.slice(0, 8).toLowerCase() === "section:";
    const out = new Map();
    const lines = text.split("\n");
    let i = 0;
    while (i < lines.length) {
        let line = strip(lines[i++]);
        while (defines(line)) {
            const name = pyStrip(line.slice(8)).toLowerCase();
            const list = [];
            line = "";
            while (i < lines.length) {
                const l = strip(lines[i++]);
                if (!l)
                    continue;
                if (l === "end" || defines(l)) {
                    line = l;
                    break;
                }
                list.push(l);
            }
            out.set(name, list);
        }
    }
    return out;
}

function latin1(b) {
    let s = "";
    for (let at = 0; at < b.length; at += 65536)
        s += String.fromCharCode.apply(null, b.subarray(at, Math.min(b.length, at + 65536)));
    return s;
}

// ---- Models (jkview's threedo.py)

// { materials: Map(index -> name), meshes: Map(mesh -> [{ vertices, material }]),
// roots: [node] } (node: { mesh, offset, rot, pivot, children }), or throws
// where jkview's reader does (then the preview has none of the model).
export function readModel(text) {
    const secs = sections(text);
    const need = name => {
        if (!secs.has(name))
            throw new Error("no section " + name);
        return secs.get(name);
    };
    const materials = new Map();
    for (const line of need("modelresource")) {
        const m = MAT_RE.exec(line);
        if (m)
            materials.set(Number(m[1]), m[2]);
    }

    const geosets = new Map();
    let geoset = new Map(), mesh = new Map(), v = { xyzi: new Map(), uv: new Map(), norm: new Map() };
    let target = "";
    for (const line of need("geometrydef")) {
        if (line.startsWith("VERTICES")) { target = "xyzi"; continue; }
        if (line.startsWith("TEXTURE VERTICES")) { target = "uv"; continue; }
        if (line.startsWith("VERTEX NORMALS")) { target = "norm"; continue; }
        if (line.startsWith("FACES")) { target = "faces"; continue; }
        if (line.startsWith("FACE NORMALS")) { target = "fnorm"; continue; }
        let m = INTEGER_VALUE_RE.exec(line);
        if (m) {
            target = "";
            const value = parseInt(m[2], 10);
            if (m[1] === "GEOSET") {
                geosets.set(value, geoset = new Map());
            } else if (m[1] === "MESH") {
                geoset.set(value, mesh = new Map());
                v = { xyzi: new Map(), uv: new Map(), norm: new Map() };
            }
        }
        if (target === "xyzi") {
            if ((m = VERTEX_XYZI_RE.exec(line)))
                v.xyzi.set(Number(m[1]), [pyFloat(m[2]), pyFloat(m[3]), pyFloat(m[4])]);
        } else if (target === "uv") {
            if ((m = VERTEX_UV_RE.exec(line)))
                v.uv.set(Number(m[1]), [pyFloat(m[2]), pyFloat(m[3])]);
        } else if (target === "norm") {
            if ((m = NORMAL_RE.exec(line)))
                v.norm.set(Number(m[1]), [pyFloat(m[2]), pyFloat(m[3]), pyFloat(m[4])]);
        } else if (target === "faces") {
            if (!(m = FACE_RE.exec(line)))
                continue;
            const key = Number(m[1]), mat = parseInt(m[2], 10), type = parseInt(m[3].slice(2), 16);
            const geo = parseInt(m[4], 10), nverts = Number(m[8]);
            pyFloat(m[7]);
            const r = faceRestRe(nverts).exec(line.slice(m[0].length));
            if (!r)
                continue;
            const vertices = [];
            for (let i = 0; i < nverts; i++) {
                const xi = Number(r[2 * i + 1]), ui = Number(r[2 * i + 2]);
                const pos = v.xyzi.get(xi);
                if (!pos || !v.norm.has(xi))
                    throw new Error("no vertex " + xi);
                vertices.push([pos, geo === 4 && v.uv.has(ui) ? v.uv.get(ui) : [0, 0]]);
            }
            // Two-sided: the corners back again, as jkview has it.
            if (type & 1)
                vertices.push(...vertices.slice(1, -1).reverse());
            mesh.set(key, { vertices, material: mat });
        }
    }
    if (!geosets.has(0))
        throw new Error("no geoset 0");

    const nodes = new Map();
    for (const line of need("hierarchydef")) {
        const m = NODE_RE.exec(line);
        if (!m)
            continue;
        const f = i => pyFloat(m[i]);
        nodes.set(Number(m[1]), {
            mesh: parseInt(m[4], 10), parent: parseInt(m[5], 10),
            offset: [f(9), f(10), f(11)], rot: [f(12), f(13), f(14)], pivot: [f(15), f(16), f(17)], children: []
        });
    }
    const roots = [];
    for (const n of nodes.values()) {
        if (n.parent >= 0) {
            const p = nodes.get(n.parent);
            if (!p)
                throw new Error("no node " + n.parent);
            p.children.push(n);
        } else {
            roots.push(n);
        }
    }
    if (!roots.length)
        throw new Error("no root nodes");
    return { materials, meshes: geosets.get(0), roots };
}

// ---- Placing (jkview's loader.py, with Christoph Gohlke's
// transformations.py: euler_matrix(roll, yaw, pitch, 'ryzx'))

function matMul(a, b) {
    const out = new Array(16).fill(0);
    for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++)
            out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    return out;
}

function translation(d) {
    return [1, 0, 0, d[0], 0, 1, 0, d[1], 0, 0, 1, d[2], 0, 0, 0, 1];
}

// rot: [pitch, yaw, roll] in degrees.
function rotation(rot) {
    // 'ryzx' is (firstaxis 0, parity 1, repetition 0, frame 1): i = 0, j = 2,
    // k = 1; the frame swaps the first and last angle, the parity negates them.
    const rad = Math.PI / 180;
    const ai = -rot[0] * rad, aj = -rot[1] * rad, ak = -rot[2] * rad;
    const si = Math.sin(ai), sj = Math.sin(aj), sk = Math.sin(ak);
    const ci = Math.cos(ai), cj = Math.cos(aj), ck = Math.cos(ak);
    const cc = ci * ck, cs = ci * sk, sc = si * ck, ss = si * sk;
    const M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const set = (r, c, x) => { M[r * 4 + c] = x; };
    const i = 0, j = 2, k = 1;
    set(i, i, cj * ck);
    set(i, j, sj * sc - cs);
    set(i, k, sj * cc + ss);
    set(j, i, cj * sk);
    set(j, j, sj * ss + cc);
    set(j, k, sj * cs - sc);
    set(k, i, -sj);
    set(k, j, cj * si);
    set(k, k, cj * ci);
    return M;
}

function apply(m, p) {
    return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
}

// The surfaces of a node and those under it: [{ vertices: [[pos, uv]...], material: name }].
function placeNode(out, model, node, transform) {
    transform = matMul(matMul(transform, translation(node.offset)), rotation(node.rot));
    if (node.mesh !== -1) {
        const mt = matMul(transform, translation(node.pivot));
        const mesh = model.meshes.get(node.mesh);
        if (!mesh)
            throw new Error("no mesh " + node.mesh);
        for (const s of mesh.values()) {
            const name = model.materials.get(s.material);
            if (name === undefined)
                continue;
            out.push({ vertices: s.vertices.map(v => [apply(mt, v[0]), v[1]]), material: name });
        }
    }
    for (const c of node.children)
        placeNode(out, model, c, transform);
}

// ---- Levels (jkview's jkl.py)

function config(text) {
    const c = new Map();
    for (const pair of pySplit(text || "")) {
        const kv = pair.split("=");
        if (kv.length === 2)
            c.set(kv[0], kv[1]);
    }
    return c;
}

// The things with a model, as jkview places them: [{ model, pos, rot }].
export function levelModels(text) {
    const secs = sections(text);
    for (const name of ["materials", "georesource", "sectors", "templates", "things"]) {
        if (!secs.has(name))
            throw new Error("no section " + name);
    }
    const sectors = new Set();
    for (const line of secs.get("sectors")) {
        const m = SECTOR_RE.exec(line);
        if (m)
            sectors.add(Number(m[1]));
    }
    const templates = new Map();
    for (const line of secs.get("templates")) {
        const m = TEMPLATE_RE.exec(line);
        if (!m)
            continue;
        const name = m[1].toLowerCase(), base = m[2].toLowerCase();
        let c = config(m[3]);
        if (templates.has(base))
            c = new Map([...templates.get(base), ...c]);
        templates.set(name, c);
    }
    const out = [];
    for (const line of secs.get("things")) {
        const m = THING_RE.exec(line);
        if (!m)
            continue;
        const template = m[2].toLowerCase();
        let c = m[12] ? config(m[12]) : new Map();
        if (templates.has(template))
            c = new Map([...templates.get(template), ...c]);
        const model = c.get("model3d");
        if (model === undefined)
            continue;
        const f = i => pyFloat(m[i]);
        if (!sectors.has(parseInt(m[10], 10)))
            continue;
        out.push({ model, pos: [f(4), f(5), f(6)], rot: [f(7), f(8), f(9)] });
    }
    return out;
}

// ---- Textures

// A MAT's size as jkview makes its picture: 1 x 1 for a color, else the
// first texture's.
export function matSize(b) {
    const u32 = at => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
    if (!b || b.length < 76 || u32(0) !== 0x2054414d || u32(4) !== 50)
        return null;
    const type = u32(8), count = u32(12);
    if (type === 0)
        return [1, 1];
    const at = 76 + count * 40;
    if (type !== 2 || count < 1 || count > 4096 || at + 8 > b.length)
        return null;
    const w = u32(at) | 0, h = u32(at + 4) | 0;
    return w > 0 && h > 0 ? [w, h] : null;
}

// A PNG's size (its IHDR), from a data: URL.
export function pngSize(dataUrl) {
    const comma = String(dataUrl || "").indexOf(",");
    if (comma < 0)
        return null;
    let bin;
    try {
        bin = atob(dataUrl.slice(comma + 1, comma + 1 + 44));
    } catch {
        return null;
    }
    if (bin.length < 24 || bin.slice(1, 4) !== "PNG")
        return null;
    const u32 = at => ((bin.charCodeAt(at) << 24) | (bin.charCodeAt(at + 1) << 16) | (bin.charCodeAt(at + 2) << 8) | bin.charCodeAt(at + 3)) >>> 0;
    return [u32(16), u32(20)];
}

function toBase64(b) {
    let s = "";
    for (let at = 0; at < b.length; at += 32768)
        s += String.fromCharCode.apply(null, b.subarray(at, Math.min(b.length, at + 32768)));
    return btoa(s);
}

const round = x => Math.round(x * 1e6) / 1e6;

// ---- The level

// files: the level's GOB(s), [{ name (lowercased, '/') -> { bytes } }] as
// find(path) -> Uint8Array or null; jkl: the map's .jkl path; mats: the
// preview's mat.json for the map. which: "left" (the parts the preview leaves
// out) or "kept" (the ones it keeps, for the tests). official: the names
// (lowercased, without .3do) of the games' own models: the preview reads the
// games' files over the level's, so where a level ships a model of the same
// name it has the game's (Blue Rain's trees are MotS's tree.3do), and nothing
// of the level's is added there.
//
// Gives null when nothing is left out, else { v: 1, base, mats, model_surfaces }:
// base is how many textures the preview's mat.json has; a surface's material
// below base is the preview's, base + i is mats[i] ({ name, mat: the MAT's
// bytes in base64 } when the level ships it, else { name }: one of the
// game's). Texture places are divided by the texture's size, as the
// preview's are; where the size isn't known (one of the game's textures the
// preview's list doesn't have), the material's entry says raw: true and the
// page divides by the size of the texture it finds.
export function levelParts(files, jkl, mats, which = "left", official = null) {
    const text = files.find(jkl);
    if (!text)
        return null;
    const things = levelModels(latin1(text));
    const list = Array.isArray(mats) ? mats : Object.keys(mats || {}).sort((a, b) => a - b).map(k => mats[k]);
    const base = list.length;
    // The preview's textures by name as it wrote them (jkview keeps one for
    // each spelling: a model's DFLT.MAT isn't the level's dflt.mat), then by
    // name in any case.
    const byName = new Map(), byLow = new Map();
    list.forEach((m, i) => {
        const n = m && m.name ? String(m.name).replace(/\\/g, "/") : "";
        const hit = { index: i, size: pngSize(m && m.data) };
        if (n && !byName.has(n))
            byName.set(n, hit);
        if (n && !byLow.has(n.toLowerCase()))
            byLow.set(n.toLowerCase(), hit);
    });
    const models = new Map();
    const surfaces = [];
    for (const t of things) {
        const key = t.model.toLowerCase();
        if (official && official.has(key.replace(/\.3do$/, "")))
            continue;
        if (!models.has(key)) {
            const b = files.find("3do/" + key);
            let model = null;
            if (b) {
                try {
                    model = readModel(latin1(b));
                } catch {
                    model = null;
                }
            }
            models.set(key, model);
        }
        const model = models.get(key);
        // The games' own models aren't cut; one the preview couldn't read it
        // has none of, and nor does this.
        if (!model || model.roots.length < 2)
            continue;
        const roots = which === "kept" ? model.roots.slice(-1) : model.roots.slice(0, -1);
        const at = matMul(translation(t.pos), rotation(t.rot));
        for (const r of roots)
            placeNode(surfaces, model, r, at);
    }
    if (!surfaces.length)
        return null;

    // Each texture: the preview's (in mat/ or 3do/mat/, the last found, as
    // jkview looks), else the level's MAT, else one of the game's.
    const added = [], addedBy = new Map();
    const material = name => {
        const low = name.toLowerCase();
        for (const p of ["3do/mat/", "mat/"]) {
            const hit = byName.get(p + name);
            if (hit)
                return hit;
        }
        for (const p of ["3do/mat/", "mat/"]) {
            const hit = byLow.get(p + low);
            if (hit)
                return hit;
        }
        if (addedBy.has(low))
            return addedBy.get(low);
        let entry = null, size = null;
        for (const p of ["3do/mat/", "mat/"]) {
            const b = files.find(p + low);
            if (b) {
                size = matSize(b);
                entry = { name: p + name, mat: toBase64(b) };
                break;
            }
        }
        if (!entry)
            entry = { name: "mat/" + name };
        if (!size)
            entry.raw = true;
        const hit = { index: base + added.length, size };
        added.push(entry);
        addedBy.set(low, hit);
        return hit;
    };
    const out = [];
    for (const s of surfaces) {
        const m = material(s.material);
        const su = m.size ? 1 / m.size[0] : 1, sv = m.size ? 1 / m.size[1] : 1;
        out.push({
            vertices: s.vertices.map(v => [[round(v[0][0]), round(v[0][1]), round(v[0][2])], [round(v[1][0] * su), round(v[1][1] * sv)]]),
            material: m.index
        });
    }
    return { v: 1, base, mats: added, model_surfaces: out };
}

// A level's GOBs as files to look in: the one with the .jkl first.
export function gobFinder(gobs, parse) {
    const dirs = gobs.map(b => {
        const map = new Map();
        for (const f of parse(b) || [])
            map.set(f.name.toLowerCase(), f);
        return { b, map };
    });
    return {
        find(name) {
            name = name.toLowerCase();
            for (const d of dirs) {
                const f = d.map.get(name);
                if (f)
                    return d.b.subarray(f.offset, f.offset + f.size);
            }
            return null;
        },
        has(name) {
            name = name.toLowerCase();
            return dirs.some(d => d.map.has(name));
        },
        only(name) {
            name = name.toLowerCase();
            const d = dirs.find(x => x.map.has(name));
            return d ? gobFinder([d.b], parse) : null;
        }
    };
}
