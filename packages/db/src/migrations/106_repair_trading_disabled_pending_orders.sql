-- A resolved CLOB 503 `trading is disabled` response was previously classified as an
-- ambiguous submit, leaving exact prepared-order hashes pending even though the exchange
-- definitively rejected them. Repair only rows with the matching durable submit evidence.
WITH valid_evidence AS MATERIALIZED (
  SELECT
    id,
    payload,
    CASE
      WHEN json_valid(payload)
        THEN json_extract(payload, '$.errorDetails.responseBody')
      ELSE NULL
    END AS response_body
  FROM risk_events
  WHERE event_type = 'live_order_submit_unknown'
    AND json_valid(payload)
),
candidates AS MATERIALIZED (
  SELECT
    o.order_id,
    (
      SELECT evidence.response_body
      FROM valid_evidence AS evidence
      WHERE json_extract(evidence.payload, '$.orderId') = o.order_id
        AND json_extract(evidence.payload, '$.clientOrderId') = o.client_order_id
        AND json_type(evidence.payload, '$.errorDetails.responseBody') = 'object'
        AND json_type(evidence.payload, '$.errorDetails.responseBody.status') = 'integer'
        AND json_extract(evidence.payload, '$.errorDetails.responseBody.status') = 503
        AND (
          (
            json_type(evidence.payload, '$.errorDetails.responseBody.error') = 'text'
            AND lower(trim(json_extract(
              evidence.payload, '$.errorDetails.responseBody.error'
            ))) = 'trading is disabled'
          )
          OR (
            json_type(evidence.payload, '$.errorDetails.responseBody.message') = 'text'
            AND lower(trim(json_extract(
              evidence.payload, '$.errorDetails.responseBody.message'
            ))) = 'trading is disabled'
          )
        )
      ORDER BY evidence.id DESC
      LIMIT 1
    ) AS response_body
  FROM orders AS o
  WHERE o.status = 'pending'
    AND o.order_id = o.exchange_order_id
    AND o.exchange_order_id IS NOT NULL
    AND o.exchange_order_id <> ''
    AND NOT EXISTS (SELECT 1 FROM fills AS f WHERE f.order_id = o.order_id)
)
UPDATE orders
SET status = 'rejected',
    fill_progress_shares = 0,
    exchange_error_code = 'UNKNOWN',
    exchange_error_message = 'trading is disabled',
    exchange_error_payload = json_object(
      'responseBody',
      json((SELECT response_body FROM candidates WHERE candidates.order_id = orders.order_id))
    ),
    exchange_rejection_reason = 'rejection_unknown',
    metadata_json = CASE
      WHEN json_valid(metadata_json)
        THEN json_remove(
          metadata_json,
          '$.makerCaptureLineageV1',
          '$.bounceAskCaptureLineageV1'
        )
      ELSE metadata_json
    END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE order_id IN (
  SELECT order_id FROM candidates WHERE response_body IS NOT NULL
);
