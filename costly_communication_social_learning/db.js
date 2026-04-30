const Database = require("better-sqlite3");

function initDb(path = "data.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY,
      created_ts INTEGER,
      condition_cost INTEGER,
      kappa REAL,
      sigma REAL,
      hidden_state INTEGER,
      rounds INTEGER
    );

    CREATE TABLE IF NOT EXISTS participants (
      participant_id TEXT PRIMARY KEY,
      group_id TEXT,
      joined_ts INTEGER,
      dropped INTEGER DEFAULT 0,
      private_p REAL,
      score INTEGER DEFAULT 0,
      FOREIGN KEY(group_id) REFERENCES groups(group_id)
    );

    CREATE TABLE IF NOT EXISTS belief_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT,
      participant_id TEXT,
      round INTEGER,
      belief_p REAL,
      ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS message_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT,
      participant_id TEXT,
      round INTEGER,
      msg_p REAL,
      cost INTEGER,
      ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS round_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT,
      round INTEGER,
      event_type TEXT,
      ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS final_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT,
      participant_id TEXT,
      final_guess INTEGER,
      correct INTEGER,
      reward INTEGER,
      total_cost INTEGER,
      final_score INTEGER,
      ts INTEGER
    );
  `);

  const stmts = {
    insertGroup: db.prepare(`
      INSERT INTO groups(group_id, created_ts, condition_cost, kappa, sigma, hidden_state, rounds)
      VALUES(?,?,?,?,?,?,?)
    `),
    insertParticipant: db.prepare(`
      INSERT INTO participants(participant_id, group_id, joined_ts, private_p)
      VALUES(?,?,?,?)
    `),
    markDropped: db.prepare(`
      UPDATE participants SET dropped=1 WHERE participant_id=?
    `),
    updateScore: db.prepare(`
      UPDATE participants SET score=? WHERE participant_id=?
    `),
    insertBelief: db.prepare(`
      INSERT INTO belief_events(group_id, participant_id, round, belief_p, ts)
      VALUES(?,?,?,?,?)
    `),
    insertMessage: db.prepare(`
      INSERT INTO message_events(group_id, participant_id, round, msg_p, cost, ts)
      VALUES(?,?,?,?,?,?)
    `),
    insertRoundEvent: db.prepare(`
      INSERT INTO round_events(group_id, round, event_type, ts)
      VALUES(?,?,?,?)
    `),
    insertFinal: db.prepare(`
      INSERT INTO final_events(group_id, participant_id, final_guess, correct, reward, total_cost, final_score, ts)
      VALUES(?,?,?,?,?,?,?,?)
    `),
  };

  return { db, stmts };
}

module.exports = { initDb };
