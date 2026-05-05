# MTProto Moderator analytics (`analytics_events`)

Telemetry is written through `Analytics.trackEvent(...)` in `src/utils/analytics.ts` and persisted via store query `analytics.insert`.

Storage shape in JSON DB:

- `event`
- `props` (object)
- `createdAt` (ISO timestamp)

## Event catalog

### `moderation_decision`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Incoming non-secret message is evaluated for first-reply vs block
- **Props:** `senderId`, `chatId`, `action`, `confidence`, `experiment`, `variant`

### `user_ensure_rejected`

- **Source:** `src/middleware/handle-user-middleware.ts`
- **When:** Routed update has invalid Telegram user payload (`telegramId == 0`)
- **Props:** `status=invalid`, `reason=zero_telegram_id`, `chatId`

### `policy_sent`

- **Source:** `src/use-cases/handle-policy.ts`
- **When:** Policy command is processed (`/help`, `/terms`, `/commitment`)
- **Props:** `userId`, `command`, `sent`

### `policy_requested`

- **Source:** `src/use-cases/handle-policy.ts`
- **When:** Policy command is received before file delivery
- **Props:** `userId`, `command`

### `onboarding_start`

- **Source:** `src/use-cases/onboarding.ts`
- **When:** `/start` onboarding flow is entered
- **Props:** `userId`

### `onboarding_text`

- **Source:** `src/use-cases/onboarding.ts`
- **When:** Any onboarding text input is handled
- **Props:** `userId`, `textLength`

### `onboarding_completed`

- **Source:** `src/use-cases/onboarding.ts`
- **When:** Telegram auth succeeds and session is activated
- **Props:** `userId`

### `onboarding_failed`

- **Source:** `src/use-cases/onboarding.ts`
- **When:** Onboarding auth flow fails
- **Props:** `userId`, `error`

### `first_message_reply_sent`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** First non-secret incoming message is replied to
- **Props:** `senderId`, `chatId`, `experiment`, `variant`

### `sender_block_queued`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Follow-up sender is queued for block execution
- **Props:** `senderId`, `chatId`, `experiment`, `variant`

### `block_notice_sent`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Client block notification is attempted
- **Props:** `senderId`, `sessionId`, `sentViaBot`, `experiment`, `variant`

## Experiments

`experiment` and `variant` are stamped by `ExperimentService` (`src/services/experiment-service.ts`). Manifests live alongside the templates they control, e.g. `assets/messages/message-warning/manifest.json`. Assignment is a deterministic hash of `(experimentId, senderId)`, so warning-side and block-side events for the same sender always carry the same variant tag without persisting an exposures table.

Conversion query for the warning experiment:

```sql
SELECT
  props_json->>'variant' AS variant,
  COUNT(*) FILTER (WHERE event = 'first_message_reply_sent') AS warned,
  COUNT(*) FILTER (WHERE event = 'sender_block_queued')      AS blocked
FROM analytics_events
WHERE props_json->>'experiment' = 'warning_copy_2026_05'
GROUP BY 1
ORDER BY 1;
```

## Notes

- Analytics writes are deferred with `setImmediate` so request/update handlers are not blocked.
- There is no separate in-memory analytics queue; each event schedules one asynchronous store write.
