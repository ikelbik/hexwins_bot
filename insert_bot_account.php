<?php
/**
 * Вставляет/обновляет аккаунт бота в condor_players.
 * Запускать один раз: php insert_bot_account.php
 */

define('CONDOR_CONFIG_PATH', dirname(__DIR__, 4) . '/config_candor.php');
require_once CONDOR_CONFIG_PATH;

$pdo = new PDO(
    'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
    DB_USER,
    DB_PASS,
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

$stmt = $pdo->prepare("
    INSERT INTO condor_players (telegram_id, telegram_nick, display_name, hex_balance)
    VALUES (:tid, :nick, :name, :bal)
    ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        hex_balance  = VALUES(hex_balance)
");

$stmt->execute([
    ':tid'  => 10000000001,
    ':nick' => '@condor_bot',
    ':name' => 'CondorBot',
    ':bal'  => 10000000,
]);

echo "Done. Rows affected: " . $stmt->rowCount() . PHP_EOL;
