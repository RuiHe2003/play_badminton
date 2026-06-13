const initSqlJs = require('sql.js');
async function main() {
  const SQL = await initSqlJs();
  const buffer = require('fs').readFileSync('data.db');
  const db = new SQL.Database(buffer);
  // Find 国王杯 edition 7 round
  const r = db.exec("SELECT r.id, r.edition, r.date, r.level FROM rounds r JOIN tournaments t ON r.tournament_id = t.id WHERE t.name = '国王杯' AND r.edition = 7");
  console.log('Round:', JSON.stringify(r, null, 2));
  // Get teams
  const roundId = r[0].values[0][0];
  console.log('Round ID:', roundId);
  const teams = db.exec("SELECT t.id, t.player1_id, t.player2_id, p1.name as p1n, p2.name as p2n FROM teams t JOIN players p1 ON t.player1_id = p1.id LEFT JOIN players p2 ON t.player2_id = p2.id WHERE t.round_id = " + roundId);
  console.log('Teams:', JSON.stringify(teams, null, 2));
  // Get existing matches
  const matches = db.exec("SELECT m.id, m.team1_id, m.team2_id, m.team1_score, m.team2_score FROM matches m WHERE m.round_id = " + roundId + " ORDER BY m.id");
  console.log('Matches count:', matches[0]?.values?.length || 0);
  console.log('Matches:', JSON.stringify(matches, null, 2));
}
main();
