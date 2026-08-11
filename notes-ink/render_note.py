#!/usr/bin/env python3
"""Render an Apple Notes paper-bundle sqlite (macOS 26 enhanced-canvas ink)
to a single full-height VECTOR pdf.  Pure stdlib.

Usage:
  python3 render_note.py <bundle.sqlite3> <out.pdf> [W H [OX OY]]

W H  = canvas size in points (from NoteStore ZMETADATADATA
       paperContentBoundsWidth/Height); OX OY = canvas origin (default 0 0).
       If W H are omitted the page is sized to the ink extent + margin.

Pipeline: extract_strokes.py (same dir) yields document-ordered strokes with
final canvas coords (per-stroke affine already applied) plus ink color/width.
This file just writes them as stroked paths into a minimal one-page PDF:
mediaBox = canvas size, y flipped (canvas y grows down, PDF y grows up),
round caps + joins, per-stroke RGB + line width from the ink record.
"""
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_strokes import extract_strokes


def content_stream(strokes, height, ox, oy):
    """PDF content stream drawing every stroke as a polyline."""
    out = ["1 J 1 j"]                              # round cap, round join
    last_col = last_w = None
    for s in strokes:
        pts = s["points"]
        if not pts:
            continue
        ink = s["ink"] or {}
        r, g, b, a = ink.get("color", (0.0, 0.0, 0.0, 1.0))
        w = ink.get("width") or 1.5
        col = "%.3f %.3f %.3f RG" % (r, g, b)
        if col != last_col:
            out.append(col); last_col = col
        if w != last_w:
            out.append("%.2f w" % w); last_w = w
        cmds = []
        for i, (x, y) in enumerate(pts):
            cmds.append("%.2f %.2f %s" % (x - ox, height - (y - oy),
                                          "m" if i == 0 else "l"))
        if len(pts) == 1:                          # dot: zero-length segment
            cmds.append(cmds[0][:-1] + "l")        # round caps make it round
        cmds.append("S")
        out.append(" ".join(cmds))
    return "\n".join(out).encode("ascii")


def write_pdf(path, width, height, stream):
    """Minimal 1-page PDF: catalog, pages, page, Flate content stream."""
    z = zlib.compress(stream, 9)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] "
         "/Contents 4 0 R >>" % (width, height)).encode("ascii"),
        b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(z)
        + z + b"\nendstream",
    ]
    buf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, body in enumerate(objs, 1):
        offsets.append(len(buf))
        buf += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(buf)
    buf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offsets:
        buf += b"%010d 00000 n \n" % o
    buf += (b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (len(objs) + 1, xref))
    with open(path, "wb") as f:
        f.write(buf)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    sqlite_path, out_pdf = sys.argv[1], sys.argv[2]
    strokes = extract_strokes(sqlite_path)
    if not strokes:
        sys.exit("no strokes found in %s" % sqlite_path)
    npts = sum(len(s["points"]) for s in strokes)
    xs = [x for s in strokes for x, y in s["points"]]
    ys = [y for s in strokes for x, y in s["points"]]

    if len(sys.argv) >= 5:
        width, height = float(sys.argv[3]), float(sys.argv[4])
        ox = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
        oy = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0
    else:                                          # fall back to ink extent
        margin = 20.0
        ox, oy = min(xs) - margin, min(ys) - margin
        width, height = max(xs) - ox + margin, max(ys) - oy + margin

    write_pdf(out_pdf, width, height,
              content_stream(strokes, height, ox, oy))
    print("%s: %d strokes / %d points  ink x %.1f..%.1f y %.1f..%.1f"
          % (os.path.basename(sqlite_path), len(strokes), npts,
             min(xs), max(xs), min(ys), max(ys)))
    print("wrote %s  page %.0fx%.0f pt  %d bytes"
          % (out_pdf, width, height, os.path.getsize(out_pdf)))
    if height > 14400:
        print("note: page height > 14400 pt (Acrobat's classic limit); "
              "Preview/Quartz render it fine")


if __name__ == "__main__":
    main()
