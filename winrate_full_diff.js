// 全库对比：当前库 vs 备份库，所有 matches 比分差异 + rounds 日期差异
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const A = path.join(__dirname, 'data.db');
const B = process.argv[2] || path.join(__dirname, 'data.db.bak-logdel-20261024_154157');

initSqlJs().then(SQL => {
  const dba = new SQL.Database(fs.readFileSync(A));
  const dbb = new SQL.Database(fs.readFileSync(B));
  const q = (db, sql, p) => { const st = db.prepare(sql); if (p) st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };

  const ma = q(dba, 'SELECT * FROM matches');
  const mb = q(dbb, 'SELECT * FROM matches');
  const mapB = new Map(mb.map(m => [m.id, m]));

  const names = {};
  for (const p of q(dba, 'SELECT id, name, real_name FROM players')) names[p.id] = p.real_name || p.name;
  const teamInfo = (db, tid) => {
    const t = q(db, 'SELECT player1_id, player2_id FROM teams WHERE id=?', [tid])[0];
    if (!t) return '(队伍已删)';
    return [t.player1_id, t.player2_id].filter(Boolean).map(x => names[x] || ('#' + x)).join('/');
  };

  console.log('=== matches 差异（当前 vs 备份）===');
  let n = 0;
  for (const m of ma) {
    const b = mapB.get(m.id);
    if (!b) { console.log(`  [新增] match#${m.id} round=${m.round_id} ${m.team1_score}:${m.team2_score}`); n++; continue; }
    if (b.team1_score !== m.team1_score || b.team2_score !== m.team2_score) {
      const swapped = (b.team1_score === m.team2_score && b.team2_score === m.team1_score);
      console.log(`  [${swapped ? '比分颠倒' : '比分变更'}] match#${m.id} round=${m.round_id}`);
      console.log(`      备份 ${b.team1_score}:${b.team2_score}  (${teamInfo(dbb, b.team1_id)} vs ${teamInfo(dbb, b.team2_id)})`);
      console.log(`      当前 ${m.team1_score}:${m.team2_score}  (${teamInfo(dba, m.team1_id)} vs ${teamInfo(dba, m.team2_id)})`);
      console.log(`      受影响的选手: ${[...new Set([b.team1_id, b.team2_id].flatMap(t => { const t2 = q(dba, 'SELECT player1_id, player2_id FROM teams WHERE id=?', [t])[0]; return t2 ? [t2.player1_id, t2.player2_id] : []; }))].filter(Boolean).map(x => names[x]).join('、')}`);
      n++;
    }
  }
  for (const b of mb) if (!ma.find(m => m.id === b.id)) { console.log(`  [删除] match#${b.id} round=${b.round_id} ${b.team1_score}:${b.team2_score}`); n++; }
  console.log('差异场次:', n);

  console.log('\n=== rounds 日期/届数/级别差异 ===');
  const ra = q(dba, 'SELECT id, tournament_id, edition, date, level FROM rounds');
  const rb = new Map(q(dbb, 'SELECT id, tournament_id, edition, date, level FROM rounds').map(r => [r.id, r]));
  const tn = {};
  for (const t of q(dba, 'SELECT id, name FROM tournaments')) tn[t.id] = t.name;
  let rn = 0;
  for (const r of ra) {
    const b = rb.get(r.id);
    if (!b) { console.log(`  [新增] round#${r.id} ${tn[r.tournament_id]}第${r.edition}届 ${r.date}`); rn++; continue; }
    if (b.date !== r.date || b.edition !== r.edition || b.level !== r.level) {
      console.log(`  [变更] round#${r.id} ${tn[r.tournament_id]}第${r.edition}届: 日期 ${b.date}->${r.date}, 届 ${b.edition}->${r.edition}, 级 ${b.level}->${r.level}`);
      rn++;
    }
  }
  for (const [id, b] of rb) if (!ra.find(r => r.id === id)) { console.log(`  [删除] round#${id} ${tn[b.tournament_id]}第${b.edition}届 ${b.date}`); rn++; }
  console.log('差异轮次:', rn);

  dba.close(); dbb.close();
});
