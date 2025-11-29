// server.js
// Run: node server.js
// Simple authoritative server with simulated 200ms latency for both inbound and outbound messages.

const WebSocket = require('ws');
const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`Server starting on ws://localhost:${PORT}`);

let nextPlayerId = 1;
let players = {}; // id -> {id, x, y, score, input}
let coins = {};   // coinId -> {id, x, y}
let nextCoinId = 1;

const MAP_W = 800, MAP_H = 600;
const PLAYER_SPEED = 150; // pixels per second
const PLAYER_R = 16;
const COIN_R = 10;
const MAX_COINS = 20;

const PHYS_DT = 0.05; // 50ms physics tick
const COIN_SPAWN_INTERVAL = 3000; // ms

// Latency simulation: buffer inbound messages for 200ms before processing
const SIM_LATENCY_MS = 200;

let inboundQueue = []; // {processAt, ws, raw}
function queueInbound(ws, raw) {
  inboundQueue.push({ processAt: Date.now() + SIM_LATENCY_MS, ws, raw });
}

// Outbound: wraps ws.send with latency
function sendWithLatency(ws, msg) {
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }, SIM_LATENCY_MS);
}

function broadcastState() {
  const snapshot = {
    type: "snapshot",
    t: Date.now(),
    players: Object.values(players).map(p => ({ id: p.id, x: p.x, y: p.y, score: p.score })),
    coins: Object.values(coins).map(c => ({ id: c.id, x: c.x, y: c.y }))
  };
  const s = JSON.stringify(snapshot);
  wss.clients.forEach(ws => sendWithLatency(ws, s));
}

// create a random coin
function spawnCoin() {
  const id = nextCoinId++;
  coins[id] = { id, x: Math.random() * (MAP_W - 40) + 20, y: Math.random() * (MAP_H - 40) + 20 };
}

// process inbound queue
function processInboundQueue() {
  const now = Date.now();
  for (let i = 0; i < inboundQueue.length; ) {
    if (inboundQueue[i].processAt <= now) {
      const { ws, raw } = inboundQueue[i];
      try {
        const msg = JSON.parse(raw);
        handleMsg(ws, msg);
      } catch (e) {
        // ignore malformed
      }
      inboundQueue.splice(i, 1);
    } else i++;
  }
}

// handle messages (after simulated latency)
function handleMsg(ws, msg) {
  if (!ws.playerId) return;
  const player = players[ws.playerId];
  if (!player) return;

  if (msg.type === "input") {
    // validate and store input intent
    // Inputs: {up,down,left,right,stamp}
    player.input = {
      up: !!msg.up,
      down: !!msg.down,
      left: !!msg.left,
      right: !!msg.right,
      stamp: msg.stamp || Date.now()
    };
  }
}

wss.on('connection', (ws) => {
  const id = nextPlayerId++;
  ws.playerId = id;
  players[id] = {
    id,
    x: Math.random() * (MAP_W - 100) + 50,
    y: Math.random() * (MAP_H - 100) + 50,
    score: 0,
    input: { up: false, down: false, left: false, right: false }
  };

  // send welcome + full state (with latency)
  const welcome = { type: 'welcome', id, map: {w: MAP_W, h: MAP_H}, t: Date.now() };
  sendWithLatency(ws, JSON.stringify(welcome));
  broadcastState();

  ws.on('message', raw => queueInbound(ws, raw));

  ws.on('close', () => {
    delete players[ws.playerId];
    broadcastState();
  });
});

// physics & game loop
let lastSpawn = Date.now();
setInterval(() => {
  processInboundQueue();

  const dt = PHYS_DT; // fixed dt
  // update players according to stored input
  Object.values(players).forEach(p => {
    const inp = p.input || {};
    let vx = 0, vy = 0;
    if (inp.left) vx -= 1;
    if (inp.right) vx += 1;
    if (inp.up) vy -= 1;
    if (inp.down) vy += 1;
    // normalize
    if (vx !== 0 || vy !== 0) {
      const len = Math.sqrt(vx*vx + vy*vy);
      vx /= len; vy /= len;
      let speedFactor = p.inputSpeedLoss || 1;
      p.x += vx * PLAYER_SPEED * dt * speedFactor;
      p.y += vy * PLAYER_SPEED * dt * speedFactor;
      p.inputSpeedLoss = 1; // reset
    }
    // clamp
    p.x = Math.max(PLAYER_R, Math.min(MAP_W-PLAYER_R, p.x));
    p.y = Math.max(PLAYER_R, Math.min(MAP_H-PLAYER_R, p.y));
  });

  // --- collisions: player -> player ---
  const playerArr = Object.values(players);
  for (let i = 0; i < playerArr.length; i++) {
    for (let j = i+1; j < playerArr.length; j++) {
      const p1 = playerArr[i];
      const p2 = playerArr[j];

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const minDist = 2 * PLAYER_R;

      if (dist < minDist && dist > 0) {
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;

        // score-based dominance ratio
        const totalScore = p1.score + p2.score + 1; // avoid div0
        const ratio = p2.score / totalScore;

        // apply momentum transfer
        p1.x -= nx * overlap * (1 - ratio);
        p1.y -= ny * overlap * (1 - ratio);
        p2.x += nx * overlap * ratio;
        p2.y += ny * overlap * ratio;

        // reduce speed slightly to simulate energy loss
        p1.inputSpeedLoss = 0.8;
        p2.inputSpeedLoss = 0.8;
      }
    }
  }

  // collisions: player -> coins
  for (const pid in players) {
    const p = players[pid];
    for (const cid in coins) {
      const c = coins[cid];
      const dx = p.x - c.x, dy = p.y - c.y;
      if (dx*dx + dy*dy <= (PLAYER_R + COIN_R)*(PLAYER_R + COIN_R)) {
        // award
        p.score += 1;
        delete coins[cid];
      }
    }
  }

  // spawn coin occasionally
  if (Date.now() - lastSpawn > COIN_SPAWN_INTERVAL) {
    if (Object.keys(coins).length < MAX_COINS) {
      spawnCoin();
      }
    lastSpawn = Date.now();
  }

  // broadcast authoritative state to clients
  broadcastState();

}, PHYS_DT * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down');
  process.exit();
});
