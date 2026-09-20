const http = require('http');

const ROUND = 33;
const matches = [
  [38,14, 22,12, 15,11],  // 雨,谷 vs 邱邱你呢,尘
  [10,8,  38,12, 9,15],   // 烽,Refined Pei vs 雨,尘
  [14,8,  10,22, 15,8],   // 谷,Refined Pei vs 烽,邱邱你呢
  [38,12, 14,22, 9,15],   // 雨,尘 vs 谷,邱邱你呢
  [38,8,  10,12, 11,15],  // 雨,Refined Pei vs 烽,尘
  [22,8,  10,14, 7,15],   // 邱邱你呢,Refined Pei vs 烽,谷
  [38,22, 14,12, 15,11],  // 雨,邱邱你呢 vs 谷,尘
  [8,12,  38,10, 8,15],   // Refined Pei,尘 vs 雨,烽
  [10,8,  14,22, 15,12],  // 烽,Refined Pei vs 谷,邱邱你呢
  [38,14, 10,22, 14,16],  // 雨,谷 vs 烽,邱邱你呢
  [8,12,  38,22, 5,15],   // Refined Pei,尘 vs 雨,邱邱你呢
  [14,8,  10,12, 12,15],  // 谷,Refined Pei vs 烽,尘
  [38,10, 22,12, 15,11],  // 雨,烽 vs 邱邱你呢,尘
  [38,8,  10,14, 15,9],   // 雨,Refined Pei vs 烽,谷
  [22,8,  14,12, 15,9]    // 邱邱你呢,Refined Pei vs 谷,尘
];
const names = {38:'雨',10:'烽',14:'谷',22:'邱邱你呢',12:'尘',8:'Refined Pei'};

async function submit(m, idx) {
  const body = JSON.stringify({
    round_id: ROUND,
    player1_id: m[0], player2_id: m[1],
    player3_id: m[2], player4_id: m[3],
    team1_score: m[4], team2_score: m[5]
  });
  return new Promise((resolve) => {
    const req = http.request('http://localhost:3000/api/matches/direct', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const r = JSON.parse(d);
        const tag = r.created ? 'OK' : r.updated ? 'UPDATED' : 'FAIL: ' + (r.error||'unknown');
        console.log((idx+1) + '. ' + names[m[0]]+','+names[m[1]] + ' vs ' + names[m[2]]+','+names[m[3]] + ' = ' + m[4]+':'+m[5] + ' -> ' + tag);
        resolve();
      });
    });
    req.write(body);
    req.end();
  });
}

(async () => {
  for (let i = 0; i < matches.length; i++) {
    await submit(matches[i], i);
  }
  console.log('--- ALL DONE ---');
})();
