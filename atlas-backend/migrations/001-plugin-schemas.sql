-- Atlas migration 001 — one Postgres schema per plugin.
--
-- Before: every table sat in `public` with a name-prefix convention
--         (gym_workouts, finance_networth_history, users, page_boards).
-- After:  each plugin owns a schema and the redundant prefix is dropped
--         (gym.workouts, finance.networth_history, auth.users, profile.page_boards).
--
-- Why: the prefix was only a convention, and it was ambiguous — the component
-- name itself contains underscores, so nothing could tell finance_networth_history
-- apart as finance + networth_history rather than finance_networth + history.
-- A schema makes the boundary structural, and DROP SCHEMA <plugin> CASCADE
-- becomes a clean per-plugin uninstall.
--
-- SET SCHEMA / RENAME move the table by identity: indexes, constraints and
-- foreign keys follow automatically and no data is rewritten. Foreign keys
-- track the table OID, not its name, so nothing needs rebuilding.
--
-- Safe to re-run: every statement is IF EXISTS, so an already-migrated database
-- is a no-op. Transactional — DDL is transactional in Postgres, so a failure
-- part-way rolls the whole thing back and leaves the old layout intact.
--
-- ORDER MATTERS. Stop the backend, migrate, then start the new code:
--
--   docker compose down
--   pg_dump ... > backup.sql                 # cheap, and this is real data
--   psql -v ON_ERROR_STOP=1 -f 001-plugin-schemas.sql <database>
--   docker compose up -d --build
--
-- Starting the new code FIRST would have each service run CREATE TABLE IF NOT
-- EXISTS against its new schema and get fresh, empty tables — the app would
-- look wiped while the real rows sat untouched in public. This migration then
-- refuses to run (the RENAME collides with the empty table) and rolls back, so
-- nothing is destroyed, but the fix is still: stop, drop the empty schemas,
-- migrate, restart.
--
-- To reverse: run the two statements per table backwards
--   ALTER TABLE gym.settings RENAME TO gym_settings;
--   ALTER TABLE gym.gym_settings SET SCHEMA public;
-- and check out the previous commit of atlas-backend.

BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS calendar;
CREATE SCHEMA IF NOT EXISTS canvas;
CREATE SCHEMA IF NOT EXISTS course;
CREATE SCHEMA IF NOT EXISTS email;
CREATE SCHEMA IF NOT EXISTS finance;
CREATE SCHEMA IF NOT EXISTS google;
CREATE SCHEMA IF NOT EXISTS graph;
CREATE SCHEMA IF NOT EXISTS gym;
CREATE SCHEMA IF NOT EXISTS ladder;
CREATE SCHEMA IF NOT EXISTS profile;
CREATE SCHEMA IF NOT EXISTS sleep;
CREATE SCHEMA IF NOT EXISTS work;

