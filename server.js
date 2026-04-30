// server.js
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");
const { initDb } = require("./db");
const { samplePrivateP, makeRingAdjacency } = require("./experiment");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ---------- fixed protocol params ----------
const N = process.env.N ? Number(process.env.N) : 8;                 // group size
const ROUNDS = process.env.ROUNDS ? Number(process.env.ROUNDS) : 10;
const ROUND_MS = process.env.ROUND_MS ? Number(process.env.ROUND_MS) : 25000;
const REWARD = process.env.REWARD ? Number(process.env.REWARD) : 100;

// ---------- condition grid + quota ----------
function parseNumberList(envVal, defaultList) {
  if (!envVal) return defaultList;
  return envVal
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((x) => Number.isFinite(x));
}

// Paper defaults: cost={1,5}, kappa={0.2,0.4}, sigma={1.0}.
// These defaults reproduce the condition grid used for the frozen paper run.
const COST_LEVELS = parseNumberList(process.env.COST_LEVELS, [1, 5]);
const KAPPA_LEVELS = parseNumberList(process.env.KAPPA_LEVELS, [0.2, 0.4]);
const SIGMA_LEVELS = parseNumberList(process.env.SIGMA_LEVELS, [1.0]);

const GROUPS_PER_CELL = process.env.GROUPS_PER_CELL ? Number(process.env.GROUPS_PER_CELL) : 40;

if (!Number.isFinite(N) || N <= 1) throw new Error("N must be > 1");
if (!Number.isFinite(ROUNDS) || ROUNDS <= 0) throw new Error("ROUNDS must be > 0");
if (!Number.isFinite(ROUND_MS) || ROUND_MS <= 0) throw new Error("ROUND_MS must be > 0");
if (!Number.isFinite(REWARD)) throw new Error("REWARD must be a number");
if (!Number.isFinite(GROUPS_PER_CELL) || GROUPS_PER_CELL <= 0) throw new Error("GROUPS_PER_CELL must be > 0");
if (COST_LEVELS.length === 0 || KAPPA_LEVELS.length === 0 || SIGMA_LEVELS.length === 0) {
  throw new Error("COST_LEVELS / KAPPA_LEVELS / SIGMA_LEVELS must be non-empty lists");
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server);

const { db, stmts } = initDb(process.env.SQLITE_PATH || "data.sqlite");

// --------- condition cell bookkeeping ----------
function cellKey(cost, kappa, sigma) {
  // keep key stable (avoid float string noise by fixed decimals)
  const k = Number(kappa).toFixed(3);
  const s = Number(sigma).toFixed(3);
  return `${cost}|${k}|${s}`;
}

function buildCells() {
  const cells = [];
  for (const cost of COST_LEVELS) {
    for (const kappa of KAPPA_LEVELS) {
      for (const sigma of SIGMA_LEVELS) {
        cells.push({ cost, kappa, sigma, key: cellKey(cost, kappa, sigma) });
      }
    }
  }
  return cells;
}

const CELLS = buildCells();
const remaining = new Map(); // key -> remaining groups
for (const c of CELLS) remaining.set(c.key, GROUPS_PER_CELL);

// hidden_state quotas per cell: keep 0/1 balanced inside each condition cell
const stateRemaining = new Map(); // key -> {0: n0, 1: n1}
for (const c of CELLS) {
  const n0 = Math.floor(GROUPS_PER_CELL / 2);
  const n1 = GROUPS_PER_CELL - n0;
  stateRemaining.set(c.key, { 0: n0, 1: n1 });
}

