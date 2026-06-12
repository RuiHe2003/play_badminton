const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
let db;

async function initDatabase() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  createTables();
  seedTournaments();
  saveDatabase();
}

function saveDatabase() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function createTables() {
  db.run(`CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    gender TEXT NOT NULL CHECK(gender IN ('male', 'female'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('singles', 'mens_doubles', 'mixed_doubles'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    edition INTEGER NOT NULL DEFAULT 1,
    round_number INTEGER NOT NULL,
    date TEXT NOT NULL,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    player1_id INTEGER NOT NULL,
    player2_id INTEGER,
    FOREIGN KEY (round_id) REFERENCES rounds(id),
    FOREIGN KEY (player1_id) REFERENCES players(id),
    FOREIGN KEY (player2_id) REFERENCES players(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    team1_id INTEGER NOT NULL,
    team2_id INTEGER NOT NULL,
    team1_score INTEGER NOT NULL,
    team2_score INTEGER NOT NULL,
    FOREIGN KEY (round_id) REFERENCES rounds(id),
    FOREIGN KEY (team1_id) REFERENCES teams(id),
    FOREIGN KEY (team2_id) REFERENCES teams(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // Add edition column if upgrading from old schema
  try { db.run(`ALTER TABLE rounds ADD COLUMN edition INTEGER NOT NULL DEFAULT 1`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN bio TEXT DEFAULT ''`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN avatar TEXT DEFAULT ''`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN real_name TEXT DEFAULT ''`); } catch(e) {}
}

function seedTournaments() {
  const existing = db.exec(`SELECT COUNT(*) as cnt FROM tournaments`);
  if (existing[0].values[0][0] === 0) {
    const s = db.prepare(`INSERT INTO tournaments (name, type) VALUES (?, ?)`);
    s.run(['集帅杯', 'singles']);
    s.run(['国王杯', 'mixed_doubles']);
    s.run(['龙王杯', 'mens_doubles']);
    s.free();
  }

  const existingSettings = db.exec(`SELECT COUNT(*) as cnt FROM settings`);
  if (existingSettings[0].values[0][0] === 0) {
    const s = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
    s.run(['password', '202606']);
    s.run(['security_question', '林瑞和生日的年份是？']);
    s.run(['security_answer', '2003']);
    s.free();
  }
}

function getDb() { return db; }

module.exports = { initDatabase, saveDatabase, getDb };
