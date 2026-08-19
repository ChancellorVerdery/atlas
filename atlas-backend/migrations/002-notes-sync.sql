-- Synced notes folder: the server becomes a full peer alongside each device.
--
-- Run as the OWNER role (atlas_user), not as atlas_api — uiapi's role is
-- deliberately least-privilege and cannot create schemas. The GRANTs at the
-- bottom are what let it read and write these two tables and nothing else.
--
--   psql -d atlas -f migrations/002-notes-sync.sql
--
-- Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS notes_sync;

-- One row per path per user, INCLUDING deleted ones: a delete is a tombstone
-- that keeps its content, which is what makes the 30-day archive possible and
-- what tells a device that has been offline "this was removed" rather than
-- "this never existed" (an absent row is indistinguishable from a file the
-- device has never seen, and would be re-uploaded on the next pass).
CREATE TABLE IF NOT EXISTS notes_sync.files (
  user_id    uuid   NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  path       text   NOT NULL,           -- relative, '/'-separated, no leading slash
  content    text   NOT NULL DEFAULT '',
  sha256     text   NOT NULL,
  size       bigint NOT NULL,
  mtime      bigint NOT NULL,           -- ms since epoch, from the writing device
  rev        bigint NOT NULL,           -- per-user monotonic; every change bumps it
  deleted_at timestamptz,               -- NULL = live, set = archived
  PRIMARY KEY (user_id, path)
);

-- Delta pulls are "everything with rev > my cursor", so this index is the
-- difference between a scan per sync pass and an index seek.
CREATE INDEX IF NOT EXISTS files_user_rev ON notes_sync.files (user_id, rev);
CREATE INDEX IF NOT EXISTS files_user_deleted ON notes_sync.files (user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

-- The per-user revision counter. Bumping it is an UPDATE ... RETURNING inside
-- the same transaction as the row it stamps, so the row lock serializes two
-- devices writing at once and no two changes can ever share a rev.
CREATE TABLE IF NOT EXISTS notes_sync.cursor (
  user_id uuid   PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  rev     bigint NOT NULL DEFAULT 0
);

GRANT USAGE ON SCHEMA notes_sync TO atlas_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON notes_sync.files  TO atlas_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON notes_sync.cursor TO atlas_api;
