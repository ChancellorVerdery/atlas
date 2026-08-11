#!/bin/bash
# notes2pdf.sh — export an Apple Notes note (handwriting included) to PDF.
#
#   ./notes2pdf.sh "the electric field"            → ./the electric field.pdf
#   ./notes2pdf.sh "the electric field" ch23.pdf   → ./ch23.pdf
#
# Drives Notes' own File > Export as > PDF, so ink renders exactly as Apple
# draws it. Needs: screen unlocked, and Accessibility granted to the terminal.
#
# IMPORTANT for handwritten ("paper") notes: Notes syncs ink lazily — a note
# never opened on this Mac only has low-res preview tiles locally, and the
# export truncates to that. Scroll through the whole note in Notes once on
# this Mac first, then export.
# ponytail: the save panel is driven by typing the filename + Return into the
# focused name field and letting it save to the panel's default folder, then
# the file is located and moved — the panel's AX tree is out-of-process and
# unscriptable, and the cmd+shift+G go-to sheet doesn't open reliably.
set -euo pipefail

TITLE="${1:?usage: notes2pdf.sh \"<note title>\" [out.pdf]}"
OUT="${2:-$TITLE.pdf}"
[[ "$OUT" = /* ]] || OUT="$PWD/$OUT"
STAMP="n2p$$" # unique save name so the file is findable wherever the panel saves

# AppleScript string literals: escape backslash and double quote.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

osascript <<EOF
tell application "Notes"
  activate
  show (first note whose name is "$(esc "$TITLE")")
end tell
delay 1.5
tell application "System Events"
  tell process "Notes"
    set frontmost to true
    click menu bar item "File" of menu bar 1
    delay 0.4
    -- macOS 26 nests it: File > Export as > PDF (older: File > Export as PDF…)
    if exists menu item "Export as" of menu "File" of menu bar 1 then
      click menu item "Export as" of menu "File" of menu bar 1
      delay 0.4
      click menu item "PDF" of menu "Export as" of menu item "Export as" of menu "File" of menu bar 1
    else
      click (first menu item of menu "File" of menu bar 1 whose name begins with "Export as PDF")
    end if
    -- The save panel appears as a sheet OR an out-of-process panel window;
    -- Notes' own window list can be momentarily EMPTY during the transition,
    -- so every probe is wrapped (AppleScript's "and" does not short-circuit).
    set panelReady to false
    repeat with i from 1 to 30
      delay 0.3
      try
        if (count of sheets of window 1) > 0 then
          set panelReady to true
          exit repeat
        end if
      end try
      try
        if (count of windows of process "com.apple.appkit.xpc.openAndSavePanelService") > 0 then
          set panelReady to true
          exit repeat
        end if
      end try
    end repeat
  end tell
  -- CRITICAL: only type when the save panel is confirmed open. Otherwise the
  -- keystrokes leak into whatever app has focus (e.g. typing the temp filename
  -- into the user's active window). No panel → bail loudly, type nothing.
  if not panelReady then error "save panel never opened (Notes not frontmost, note not found, or screen unavailable)"
  -- Name field has focus; replace the default name and save to default folder.
  keystroke "a" using command down
  delay 0.2
  keystroke "$STAMP"
  delay 0.4
  key code 36
end tell
EOF

# Locate wherever the panel saved it and move it into place.
FOUND=""
for _ in $(seq 1 40); do
  FOUND=$(find "$HOME/Downloads" "$HOME/Desktop" "$HOME/Documents" -maxdepth 2 -name "$STAMP.pdf" -mmin -2 2>/dev/null | head -1)
  [ -n "$FOUND" ] && sleep 1 && break
  sleep 0.5
done
[ -n "$FOUND" ] || { echo "export failed — no PDF appeared (is the screen unlocked?)" >&2; exit 1; }
mv "$FOUND" "$OUT"
echo "exported: $OUT"
