export interface ProgressSample {
  profile: string;
  label: string;
  observedAt: string;
  valueA: number | null;
  valueB: number | null;
  status: string;
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
  return `BEGIN;
    SELECT pg_advisory_xact_lock(hashtext(${profile}));
    INSERT INTO metric_progress_samples(profile_id,profile_label,observed_at,value_a,value_b,source_status)
    VALUES(${profile},${literal(sample.label)},${time}::timestamptz,${valueA},${valueB},${literal(sample.status)})
    ON CONFLICT(profile_id,observed_at) DO NOTHING;
    WITH previous AS (SELECT
      (SELECT value_a FROM metric_progress_samples WHERE profile_id=${profile} AND observed_at<${time}::timestamptz AND value_a IS NOT NULL ORDER BY observed_at DESC LIMIT 1) AS valueA,
      (SELECT value_b FROM metric_progress_samples WHERE profile_id=${profile} AND observed_at<${time}::timestamptz AND value_b IS NOT NULL ORDER BY observed_at DESC LIMIT 1) AS valueB),
    events AS (
      SELECT 'value_a_increased' AS kind,valueA,valueB FROM previous WHERE ${valueA}>valueA
      UNION ALL SELECT 'value_b_increased',valueA,valueB FROM previous WHERE ${valueB}>valueB
      UNION ALL SELECT 'activated',valueA,valueB FROM previous WHERE valueB=0 AND ${valueB}>0)
    INSERT INTO metric_progress_events(profile_id,observed_at,event_type,previous_value_a,value_a,previous_value_b,value_b)
    SELECT ${profile},${time}::timestamptz,kind,valueA,${valueA},valueB,${valueB} FROM events
    ON CONFLICT(profile_id,observed_at,event_type) DO NOTHING;
    COMMIT;`;
}
