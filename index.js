'use strict';

/**
 * Condor Betting Bot
 * Connects to all 15 lobbies (5 bet sizes × 3 multipliers) and places bets
 * with human-like random timing and selection.
 */

const WebSocket = require('ws');
const fetch = require('node-fetch');

// ─── Config ───────────────────────────────────────────────────────────────────

const WS_URL       = process.env.WS_URL       || 'wss://candor-server-production-b41b.up.railway.app';
const API_BASE     = process.env.API_BASE      || 'https://ggcoin.tech/api2/condor_profile.php';
const BOT_SECRET   = process.env.BOT_SECRET    || '';   // must match CONDOR_BOT_SECRET in config_candor.php
const BOT_ID       = parseInt(process.env.BOT_ID || '1', 10);
const BOT_TELEGRAM_ID = String(10000000000 + BOT_ID);

// Lobbies: all combinations of bet sizes × multipliers
const BET_SIZES   = [5, 10, 25, 50, 100];
const MULTIPLIERS = [2, 3, 6];

// Human-like behaviour knobs
const BET_PROBABILITY   = 0.70;   // 70 % chance to bet in any given round
const MIN_HEX_COUNT     = 1;
const MAX_HEX_COUNT     = 3;
const MIN_BET_DELAY_MS  = 5_000;  // earliest the bot places its bet after round starts
const MAX_BET_DELAY_MS  = 45_000; // latest (must be well before round end ~60 s)
const TOTAL_HEX_COUNT   = 18;     // hex grid size in each lobby

// Reconnect timing
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 120_000;

if (!BOT_SECRET) {
  console.error('[bot] BOT_SECRET env var is required. Exiting.');
  process.exit(1);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randDelay(minMs, maxMs) {
  return new Promise(r => setTimeout(r, randInt(minMs, maxMs)));
}

function pickHexes(count, takenSet) {
  const available = [];
  for (let i = 1; i <= TOTAL_HEX_COUNT; i++) {
    if (!takenSet.has(i)) available.push(i);
  }
  // Shuffle and take first `count`
  for (let i = available.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [available[i], available[j]] = [available[j], available[i]];
  }
  return available.slice(0, Math.min(count, available.length));
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiPost(action, body) {
  const url = `${API_BASE}?action=${action}`;
  const payload = {
    ...body,
    telegram_id: BOT_TELEGRAM_ID,
    bot_id: String(BOT_ID),
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': BOT_SECRET,
      },
      body: JSON.stringify(payload),
      timeout: 15_000,
    });
    return await res.json();
  } catch (err) {
    console.error(`[api] ${action} error:`, err.message);
    return { success: false, error: err.message };
  }
}

async function lockBet({ roundId, lobbyKey, betSize, multiplier, hexNums, roundHash, roundSig }) {
  return apiPost('lock_bet', {
    round_id:   roundId,
    lobby_key:  lobbyKey,
    bet_size:   betSize,
    multiplier: multiplier,
    hex_nums:   hexNums,
    round_hash: roundHash,
    round_sig:  roundSig,
  });
}

async function claimResult({ roundId, seed, winningNumbers }) {
  return apiPost('claim_result', {
    round_id:        roundId,
    seed:            seed,
    winning_numbers: winningNumbers,
  });
}

// ─── LobbyBot ─────────────────────────────────────────────────────────────────

class LobbyBot {
  constructor(betSize, multiplier) {
    this.betSize    = betSize;
    this.multiplier = multiplier;
    this.lobbyKey   = `${betSize}x${multiplier}`;
    this.tag        = `[${this.lobbyKey}]`;

    // Round state
    this.roundId   = null;
    this.roundHash = null;
    this.roundSig  = null;
    this.takenHexes = new Set();

    // Flags
    this.betScheduled  = false;
    this.betPlaced     = false;
    this.betTimer      = null;
    this.myHexes       = [];
    this.myRoundId     = null;

    // WS
    this.ws            = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.destroyed     = false;

    this._connect();
  }

