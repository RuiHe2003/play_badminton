// dry-run：统计每人的交手次数（对手）与同队次数（搭档），并列出当前 rivals/partners 为空的玩家
// 只读，不写库
const initSql = require('D:/node_global/badminton-app/node_modules/sql.js');
const fs = require('fs');

(async () => {
  const SQL = await initSql();
  const db = new SQL.Database(fs.readFileSync('D:/node_global/badminton-app/data.db'));
  const q = (sql, params = []) => {
    const st = db.prepare(sql); if (params.length) st.bind(params);
    const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows;
  };

  const players = q('SELECT id, name, gender, rival1_id, rival2_id, rival3_id, rival4_id, rival5_id, partner1_id, partner2_id, partner3_id FROM players ORDER BY id');
  const nameOf = {}; players.forEach(p => nameOf[p.id] = p.name);
  const rivalCnt = {}, partnerCnt = {};   // me -> {other: n}
  const inc = (m, a, b) => { if (!a || !b || a === b) return; (m[a] = m[a] || {})[b] = (m[a][b] || 0) + 1; };

  // ---- 老数据：matches + teams ----
  for (const r of q(`
    SELECT t1.player1_id AS a1, t1.player2_id AS a2, t2.player1_id AS b1, t2.player2_id AS b2
    FROM matches m JOIN teams t1 ON t1.id = m.team1_id JOIN teams t2 ON t2.id = m.team2_id`)) {
    const A = [r.a1, r.a2].filter(Boolean), B = [r.b1, r.b2].filter(Boolean);
    for (const x of A) for (const y of B) { inc(rivalCnt, x, y); inc(rivalCnt, y, x); }
  }
  for (const t of q('SELECT player1_id, player2_id FROM teams WHERE player2_id IS NOT NULL')) {
    inc(partnerCnt, t.player1_id, t.player2_id); inc(partnerCnt, t.player2_id, t.player1_id);
  }

  // ---- 新引擎：event_ties（只算打过的）+ event_entry_members ----
  const memOf = {};   // entry_id -> [player_id]
  for (const m of q('SELECT entry_id, player_id FROM event_entry_members')) (memOf[m.entry_id] = memOf[m.entry_id] || []).push(m.player_id);
  const ties = q(`SELECT side1_entry_id, side2_entry_id, side1_entry2_id, side2_entry2_id FROM event_ties WHERE state = 'done' OR winner_entry_id IS NOT NULL`);
  for (const t of ties) {
    const s1 = [...(memOf[t.side1_entry_id] || []), ...(memOf[t.side1_entry2_id] || [])];
    const s2 = [...(memOf[t.side2_entry_id] || []), ...(memOf[t.side2_entry2_id] || [])];
    for (const x of s1) for (const y of s2) { inc(rivalCnt, x, y); inc(rivalCnt, y, x); }
    // 搭档：同侧同伴；非固搭时按「另一侧同伴位」交叉
    const base1 = memOf[t.side1_entry_id] || [], base2 = memOf[t.side2_entry_id] || [];
    const cross1 = memOf[t.side1_entry2_id] || [], cross2 = memOf[t.side2_entry2_id] || [];
    for (const a of base1) { for (const b of base1) inc(partnerCnt, a, b); for (const b of cross2) inc(partnerCnt, a, b); }
    for (const a of cross1) { for (const b of cross1) inc(partnerCnt, a, b); for (const b of base2) inc(partnerCnt, a, b); }
    for (const a of base2) { for (const b of base2) inc(partnerCnt, a, b); for (const b of cross1) inc(partnerCnt, a, b); }
    for (const a of cross2) { for (const b of cross2) inc(partnerCnt, a, b); for (const b of base1) inc(partnerCnt, a, b); }
  }

  console.log('玩家总数:', players.length, '| 老 matches:', q('SELECT COUNT(*) c FROM matches')[0].c, '| 新 done ties:', ties.length);
  console.log('\n=== rivals / partners 为空的玩家（将被补默认值）===');
  for (const p of players) {
    const rivalsEmpty = ![p.rival1_id, p.rival2_id, p.rival3_id, p.rival4_id, p.rival5_id].some(Boolean);
    const partnersEmpty = ![p.partner1_id, p.partner2_id, p.partner3_id].some(Boolean);
    if (!rivalsEmpty && !partnersEmpty) continue;
    const top = m => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id, n]) => `${nameOf[id]}(${n})`).join('、') || '（无交手记录）';
    console.log(`#${p.id} ${p.name}${p.gender === 'male' ? '(男)' : '(女)'} | 对手空:${rivalsEmpty ? '是' : '否'} 搭档空:${partnersEmpty ? '是' : '否'}`);
    console.log(`   交手TOP3: ${top(rivalCnt[p.id])}`);
    console.log(`   搭档TOP3: ${top(partnerCnt[p.id])}`);
  }
  console.log('\n=== 已自行设置过的（不碰）===');
  for (const p of players) {
    const rivalsEmpty = ![p.rival1_id, p.rival2_id, p.rival3_id, p.rival4_id, p.rival5_id].some(Boolean);
    const partnersEmpty = ![p.partner1_id, p.partner2_id, p.partner3_id].some(Boolean);
    if (rivalsEmpty || partnersEmpty) console.log(`#${p.id} ${p.name} rivals:[${[p.rival1_id,p.rival2_id,p.rival3_id,p.rival4_id,p.rival5_id].filter(Boolean).map(i=>nameOf[i]).join(',')}] partners:[${[p.partner1_id,p.partner2_id,p.partner3_id].filter(Boolean).map(i=>nameOf[i]).join(',')}]`);
  }
  db.close();
})().catch(e => { console.error(e); process.exit(1); });