// On restart, subtract already-created groups in DB so quotas stay consistent.
(function applyExistingCountsFromDb() {
  const rows = db.prepare(`
    SELECT condition_cost AS cost, kappa, sigma, hidden_state, COUNT(*) AS cnt
    FROM groups
    GROUP BY condition_cost, kappa, sigma, hidden_state
  `).all();

  // subtract total groups from remaining
  const cellTotals = new Map(); // key -> total groups
  for (const r of rows) {
    const key = cellKey(r.cost, r.kappa, r.sigma);
    if (!remaining.has(key)) continue;
    cellTotals.set(key, (cellTotals.get(key) || 0) + Number(r.cnt));
  }
  for (const [key, used] of cellTotals.entries()) {
    remaining.set(key, Math.max(0, remaining.get(key) - used));
  }

  // subtract hidden_state quotas
  for (const r of rows) {
    const key = cellKey(r.cost, r.kappa, r.sigma);
    if (!stateRemaining.has(key)) continue;
    const s = stateRemaining.get(key);
    const hs = Number(r.hidden_state);
    const used = Number(r.cnt);
    if (hs === 0 || hs === 1) {
      s[hs] = Math.max(0, s[hs] - used);
    }
  }
})();


function quotasStatus() {
  const out = [];
  for (const c of CELLS) {
    out.push({
      cost: c.cost,
      kappa: c.kappa,
      sigma: c.sigma,
      remaining: remaining.get(c.key) ?? 0,
      target: GROUPS_PER_CELL,
    });
  }
  return out;
}

function totalRemainingGroups() {
  let sum = 0;
  for (const v of remaining.values()) sum += v;
  return sum;
}

let rrIndex = 0;
function allocateCell() {
  // round-robin over cells with remaining > 0
  const n = CELLS.length;
  for (let i = 0; i < n; i++) {
    const idx = (rrIndex + i) % n;
    const c = CELLS[idx];
    const left = remaining.get(c.key) ?? 0;
    if (left > 0) {
      remaining.set(c.key, left - 1);
      rrIndex = (idx + 1) % n;
      return c;
    }
  }
  return null;
}

let enrollmentClosed = totalRemainingGroups() === 0;

// Admin status endpoint (local use)
app.get("/admin/status", (req, res) => {
  res.json({
    enrollmentClosed,
    totalRemaining: totalRemainingGroups(),
    grid: quotasStatus(),
  });
});

// --------- waiting pool + active groups ----------
let waiting = []; // sockets (not yet assigned to a group)

const groups = new Map();
/*
groupState = {
  groupId,
  hiddenState,
  cost, kappa, sigma,
  round,
  neighbors,
  participants: [{pid, socketId, index, score, msgCount, privateP, beliefP, dropped, finalGuess}],
  timer
}
*/

function now() {
  return Date.now();
}

function getParticipant(groupState, pid) {
  return groupState.participants.find((x) => x.pid === pid);
}

function closeEnrollmentAndFlushWaiting() {
  enrollmentClosed = true;
  for (const sock of waiting) {
    sock.emit("closed", { reason: "quota_reached" });
  }
  waiting = [];
}

function broadcastRoundState(groupState, eventType) {
  io.to(groupState.groupId).emit("round_event", {
    eventType,
    round: groupState.round,
    ts: now(),
  });
}

function startRound(groupState) {
  if (groupState.round >= ROUNDS) {
    endExperiment(groupState);
    return;
  }

  broadcastRoundState(groupState, "start");
  stmts.insertRoundEvent.run(groupState.groupId, groupState.round, "start", now());

  io.to(groupState.groupId).emit("round_start", {
    round: groupState.round,
    roundEndsAt: now() + ROUND_MS,
  });

  groupState.timer = setTimeout(() => {
    endRound(groupState);
  }, ROUND_MS);
}

function endRound(groupState) {
  broadcastRoundState(groupState, "end");
  stmts.insertRoundEvent.run(groupState.groupId, groupState.round, "end", now());

  io.to(groupState.groupId).emit("round_end", { round: groupState.round });

  groupState.round += 1;
  startRound(groupState);
}