  _connect() {
    if (this.destroyed) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      console.log(`${this.tag} connected`);
      this.reconnectDelay = RECONNECT_BASE_MS;
      this._joinLobby();
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this._handleMsg(msg);
    });

    ws.on('close', (code, reason) => {
      console.warn(`${this.tag} disconnected (${code}), reconnecting in ${this.reconnectDelay}ms`);
      this._clearBetTimer();
      this._scheduleReconnect();
    });

    ws.on('error', err => {
      console.error(`${this.tag} ws error:`, err.message);
    });
  }

  _scheduleReconnect() {
    if (this.destroyed) return;
    setTimeout(() => this._connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _joinLobby() {
    this._send({
      type:       'join_lobby',
      betSize:    this.betSize,
      multiplier: this.multiplier,
      playerId:   BOT_TELEGRAM_ID,
    });
  }

  _handleMsg(msg) {
    if (msg.lobbyKey && msg.lobbyKey !== this.lobbyKey) return;

    switch (msg.type) {
      case 'lobby_state':
        this._onLobbyState(msg);
        break;
      case 'new_round':
        this._onNewRound(msg);
        break;
      case 'bet_placed':
        if (msg.hexNum != null) this.takenHexes.add(msg.hexNum);
        break;
      case 'round_result':
        this._onRoundResult(msg);
        break;
      case 'bet_rejected':
        console.warn(`${this.tag} bet rejected:`, msg.reason);
        break;
    }
  }

  _onLobbyState(msg) {
    const isNewRound = msg.roundId && msg.roundId !== this.roundId;
    this.roundId   = msg.roundId   || this.roundId;
    this.roundHash = msg.hash      || this.roundHash;
    this.roundSig  = msg.sig       || this.roundSig;

    this.takenHexes.clear();
    if (Array.isArray(msg.positions)) {
      msg.positions.forEach(p => { if (p.hexNum) this.takenHexes.add(p.hexNum); });
    }

    // If we joined mid-round and haven't bet yet, schedule a bet
    if (isNewRound || !this.betScheduled) {
      this._resetBetState();
      if (msg.timer != null && msg.timer > 10) {
        this._maybeScheduleBet(msg.timer);
      }
    }
  }

  _onNewRound(msg) {
    this.roundId   = msg.roundId || null;
    this.roundHash = msg.hash    || null;
    this.roundSig  = msg.sig     || null;
    this.takenHexes.clear();
    this._resetBetState();
    this._maybeScheduleBet(msg.timer || 60);
  }

  _onRoundResult(msg) {
    this._clearBetTimer();

    // Only claim if we bet in this round
    if (!this.betPlaced || this.myRoundId !== msg.roundId) return;

    const roundId        = msg.roundId;
    const seed           = msg.seed;
    const winningNumbers = msg.winningNumbers;

    if (!roundId || !seed || !Array.isArray(winningNumbers)) return;

    // Small random delay before claiming (human-like)
    setTimeout(async () => {
      const result = await claimResult({ roundId, seed, winningNumbers });
      if (result.success) {
        const won = result.won ? `WON +${result.payout}` : 'lost';
        console.log(`${this.tag} claim: ${won}, balance: ${result.hex_balance}`);
      } else {
        console.warn(`${this.tag} claim failed:`, result.error || result);
      }
    }, randInt(500, 3000));
  }

  _resetBetState() {
    this._clearBetTimer();
    this.betScheduled = false;
    this.betPlaced    = false;
    this.myHexes      = [];
    this.myRoundId    = null;
  }

  _clearBetTimer() {
    if (this.betTimer) {
      clearTimeout(this.betTimer);
      this.betTimer = null;
    }
  }

  _maybeScheduleBet(timerSeconds) {
    if (this.betScheduled) return;
    if (Math.random() > BET_PROBABILITY) {
      // Sitting this round out
      return;
    }

    this.betScheduled = true;

    // Pick a delay that fits within the remaining round time (leave 10s buffer)
    const maxDelay = Math.min(MAX_BET_DELAY_MS, Math.max(0, (timerSeconds - 10) * 1000));
    if (maxDelay < MIN_BET_DELAY_MS) {
      // Not enough time left, skip
      this.betScheduled = false;
      return;
    }

    const delay = randInt(MIN_BET_DELAY_MS, maxDelay);
    console.log(`${this.tag} round ${this.roundId}: will bet in ${(delay / 1000).toFixed(1)}s`);

    this.betTimer = setTimeout(() => this._placeBet(), delay);
  }

  async _placeBet() {
    if (!this.roundId || !this.roundHash || !this.roundSig) {
      console.warn(`${this.tag} no round data, skipping`);
      return;
    }
    if (this.betPlaced) return;

    const count   = randInt(MIN_HEX_COUNT, MAX_HEX_COUNT);
    const hexNums = pickHexes(count, this.takenHexes);
    if (hexNums.length === 0) {
      console.warn(`${this.tag} no free hexes available`);
      return;
    }

    const roundId    = this.roundId;
    const roundHash  = this.roundHash;
    const roundSig   = this.roundSig;
    const lobbyKey   = this.lobbyKey;
    const betSize    = this.betSize;
    const multiplier = this.multiplier;

    const lockRes = await lockBet({ roundId, lobbyKey, betSize, multiplier, hexNums, roundHash, roundSig });

    if (!lockRes.success) {
      console.warn(`${this.tag} lock_bet failed:`, lockRes.error || lockRes);
      return;
    }

    const tickets = lockRes.bet_tickets || {};
    let sentCount = 0;

    for (const hexNum of hexNums) {
      const ticket = tickets[String(hexNum)];
      if (!ticket) {
        console.warn(`${this.tag} no ticket for hex ${hexNum}`);
        continue;
      }
      this._send({ type: 'place_bet', lobbyKey, hexNum, ticket });
      this.takenHexes.add(hexNum);
      sentCount++;
      // Tiny stagger between multiple bets (more human-like)
      if (hexNums.length > 1) await new Promise(r => setTimeout(r, randInt(200, 800)));
    }

    if (sentCount > 0) {
      this.betPlaced  = true;
      this.myHexes    = hexNums;
      this.myRoundId  = roundId;
      console.log(`${this.tag} placed ${sentCount} bet(s) on hex(es) [${hexNums.join(',')}], balance ~${lockRes.hex_balance}`);
    }
  }

  destroy() {
    this.destroyed = true;
    this._clearBetTimer();
    if (this.ws) this.ws.terminate();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`[bot] Starting Condor bot (telegram_id=${BOT_TELEGRAM_ID})`);
console.log(`[bot] WS: ${WS_URL}`);
console.log(`[bot] API: ${API_BASE}`);
console.log(`[bot] Lobbies: ${BET_SIZES.length} bet sizes × ${MULTIPLIERS.length} multipliers = ${BET_SIZES.length * MULTIPLIERS.length} connections`);

const bots = [];
for (const betSize of BET_SIZES) {
  for (const multiplier of MULTIPLIERS) {
    // Stagger connections slightly so we don't hammer the server at startup
    setTimeout(() => {
      bots.push(new LobbyBot(betSize, multiplier));
    }, randInt(0, 3000));
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[bot] SIGTERM received, shutting down');
  bots.forEach(b => b.destroy());
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[bot] SIGINT received, shutting down');
  bots.forEach(b => b.destroy());
  process.exit(0);
});
