# Paytm card/UPI terminal: Stage 1 (practice terminal only)

**Status:** Stage 1 of the Paytm T9 wireless-ECR integration. There is **no real Paytm client** in this folder. Everything
runs against `MockPaytmClient`, an in-memory pretend terminal. Nothing here can reach the network, and no credential,
address or checksum algorithm exists in the code (`tests/paytmNoNetwork.test.ts` fails if one is added by accident).

## Rules this code follows

- **Off by default.** `PAYTM_ENABLED=false`. With it off no terminal option is shown and none of this code runs.
- **Practice only.** `PAYTM_ENABLED=true` needs `PAYTM_MODE=mock`, and mock mode refuses to start when `NODE_ENV=production`.
  `PAYTM_MODE=live` refuses to start: the real client is separate work that needs its own approval.
- **A bill is paid only by a verified Status Enquiry** (`resultStatus` S / `0000`, with our transaction id, merchant id,
  terminal id and the exact amount all matching). "Accepted" (`0009`) and "pending" never pay. Anything that does not
  match becomes `UNKNOWN` and is flagged for review. See `stateMachine.ts` (pure, unit-tested).
- **Sale is never retried.** No answer means "unknown", not "failed". Only status checks are repeated.
- **Exactly once**, from layers that each hold on their own: the unique payment request id, one open attempt per bill,
  one open attempt per terminal (a partial unique index), and conditional updates when settling.
- **Refunds stay off.** The existing refund route still refuses terminal payments. Only a same-day *void* exists, and only
  against the practice terminal.

## Files

| File | What it does |
|---|---|
| `types.ts` | `PaytmClient`, request/response shapes, `ChecksumSigner` (interface only) |
| `codes.ts` | what each result code means (fail, ask status, keep waiting) |
| `stateMachine.ts` | `decideFromStatus`: the rules above, as a pure function |
| `mock.ts` | the practice terminal and its scripted scenarios |
| `service.ts` | start, status checks, settling, restart recovery, same-day void |
| `setup.ts` | startup rules (what is allowed to switch on) |

Database: migration `0014` adds `paytm_attempts` and `paytm_events` (new tables only; nothing existing is changed).

## Trying it on a development computer

In `server/.env`: `PAYTM_ENABLED=true`, `PAYTM_MODE=mock`, optionally `PAYTM_MOCK_SCENARIO=SUCCESS`. The checkout screens
then show a **Paytm** tab with a "Practice mode" banner. The Superadmin gets a picker for what the pretend terminal does next.

## Switching it off / rolling back

Set `PAYTM_ENABLED=false` (or remove it) and restart: the feature disappears and the tables are simply never used. To
remove the code, revert the Stage 1 commit. Migration `0014` is additive; if it was applied and the tables were never used,
`DROP TABLE paytm_events; DROP TABLE paytm_attempts;` removes them.