function writeFinal(groupState, p) {
  const correct = p.finalGuess === groupState.hiddenState ? 1 : 0;
  const reward = correct ? REWARD : 0;
  const totalCost = p.msgCount * groupState.cost;
  const finalScore = reward - totalCost;

  p.score = finalScore;
  stmts.updateScore.run(finalScore, p.pid);

  stmts.insertFinal.run(
    groupState.groupId,
    p.pid,
    p.finalGuess,
    correct,
    reward,
    totalCost,
    finalScore,
    now()
  );
}

function finalizeIfMissing(groupState) {
  for (const p of groupState.participants) {
    if (p.finalGuess === null) {
      p.finalGuess = p.beliefP >= 0.5 ? 1 : 0;
      writeFinal(groupState, p);
    }
  }
}

function endExperiment(groupState) {
  io.to(groupState.groupId).emit("experiment_end", { message: "Submit final guess now." });

  // grace window to allow final submissions, then auto-fill missing and cleanup
  setTimeout(() => {
    finalizeIfMissing(groupState);
    groups.delete(groupState.groupId);

    // if no more quotas, and all active groups finished, close enrollment
    if (totalRemainingGroups() === 0) {
      enrollmentClosed = true;
    }
  }, 120000);
}

function allocateHiddenStateForCell(key) {
  const s = stateRemaining.get(key);
  if (!s) return Math.random() < 0.5 ? 0 : 1;

  const n0 = s[0] || 0;
  const n1 = s[1] || 0;

  let hs;
  if (n0 > 0 && n1 > 0) {
    hs = Math.random() < 0.5 ? 0 : 1;
  } else if (n0 > 0) {
    hs = 0;
  } else if (n1 > 0) {
    hs = 1;
  } else {
    hs = Math.random() < 0.5 ? 0 : 1; // fallback
  }

  s[hs] = Math.max(0, (s[hs] || 0) - 1);
  return hs;
}



function createGroup(sockets) {
  const cell = allocateCell();
  if (!cell) {
    // should not happen if we gate joins, but keep safe
    closeEnrollmentAndFlushWaiting();
    for (const sock of sockets) {
      sock.emit("closed", { reason: "quota_reached" });
    }
    return;
  }

  const groupId = nanoid(10);
  const hiddenState = allocateHiddenStateForCell(cell.key);
  const cost = cell.cost;
  const kappa = cell.kappa;
  const sigma = cell.sigma;

  const neighbors = makeRingAdjacency(N);

  stmts.insertGroup.run(groupId, now(), cost, kappa, sigma, hiddenState, ROUNDS);

  console.log("Created group", groupId, "cost", cost, "kappa", kappa, "sigma", sigma, "remaining_total", totalRemainingGroups());

  const participants = sockets.map((sock, idx) => {
    const pid = nanoid(12);
    const privateP = samplePrivateP(hiddenState, kappa, sigma);
    stmts.insertParticipant.run(pid, groupId, now(), privateP);
    return {
      pid,
      socketId: sock.id,
      index: idx,
      score: 0,
      msgCount: 0,
      privateP,
      beliefP: privateP,
      dropped: false,
      finalGuess: null,
    };
  });

  const groupState = {
    groupId,
    hiddenState,
    cost,
    kappa,
    sigma,
    round: 0,
    neighbors,
    participants,
    timer: null,
  };

  groups.set(groupId, groupState);

  sockets.forEach((sock, idx) => {
    const p = participants[idx];
    sock.data.groupId = groupId;
    sock.data.pid = p.pid;

    sock.join(groupId);

    sock.emit("init", {
      groupId,
      pid: p.pid,
      index: idx,
      n: N,
      rounds: ROUNDS,
      roundMs: ROUND_MS,
      cost,
      reward: REWARD,
      privateP: p.privateP,
      neighbors: neighbors[idx],
      // optional: expose condition for debugging/bots
      condition: { cost, kappa, sigma },
    });
  });

  // once quotas exhausted, stop taking new joins; let active groups finish.
  if (totalRemainingGroups() === 0 && waiting.length === 0) {
    enrollmentClosed = true;
  }

  startRound(groupState);

  // If quotas just hit zero, flush anyone still waiting (do not leave them hanging).
  if (totalRemainingGroups() === 0 && waiting.length > 0) {
    closeEnrollmentAndFlushWaiting();
  }
}

