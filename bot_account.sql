-- Insert bot player account into condor_players.
-- BOT_ID=1 → telegram_id = 10000000000 + 1 = 10000000001
-- Run this once on your production database before starting the bot.

INSERT INTO condor_players (
    telegram_id,
    telegram_nick,
    display_name,
    hex_balance
)
VALUES (
    10000000001,
    '@condor_bot',
    'CondorBot',
    10000000
)
ON DUPLICATE KEY UPDATE
    hex_balance  = VALUES(hex_balance),
    display_name = VALUES(display_name);
