export interface ProgressSample {
  profile: string;
  label: string;
  observedAt: string;
  totalXp: number | null;
  dayStreak: number | null;
  status: string;
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const integer = (value: number | null) => (value === null ? 'NULL' : String(value));

/** One atomic, idempotent transaction for sample and derived events. Previous
 * values are looked up per metric, so partial samples do not erase history. */
export function progressTransaction(sample: ProgressSample): string {
  if (!sample.profile || !Number.isFinite(Date.parse(sample.observedAt)))
    throw new Error('Invalid history identity or time');
  for (const value of [sample.totalXp, sample.dayStreak]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 2147483647))
      throw new Error('Invalid progress statistic');
  }
  if (sample.totalXp === null && sample.dayStreak === null)
    throw new Error('No validated progress statistics');
  const profile = literal(sample.profile),
    time = literal(sample.observedAt),
    xp = integer(sample.totalXp),
    streak = integer(sample.dayStreak);
  return `BEGIN;
    SELECT pg_advisory_xact_lock(hashtext(${profile}));
    INSERT INTO duolingo_progress_samples(profile_id,profile_label,observed_at,total_xp,day_streak,source_status)
    VALUES(${profile},${literal(sample.label)},${time}::timestamptz,${xp},${streak},${literal(sample.status)})
    ON CONFLICT(profile_id,observed_at) DO NOTHING;
    WITH previous AS (SELECT
      (SELECT total_xp FROM duolingo_progress_samples WHERE profile_id=${profile} AND observed_at<${time}::timestamptz AND total_xp IS NOT NULL ORDER BY observed_at DESC LIMIT 1) AS xp,
      (SELECT day_streak FROM duolingo_progress_samples WHERE profile_id=${profile} AND observed_at<${time}::timestamptz AND day_streak IS NOT NULL ORDER BY observed_at DESC LIMIT 1) AS streak),
    events AS (
      SELECT 'xp_increased' AS kind,xp,streak FROM previous WHERE ${xp}>xp
      UNION ALL SELECT 'day_streak_increased',xp,streak FROM previous WHERE ${streak}>streak
      UNION ALL SELECT 'streak_activated',xp,streak FROM previous WHERE streak=0 AND ${streak}>0)
    INSERT INTO duolingo_progress_events(profile_id,observed_at,event_type,previous_total_xp,total_xp,previous_day_streak,day_streak)
    SELECT ${profile},${time}::timestamptz,kind,xp,${xp},streak,${streak} FROM events
    ON CONFLICT(profile_id,observed_at,event_type) DO NOTHING;
    COMMIT;`;
}
