export interface ProgressSample {
  profile: string;
  label: string;
  observedAt: string;
  valueA: number | null;
  valueB: number | null;
  status: string;
  activeToday?: boolean | null;
  activityDay?: string;
  activitySource?: string;
  activityTimeZone?: string;
  intervalStartAt?: string | null;
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const integer = (value: number | null) => (value === null ? 'NULL' : String(value));

/** One atomic, idempotent transaction for sample and derived events. Previous
 * values are looked up per metric, so partial samples do not erase history. */
export function progressTransaction(sample: ProgressSample): string {
  if (!sample.profile || !Number.isFinite(Date.parse(sample.observedAt)))
    throw new Error('Invalid history identity or time');
  for (const value of [sample.valueA, sample.valueB]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 2147483647))
      throw new Error('Invalid progress statistic');
  }
  if (sample.valueA === null && sample.valueB === null)
    throw new Error('No validated progress statistics');
  const profile = literal(sample.profile),
    time = literal(sample.observedAt),
    valueA = integer(sample.valueA),
    valueB = integer(sample.valueB);
  if (
    sample.activeToday !== undefined &&
    sample.activeToday !== null &&
    typeof sample.activeToday !== 'boolean'
  )
    throw new Error('Invalid daily activity indicator');
  if (sample.activityDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(sample.activityDay))
    throw new Error('Invalid activity day');
  if (sample.intervalStartAt && !Number.isFinite(Date.parse(sample.intervalStartAt)))
    throw new Error('Invalid detection interval');
  const timeZone = sample.activityTimeZone ?? 'Europe/Berlin';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
  } catch {
    throw new Error('Invalid activity time zone');
  }
  const activity =
    sample.activeToday === null || sample.activeToday === undefined
      ? 'NULL'
      : sample.activeToday
        ? 'TRUE'
        : 'FALSE';
  const day = sample.activityDay
    ? literal(sample.activityDay)
    : `(${time}::timestamptz AT TIME ZONE ${literal(timeZone)})::date`;
  return `BEGIN;
    SELECT pg_advisory_xact_lock(hashtext(${profile}));
    INSERT INTO metric_progress_samples(profile_id,profile_label,observed_at,value_a,value_b,source_status,active_today,activity_day,activity_source,interval_start_at,activity_time_zone)
    VALUES(${profile},${literal(sample.label)},${time}::timestamptz,${valueA},${valueB},${literal(sample.status)},${activity},${day}::date,${literal(sample.activitySource ?? 'unavailable')},${sample.intervalStartAt ? literal(sample.intervalStartAt) + '::timestamptz' : 'NULL'},${literal(timeZone)})
    ON CONFLICT(profile_id,observed_at) DO NOTHING;
    WITH previous AS (SELECT
      (SELECT value_a FROM metric_progress_samples WHERE profile_id=${profile} AND observed_at<${time}::timestamptz AND value_a IS NOT NULL ORDER BY observed_at DESC LIMIT 1) AS valueA,
      (SELECT value_b FROM metric_progress_samples WHERE profile_id=${profile} AND observed_at<${time}::timestamptz AND value_b IS NOT NULL ORDER BY observed_at DESC LIMIT 1) AS valueB,
      (SELECT active_today FROM metric_progress_samples WHERE profile_id=${profile} AND observed_at<${time}::timestamptz AND activity_day=${day}::date AND active_today IS NOT NULL ORDER BY observed_at DESC LIMIT 1) AS active),
    events AS (
      SELECT 'value_a_increased' AS kind,valueA,valueB FROM previous WHERE ${valueA}>valueA
      UNION ALL SELECT 'value_b_increased',valueA,valueB FROM previous WHERE ${valueB}>valueB
      UNION ALL SELECT 'activated',valueA,valueB FROM previous WHERE valueB=0 AND ${valueB}>0
      UNION ALL SELECT 'daily_activity_activated',valueA,valueB FROM previous WHERE ${activity}=TRUE AND active IS DISTINCT FROM TRUE)
    INSERT INTO metric_progress_events(profile_id,observed_at,event_type,previous_value_a,value_a,previous_value_b,value_b,interval_start_at,active_today,activity_day,activity_time_zone)
    SELECT ${profile},${time}::timestamptz,kind,valueA,${valueA},valueB,${valueB},${sample.intervalStartAt ? literal(sample.intervalStartAt) + '::timestamptz' : 'NULL'},${activity},${day}::date,${literal(timeZone)} FROM events
    ON CONFLICT(profile_id,observed_at,event_type) DO NOTHING;
    COMMIT;`;
}

export const progressSchemaMigration = `ALTER TABLE metric_progress_samples ADD COLUMN IF NOT EXISTS active_today boolean;
ALTER TABLE metric_progress_samples ADD COLUMN IF NOT EXISTS activity_day date;
ALTER TABLE metric_progress_samples ADD COLUMN IF NOT EXISTS activity_source text;
ALTER TABLE metric_progress_samples ADD COLUMN IF NOT EXISTS interval_start_at timestamptz;
ALTER TABLE metric_progress_samples ADD COLUMN IF NOT EXISTS activity_time_zone text;
ALTER TABLE metric_progress_events ADD COLUMN IF NOT EXISTS active_today boolean;
ALTER TABLE metric_progress_events ADD COLUMN IF NOT EXISTS activity_day date;
ALTER TABLE metric_progress_events ADD COLUMN IF NOT EXISTS interval_start_at timestamptz;
ALTER TABLE metric_progress_events ADD COLUMN IF NOT EXISTS activity_time_zone text;
ALTER TABLE metric_progress_events DROP CONSTRAINT IF EXISTS metric_progress_events_event_type_check;
ALTER TABLE metric_progress_events ADD CONSTRAINT metric_progress_events_event_type_check CHECK(event_type IN ('value_a_increased','value_b_increased','activated','daily_activity_activated'));`;

/** Do not derive today's practice state from the number of metric values. */
export function parseActivityIndicator(
  value: string | null,
  active: string[],
  inactive: string[]
): boolean | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (active.some((v) => v.toLowerCase() === normalized)) return true;
  if (inactive.some((v) => v.toLowerCase() === normalized)) return false;
  return null;
}
