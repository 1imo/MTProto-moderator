-- Moderation reset for specific Telegram users

DO $body$
DECLARE
  sender_ids TEXT[] := ARRAY[
    '8392122581',
    '6412617720'
  ];
BEGIN
  DELETE FROM messages WHERE sender_id = ANY(sender_ids);
  DELETE FROM action_logs WHERE sender_id = ANY(sender_ids);
END
$body$;
