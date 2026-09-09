# Session resend observability

Dashboard panels for the FIX session layer should group by `job_type`,
`conversation_kind`, and bounded `reason` labels. Never include envelope bodies,
signatures, tokens, or private keys.

## Panels

| Panel | Metric | Purpose |
|---|---|---|
| Resend requests | `sigil_resend_request_total` | Accepted recovery demand |
| Fulfillment rate | `sigil_resend_fulfilled_total` | Completed recovery work |
| Recovery latency | `sigil_resend_latency_seconds` | Age from enqueue to fulfillment |
| Sequence resets | `sigil_sequence_reset_total` | Permanently expired ranges |
| Queue depth | `sigil_relay_jobs_depth` | Pending and processing pressure |
| Oldest job | `sigil_relay_jobs_oldest_age_seconds` | Stalled-work alarm input |

## Alerts

- Alert when `sigil_relay_jobs_oldest_age_seconds{job_type="resend"}` exceeds
  300 seconds for 10 minutes.
- Alert when the five-minute rate of `sigil_sequence_reset_total` exceeds the
  deployment baseline by 3x.
- Alert when resend requests rise while fulfillment remains zero for 10
  minutes.
