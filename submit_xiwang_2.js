const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const TOURNAMENT_ID = 4; // 希王杯
const EDITION = 2;
const DATE = '2026-03-28';
const LEVEL = 500;

const newPlayers = [
  { name: 'hjy', gender: 'female' },
  { name: '好梦', gender: 'female' },
  { name: '黎鸿雨', gender: 'male' }
];

// Existing player IDs
const P = {
  '雨': 38, '21': 17, 'Lynn': 32, '谷': 14,
  'Ethereal': 11, '給ヤ': 6, '邱邱你呢': 22,
  '余泳琳': 60, 'bulin': 18,
  'hjy': null, '好梦': null, '黎鸿雨': null
};

const teams = {};

// 15 matches: [teamA, teamB, s1, s2]
const matches = [
  ['A','B', 18,21], ['C','D', 21,19], ['E','F', 21,18],
  ['D','A', 21,16], ['F','B', 22,20], ['E','C', 12,21],
  ['A','F', 13,21], ['D','E', 19,21], ['B','C', 12,21],
  ['E','A', 21,17], ['C','F', 21,17], ['B','D', 21,19],
  ['A','C', 16,21], ['E','B', 21,19], ['F','D', 26,24]
];

function selectOne(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  // 1. Add new players
  console.log('=== Step 1: Adding new players ===');
  for (const np of newPlayers) {
    db.run('INSERT INTO players (name, gender, real_name) VALUES (?, ?, ?)', [np.name, np.gender, '']);
    const row = selectOne(db, 'SELECT id FROM players WHERE name = ?', [np.name]);
    P[np.name] = row.id;
    console.log(`  ${np.name} (${np.gender}) -> id ${row.id}`);
  }

  // 2. Define teams
  teams.A = { p1: P['雨'], p2: P['21'], name: '雨 & 21' };
  teams.B = { p1: P['Lynn'], p2: P['谷'], name: 'Lynn & 谷' };
  teams.C = { p1: P['Ethereal'], p2: P['給ヤ'], name: 'Ethereal & 給ヤ' };
  teams.D = { p1: P['hjy'], p2: P['邱邱你呢'], name: 'hjy & 邱邱你呢' };
  teams.E = { p1: P['余泳琳'], p2: P['bulin'], name: '余泳琳 & bulin' };
  teams.F = { p1: P['好梦'], p2: P['黎鸿雨'], name: '好梦 & 黎鸿雨' };

  // 3. Create round
  console.log('\n=== Step 2: Creating round ===');
  const existing = selectOne(db, 'SELECT id FROM rounds WHERE tournament_id = ? AND edition = ? ORDER BY id DESC LIMIT 1', [TOURNAMENT_ID, EDITION]);
  let roundId;
  if (existing) {
    roundId = existing.id;
    console.log(`Round exists (id=${roundId}), clearing...`);
    db.run('DELETE FROM matches WHERE round_id = ?', [roundId]);
    db.run('DELETE FROM teams WHERE round_id = ?', [roundId]);
    db.run('UPDATE rounds SET date = ?, level = ? WHERE id = ?', [DATE, LEVEL, roundId]);
  } else {
    db.run('INSERT INTO rounds (tournament_id, edition, round_number, date, level) VALUES (?, ?, 1, ?, ?)', [TOURNAMENT_ID, EDITION, DATE, LEVEL]);
    const row = selectOne(db, 'SELECT id FROM rounds WHERE tournament_id = ? AND edition = ? ORDER BY id DESC LIMIT 1', [TOURNAMENT_ID, EDITION]);
    roundId = row.id;
    console.log(`Created round (id=${roundId})`);
  }

  // 4. Create teams
  console.log('\n=== Step 3: Creating teams ===');
  const teamIds = {};
  for (const [key, t] of Object.entries(teams)) {
    db.run('INSERT INTO teams (round_id, player1_id, player2_id) VALUES (?, ?, ?)', [roundId, t.p1, t.p2]);
    const row = selectOne(db, 'SELECT id FROM teams WHERE round_id = ? AND player1_id = ? AND player2_id = ?', [roundId, t.p1, t.p2]);
    teamIds[key] = row.id;
    console.log(`  Team ${key} (id=${row.id}): ${t.name}`);
  }

  // 5. Create matches
  console.log('\n=== Step 4: Creating matches ===');
  let count = 0;
  for (const [t1Key, t2Key, s1, s2] of matches) {
    const t1 = teamIds[t1Key], t2 = teamIds[t2Key];
    db.run('INSERT INTO matches (round_id, team1_id, team2_id, team1_score, team2_score) VALUES (?, ?, ?, ?, ?)', [roundId, t1, t2, s1, s2]);
    count++;
    console.log(`  Match ${count}: ${teams[t1Key].name} vs ${teams[t2Key].name} = ${s1}:${s2}`);
  }

  // 6. Save
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  console.log(`\n=== Done! ${count} matches saved ===`);
  console.log(`Round ${roundId} | 第${EDITION}届希王杯 | ${LEVEL}级 | ${DATE}`);

  // 7. Rankings preview
  const stats = {};
  for (const [key, t] of Object.entries(teams)) {
    stats[teamIds[key]] = { ...t, team_id: teamIds[key], key, wins: 0, losses: 0, pf: 0, pa: 0 };
  }
  for (const [t1Key, t2Key, s1, s2] of matches) {
    const t1 = teamIds[t1Key], t2 = teamIds[t2Key];
    stats[t1].pf += s1; stats[t1].pa += s2;
    stats[t2].pf += s2; stats[t2].pa += s1;
    if (s1 > s2) { stats[t1].wins++; stats[t2].losses++; }
    else { stats[t2].wins++; stats[t1].losses++; }
  }
  const rankings = Object.values(stats).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return (b.pf - b.pa) - (a.pf - a.pa);
  });
  const n = rankings.length;
  const d = Math.round(LEVEL / n);
  console.log('\n=== Rankings Preview ===');
  rankings.forEach((r, i) => {
    const pts = LEVEL - d * i;
    const net = r.pf - r.pa;
    console.log(`  ${i+1}. ${r.name.padEnd(20)} ${r.wins}胜${r.losses}负  净分${net>=0?'+':''}${net}  积分${pts}`);
  });
})();
