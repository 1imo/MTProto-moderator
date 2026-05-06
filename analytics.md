# MTProto Moderator analytics (`analytics_events`)

Telemetry is written through `Analytics.trackEvent(...)` in `src/utils/analytics.ts` and persisted via store query `analytics.insert`.

Storage shape in JSON DB:

- `event`
- `props` (object)
- `createdAt` (ISO timestamp)

## Event catalog

### `moderation_decision`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Incoming non-secret message is evaluated for the 3-step flow (level-1 warning → level-2 final warning → block)
- **Props:** `senderId`, `chatId`, `action`, `confidence`, `experiment`, `variant`, `tier` (`first_warning` | `second_warning` | `block`)

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
- **When:** First non-secret incoming message is replied to (`message-warning` copy)
- **Props:** `senderId`, `chatId`, `experiment`, `variant`, `hasMedia`

### `second_message_warning_sent`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Second non-secret incoming message is replied to (`message-warning-final` copy)
- **Props:** `senderId`, `chatId`, `experiment`, `variant`, `hasMedia`

### `sender_block_queued`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Third or later non-secret message queues block execution (`messages-block` copy)
- **Props:** `senderId`, `chatId`, `experiment`, `variant`

### `block_notice_sent`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Client block notification is attempted
- **Props:** `senderId`, `sessionId`, `sentViaBot`, `experiment`, `variant`

## Experiments

`experiment` and `variant` are stamped by `ExperimentService` (`src/services/experiment-service.ts`). Active manifests:

- **`level1_message_warning`** — `assets/messages/message-warning/manifest.json` (first reply)
- **`level2_message_warning_final`** — `assets/messages/message-warning-final/manifest.json` (second reply)
- **`level3_messages_block`** — `assets/messages/messages-block/manifest.json` (block DM)

For moderation steps, tiers use **`assignModerationTier`**, which hashes `moderation_flow_2026_05:${senderId}` and takes `digest % totalWeight` for each manifest. Tier 2 and tier 3 both use total weight 2, so the **same variant id** is chosen for the final warning and the block message for a given sender. Tier 1 uses total weight 4 (four first-warning variants).

Volume by tier (each step records its own `experiment` id):

```sql
SELECT
  event,
  props_json->>'experiment' AS experiment,
  props_json->>'variant'   AS variant,
  COUNT(*) AS n
FROM analytics_events
WHERE event IN (
  'first_message_reply_sent',
  'second_message_warning_sent',
  'sender_block_queued'
)
GROUP BY 1, 2, 3
ORDER BY 2, 3, 1;
```

## Notes

- Analytics writes are deferred with `setImmediate` so request/update handlers are not blocked.
- There is no separate in-memory analytics queue; each event schedules one asynchronous store write.
