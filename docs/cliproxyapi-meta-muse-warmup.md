# Future CLIProxyAPI fork: Meta Muse window warm-up

Status: parked design only. No implementation is intended on this branch.

This document belongs in a future `elmakus/CLIProxyAPI` fork. It is stored here only because that fork does not exist yet. When the fork is created, move this design there and implement it against a freshly verified upstream revision.

## Verified baseline

Research was verified against:

- `router-for-me/CLIProxyAPI` main `b773607e3e7756dc6020a291825e4eb08899595a`
- historical PR #3216, which implemented a generic session prewarmer but was closed without merge
- current Meta OAuth path: device OAuth -> DCA token -> minted API key
- current Meta quota handling: HTTP 429 may expose `error.resets_at`, and CLIProxyAPI already converts that into credential cooldown state
- Codex-LB's reset-aware limit warm-up design as the architectural reference

## Goal

For Meta Muse OAuth credentials only, send one minimal real inference request after a subscription quota window becomes available again, so an otherwise idle account can pre-start the next rolling usage window.

This is quota-window warm-up. It is not OAuth-token refresh and must not be implemented by calling only `Refresh()`.

## Minimal v1 design

Keep the change Meta-specific and opt-in.

1. Observe a Meta subscription quota response with HTTP 429 and a valid future `error.resets_at`.
2. Persist a pending warm-up record keyed by at least:
   - auth ID
   - observed `reset_at`
   - state/status
   - attempt timestamps
3. Schedule one attempt for `reset_at + grace`.
4. Resolve the exact Meta OAuth credential by auth ID. Do not route the warm-up through normal round-robin selection.
5. Send one minimal, valid Responses inference request through the existing Meta executor.
6. Mark success only after a valid terminal response is received.
7. Deduplicate the same `(auth_id, reset_at)` across scheduler ticks and process restarts.
8. If the warm-up still receives subscription 429:
   - consume a newer `error.resets_at` when supplied;
   - otherwise retry with bounded backoff;
   - never busy-loop.
9. Transient transport failures may retry with bounded backoff. Permanent auth failures stop and require normal auth recovery.
10. Disabled credentials are never eligible.

## State shape

A minimal state machine is enough:

`idle -> quota_blocked(reset_at) -> due -> warming -> succeeded`

Failure paths:

- `warming -> quota_blocked(new_reset_at)`
- `warming -> retry_wait` for bounded transient retry
- `warming -> terminal_failed` for permanent auth/configuration failures

The scheduler must record successful completion after the request succeeds, not before it begins.

## Request shape

Use the existing Meta Responses executor and the smallest request Meta accepts reliably:

- one short text input
- no tools
- no storage
- streaming only if the existing executor requires it
- very small output budget, but never assume `1` is valid without a live test

The warm-up request must remain attributable in logs/metrics, for example with a dedicated source/request-kind marker.

## Persistence and concurrency

Borrow the good properties from Codex-LB:

- durable deduplication per account/window/reset
- atomic claim before sending
- bounded concurrency
- process restart must not fire the same window twice
- no package-global mutable pointer exposed unsafely to HTTP handlers

If manual management endpoints are added later, background work must be detached from the request context and controlled by the service lifecycle context.

## Deliberately out of scope for v1

Do not revive all of PR #3216.

Excluded initially:

- provider-generic prewarming interface
- arbitrary wall-clock cron schedules
- generic OAuth session-expiry refresh
- management UI
- multi-provider orchestration
- proactive traffic before a real Meta quota reset is observed

These can be reconsidered only after the Meta-specific behavior is proven.

## Proof required before implementation

Before writing the fork feature, verify on a real Muse OAuth account:

1. reach subscription quota and capture `error.resets_at`;
2. wait until just after that timestamp;
3. send one minimal request manually;
4. verify from subsequent quota data/errors that the next rolling window is actually anchored by that request.

Do not encode the assumption that the first post-reset request starts a new five-hour window until this is demonstrated.

## Acceptance tests

Implementation should include at least:

- parses a future Meta `resets_at` into a pending warm-up
- ignores non-subscription 429s and malformed/missing reset timestamps
- one reset creates one durable attempt
- restart does not duplicate a completed attempt
- disabled auth is skipped
- exact auth ID is used, not normal provider selection
- successful inference marks success
- subscription 429 with newer reset reschedules correctly
- transient failure retries within bounds
- permanent auth failure becomes terminal
- concurrent scheduler ticks cannot double-send
