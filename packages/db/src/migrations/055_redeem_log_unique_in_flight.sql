UPDATE redeem_log
   SET status = 'failed_orphaned',
       error_msg = COALESCE(error_msg, 'superseded_by_newer_active_attempt_before_unique_index')
 WHERE status IN ('attempting', 'submitted', 'pending')
   AND EXISTS (
     SELECT 1
       FROM redeem_log newer
      WHERE newer.condition_id = redeem_log.condition_id
        AND (
          newer.attempt_ts > redeem_log.attempt_ts
          OR (newer.attempt_ts = redeem_log.attempt_ts AND newer.id > redeem_log.id)
        )
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_redeem_log_unique_in_flight
  ON redeem_log(condition_id)
  WHERE status IN ('attempting', 'submitted', 'pending');
