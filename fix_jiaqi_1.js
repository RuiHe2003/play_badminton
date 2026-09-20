const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const ROUND_ID = 37; // 假期杯第1届
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

  // 1. Clear old data for round 37
  console.log('=== Clearing old round 37 data ===');
  db.run('DELETE FROM matches WHERE round_id = ?', [ROUND_ID]);
  db.run('DELETE FROM teams WHERE round_id = ?', [ROUND_ID]);

  // 2. Add new players
  console.log('\n=== Adding new players ===');
  const newPlayers = [
    { name: 'Kiyo', gender: 'male' },
    { name: '丞丞丞哥', gender: 'female' }
  ];
  const P = {};
  for (const np of newPlayers) {
    db.run('INSERT INTO players (name, gender, real_name) VALUES (?, ?, ?)', [np.name, np.gender, '']);
    P[np.name] = selectOne(db, 'SELECT id FROM players WHERE name = ?', [np.name]).id;
    console.log(`  ${np.name} (${np.gender}) -> id ${P[np.name]}`);
  }

  // 3. Define teams
  const teams = [
    { key: 'A', p1: 6,  p2: P['丞丞丞哥'], name: '給ヤ & 丞丞丞哥' },
    { key: 'B', p1: 22, p2: 9,  name: '邱邱你呢 & 雪季雨' },
    { key: 'C', p1: 10, p2: 7,  name: '烽 & 等假期' },
    { key: 'D', p1: 18, p2: 13, name: 'bulin & Queeny' },
    { key: 'E', p1: 16, p2: 21, name: '闲ノG & 大圆太方' },
    { key: 'F', p1: P['Kiyo'], p2: 17, name: 'Kiyo & 21' }
  ];

  // 4. Create teams
  console.log('\n=== Creating teams ===');
  const teamIds = {};
  for (const t of teams) {
    db.run('INSERT INTO teams (round_id, player1_id, player2_id) VALUES (?, ?, ?)', [ROUND_ID, t.p1, t.p2]);
    teamIds[t.key] = selectOne(db, 'SELECT id FROM teams WHERE round_id = ? AND player1_id = ? AND player2_id = ?', [ROUND_ID, t.p1, t.p2]).id;
    console.log(`  Team ${t.key} (id=${teamIds[t.key]}): ${t.name}`);
  }

  // 5. Create matches
  const matches = [
    ['A','B', 21,16], ['C','D', 21,18], ['E','F', 21,16],
    ['D','A', 10,21], ['F','B', 21,17], ['E','C', 21,17],
    ['A','F', 21,18], ['D','E', 21,16], ['B','C', 14,21],
    ['E','A', 23,21], ['C','F', 21,9],  ['B','D', 21,19],
    ['A','C', 22,20], ['E','B', 19,21], ['F','D', 21,16]
  ];
  console.log('\n=== Creating matches ===');
  let count = 0;
  for (const [t1k, t2k, s1, s2] of matches) {
    db.run('INSERT INTO matches (round_id, team1_id, team2_id, team1_score, team2_score) VALUES (?, ?, ?, ?, ?)',
      [ROUND_ID, teamIds[t1k], teamIds[t2k], s1, s2]);
    count++;
    console.log(`  ${count}. ${teams.find(t=>t.key===t1k).name} vs ${teams.find(t=>t.key===t2k).name} = ${s1}:${s2}`);
  }

  // 6. Save
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  console.log(`\n=== Done! ${count} matches saved (replaced old data) ===`);

  // 7. Rankings
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
    console.log(`  ${i+1}. ${r.name.padEnd(22)} ${r.wins}胜${r.losses}负  净分${r.pf-r.pa>=0?'+':''}${r.pf-r.pa}  积分${LEVEL - d * i}`);
  });
})();
