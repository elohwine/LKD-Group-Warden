# TODO: Site Rule Alignment and Carcheck Reliability

## Confirmed schema from live Firestore `sites` docs
- Default consideration field: `anprRules.considerationMinutes`
- Contraventions list: `contraventions[]`
- Common consideration rule entry shape:
  - `type: "Rule"`
  - `name: "Consideration Time (6 Minutes)"`
  - `value: 6`
- Additional rule container seen: `rules` (object)

## Completed in this change
- Stepper defaults now prioritize site consideration period (`anprRules.considerationMinutes`) unless user manually changes contravention.
- Observation minute fallbacks changed from hardcoded `10` to resolved rule value (or `0` if none configured).
- Carcheck lookup now tries both:
  - `/api/carcheck`
  - `/kiosk/carcheck`

## Follow-up verification tasks
- Verify one site with `anprRules.considerationMinutes = 6`:
  - Open stepper and confirm default contravention timer is `6 min`.
- Verify manual override:
  - Change contravention in dropdown and confirm timer updates to selected rule's duration.
- Verify non-time-based contravention:
  - Ensure timer is `0` and no forced 10-minute consideration is applied.
- Verify carcheck in deployed environment:
  - Ensure one of `/api/carcheck` or `/kiosk/carcheck` returns data with active auth token.

## If any mismatch remains
- Add a lightweight debug panel in detail view to display:
  - selected site id
  - selected contravention code
  - resolved observation minutes
  - source used (`anprRules.considerationMinutes`, rule value, parsed label, none)
