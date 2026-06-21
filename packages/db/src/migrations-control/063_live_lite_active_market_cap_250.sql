-- Phase-1 active market cap lift.
-- Production live-lite carries an explicit profile_settings.envelope_json
-- override, so code fallback defaults alone do not change the effective cap.
-- Preserve operator edits: only lift live-lite rows still on the previous
-- 100-market cap.

UPDATE profile_settings
   SET envelope_json = json_set(
         COALESCE(
           CASE
             WHEN envelope_json IS NOT NULL AND json_valid(envelope_json) = 1
             THEN envelope_json
             ELSE '{}'
           END,
           '{}'
         ),
         '$.maxActiveMarkets',
         250
       ),
       updated_at = datetime('now')
 WHERE profile_id = 'live-lite'
   AND COALESCE(
         CASE
           WHEN envelope_json IS NOT NULL AND json_valid(envelope_json) = 1
           THEN json_extract(envelope_json, '$.maxActiveMarkets')
           ELSE NULL
         END,
         100
       ) = 100;
