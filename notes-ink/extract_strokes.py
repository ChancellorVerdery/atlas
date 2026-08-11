"""Extract handwritten-ink strokes from an Apple Notes paper-bundle sqlite file
(macOS 26 "enhanced canvas" / new-inks format). Pure stdlib.

FORMAT (reverse-engineered 2026-07 against fixture note "Chapter 22 - Electric"):

Reference.Data blob = 8-byte header  b'crdt' 0x06 0x00 0x00 0x00  then protobuf.
(NOT 9 bytes as previously assumed - byte 8 is already the first protobuf tag.)

Every record is a CRDT object:  top field 1 = object payload, top field 6 =
metadata { 1: author uuid(s), 2: repeated string KEY TABLE for the object }.

Object payload variants (field inside top field 1):
  1.10 -> STROKE GEOMETRY record (keyless).  Path 1.10.1.2:
       1 (bytes16)  stroke uuid            2 (fixed64) double, secs since 2001
       3 (varint)   point count N          4 (varint)  per-point component mask
       5 (varint)   constant component mask (4|5 == 0x7FF, disjoint)
       6 (bytes)    defaults for masked-out components, concatenated
       7 (bytes)    N packed points, stride = 34 - len(field6)
       9 (varint)   crdt clock
     Component bit -> size in bytes (full point = 34):
       0 x:f32le  1 y:f32le  2 timeOffset:f32le  3 u32(=1000)  4 u16
       5 u16      6 6B(f32 width-ish 2.6-4.5 + u16)  7 u16(def 0x7fff)
       8 0B       9 f32 0..1 (def 1.0)               10 u16(def 0)
     Bits 0,1 always per-point and first => x = f32 @+0, y = f32 @+4.
     Coordinates are canvas points, pre-transform.
  1.4  -> generic OBJECT with named properties (names from key table 6.2).
     Entries at 1.4.2 (repeated): { 1: { 1:{1:keyIndex,2:clock}, 2:{VALUE} } }
     VALUE types: 1=varint, 4=bytes (rects = 4 BE doubles, affine transform =
     6 BE doubles a b c d tx ty), 8:{5: 19B ref = 0x12 0x11 + 17B record id},
     9 = list { 1: { 4: inline object | 8.5: ref } }, 14 = typed tuple
     { 1: type-codes bytes, repeated 2:{VALUE} }.
     Known objects:
       root   (keys canvasBounds,strokes; record id = 0x02 + note uuid):
              strokes = ordered list of refs -> per-stroke ITEM records
       canvas (keys bounds,frame,drawing): bounds rect = ink extent
       INK    (keys ink[,transform]), one per stroke:
              ink = list of { 4: { 1: color submsg {1..4: fixed32 RGBA},
                                   2: ink type string "com.apple.ink.*",
                                   8: fixed64 LE double width } }
              transform = 48B, 6 BE doubles (a,b,c,d,tx,ty) - applied by Notes
              when strokes are moved / space inserted.  THIS IS REQUIRED for
              correct layout (421 of 1548 Ch22 strokes carry ty=+251.55).
  1.1  -> ITEM record (keyless, keys inherited/properties come from its class):
     actually keyset ('inherited','properties'):
       inherited  = ref -> INK record
       properties = tuple(varint, 0, ref -> STROKE GEOMETRY record, 48B blob
                    (1,0,0,0.25,0,0) constant - purpose unknown)
     (the 63-byte keyless 1.1 records are attach ops inserting items in root)

Render order = root 'strokes' list order.  Final coords = affine(INK.transform)
applied to raw point (x,y).
"""
import sqlite3
import struct


# ---------------------------------------------------------------- protobuf ---

