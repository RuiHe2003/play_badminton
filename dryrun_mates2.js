// dry-run v2：修正新引擎统计口径
// - 真实出场取 event_tie_items.side1_players/side2_players（JSON entry 数组），
//   没有 items 时退化到 event_ties 的 side*_entry_id(+2)
// - entry→player：event_entry_members 优先；free 单人 entry 缺 members 时按 label 匹配 players.name
//   （欣欣杯 761-765 就是缺 members 的历史数据，label 即人名）
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
  const byName = {}; players.forEach(p => { if (!byName[p.name]) byName[p.name] = p.id; });
  const rivalCnt = {}, partnerCnt = {};
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

  // ---- 新引擎 ----
  const memOf = {};
  for (const m of q('SELECT entry_id, player_id FROM event_entry_members')) (memOf[m.entry_id] = memOf[m.entry_id] || []).push(m.player_id);
  const entries = q('SELECT id, label FROM event_entries');
  const labelOf = {}; entries.forEach(e => labelOf[e.id] = e.label);
  // entry→players：members 优先；free 单人 entry 缺 members 时按 label 匹配（唯一命中才用）
  const entryPlayers = eid => {
    if (memOf[eid] && memOf[eid].length) return memOf[eid];
    const lb = labelOf[eid];
    if (lb && byName[lb] != null) return [byName[lb]];
    return [];
  };
  let tieStat = { used: 0, skipped: 0, labelFallback: 0 };
  const ties = q(`SELECT id, side1_entry_id, side2_entry_id, side1_entry2_id, side2_entry2_id,
                         winner_entry_id, state FROM event_ties
                  WHERE state = 'done' OR winner_entry_id IS NOT NULL ORDER BY id`);
  const itemsByTie = {};
  for (const it of q('SELECT tie_id, side1_players, side2_players, winner_side FROM event_tie_items ORDER BY tie_id, seq, id')) {
    (itemsByTie[it.tie_id] = itemsByTie[it.tie_id] || []).push(it);
  }
  for (const t of ties) {
    let sidePairs = [];
    const its = (itemsByTie[t.id] || []).filter(x => x.winner_side !== 0);
    if (its.length) {
      // 有单项明细：按实际出场（side1_players/side2_players 是 entry 数组）
      for (const it of its) {
        const p1 = (JSON.parse(it.side1_players || '[]')).map(Number).filter(Boolean);
        const p2 = (JSON.parse(it.side2_players || '[]')).map(Number).filter(Boolean);
        if (p1.length && p2.length) sidePairs.push([p1, p2]);
      }
    } else {
      // 无明细：退化到 ties 的占位 entry
      const s1 = [t.side1_entry_id, t.side1_entry2_id].filter(Boolean);
      const s2 = [t.side2_entry_id, t.side2_entry2_id].filter(Boolean);
      if (s1.length && s2.length) sidePairs.push([s1, s2]);
    }
    if (!sidePairs.length) { tieStat.skipped++; continue; }
    tieStat.used++;
    for (const [e1, e2] of sidePairs) {
      const P1 = [...new Set(e1.flatMap(entryPlayers))];
      const P2 = [...new Set(e2.flatMap(entryPlayers))];
      if (memOf[e1[0]] === undefined && labelOf[e1[0]] && byName[labelOf[e1[0]]] != null) tieStat.labelFallback++;
      for (const x of P1) for (const y of P2) { inc(rivalCnt, x, y); inc(rivalCnt, y, x); }
      for (const arr of [P1, P2]) for (const a of arr) for (const b of arr) inc(partnerCnt, a, b);
    }
  }

  console.log('玩家:', players.length, '| 老 matches:', q('SELECT COUNT(*) c FROM matches')[0].c,
    '| 新 ties:', ties.length, '(采用', tieStat.used, '跳过', tieStat.skipped, 'label兜底', tieStat.labelFallback, ')');
  console.log('\n=== 欣欣杯 6 人（free 引擎）统计验证 ===');
  const xxb = ['21', '大圆太方', '等假期', '多喝水早睡', 'Ethereal', '伍翠莹'];
  for (const p of players) {
    if (!xxb.includes(p.name)) continue;
    const top = m => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, n]) => `${nameOf[id]}(${n})`).join('、') || '（无）';
    console.log(`#${p.id} ${p.name}: 交手 ${top(rivalCnt[p.id])} | 搭档 ${top(partnerCnt[p.id])}`);
  }
  console.log('\n=== 将被补默认值的玩家（rivals 或 partners 全空）===');
  let n = 0;
  for (const p of players) {
    const rivalsEmpty = ![p.rival1_id, p.rival2_id, p.rival3_id, p.rival4_id, p.rival5_id].some(Boolean);
    const partnersEmpty = ![p.partner1_id, p.partner2_id, p.partner3_id].some(Boolean);
    if (!rivalsEmpty && !partnersEmpty) continue;
    n++;
    const top = m => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id, c]) => `${nameOf[id]}(${c})`).join('、') || '（无记录→不设）';
    console.log(`#${p.id} ${p.name}${p.gender === 'male' ? '(男)' : '(女)'} [对手空:${rivalsEmpty ? 'Y' : '-'} 搭档空:${partnersEmpty ? 'Y' : '-'}]`);
    if (rivalsEmpty) console.log(`   对手→ ${top(rivalCnt[p.id])}`);
    if (partnersEmpty) console.log(`   搭档→ ${top(partnerCnt[p.id])}`);
  }
  console.log('\n合计将被补:', n, '人');
  db.close();
})().catch(e => { console.error(e); process.exit(1); });
