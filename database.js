const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// DB_PATH 支持用环境变量覆盖：迁移/回归测试要在影子副本上跑，
// 直接改文件常量的话就只能对着正在运行的线上库动刀，太危险。
// 生产（npm start / Procfile）不设该变量，行为与以前完全一致。
const DB_PATH = process.env.BADMINTON_DB || path.join(__dirname, 'data.db');
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

  // type 不再用 CHECK 约束：创建赛事功能会引入 'team' / 'womens_doubles' 等新类型。
  // 老库带 CHECK，靠 migrateTournamentTypeCheck() 重建一次表来放开（见文件末尾）。
  db.run(`CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1000
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    edition INTEGER NOT NULL DEFAULT 1,
    round_number INTEGER NOT NULL,
    date TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1000,
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
  try { db.run(`ALTER TABLE tournaments ADD COLUMN level INTEGER NOT NULL DEFAULT 1000`); } catch(e) {}
  try { db.run(`ALTER TABLE tournaments ADD COLUMN icon TEXT DEFAULT ''`); } catch(e) {}
  try { db.run(`ALTER TABLE rounds ADD COLUMN level INTEGER NOT NULL DEFAULT 1000`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN partner1_id INTEGER DEFAULT NULL`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN partner2_id INTEGER DEFAULT NULL`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN partner3_id INTEGER DEFAULT NULL`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN rival1_id INTEGER DEFAULT NULL`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN rival2_id INTEGER DEFAULT NULL`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN rival3_id INTEGER DEFAULT NULL`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN rival4_id INTEGER DEFAULT NULL`); } catch(e) {}
  try { db.run(`ALTER TABLE players ADD COLUMN rival5_id INTEGER DEFAULT NULL`); } catch(e) {}

  migrateTournamentTypeCheck();
  createEventTables();
  migrateEventEditions();
}