io.on("connection", (socket) => {
  socket.on("join", () => {
    if (socket.data.groupId) return;

    if (enrollmentClosed || totalRemainingGroups() === 0) {
      enrollmentClosed = true;
      socket.emit("closed", { reason: "quota_reached" });
      return;
    }

    waiting.push(socket);
    socket.emit("waiting", { needed: N, current: waiting.length });

    // If we can form a group, do it immediately.
    if (waiting.length >= N) {
      const sockets = waiting.splice(0, N);
      createGroup(sockets);
    }
  });

  socket.on("submit_belief", (payload) => {
    const groupId = socket.data.groupId;
    const pid = socket.data.pid;
    if (!groupId || !pid) return;
    const groupState = groups.get(groupId);
    if (!groupState) return;

    const p = getParticipant(groupState, pid);
    if (!p || p.dropped) return;

    const beliefP = Number(payload?.beliefP);
    if (!Number.isFinite(beliefP) || beliefP <= 0 || beliefP >= 1) return;

    p.beliefP = beliefP;
    stmts.insertBelief.run(groupId, pid, groupState.round, beliefP, now());
  });

  socket.on("send_message", (payload) => {
    const groupId = socket.data.groupId;
    const pid = socket.data.pid;
    if (!groupId || !pid) return;
    const groupState = groups.get(groupId);
    if (!groupState) return;

    const sender = getParticipant(groupState, pid);
    if (!sender || sender.dropped) return;

    const msgP = Number(payload?.msgP);
    if (!Number.isFinite(msgP) || msgP <= 0 || msgP >= 1) return;

    sender.msgCount += 1;
    stmts.insertMessage.run(groupId, pid, groupState.round, msgP, groupState.cost, now());

    // forward to neighbors by index
    const senderIdx = sender.index;
    const nbIdxs = groupState.neighbors[senderIdx];

    for (const j of nbIdxs) {
      const receiver = groupState.participants.find((x) => x.index === j);
      if (!receiver || receiver.dropped) continue;
      io.to(receiver.socketId).emit("incoming_message", {
        round: groupState.round,
        fromIndex: senderIdx,
        msgP,
        ts: now(),
      });
    }

    socket.emit("message_sent", {
      round: groupState.round,
      msgP,
      cost: groupState.cost,
      msgCount: sender.msgCount,
    });
  });

  socket.on("submit_final", (payload) => {
    const groupId = socket.data.groupId;
    const pid = socket.data.pid;
    if (!groupId || !pid) return;
    const groupState = groups.get(groupId);
    if (!groupState) return;

    const p = getParticipant(groupState, pid);
    if (!p || p.dropped) return;

    const g = Number(payload?.finalGuess);
    if (g !== 0 && g !== 1) return;

    if (p.finalGuess === null) {
      p.finalGuess = g;
      writeFinal(groupState, p);
    }

    socket.emit("final_ack", { score: p.score });
  });

  socket.on("disconnect", () => {
    waiting = waiting.filter((s) => s.id !== socket.id);

    const groupId = socket.data.groupId;
    const pid = socket.data.pid;
    if (!groupId || !pid) return;
    const groupState = groups.get(groupId);
    if (!groupState) return;

    const p = getParticipant(groupState, pid);
    if (!p) return;
    p.dropped = true;
    stmts.markDropped.run(pid);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log("Condition grid:", CELLS.map((c) => c.key).join(" ; "));
  console.log("Groups per cell:", GROUPS_PER_CELL, "Total groups target:", GROUPS_PER_CELL * CELLS.length);
  console.log("Total remaining at start:", totalRemainingGroups());
});
