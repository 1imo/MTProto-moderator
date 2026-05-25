-- Moderation reset for specific Telegram users

DO $body$
DECLARE
  sender_ids TEXT[] := ARRAY[
    '8939428561'
  ];
BEGIN
  DELETE FROM messages WHERE sender_id = ANY(sender_ids);
  DELETE FROM action_logs WHERE sender_id = ANY(sender_ids);
END
$body$;