// 放开 tournaments.type 的 CHECK 约束。
// SQLite 改不了已有约束，只能重建表；这里做「只做一次、失败不半途改库」的迁移：
//   1) 先用 sqlite_master 里的原始 DDL 判断是否还带 CHECK —— 不带就直接返回（幂等）；
//   2) 重建放在事务里，任何一步抛错都 ROLLBACK，老表原样保留。
// 列名一律显式写死，不用 SELECT *（老库列顺序与新建库不同，靠 * 会错位）。
function migrateTournamentTypeCheck() {
  let ddl = '';
  try {
    const r = db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tournaments'`);
    if (!r.length || !r[0].values.length) return;
    ddl = String(r[0].values[0][0] || '');
  } catch (e) { return; }
  if (!/CHECK\s*\(\s*type/i.test(ddl)) return;   // 已迁移过

  try {
    db.run('BEGIN');
    db.run(`CREATE TABLE tournaments_mig (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1000,
      icon TEXT DEFAULT ''
    )`);
    db.run(`INSERT INTO tournaments_mig (id, name, type, level, icon)
            SELECT id, name, type, level, IFNULL(icon, '') FROM tournaments`);
    db.run('DROP TABLE tournaments');
    db.run('ALTER TABLE tournaments_mig RENAME TO tournaments');
    db.run('COMMIT');
    console.log('[migrate] tournaments.type CHECK 约束已放开');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (e2) {}
    console.error('[migrate] 重建 tournaments 失败，已回滚：', e.message);
  }
}

// 把「赛事 = 一锤子买卖」的旧结构迁移成「赛事定义 + 届次」两层。
// 幂等：靠 sqlite_master 判断列在不在，已迁移过就直接返回。
// 迁移内容：
//   1) events 补 best_of（局制，默认 3 局 2 胜 —— 与迁移前的行为一致）；
//   2) event_entries / event_ties 补 edition_id；
//   3) 每个已有赛事补出「第 1 届」，把它的日期/级别/状态/round_id 与全部参赛单元、对阵搬进去。
// 不做任何删除：搬不动就让这批老数据留在原地（edition_id=0），也不会影响老赛事的积分口径。
function migrateEventEditions() {
  const hasCol = (table, col) => {
    try {
      const r = db.exec(`PRAGMA table_info(${table})`);
      if (!r.length) return false;
      return r[0].values.some(v => String(v[1]) === col);
    } catch (e) { return false; }
  };
  const addCol = (table, col, ddl) => {
    if (hasCol(table, col)) return;
    try { db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); } catch (e) {}
  };

  addCol('events', 'best_of', 'INTEGER NOT NULL DEFAULT 3');
  addCol('event_entries', 'edition_id', 'INTEGER NOT NULL DEFAULT 0');
  addCol('event_ties', 'edition_id', 'INTEGER NOT NULL DEFAULT 0');
  // 赛制三件套（都是「默认 = 迁移前的行为」，老赛事不用改就能照旧跑）：
  //   seed_by    种子排序依据：entry=按录入顺序（原行为）| points=按成员总积分之和
  //   group_mode 分组方式：snake=按种子蛇形自动分（原行为）| manual=管理员手动指定
  //   ko_mode    淘汰对阵：seed=标准种子位固定交叉（原行为）| random=随机抽签 | random_avoid=随机且首轮回避同组
  addCol('events', 'seed_by', "TEXT NOT NULL DEFAULT 'entry'");
  addCol('events', 'group_mode', "TEXT NOT NULL DEFAULT 'snake'");
  addCol('events', 'ko_mode', "TEXT NOT NULL DEFAULT 'seed'");

  try {
    db.run('BEGIN');
    const evs = db.exec('SELECT id, date, level, status, round_id FROM events');
    const list = evs.length ? evs[0].values.map(v => ({
      id: v[0], date: v[1], level: v[2], status: v[3], round_id: v[4]
    })) : [];
    for (const e of list) {
      const r = db.exec(`SELECT COUNT(*) FROM event_editions WHERE event_id = ${e.id}`);
      const n = r.length ? r[0].values[0][0] : 0;
      if (n > 0) continue;                        // 已迁移过
      const date = e.date ? `'${String(e.date).replace(/'/g, "''")}'` : "''";
      db.run(`INSERT INTO event_editions (event_id, edition, date, level, status, round_id, created_at)
              VALUES (${e.id}, 1, ${date}, ${e.level || 1000}, '${e.status || 'draft'}', ${e.round_id === null || e.round_id === undefined ? 'NULL' : e.round_id}, '')`);
      const rr = db.exec('SELECT last_insert_rowid()');
      const edId = rr.length ? rr[0].values[0][0] : null;
      if (!edId) continue;
      db.run(`UPDATE event_entries SET edition_id = ${edId} WHERE event_id = ${e.id} AND edition_id = 0`);
      db.run(`UPDATE event_ties SET edition_id = ${edId} WHERE event_id = ${e.id} AND edition_id = 0`);
    }
    db.run('COMMIT');
    if (list.length) console.log(`[migrate] 赛事已升级为「定义 + 届次」两层，迁移 ${list.length} 个赛事`);
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (e2) {}
    console.error('[migrate] 赛事届次迁移失败，已回滚：', e.message);
  }
}

