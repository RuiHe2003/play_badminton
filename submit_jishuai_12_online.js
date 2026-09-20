const https = require('https');
const BASE = 'https://badminton.bonto.run';
const TOURNAMENT_ID = 1; // 集帅杯
const EDITION = 12;
const DATE = '2026-09-19';
const LEVEL = 1000;

const playerIds = [29, 18, 20, 22, 10, 8, 25, 16];
const playerNames = {29:':-D',18:'bulin',20:'睿河',22:'邱邱你呢',10:'烽',8:'Refined Pei',25:'一般不紧张',16:'闲ノG'};

// [player1_id, player2_id, score1, score2]
const matchData = [
  [29, 18, 15, 8],   [20, 22, 15, 21], [10, 8, 21, 12],  [25, 16, 15, 21],
  [22, 29, 21, 13],  [8, 18, 15, 11],  [16, 20, 21, 19], [25, 10, 14, 21],
  [29, 8, 21, 18],   [22, 16, 10, 15], [18, 25, 11, 21], [20, 10, 18, 21],
  [16, 29, 21, 15],  [25, 8, 19, 21],  [10, 22, 21, 13], [20, 18, 23, 21],
  [29, 25, 12, 21],  [16, 10, 21, 19], [8, 20, 15, 21],  [22, 18, 21, 17],
  [10, 29, 21, 13],  [20, 25, 21, 19], [18, 16, 18, 21], [22, 8, 21, 15],
  [29, 20, 16, 21],  [10, 18, 21, 11], [25, 22, 21, 17], [16, 8, 21, 13]
];

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    https.get(BASE + path, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    }).on('error', reject);
  });
}

(async () => {
  // Step 1: Create round with participants
  console.log('=== Step 1: Creating round (第12届集帅杯) ===');
  const participants = playerIds.map(id => ({ player1_id: id }));
  const roundRes = await post('/api/rounds', {
    tournament_id: TOURNAMENT_ID,
    edition: EDITION,
    date: DATE,
    level: LEVEL,
    participants
  });
  const roundId = roundRes.id;
  console.log(`Round created: id=${roundId}`);

  // Step 2: Get team IDs
  console.log('\n=== Step 2: Fetching team IDs ===');
  const teams = await get(`/api/rounds/${roundId}/teams`);
  const playerToTeam = {};
  for (const t of teams) {
    playerToTeam[t.player1_id] = t.team_id;
    console.log(`  ${playerNames[t.player1_id].padEnd(14)} -> team ${t.team_id}`);
  }

  // Step 3: Submit matches
  console.log('\n=== Step 3: Submitting 28 matches ===');
  let ok = 0, fail = 0;
  for (let i = 0; i < matchData.length; i++) {
    const [p1, p2, s1, s2] = matchData[i];
    const t1 = playerToTeam[p1];
    const t2 = playerToTeam[p2];
    const res = await post('/api/matches', {
      round_id: roundId,
      team1_id: t1,
      team2_id: t2,
      team1_score: s1,
      team2_score: s2
    });
    const tag = res.created ? 'OK(new)' : res.updated ? 'OK(upd)' : 'FAIL: ' + (res.error || 'unknown');
    if (res.created || res.updated) ok++; else fail++;
    console.log(`  ${(i+1).toString().padStart(2)}. ${playerNames[p1]} vs ${playerNames[p2]}  ${s1}:${s2}  -> ${tag}`);
  }

  console.log(`\n=== Done: ${ok} ok, ${fail} failed ===`);
  console.log(`Round ${roundId} | 第${EDITION}届集帅杯 | ${LEVEL}级 | ${DATE}`);

  // Step 4: Verify rankings
  console.log('\n=== Online Rankings ===');
  const rankings = await get(`/api/rankings/${roundId}`);
  for (const r of rankings.rankings) {
    const name = playerNames[r.player1_id] || '?';
    console.log(`  ${r.rank}. ${name.padEnd(14)} ${r.wins}胜${r.losses}负  净分${r.net_points >= 0 ? '+' : ''}${r.net_points}  积分${r.points_earned}`);
  }
})();