ALTER TABLE IF EXISTS public.sessions SET SCHEMA auth;
ALTER TABLE IF EXISTS public.users SET SCHEMA auth;
ALTER TABLE IF EXISTS public.calendar_hidden_cals SET SCHEMA calendar;
ALTER TABLE IF EXISTS calendar.calendar_hidden_cals RENAME TO hidden_cals;
ALTER TABLE IF EXISTS public.calendar_prefs SET SCHEMA calendar;
ALTER TABLE IF EXISTS calendar.calendar_prefs RENAME TO prefs;
ALTER TABLE IF EXISTS public.canvas_course_prefs SET SCHEMA canvas;
ALTER TABLE IF EXISTS canvas.canvas_course_prefs RENAME TO course_prefs;
ALTER TABLE IF EXISTS public.canvas_dismissed SET SCHEMA canvas;
ALTER TABLE IF EXISTS canvas.canvas_dismissed RENAME TO dismissed;
ALTER TABLE IF EXISTS public.canvas_semester_classes SET SCHEMA canvas;
ALTER TABLE IF EXISTS canvas.canvas_semester_classes RENAME TO semester_classes;
ALTER TABLE IF EXISTS public.canvas_semesters SET SCHEMA canvas;
ALTER TABLE IF EXISTS canvas.canvas_semesters RENAME TO semesters;
ALTER TABLE IF EXISTS public.canvas_settings SET SCHEMA canvas;
ALTER TABLE IF EXISTS canvas.canvas_settings RENAME TO settings;
ALTER TABLE IF EXISTS public.course_courses SET SCHEMA course;
ALTER TABLE IF EXISTS course.course_courses RENAME TO courses;
ALTER TABLE IF EXISTS public.course_settings SET SCHEMA course;
ALTER TABLE IF EXISTS course.course_settings RENAME TO settings;
ALTER TABLE IF EXISTS public.course_terms SET SCHEMA course;
ALTER TABLE IF EXISTS course.course_terms RENAME TO terms;
ALTER TABLE IF EXISTS public.email_pins SET SCHEMA email;
ALTER TABLE IF EXISTS email.email_pins RENAME TO pins;
ALTER TABLE IF EXISTS public.email_prefs SET SCHEMA email;
ALTER TABLE IF EXISTS email.email_prefs RENAME TO prefs;
ALTER TABLE IF EXISTS public.finance_accounts SET SCHEMA finance;
ALTER TABLE IF EXISTS finance.finance_accounts RENAME TO accounts;
ALTER TABLE IF EXISTS public.finance_budgets SET SCHEMA finance;
ALTER TABLE IF EXISTS finance.finance_budgets RENAME TO budgets;
ALTER TABLE IF EXISTS public.finance_custom_categories SET SCHEMA finance;
ALTER TABLE IF EXISTS finance.finance_custom_categories RENAME TO custom_categories;
ALTER TABLE IF EXISTS public.finance_items SET SCHEMA finance;
ALTER TABLE IF EXISTS finance.finance_items RENAME TO items;
ALTER TABLE IF EXISTS public.finance_networth_history SET SCHEMA finance;
ALTER TABLE IF EXISTS finance.finance_networth_history RENAME TO networth_history;
ALTER TABLE IF EXISTS public.finance_overrides SET SCHEMA finance;
ALTER TABLE IF EXISTS finance.finance_overrides RENAME TO overrides;
ALTER TABLE IF EXISTS public.finance_settings SET SCHEMA finance;
ALTER TABLE IF EXISTS finance.finance_settings RENAME TO settings;
ALTER TABLE IF EXISTS public.finance_transactions SET SCHEMA finance;
ALTER TABLE IF EXISTS finance.finance_transactions RENAME TO transactions;
ALTER TABLE IF EXISTS public.finance_widget_prefs SET SCHEMA finance;
ALTER TABLE IF EXISTS finance.finance_widget_prefs RENAME TO widget_prefs;
ALTER TABLE IF EXISTS public.google_tokens SET SCHEMA google;
ALTER TABLE IF EXISTS google.google_tokens RENAME TO tokens;
ALTER TABLE IF EXISTS public.graph_settings SET SCHEMA graph;
ALTER TABLE IF EXISTS graph.graph_settings RENAME TO settings;
ALTER TABLE IF EXISTS public.gym_completions SET SCHEMA gym;
ALTER TABLE IF EXISTS gym.gym_completions RENAME TO completions;
ALTER TABLE IF EXISTS public.gym_exercises SET SCHEMA gym;
ALTER TABLE IF EXISTS gym.gym_exercises RENAME TO exercises;
ALTER TABLE IF EXISTS public.gym_hours SET SCHEMA gym;
ALTER TABLE IF EXISTS gym.gym_hours RENAME TO hours;
ALTER TABLE IF EXISTS public.gym_logs SET SCHEMA gym;
ALTER TABLE IF EXISTS gym.gym_logs RENAME TO logs;
ALTER TABLE IF EXISTS public.gym_plan_cycle SET SCHEMA gym;
ALTER TABLE IF EXISTS gym.gym_plan_cycle RENAME TO plan_cycle;
ALTER TABLE IF EXISTS public.gym_plan_weekly SET SCHEMA gym;
ALTER TABLE IF EXISTS gym.gym_plan_weekly RENAME TO plan_weekly;
ALTER TABLE IF EXISTS public.gym_settings SET SCHEMA gym;
ALTER TABLE IF EXISTS gym.gym_settings RENAME TO settings;
ALTER TABLE IF EXISTS public.gym_workouts SET SCHEMA gym;
ALTER TABLE IF EXISTS gym.gym_workouts RENAME TO workouts;
ALTER TABLE IF EXISTS public.ladder_aliases SET SCHEMA ladder;
ALTER TABLE IF EXISTS ladder.ladder_aliases RENAME TO aliases;
ALTER TABLE IF EXISTS public.ladder_drive_cache SET SCHEMA ladder;
ALTER TABLE IF EXISTS ladder.ladder_drive_cache RENAME TO drive_cache;
ALTER TABLE IF EXISTS public.ladder_flex SET SCHEMA ladder;
ALTER TABLE IF EXISTS ladder.ladder_flex RENAME TO flex;
ALTER TABLE IF EXISTS public.ladder_geo_cache SET SCHEMA ladder;
ALTER TABLE IF EXISTS ladder.ladder_geo_cache RENAME TO geo_cache;
ALTER TABLE IF EXISTS public.ladder_meals SET SCHEMA ladder;
ALTER TABLE IF EXISTS ladder.ladder_meals RENAME TO meals;
ALTER TABLE IF EXISTS public.ladder_pushed_events SET SCHEMA ladder;
ALTER TABLE IF EXISTS ladder.ladder_pushed_events RENAME TO pushed_events;
ALTER TABLE IF EXISTS public.ladder_settings SET SCHEMA ladder;
ALTER TABLE IF EXISTS ladder.ladder_settings RENAME TO settings;
ALTER TABLE IF EXISTS public.page_boards SET SCHEMA profile;
ALTER TABLE IF EXISTS public.user_flags SET SCHEMA profile;
ALTER TABLE IF EXISTS public.sleep_logs SET SCHEMA sleep;
ALTER TABLE IF EXISTS sleep.sleep_logs RENAME TO logs;
ALTER TABLE IF EXISTS public.sleep_settings SET SCHEMA sleep;
ALTER TABLE IF EXISTS sleep.sleep_settings RENAME TO settings;
ALTER TABLE IF EXISTS public.work_settings SET SCHEMA work;
ALTER TABLE IF EXISTS work.work_settings RENAME TO settings;
ALTER TABLE IF EXISTS public.work_shifts SET SCHEMA work;
ALTER TABLE IF EXISTS work.work_shifts RENAME TO shifts;
ALTER TABLE IF EXISTS public.work_upcoming SET SCHEMA work;
ALTER TABLE IF EXISTS work.work_upcoming RENAME TO upcoming;
ALTER TABLE IF EXISTS public.work_widget_ranges SET SCHEMA work;
ALTER TABLE IF EXISTS work.work_widget_ranges RENAME TO widget_ranges;

COMMIT;

-- Verify (expect zero rows: nothing plugin-owned left in public):
--   SELECT tablename FROM pg_tables WHERE schemaname = 'public';
-- And the new layout:
--   SELECT schemaname, tablename FROM pg_tables
--    WHERE schemaname IN ('auth', 'calendar', 'canvas', 'course', 'email', 'finance', 'google', 'graph', 'gym', 'ladder', 'profile', 'sleep', 'work') ORDER BY 1, 2;