// ==================== 赛事创建（新版赛事引擎） ====================
// 统一模型：赛事(event) → 对抗(tie) → 单项(tie_item) → 局(tie_game)
//   · 单项赛：一个 tie 就是一场比赛，挂 1 个 tie_item（N=1），逐局录分。
//   · 团体赛：一个 tie 是一场团体对抗，挂 N 个 tie_item（勾选的男单/女单/男双/女双/混双），
//     每个 tie_item 也让双方各自排阵（side1_players / side2_players 存 JSON 数组）。
// 一套录入 UI 通吃两种赛事类型，这是刻意的：少一条分支就少一类 bug。
//
// 【两层结构：赛事定义 vs 届次】
//   events 只描述「赛制」：类型、赛制（单循环/淘汰/小组+淘汰）、局制、团体项目与出场顺序、
//   小组配置、季军赛。它和老 tournaments 一样可以办很多届，本身不带日期、级别、参赛名单。
//   event_editions 是某一届：日期、级别、参赛单元、对阵、比分都挂在这一层，
//   与老 rounds 一一对应（edition.round_id 就是镜像的 rounds 行）。
//   这样「赛制」改一次就对所有届生效，而「谁参赛、什么时候打」按届各自录入。
function createEventTables() {
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,                       -- individual | team
    format TEXT NOT NULL,                     -- rr 单循环 | ko 淘汰 | group_ko 小组+淘汰
    best_of INTEGER NOT NULL DEFAULT 3,       -- 1 一局定胜负 | 3 三局两胜
    level INTEGER NOT NULL DEFAULT 1000,      -- 已废弃：级别改按届存（老库列保留，只为不破坏旧结构）
    date TEXT NOT NULL DEFAULT '',            -- 已废弃：日期改按届存
    icon TEXT DEFAULT '',
    third_place INTEGER NOT NULL DEFAULT 0,   -- 季军赛开关
    group_count INTEGER NOT NULL DEFAULT 0,
    advance_per_group INTEGER NOT NULL DEFAULT 0,
    seed_by TEXT NOT NULL DEFAULT 'entry',        -- 种子依据：entry 录入顺序 | points 成员总积分之和
    group_mode TEXT NOT NULL DEFAULT 'snake',     -- 分组：snake 按种子蛇形 | manual 手动指定
    ko_mode TEXT NOT NULL DEFAULT 'seed',         -- 淘汰对阵：seed 固定交叉 | random 随机 | random_avoid 随机+首轮回避同组
    status TEXT NOT NULL DEFAULT 'draft',     -- 已废弃：状态改按届存
    tournament_id INTEGER,                    -- 镜像到 tournaments 的行（让新赛事在各页面地位同等）
    round_id INTEGER,                         -- 已废弃：每一届各有一行 rounds
    created_at TEXT DEFAULT ''
  )`);

  // 一届赛事。round_id 是镜像到 rounds 的行 —— 积分 / 荣誉 / 选手资料页都认它。
  db.run(`CREATE TABLE IF NOT EXISTS event_editions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    edition INTEGER NOT NULL DEFAULT 1,       -- 第几届
    date TEXT NOT NULL DEFAULT '',
    level INTEGER NOT NULL DEFAULT 1000,
    status TEXT NOT NULL DEFAULT 'draft',     -- draft 未生成对阵 | ready 进行中 | done 已结束
    round_id INTEGER,
    created_at TEXT DEFAULT ''
  )`);

  // 团体赛的单项配置。seq 就是「自定义出场顺序」，改顺序只改 seq。
  db.run(`CREATE TABLE IF NOT EXISTS event_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    code TEXT NOT NULL,                       -- ms/ws/md/wd/xd
    name TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0
  )`);

  // 参赛单元：单项赛=选手或组合，团体赛=队伍。按届录入 —— 同一赛事不同届名单可以完全不同。
  db.run(`CREATE TABLE IF NOT EXISTS event_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    edition_id INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL,
    group_no INTEGER NOT NULL DEFAULT 0,      -- 0 = 未分组
    seq INTEGER NOT NULL DEFAULT 0
  )`);

  // 参赛单元成员。团体赛是关键：一个 entry 可以有 4~8 个队员，
  // 这正是它装不进老 teams 表（只有 player1/player2 两列）的原因。
  db.run(`CREATE TABLE IF NOT EXISTS event_entry_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0
  )`);

  // 一场对抗。stage: group 小组赛 / ko 淘汰赛 / third 季军赛
  // ko_round：1 = 首轮，递增到决赛；slot 为该轮内的序号
  db.run(`CREATE TABLE IF NOT EXISTS event_ties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    edition_id INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL,
    group_no INTEGER NOT NULL DEFAULT 0,
    ko_round INTEGER NOT NULL DEFAULT 0,
    slot INTEGER NOT NULL DEFAULT 0,
    side1_entry_id INTEGER,
    side2_entry_id INTEGER,
    winner_entry_id INTEGER,
    state TEXT NOT NULL DEFAULT 'pending',    -- pending | done
    seq INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS event_tie_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tie_id INTEGER NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    seq INTEGER NOT NULL DEFAULT 0,
    side1_players TEXT DEFAULT '',            -- JSON 数组：该单项我方上场球员
    side2_players TEXT DEFAULT '',
    winner_side INTEGER NOT NULL DEFAULT 0    -- 0 未定 | 1 | 2 | -1 未进行（提前分出胜负）
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS event_tie_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tie_item_id INTEGER NOT NULL,
    game_no INTEGER NOT NULL,
    s1 INTEGER NOT NULL DEFAULT 0,
    s2 INTEGER NOT NULL DEFAULT 0
  )`);
}

function seedTournaments() {
  const existing = db.exec(`SELECT COUNT(*) as cnt FROM tournaments`);
  if (existing[0].values[0][0] === 0) {
    const s = db.prepare(`INSERT INTO tournaments (name, type, level) VALUES (?, ?, ?)`);
    s.run(['集帅杯', 'singles', 1000]);
    s.run(['国王杯', 'mixed_doubles', 1000]);
    s.run(['龙王杯', 'mens_doubles', 1000]);
    s.run(['狗王杯', 'mixed_doubles', 1000]);
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
