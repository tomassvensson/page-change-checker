import { execFileSync } from 'node:child_process';

import { expect, it } from 'vitest';

import { progressTransaction, progressSchemaMigration } from '../../src/monitor/history.js';

/** Opt-in native PostgreSQL fault injection. Only session-local TEMP tables and
 * pg_temp functions are created; permanent monitoring history is untouched. */
it.skipIf(!process.env.PCC_TEST_PSQL)(
  'rolls back a sample when event storage fails and recovers idempotently',
  () => {
    const baseline = {
      profile: 'synthetic-example',
      label: 'Example',
      observedAt: '2026-10-01T10:00:00Z',
      totalXp: 100,
      dayStreak: 0,
      status: 'unchanged'
    };
    const changed = { ...baseline, observedAt: '2026-10-01T11:00:00Z', totalXp: 110, dayStreak: 1 };
    const activity = {
      ...changed,
      observedAt: '2026-10-01T12:00:00Z',
      activeToday: true,
      activityDay: '2026-10-01',
      activityTimeZone: 'Europe/Berlin',
      intervalStartAt: changed.observedAt
    };
    const sql = `CREATE TEMP TABLE duolingo_progress_samples(profile_id text,profile_label text,observed_at timestamptz,total_xp int,day_streak int,source_status text,UNIQUE(profile_id,observed_at));
    CREATE TEMP TABLE duolingo_progress_events(profile_id text,observed_at timestamptz,event_type text,previous_total_xp int,total_xp int,previous_day_streak int,day_streak int,UNIQUE(profile_id,observed_at,event_type));
    ${progressSchemaMigration}
    ${progressTransaction(baseline)}
    CREATE FUNCTION pg_temp.reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event storage failure'; END $$;
    CREATE TRIGGER reject_event BEFORE INSERT ON duolingo_progress_events FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_event();
    ${progressTransaction(changed)}
    SELECT 'rollback:' || count(*) FROM duolingo_progress_samples;
    DROP TRIGGER reject_event ON duolingo_progress_events;
    ${progressTransaction(changed)}
    ${progressTransaction(changed)}
    SELECT 'samples:' || count(*) FROM duolingo_progress_samples;
    SELECT 'events:' || count(*) FROM duolingo_progress_events;
    ${progressTransaction(activity)}
    ${progressTransaction(activity)}
    SELECT 'daily-activity:' || count(*) FROM duolingo_progress_events WHERE event_type='daily_activity_activated';
    SELECT 'interval:' || count(*) FROM duolingo_progress_events WHERE interval_start_at='2026-10-01T11:00:00Z'::timestamptz;
    SELECT 'timezone:' || count(*) FROM duolingo_progress_events WHERE event_type='daily_activity_activated' AND activity_time_zone='Europe/Berlin';`;
    const output = execFileSync(
      process.env.PCC_TEST_PSQL!,
      [
        '--no-psqlrc',
        '--no-password',
        '-h',
        'localhost',
        '-p',
        process.env.PCC_TEST_PGPORT ?? '5432',
        '-U',
        process.env.PCC_TEST_PGUSER ?? 'postgres',
        '-d',
        process.env.PCC_TEST_PGDATABASE ?? 'postgres',
        '-v',
        'ON_ERROR_STOP=0',
        '-At',
        '-f',
        '-'
      ],
      {
        encoding: 'utf8',
        input: sql,
        timeout: 20000,
        windowsHide: true,
        env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    expect(output).toContain('rollback:1');
    expect(output).toContain('samples:2');
    expect(output).toContain('events:3');
    expect(output).toContain('daily-activity:1');
    expect(output).toContain('interval:1');
    expect(output).toContain('timezone:1');
  },
  30000
);
