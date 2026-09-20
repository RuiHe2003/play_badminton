const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const TOURNAMENT_ID = 1; // 集帅杯
const EDITION = 12;
const DATE = '2026-09-19';
const LEVEL = 1000;

const players = [
  { id: 29, name: ':-D', real: '朱开源' },
  { id: 18, name: 'bulin', real: '腢沛霖' },
  { id: 20, name: '睿河', real: '林瑞和' },
  { id: 22, name: '邱邱你呢', real: '邱祥轩' },
  { id: 10, name: '烽', real: '郑泽烽' },
  { id: 8, name: 'Refined Pei', real: '陆家陪' },
  { id: 25, name: '一般不紧张', real: '张凯宁' },
  { id: 16, name: '闲ノG', real: '李知翰' }
];

// [player1_id, player2_id, team1_score, team2_score]
const matchData = [
  [29, 18, 15, 8],
  [20, 22, 15, 21],
  [10, 8, 21, 12],
  [25, 16, 15, 21],
  [22, 29, 21, 13],
  [8, 18, 15, 11],
  [16, 20, 21, 19],
  [25, 10, 14, 21],
  [29, 8, 21, 18],
  [22, 16, 10, 15],
  [18, 25, 11, 21],
  [20, 10, 18, 21],
  [16, 29, 21, 15],
  [25, 8, 19, 21],
  [10, 22, 21, 13],
  [20, 18, 23, 21],
  [29, 25, 12, 21],
  [16, 10, 21, 19],
  [8, 20, 15, 21],
  [22, 18, 21, 17],
  [10, 29, 21, 13],
  [20, 25, 21, 19],
  [18, 16, 18, 21],
  [22, 8, 21, 15],
  [29, 20, 16, 21],
  [10, 18, 21, 11],
  [25, 22, 21, 17],
  [16, 8, 21, 13]
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
  const buffer = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  const db = buffer ? new SQL.Database(buffer) : new SQL.Database();

  // 1. Check if round already exists
  const existing = selectOne(db, 'SELECT id FROM rounds WHERE tournament_id = ? AND edition = ? ORDER BY id DESC LIMIT 1', [TOURNAMENT_ID, EDITION]);
  let roundId;

  if (existing) {
    roundId = existing.id;
    console.log(`Round already exists (id=${roundId}), clearing old matches/teams...`);
    db.run('DELETE FROM matches WHERE round_id = ?', [roundId]);
    db.run('DELETE FROM teams WHERE round_id = ?', [roundId]);
    db.run('UPDATE rounds SET date = ?, level = ? WHERE id = ?', [DATE, LEVEL, roundId]);
  } else {
    db.run('INSERT INTO rounds (tournament_id, edition, round_number, date, level) VALUES (?, ?, 1, ?, ?)', [TOURNAMENT_ID, EDITION, DATE, LEVEL]);
    const row = selectOne(db, 'SELECT id FROM rounds WHERE tournament_id = ? AND edition = ? ORDER BY id DESC LIMIT 1', [TOURNAMENT_ID, EDITION]);
    roundId = row.id;
    console.log(`Created new round (id=${roundId})`);
  }

  // 2. Create teams for each player (singles: player2_id = NULL)
  const playerToTeam = {};
  for (const p of players) {
    db.run('INSERT INTO teams (round_id, player1_id, player2_id) VALUES (?, ?, NULL)', [roundId, p.id]);
    const team = selectOne(db, 'SELECT id FROM teams WHERE round_id = ? AND player1_id = ? AND player2_id IS NULL', [roundId, p.id]);
    playerToTeam[p.id] = team.id;
    console.log(`  Team ${team.id}: ${p.name} (${p.real})`);
  }

  // 3. Create matches
  let count = 0;
  for (let i = 0; i < matchData.length; i++) {
    const [p1, p2, s1, s2] = matchData[i];
    const t1 = playerToTeam[p1];
    const t2 = playerToTeam[p2];
    db.run('INSERT INTO matches (round_id, team1_id, team2_id, team1_score, team2_score) VALUES (?, ?, ?, ?, ?)', [roundId, t1, t2, s1, s2]);
    count++;
    const n1 = players.find(p => p.id === p1).name;
    const n2 = players.find(p => p.id === p2).name;
    console.log(`  Match ${count}: ${n1} vs ${n2} = ${s1}:${s2}`);
  }

  // 4. Save database
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  console.log(`\n=== Done! ${count} matches saved ===`);
  console.log(`Round ID: ${roundId} | 第${EDITION}届集帅杯 | ${LEVEL}级 | ${DATE}`);

  // 5. Calculate rankings preview
  const teams = [];
  for (const p of players) {
    teams.push({ team_id: playerToTeam[p.id], ...p, wins: 0, losses: 0, pf: 0, pa: 0 });
  }
  const stats = {};
  for (const t of teams) stats[t.team_id] = { ...t, wins: 0, losses: 0, pf: 0, pa: 0 };

  for (const [p1, p2, s1, s2] of matchData) {
    const t1 = playerToTeam[p1], t2 = playerToTeam[p2];
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
  console.log(`\n=== Rankings Preview ===`);
  rankings.forEach((r, i) => {
    const pts = LEVEL - d * i;
    const net = r.pf - r.pa;
    console.log(`  ${i + 1}. ${r.name.padEnd(12)} ${r.wins}胜${r.losses}负  净分${net >= 0 ? '+' : ''}${net}  积分${pts}`);
  });
})();