def _varint(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s
        if not (x & 0x80):
            return r, i
        s += 7
        if s > 70:
            raise ValueError("varint")


def _parse(b):
    """-> list of (field, wiretype, value); wt2 value is raw bytes."""
    out = []
    i, n = 0, len(b)
    while i < n:
        key, i = _varint(b, i)
        f, wt = key >> 3, key & 7
        if f == 0:
            raise ValueError("field0")
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 1:
            v = b[i:i + 8]; i += 8
        elif wt == 5:
            v = b[i:i + 4]; i += 4
        elif wt == 2:
            l, i = _varint(b, i)
            if i + l > n:
                raise ValueError("trunc")
            v = b[i:i + l]; i += l
        else:
            raise ValueError("wt%d" % wt)
        out.append((f, wt, v))
    return out


def _msgs(items, f):
    """All field-f wt2 values parsed as submessages."""
    out = []
    for ff, ww, vv in items:
        if ff == f and ww == 2:
            try:
                out.append(_parse(vv))
            except (ValueError, IndexError):
                pass
    return out


def _bytes_of(items, f):
    for ff, ww, vv in items:
        if ff == f and ww == 2:
            return vv
    return None


def _varint_of(items, f):
    for ff, ww, vv in items:
        if ff == f and ww == 0:
            return vv
    return None


# ------------------------------------------------------------ record layer ---

def _keys_of(top):
    out = []
    for m6 in _msgs(top, 6):
        for ff, ww, vv in m6:
            if ff == 2 and ww == 2:
                try:
                    out.append(vv.decode("ascii"))
                except UnicodeDecodeError:
                    pass
    return out


def _entries(top):
    """(key_index, value_items) pairs of a 1.4 property object."""
    for f1 in _msgs(top, 1):
        for m4 in _msgs(f1, 4):
            for e2 in _msgs(m4, 2):
                for e1 in _msgs(e2, 1):
                    key = 0
                    for kk in _msgs(e1, 1):
                        kv = _varint_of(kk, 1)
                        if kv is not None:
                            key = kv
                    vals = _msgs(e1, 2)
                    if vals:
                        yield key, vals[0]


def _ref_of(val):
    """17-byte record id from an 8.5 reference value."""
    for m8 in _msgs(val, 8):
        b = _bytes_of(m8, 5)
        if b and len(b) == 19:
            return bytes(b[2:])
    return None


def _stroke_geom(top):
    """Stroke geometry dict from a 1.10 record, or None."""
    for f1 in _msgs(top, 1):
        for m10 in _msgs(f1, 10):
            for m1 in _msgs(m10, 1):
                for s in _msgs(m1, 2):
                    cnt = _varint_of(s, 3)
                    mask = _varint_of(s, 4) or 0
                    pts = _bytes_of(s, 7)
                    uuid = _bytes_of(s, 1)
                    if not cnt or not pts or (mask & 3) != 3:
                        continue
                    if len(pts) % cnt:
                        continue
                    ts = None
                    for ff, ww, vv in s:
                        if ff == 2 and ww == 1:
                            ts = struct.unpack("<d", vv)[0]
                    return {"uuid": bytes(uuid or b""), "timestamp": ts,
                            "count": cnt, "mask": mask,
                            "defaults": bytes(_bytes_of(s, 6) or b""),
                            "raw_points": bytes(pts),
                            "stride": len(pts) // cnt}
    return None


def _ink_of(val):
    """Ink dict from an 'ink' property value (list -> 1 -> 4 object)."""
    for m9 in _msgs(val, 9):
        for el in _msgs(m9, 1):
            for obj in _msgs(el, 4):
                ink = {}
                cb = _bytes_of(obj, 1)
                if cb:
                    try:
                        col = _parse(cb)
                        rgba = [0.0, 0.0, 0.0, 1.0]
                        for ff, ww, vv in col:
                            if ww == 5 and 1 <= ff <= 4:
                                rgba[ff - 1] = struct.unpack("<f", vv)[0]
                        ink["color"] = tuple(rgba)
                    except (ValueError, IndexError):
                        pass
                tb = _bytes_of(obj, 2)
                if tb:
                    try:
                        ink["type"] = tb.decode("ascii")
                    except UnicodeDecodeError:
                        pass
                for ff, ww, vv in obj:
                    if ff == 8 and ww == 1:
                        ink["width"] = struct.unpack("<d", vv)[0]
                return ink
    return None


# ------------------------------------------------------------------ public ---

def extract_strokes(sqlite_path):
    """Return strokes in document (z) order.  Each stroke dict:
       points   [(x, y), ...]  final canvas coordinates (transform applied)
       ink      {'color': (r,g,b,a), 'type': str, 'width': float} or None
       transform (a,b,c,d,tx,ty), uuid, timestamp, mask/defaults/raw/stride."""
    db = sqlite3.connect("file:%s?mode=ro" % sqlite_path, uri=True)
    recs = {}
    for rid, data in db.execute("SELECT Id, Data FROM Reference"):
        if not data or data[:4] != b"crdt":
            continue
        try:
            recs[bytes(rid)] = _parse(bytes(data)[8:])
        except (ValueError, IndexError):
            continue
    db.close()

    geoms, items, inkrecs = {}, {}, {}
    order = None
    for rid, top in recs.items():
        keys = _keys_of(top)
        if "strokes" in keys:                       # root
            for k, val in _entries(top):
                if keys[k] == "strokes" if k < len(keys) else False:
                    pass
            # root strokes list: refs live in list entries (9 -> 1 -> 8.5)
            refs = []
            for k, val in _entries(top):
                if k < len(keys) and keys[k] == "strokes":
                    for m9 in _msgs(val, 9):
                        for el in _msgs(m9, 1):
                            r = _ref_of(el)
                            if r:
                                refs.append(r)
            if refs:
                order = refs
        elif keys[:1] == ["inherited"]:             # per-stroke item
            ink_ref = geo_ref = None
            for k, val in _entries(top):
                name = keys[k] if k < len(keys) else None
                if name == "inherited":
                    ink_ref = _ref_of(val)
                elif name == "properties":
                    for m14 in _msgs(val, 14):
                        for vv in _msgs(m14, 2):
                            r = _ref_of(vv)
                            if r:
                                geo_ref = r
            if geo_ref:
                items[rid] = (geo_ref, ink_ref)
        elif "ink" in keys:                         # ink / transform record
            ink = None
            tf = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
            for k, val in _entries(top):
                name = keys[k] if k < len(keys) else None
                if name == "ink":
                    ink = _ink_of(val)
                elif name == "transform":
                    b = _bytes_of(val, 4)
                    if b and len(b) == 48:
                        tf = struct.unpack(">6d", b)
            inkrecs[rid] = (ink, tf)
        else:
            g = _stroke_geom(top)
            if g:
                geoms[rid] = g

    item_ids = list(order) if order else list(items.keys())
    # root order may reference item records not present (partial sync) - keep
    # any leftover items too
    seen = set(item_ids)
    item_ids += [i for i in items if i not in seen]

    strokes = []
    for iid in item_ids:
        if iid not in items:
            continue
        geo_ref, ink_ref = items[iid]
        g = geoms.get(geo_ref)
        if not g:
            continue
        ink, tf = inkrecs.get(ink_ref, (None, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)))
        a, b, c, d, tx, ty = tf
        pts, stride = g["raw_points"], g["stride"]
        poly = []
        for i in range(g["count"]):
            x, y = struct.unpack_from("<ff", pts, i * stride)
            poly.append((a * x + c * y + tx, b * x + d * y + ty))
        s = dict(g)
        s["points"] = poly
        s["ink"] = ink
        s["transform"] = tf
        strokes.append(s)
    return strokes


def extract_polylines(sqlite_path):
    """list of polylines; each is a list of (x, y) canvas points."""
    return [s["points"] for s in extract_strokes(sqlite_path)]


if __name__ == "__main__":
    import sys
    from collections import Counter
    path = sys.argv[1] if len(sys.argv) > 1 else (
        "~/.claude/jobs/b33ffdaa/tmp/ink-work/"
        "other-10B6B7C4-813A-4939-8675-2F0A7B46DE5E.sqlite3")
    strokes = extract_strokes(path)
    xs = [x for s in strokes for x, y in s["points"]]
    ys = [y for s in strokes for x, y in s["points"]]
    print("strokes: %d   points: %d" % (len(strokes), len(xs)))
    print("x bounds: %.2f .. %.2f" % (min(xs), max(xs)))
    print("y bounds: %.2f .. %.2f" % (min(ys), max(ys)))
    print("inks:", Counter((s["ink"] or {}).get("type") for s in strokes))
    print("widths:", Counter((s["ink"] or {}).get("width") for s in strokes))
    print("colors:", Counter((s["ink"] or {}).get("color") for s in strokes))
    print("transforms:", Counter(s["transform"] for s in strokes))
