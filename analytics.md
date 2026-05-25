# MTProto Moderator analytics (`analytics_events`)

Telemetry is written through `Analytics.trackEvent(...)` in `src/utils/analytics.ts` and persisted via store query `analytics.insert`.

Storage shape in JSON DB:

- `event`
- `props` (object)
- `createdAt` (ISO timestamp)

## Event catalog

### `moderation_duplicate_inbound_skipped`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** The same Telegram `(chat_id, message_id)` was already processed (typically MTProto + Bot API/automation duplicate delivery).
- **Props:** `senderId`, `chatId`, `messageId`, `source` (`mtproto` | `bot_api_automation` | `unknown`)

### `moderation_decision`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Incoming non-secret message is evaluated for the 3-step flow (level-1 warning → level-2 final warning → block), or skipped for a chat-scoped prior block
- **Props:** `senderId`, `chatId`, `action`, `confidence`, optional `reason`, optional `experiment`, optional `variant`, `tier` (`first_warning` | `second_warning` | `block` | `skipped_prior_block`)

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

### `moderation_skipped_prior_block`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** A prior `block` decision already exists for the same `(senderId, chatId)` pair, so no additional warning/block action is sent
- **Props:** `senderId`, `chatId`

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

Skip visibility (shows chat-scoped ignore rows that still log a moderation decision):

```sql
SELECT
  created_at,
  sender_id,
  chat_id,
  decision_json
FROM action_logs
WHERE decision_json->>'action' = 'ignore'
  AND decision_json->>'reason' = 'prior_block_in_chat_skip'
ORDER BY created_at DESC
LIMIT 200;
```

## Chat automation (Bot API) vs MTProto

- **Ingest:** `src/routes/bot.ts` runs `ChatAutomationController` first. Updates that carry `business_message` or `message.business_connection_id` are treated as inbound mail for a connected account ([Bot API BusinessConnection](https://core.telegram.org/bots/api#getbusinessconnection) / Telegram’s profile automation rollout).
- **Act:** Responses and blocks still run through **`TelegramClient`** (MTProto session) for that account, so onboarding / `sessions` must be active (`src/controllers/chat-automation-controller.ts`). The management bot token is reused today; split tokens later if Telegram requires a dedicated automation bot.
- **Dedupe:** in-process `InboundMessageDedupe` keeps recent `(chat_id, message_id)` keys (TTL ~30m, bounded size) so the same message is not moderated twice across MTProto + Bot API in one Node process (`src/services/inbound-message-dedupe.ts`). Not shared across multiple app instances.

## Notes

- Analytics writes are deferred with `setImmediate` so request/update handlers are not blocked.
- There is no separate in-memory analytics queue; each event schedules one asynchronous store write.
