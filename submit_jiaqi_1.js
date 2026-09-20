const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const DATE = '2026-06-01';
const LEVEL = 500;

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

  // 1. Create tournament 假期杯
  db.run("INSERT INTO tournaments (name, type, level) VALUES ('假期杯', 'mixed_doubles', 500)");
  const tour = selectOne(db, "SELECT id FROM tournaments WHERE name = '假期杯'");
  const tournamentId = tour.id;
  console.log(`=== 假期杯 created (id=${tournamentId}) ===`);

  // 2. Create round
  db.run('INSERT INTO rounds (tournament_id, edition, round_number, date, level) VALUES (?, 1, 1, ?, ?)', [tournamentId, DATE, LEVEL]);
  const round = selectOne(db, 'SELECT id FROM rounds WHERE tournament_id = ? AND edition = 1', [tournamentId]);
  const roundId = round.id;
  console.log(`Round created (id=${roundId})`);

  // 3. Create teams (all players exist)
  const teams = [
    { key: 'A', p1: 38, p2: 17, name: '雨 & 21' },
    { key: 'B', p1: 32, p2: 14, name: 'Lynn & 谷' },
    { key: 'C', p1: 11, p2: 6,  name: 'Ethereal & 給ヤ' },
    { key: 'D', p1: 62, p2: 22, name: 'hjy & 邱邱你呢' },
    { key: 'E', p1: 60, p2: 18, name: '余泳琳 & bulin' },
    { key: 'F', p1: 63, p2: 64, name: '好梦 & 黎鸿雨' }
  ];
  const teamIds = {};
  for (const t of teams) {
    db.run('INSERT INTO teams (round_id, player1_id, player2_id) VALUES (?, ?, ?)', [roundId, t.p1, t.p2]);
    const row = selectOne(db, 'SELECT id FROM teams WHERE round_id = ? AND player1_id = ? AND player2_id = ?', [roundId, t.p1, t.p2]);
    teamIds[t.key] = row.id;
    console.log(`  Team ${t.key} (id=${row.id}): ${t.name}`);
  }

  // 4. Create matches
  const matches = [
    ['A','B', 18,21], ['C','D', 21,19], ['E','F', 21,18],
    ['D','A', 21,16], ['F','B', 22,20], ['E','C', 12,21],
    ['A','F', 13,21], ['D','E', 19,21], ['B','C', 12,21],
    ['E','A', 21,17], ['C','F', 21,17], ['B','D', 21,19],
    ['A','C', 16,21], ['E','B', 21,19], ['F','D', 26,24]
  ];
  console.log('\n=== Matches ===');
  let count = 0;
  for (const [t1k, t2k, s1, s2] of matches) {
    db.run('INSERT INTO matches (round_id, team1_id, team2_id, team1_score, team2_score) VALUES (?, ?, ?, ?, ?)',
      [roundId, teamIds[t1k], teamIds[t2k], s1, s2]);
    count++;
    console.log(`  ${count}. ${teams.find(t=>t.key===t1k).name} vs ${teams.find(t=>t.key===t2k).name} = ${s1}:${s2}`);
  }

  // 5. Save
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  console.log(`\n=== Done! ${count} matches saved ===`);
  console.log(`假期杯(id=${tournamentId}) | 第1届 | ${LEVEL}级 | ${DATE} | Round ${roundId}`);

  // 6. Rankings
  const stats = {};
  for (const t of teams) {
    stats[teamIds[t.key]] = { ...t, team_id: teamIds[t.key], wins: 0, losses: 0, pf: 0, pa: 0 };
  }
  for (const [t1k, t2k, s1, s2] of matches) {
    const t1 = teamIds[t1k], t2 = teamIds[t2k];
    stats[t1].pf += s1; stats[t1].pa += s2;
    stats[t2].pf += s2; stats[t2].pa += s1;
    if (s1 > s2) { stats[t1].wins++; stats[t2].losses++; }
    else { stats[t2].wins++; stats[t1].losses++; }
  }
  const rankings = Object.values(stats).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return (b.pf - b.pa) - (a.pf - a.pa);
  });
  const d = Math.round(LEVEL / rankings.length);
  console.log('\n=== Rankings ===');
  rankings.forEach((r, i) => {
    console.log(`  ${i+1}. ${r.name.padEnd(20)} ${r.wins}胜${r.losses}负  净分${r.pf-r.pa>=0?'+':''}${r.pf-r.pa}  积分${LEVEL - d * i}`);
  });
})();
