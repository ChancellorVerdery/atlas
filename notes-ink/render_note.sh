#!/bin/sh
# Render an Apple Notes paper-bundle sqlite to one full-height vector PDF.
#   render_note.sh <bundle.sqlite3> <out.pdf> [WIDTH HEIGHT [ORIGINX ORIGINY]]
# WIDTH/HEIGHT/ORIGIN = canvas bounds from NoteStore ZMETADATADATA
# (paperContentBounds*); omit them to size the page to the ink extent.
exec python3 "$(dirname "$0")/render_note.py" "$@"
