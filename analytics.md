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
- **Props:** `senderId`, `chatId`, `action`, `confidence`

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
- **Props:** `senderId`, `chatId`

### `sender_block_queued`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Follow-up sender is queued for block execution
- **Props:** `senderId`, `chatId`

### `block_notice_sent`

- **Source:** `src/use-cases/process-incoming-message.ts`
- **When:** Client block notification is attempted
- **Props:** `senderId`, `sessionId`, `sentViaBot`

## Notes

- Analytics writes are deferred with `setImmediate` so request/update handlers are not blocked.
- There is no separate in-memory analytics queue; each event schedules one asynchronous store write.
