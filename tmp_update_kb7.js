const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function main() {
  const SQL = await initSqlJs();
  const DB_PATH = path.join(__dirname, 'data.db');
  const buffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);

  // Round ID 15 for 国王杯 edition 7
  const roundId = 15;

  // Team mapping (from previous query)
  // 90: 贝贝龙+雪季雨, 91: xiaoxin+Ethereal, 92: 邱邱你呢+~啦-
  // 93: bulin+一个撇, 94: Refined Pei+Lynn, 95: :-D+吉吉国王
  // 96: 一般不紧张+东京, 97: 烽+阿饼a, 98: 給ヤ+yoyo, 99: 睿河+21

  // All 45 matches from user: [team1_id, team2_id, team1_score, team2_score]
  const matches = [
    [90, 91, 22, 20],
    [92, 93, 21, 19],
    [94, 95, 20, 22],
    [96, 97, 18, 21],
    [98, 99, 21, 11],
    [93, 90, 19, 21],
    [95, 91, 21, 14],
    [97, 92, 21, 18],
    [99, 94, 15, 21],
    [98, 96, 21, 19],
    [90, 95, 21, 17],
    [93, 97, 21, 15],
    [91, 99, 17, 21],
    [92, 98, 18, 21],
    [94, 96, 15, 21],
    [97, 90, 21, 18],
    [99, 95, 22, 20],
    [98, 93, 21, 19],
    [96, 91, 14, 21],
    [94, 92, 19, 21],
    [90, 99, 14, 21],
    [97, 98, 19, 21],
    [95, 96, 21, 8],
    [93, 94, 17, 21],
    [91, 92, 17, 21],
    [98, 90, 21, 19],
    [96, 99, 14, 21],
    [94, 97, 21, 12],
    [92, 95, 21, 18],
    [91, 93, 21, 14],
    [90, 96, 11, 21],
    [98, 94, 21, 17],
    [99, 92, 11, 21],
    [97, 91, 21, 15],
    [95, 93, 15, 21],
    [94, 90, 21, 16],
    [92, 96, 21, 15],
    [91, 98, 17, 21],
    [93, 99, 22, 20],
    [95, 97, 21, 18],
    [90, 92, 18, 21],
    [94, 91, 21, 15],
    [96, 93, 17, 21],
    [98, 95, 22, 20],
    [99, 97, 21, 17],
  ];

  // Delete existing matches for this round
  db.run(`DELETE FROM matches WHERE round_id = ${roundId}`);
  console.log('Deleted existing matches');

  // Insert new matches
  const stmt = db.prepare(`INSERT INTO matches (round_id, team1_id, team2_id, team1_score, team2_score) VALUES (?, ?, ?, ?, ?)`);
  for (const [t1, t2, s1, s2] of matches) {
    stmt.run([roundId, t1, t2, s1, s2]);
  }
  stmt.free();
  console.log(`Inserted ${matches.length} matches`);

  // Save
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  console.log('Saved to data.db');
}
main();
