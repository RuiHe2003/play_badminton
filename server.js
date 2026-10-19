const express = require('express');
const path = require('path');
const { initDatabase, saveDatabase, getDb } = require('./database');

const app = express();

app.use(express.json({ limit: '10mb' }));
// 静态资源缓存策略：
// - HTML 不带版本号，必须每次回源校验，否则改版后用户会拿到旧页面
// - 其他资源（css/js/图片）靠 URL 上的 ?v=N 破缓存，可放心让 CDN 缓存一段时间
//   （改版后忘记换版本号 = CDN 继续喂旧文件，这是 2026-10-15 线上样式错乱的根因）
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.html?$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

let db;

// 派生的全量缓存（荣誉 / 年度最高 / 赛事索引）全部挂在写操作上失效。
// 集中在这里而不是散落到各写接口 —— 以后新加写接口不会漏掉。
function invalidateDerivedCaches() {
  honorsCache = null;      // 荣誉是全量排名推导的，录一场比赛就可能翻盘
  yearBestCache = null;    // 年度最高名次同样是全量回放推导的
  eventEditionRoundMap = null;  // 新赛事「届」→ round_id 索引
  eventTourneyMap = null;       // 新赛事 → tournament_id 索引
}

// 批量写入用的事务包装：saveDatabase() 每次都会把整个库（约 2MB）写回磁盘，
// 生成小组对阵动辄上百次插入，逐个保存会把一次「生成」拖成好几秒。
// tx() 内所有写操作只落盘一次；_defer 计数支持嵌套。
let _deferDepth = 0;
function tx(fn) {
  _deferDepth++;
  try {
    return fn();
  } finally {
    _deferDepth--;
    if (_deferDepth === 0) {
      saveDatabase();
      invalidateDerivedCaches();
    }
  }
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  const isSelect = /^\s*(SELECT|WITH)/i.test(sql);
  if (params.length > 0) {
    stmt.bind(params);
  }
  if (isSelect) {
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  stmt.step();
  stmt.free();
  if (_deferDepth > 0) return null;   // 事务中，等 tx() 收尾统一落盘
  saveDatabase();
  invalidateDerivedCaches();
  return null;
}

// ==================== Players ====================

app.get('/api/players', (req, res) => {
  res.json(query('SELECT id, name, gender, real_name, avatar FROM players ORDER BY name'));
});

// 选手查询页的列表：附带每人「参加赛事届数」。
// 这里的「届」= 该选手实际出场过的 round 所属的 distinct (tournament_id, edition)。
// 同一赛事同一届打了多轮只算 1 届 —— 这是产品口径，不要改成按场次计。
// 单独开一个接口而不是往 /api/players 里加字段：后者被首页/管理端等多处复用，
// 加字段会让那些地方白白多背一次聚合查询的开销。
app.get('/api/players/with-editions', (req, res) => {
  const players = query('SELECT id, name, gender, real_name, avatar FROM players ORDER BY name');
  // 两个来源：老赛事的 teams 表，以及新版赛事的参赛单元成员。
  // 新版赛事不写 teams（团体赛一个单元 4~8 人，装不进 player1/player2 两列），
  // 所以这里必须并一份，否则参加过新赛事的选手「届数」会少算。
  // 新版赛事的镜像轮次挂在「届」上（event_editions.round_id），不在赛事上
  // （events.round_id 对新赛事恒为 NULL），所以两路都要查。
  const rows = query(`
    SELECT DISTINCT x.pid AS pid, r.tournament_id AS tid, r.edition AS ed
    FROM (
      SELECT player1_id AS pid, round_id FROM teams
      UNION ALL
      SELECT player2_id AS pid, round_id FROM teams WHERE player2_id IS NOT NULL
      UNION ALL
      SELECT m.player_id AS pid, ev.round_id AS round_id
      FROM event_entry_members m
      JOIN event_entries e ON e.id = m.entry_id
      JOIN events ev ON ev.id = e.event_id
      WHERE ev.round_id IS NOT NULL
      UNION ALL
      SELECT m.player_id AS pid, ed.round_id AS round_id
      FROM event_entry_members m
      JOIN event_entries e ON e.id = m.entry_id
      JOIN event_editions ed ON ed.id = e.edition_id
      WHERE ed.round_id IS NOT NULL
    ) x
    JOIN rounds r ON r.id = x.round_id
    WHERE x.pid IS NOT NULL
  `);
  // 按选手聚合成 Set，再取 size —— 即该选手参加过的届数
  const byPlayer = {};
  for (const row of rows) {
    if (!byPlayer[row.pid]) byPlayer[row.pid] = new Set();
    byPlayer[row.pid].add(row.tid + '-' + row.ed);
  }
  res.json(players.map(p => ({ ...p, editions: byPlayer[p.id] ? byPlayer[p.id].size : 0 })));
});

app.post('/api/players', (req, res) => {
  const { name, gender, real_name } = req.body;
  if (!name || !gender) return res.status(400).json({ error: '需要比赛ID和性别' });
  try {
    query('INSERT INTO players (name, gender, real_name) VALUES (?, ?, ?)', [name, gender, real_name || '']);
    const id = query('SELECT id FROM players WHERE name = ?', [name])[0]?.id;
    res.json({ id, name, gender, real_name: real_name || '' });
  } catch (e) {
    res.status(400).json({ error: '该比赛ID已存在' });
  }
});

app.put('/api/players/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const player = query('SELECT * FROM players WHERE id = ?', [id])[0];
  if (!player) return res.status(404).json({ error: '选手不存在' });
  const { name, bio, gender, real_name } = req.body;
  if (!name && bio === undefined && !gender && real_name === undefined) return res.status(400).json({ error: '需要修改的字段' });
  const updates = [];
  const params = [];
  if (name) { updates.push('name = ?'); params.push(name); }
  if (bio !== undefined) { updates.push('bio = ?'); params.push(bio); }
  if (gender) { updates.push('gender = ?'); params.push(gender); }
  if (real_name !== undefined) { updates.push('real_name = ?'); params.push(real_name); }
  params.push(id);
  try {
    query(`UPDATE players SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ id, name: name || player.name, gender: gender || player.gender, bio: bio !== undefined ? bio : player.bio, real_name: real_name !== undefined ? real_name : player.real_name });
  } catch (e) {
    res.status(400).json({ error: '该比赛ID已存在' });
  }
});

app.post('/api/players/:id/avatar', (req, res) => {
  const id = parseInt(req.params.id);
  const player = query('SELECT * FROM players WHERE id = ?', [id])[0];
  if (!player) return res.status(404).json({ error: '选手不存在' });
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ error: '缺少头像数据' });
  query('UPDATE players SET avatar = ? WHERE id = ?', [avatar, id]);
  res.json({ success: true });
});

app.delete('/api/players/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const player = query('SELECT * FROM players WHERE id = ?', [id])[0];
  if (!player) return res.status(404).json({ error: '选手不存在' });
  const teams = query('SELECT id FROM teams WHERE player1_id = ? OR player2_id = ?', [id, id]);
  const teamIds = teams.map(t => t.id);
  if (teamIds.length) {
    const placeholders = teamIds.map(() => '?').join(',');
    query(`DELETE FROM matches WHERE team1_id IN (${placeholders}) OR team2_id IN (${placeholders})`, [...teamIds, ...teamIds]);
    query(`DELETE FROM teams WHERE id IN (${placeholders})`, teamIds);
  }
  query('DELETE FROM players WHERE id = ?', [id]);
  res.json({ success: true });
});

// ==================== Tournaments ====================

app.get('/api/tournaments', (req, res) => {
  const rows = query('SELECT id, name, type, level, icon FROM tournaments');
  // is_event / event_id：该赛事是不是「创建赛事」新建的，以及对应的事件 id。
  // 新赛事在赛事查询/积分排名里地位与老赛事完全同等，只有「比赛管理」的下拉要把它排掉
  // —— 那些赛事由赛事工作台自己管轮次，混进「创建新轮次」会让人录出两套数据。
  // 前台点赛事图标时也靠 event_id 决定跳「轮次详情」还是「赛事工作台」。
  const evByTid = {};
  for (const r of query('SELECT id, tournament_id FROM events WHERE tournament_id IS NOT NULL')) evByTid[r.tournament_id] = r.id;
  res.json(rows.map(t => ({ ...t, is_event: evByTid[t.id] ? 1 : 0, event_id: evByTid[t.id] || null })));
});

app.post('/api/tournaments', (req, res) => {
  const { name, type, level } = req.body;
  if (!name || !type) return res.status(400).json({ error: '需要名称和类型' });
  if (!['singles', 'mens_doubles', 'mixed_doubles'].includes(type)) return res.status(400).json({ error: '类型无效' });
  const lvl = level || 1000;
  try {
    query('INSERT INTO tournaments (name, type, level) VALUES (?, ?, ?)', [name, type, lvl]);
    const id = query('SELECT id FROM tournaments WHERE name = ?', [name])[0]?.id;
    res.json({ id, name, type, level: lvl });
  } catch (e) {
    res.status(400).json({ error: '该赛事已存在' });
  }
});

// 赛事图标：icon 传空字符串表示删除图标
app.post('/api/tournaments/:id/icon', (req, res) => {
  const id = parseInt(req.params.id);
  const t = query('SELECT * FROM tournaments WHERE id = ?', [id])[0];
  if (!t) return res.status(404).json({ error: '赛事不存在' });
  const { icon } = req.body;
  if (icon === undefined) return res.status(400).json({ error: '缺少图标数据' });
  query('UPDATE tournaments SET icon = ? WHERE id = ?', [icon, id]);
  res.json({ success: true, icon });
});

// ==================== Rounds ====================

app.get('/api/tournaments/:id/rounds', (req, res) => {
  const rounds = query(`
    SELECT r.id, r.tournament_id, r.edition, r.round_number, r.date, r.level as round_level,
           t.name as tournament_name, t.type as tournament_type
    FROM rounds r
    JOIN tournaments t ON r.tournament_id = t.id
    WHERE r.tournament_id = ?
    ORDER BY r.date DESC, r.id DESC
  `, [req.params.id]);
  res.json(rounds);
});

app.get('/api/rounds', (req, res) => {
  const rounds = query(`
    SELECT r.id, r.tournament_id, r.edition, r.round_number, r.date, r.level as round_level,
           t.name as tournament_name, t.type as tournament_type
    FROM rounds r
    JOIN tournaments t ON r.tournament_id = t.id
    ORDER BY r.date ASC, r.id ASC
  `);
  res.json(rounds);
});

app.post('/api/rounds', (req, res) => {
  const { tournament_id, edition, date, participants, level } = req.body;
  if (!tournament_id || !edition || !date) {
    return res.status(400).json({ error: '需要赛事ID、届数、日期' });
  }

  const tournament = query('SELECT * FROM tournaments WHERE id = ?', [tournament_id])[0];
  if (!tournament) return res.status(400).json({ error: '赛事不存在' });

  const lvl = level || 1000;

  // 检查是否已有该赛事该届的轮次，有则复用
  const existing = query('SELECT id FROM rounds WHERE tournament_id = ? AND edition = ? ORDER BY id DESC LIMIT 1', [tournament_id, edition]);
  let roundId;
  if (existing.length) {
    roundId = existing[0].id;
    query('UPDATE rounds SET date = ?, level = ? WHERE id = ?', [date, lvl, roundId]);
    query('DELETE FROM matches WHERE round_id = ?', [roundId]);
    query('DELETE FROM teams WHERE round_id = ?', [roundId]);
  } else {
    query('INSERT INTO rounds (tournament_id, edition, round_number, date, level) VALUES (?, ?, 1, ?, ?)', [tournament_id, edition, date, lvl]);
    roundId = query('SELECT id FROM rounds WHERE tournament_id = ? AND edition = ? ORDER BY id DESC LIMIT 1', [tournament_id, edition])[0]?.id;
  }

  if (participants) {
    for (const p of participants) {
      if (tournament.type === 'singles') {
        query('INSERT INTO teams (round_id, player1_id, player2_id) VALUES (?, ?, NULL)', [roundId, p.player1_id]);
      } else {
        query('INSERT INTO teams (round_id, player1_id, player2_id) VALUES (?, ?, ?)', [roundId, p.player1_id, p.player2_id]);
      }
    }
  }

  res.json({ id: roundId, edition, round_number: 1, date, level: lvl });
});

// ==================== Teams ====================

app.get('/api/rounds/:id/teams', (req, res) => {
  const teams = query(`
    SELECT t.id as team_id, t.player1_id, t.player2_id,
           p1.name as player1_name, p1.gender as player1_gender,
           p2.name as player2_name, p2.gender as player2_gender
    FROM teams t
    JOIN players p1 ON t.player1_id = p1.id
    LEFT JOIN players p2 ON t.player2_id = p2.id
    WHERE t.round_id = ?
  `, [req.params.id]);
  res.json(teams);
});

// ==================== Matches ====================

// Direct match creation for free-doubles tournaments (e.g. 狗王杯)
// Accepts 4 player IDs + scores, auto-creates teams
app.post('/api/matches/direct', (req, res) => {
  const { round_id, player1_id, player2_id, player3_id, player4_id, team1_score, team2_score } = req.body;
  if (!round_id || !player1_id || !player2_id || !player3_id || !player4_id || team1_score === undefined || team2_score === undefined) {
    return res.status(400).json({ error: '缺少比赛信息' });
  }
  const ids = [player1_id, player2_id, player3_id, player4_id];
  if (new Set(ids).size !== 4) return res.status(400).json({ error: '4名选手不能重复' });
  if (team1_score > 31 || team2_score > 31) return res.status(400).json({ error: '比分不能超过31分' });
  if (team1_score < 0 || team2_score < 0) return res.status(400).json({ error: '比分不能为负数' });

  function findOrCreateTeam(p1, p2) {
    let sql, params;
    if (p2) {
      sql = 'SELECT id FROM teams WHERE round_id = ? AND player1_id = ? AND player2_id = ?';
      params = [round_id, p1, p2];
    } else {
      sql = 'SELECT id FROM teams WHERE round_id = ? AND player1_id = ? AND player2_id IS NULL';
      params = [round_id, p1];
    }
    let team = query(sql, params);
    if (!team.length) {
      query('INSERT INTO teams (round_id, player1_id, player2_id) VALUES (?, ?, ?)', [round_id, p1, p2 || null]);
      team = query(sql, params);
    }
    return team[0].id;
  }
  const team1_id = findOrCreateTeam(player1_id, player2_id || null);
  const team2_id = findOrCreateTeam(player3_id, player4_id || null);

  const existing = query('SELECT id FROM matches WHERE round_id = ? AND ((team1_id = ? AND team2_id = ?) OR (team1_id = ? AND team2_id = ?))',
    [round_id, team1_id, team2_id, team2_id, team1_id]);
  if (existing.length > 0) {
    query('UPDATE matches SET team1_score = ?, team2_score = ? WHERE id = ?',
      [team1_score, team2_score, existing[0].id]);
    res.json({ id: existing[0].id, updated: true });
  } else {
    query('INSERT INTO matches (round_id, team1_id, team2_id, team1_score, team2_score) VALUES (?, ?, ?, ?, ?)',
      [round_id, team1_id, team2_id, team1_score, team2_score]);
    const id = query('SELECT id FROM matches WHERE round_id = ? AND team1_id = ? AND team2_id = ?', [round_id, team1_id, team2_id])[0]?.id;
    res.json({ id, created: true });
  }
});

app.post('/api/matches', (req, res) => {
  const { round_id, team1_id, team2_id, team1_score, team2_score } = req.body;
  if (!round_id || !team1_id || !team2_id || team1_score === undefined || team2_score === undefined) {
    return res.status(400).json({ error: '缺少比赛信息' });
  }
  if (team1_score > 31 || team2_score > 31) return res.status(400).json({ error: '比分不能超过31分' });
  if (team1_score < 0 || team2_score < 0) return res.status(400).json({ error: '比分不能为负数' });
  const existing = query('SELECT id FROM matches WHERE round_id = ? AND ((team1_id = ? AND team2_id = ?) OR (team1_id = ? AND team2_id = ?))',
    [round_id, team1_id, team2_id, team2_id, team1_id]);
  if (existing.length > 0) {
    query('UPDATE matches SET team1_score = ?, team2_score = ? WHERE id = ?',
      [team1_score, team2_score, existing[0].id]);
    res.json({ id: existing[0].id, updated: true });
  } else {
    query('INSERT INTO matches (round_id, team1_id, team2_id, team1_score, team2_score) VALUES (?, ?, ?, ?, ?)',
      [round_id, team1_id, team2_id, team1_score, team2_score]);
    const id = query('SELECT id FROM matches WHERE round_id = ? AND team1_id = ? AND team2_id = ?', [round_id, team1_id, team2_id])[0]?.id;
    res.json({ id, created: true });
  }
});

app.put('/api/matches/:id', (req, res) => {
  const { team1_score, team2_score } = req.body;
  const match = query('SELECT * FROM matches WHERE id = ?', [req.params.id])[0];
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  if (team1_score > 31 || team2_score > 31) return res.status(400).json({ error: '比分不能超过31分' });
  if (team1_score < 0 || team2_score < 0) return res.status(400).json({ error: '比分不能为负数' });
  query('UPDATE matches SET team1_score = ?, team2_score = ? WHERE id = ?', [team1_score, team2_score, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/matches/:id', (req, res) => {
  const match = query('SELECT * FROM matches WHERE id = ?', [req.params.id])[0];
  if (!match) return res.status(404).json({ error: '比赛不存在' });
  query('DELETE FROM matches WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

app.put('/api/rounds/:id', (req, res) => {
  const round = query('SELECT id FROM rounds WHERE id = ?', [req.params.id])[0];
  if (!round) return res.status(404).json({ error: '轮次不存在' });
  const { edition, date, level } = req.body;
  if (edition !== undefined) {
    query('UPDATE rounds SET edition = ? WHERE id = ?', [edition, req.params.id]);
  }
  if (date !== undefined) {
    query('UPDATE rounds SET date = ? WHERE id = ?', [date, req.params.id]);
  }
  if (level !== undefined) {
    query('UPDATE rounds SET level = ? WHERE id = ?', [level, req.params.id]);
  }
  res.json({ success: true });
});

app.delete('/api/rounds/:id', (req, res) => {
  const round = query('SELECT * FROM rounds WHERE id = ?', [req.params.id])[0];
  if (!round) return res.status(404).json({ error: '轮次不存在' });
  query('DELETE FROM matches WHERE round_id = ?', [req.params.id]);
  query('DELETE FROM teams WHERE round_id = ?', [req.params.id]);
  query('DELETE FROM rounds WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/matches/:roundId', (req, res) => {
  const roundId = parseInt(req.params.roundId);
  const matches = query(`
    SELECT m.id, m.round_id, m.team1_id, m.team2_id, m.team1_score, m.team2_score,
           t1.player1_id as t1p1id, p1.name as t1p1name, p1.gender as t1p1gender,
           t1.player2_id as t1p2id, p2.name as t1p2name,
           t2.player1_id as t2p1id, p3.name as t2p1name, p3.gender as t2p1gender,
           t2.player2_id as t2p2id, p4.name as t2p2name
    FROM matches m
    JOIN teams t1 ON m.team1_id = t1.id
    JOIN teams t2 ON m.team2_id = t2.id
    JOIN players p1 ON t1.player1_id = p1.id
    LEFT JOIN players p2 ON t1.player2_id = p2.id
    JOIN players p3 ON t2.player1_id = p3.id
    LEFT JOIN players p4 ON t2.player2_id = p4.id
    WHERE m.round_id = ?
    ORDER BY m.id
  `, [roundId]);
  res.json(matches);
});

// ==================== Ranking Calculation ====================

function calculateRoundRankings(roundId, level) {
  const teams = query('SELECT * FROM teams WHERE round_id = ?', [roundId]);
  const matches = query('SELECT * FROM matches WHERE round_id = ?', [roundId]);

  if (level === undefined) {
    const round = query('SELECT level FROM rounds WHERE id = ?', [roundId])[0];
    level = round ? round.level : 1000;
  }

  const stats = {};
  for (const t of teams) {
    stats[t.id] = { team_id: t.id, player1_id: t.player1_id, player2_id: t.player2_id, wins: 0, losses: 0, points_for: 0, points_against: 0 };
  }

  for (const m of matches) {
    if (!stats[m.team1_id] || !stats[m.team2_id]) continue;
    stats[m.team1_id].points_for += m.team1_score;
    stats[m.team1_id].points_against += m.team2_score;
    stats[m.team2_id].points_for += m.team2_score;
    stats[m.team2_id].points_against += m.team1_score;
    if (m.team1_score > m.team2_score) { stats[m.team1_id].wins++; stats[m.team2_id].losses++; }
    else { stats[m.team2_id].wins++; stats[m.team1_id].losses++; }
  }

  let rankings = Object.values(stats);
  rankings.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return (b.points_for - b.points_against) - (a.points_for - a.points_against);
  });

  const n = rankings.length;
  const d = Math.round(level / n);

  // 并列处理：胜场与净胜分完全相同的队伍并列同名次，积分取所跨名次的平均值
  const tied = [];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n
      && rankings[j + 1].wins === rankings[i].wins
      && (rankings[j + 1].points_for - rankings[j + 1].points_against) === (rankings[i].points_for - rankings[i].points_against)) {
      j++;
    }
    // 名次 i+1 .. j+1 并列，积分取平均
    let sum = 0;
    for (let k = i; k <= j; k++) sum += level - d * k;
    const avg = Math.round(sum / (j - i + 1));
    for (let k = i; k <= j; k++) {
      tied.push({
        ...rankings[k], rank: i + 1,
        net_points: rankings[k].points_for - rankings[k].points_against,
        points_earned: avg
      });
    }
    i = j + 1;
  }

  return { rankings: tied, d, teamCount: n };
}

app.get('/api/rankings/:roundId', (req, res) => {
  const roundId = parseInt(req.params.roundId);
  // 必须自己查出 level / 赛事名再交给分发器：
  // 之前直接传 undefined，calculate*Rankings 里 d = Math.round(undefined / n) = NaN，
  // 整张表的 points_earned 全是 NaN。前端虽未调用，但接口对外是能拿到的，不能留 NaN。
  const r = query(`SELECT r.level AS lvl, t.name AS tname
    FROM rounds r JOIN tournaments t ON t.id = r.tournament_id
    WHERE r.id = ?`, [roundId])[0];
  if (!r) return res.status(404).json({ error: '轮次不存在' });
  res.json(roundRankings(roundId, r.lvl, r.tname));
});

// Per-player ranking for free-doubles tournaments (e.g. 狗王杯, men's doubles only)
function calculatePlayerRankings(roundId, level) {
  const maleIds = new Set(query("SELECT id FROM players WHERE gender = 'male'").map(r => r.id));
  const matches = query(`
    SELECT m.team1_id, m.team2_id, m.team1_score, m.team2_score,
           t1.player1_id as t1p1, t1.player2_id as t1p2,
           t2.player1_id as t2p1, t2.player2_id as t2p2
    FROM matches m
    JOIN teams t1 ON m.team1_id = t1.id
    JOIN teams t2 ON m.team2_id = t2.id
    WHERE m.round_id = ?
  `, [roundId]);

  const playerStats = {};
  for (const m of matches) {
    const t1w = m.team1_score > m.team2_score;
    const t1players = [[m.t1p1, m.t1p2].filter(Boolean)];
    const t2players = [[m.t2p1, m.t2p2].filter(Boolean)];
    for (const pid of t1players[0]) {
      if (!maleIds.has(pid)) continue;
      if (!playerStats[pid]) playerStats[pid] = { wins: 0, losses: 0, pf: 0, pa: 0 };
      playerStats[pid].wins += t1w ? 1 : 0;
      playerStats[pid].losses += t1w ? 0 : 1;
      playerStats[pid].pf += m.team1_score;
      playerStats[pid].pa += m.team2_score;
    }
    for (const pid of t2players[0]) {
      if (!maleIds.has(pid)) continue;
      if (!playerStats[pid]) playerStats[pid] = { wins: 0, losses: 0, pf: 0, pa: 0 };
      playerStats[pid].wins += t1w ? 0 : 1;
      playerStats[pid].losses += t1w ? 1 : 0;
      playerStats[pid].pf += m.team2_score;
      playerStats[pid].pa += m.team1_score;
    }
  }

  let rankings = Object.entries(playerStats).map(([pid, s]) => ({ player_id: parseInt(pid), ...s }));
  rankings.sort((a, b) => b.wins - a.wins || (b.pf - b.pa) - (a.pf - a.pa));

  const n = rankings.length;
  const d = n ? Math.round(level / n) : 0;

  // 并列处理：胜场与净胜分完全相同的选手并列同名次，积分取所跨名次的平均值
  const tied = [];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n
      && rankings[j + 1].wins === rankings[i].wins
      && (rankings[j + 1].pf - rankings[j + 1].pa) === (rankings[i].pf - rankings[i].pa)) {
      j++;
    }
    let sum = 0;
    for (let k = i; k <= j; k++) sum += Math.max(0, level - d * k);
    const avg = Math.round(sum / (j - i + 1));
    for (let k = i; k <= j; k++) {
      tied.push({ ...rankings[k], rank: i + 1, net_points: rankings[k].pf - rankings[k].pa, points_earned: avg });
    }
    i = j + 1;
  }

  return { rankings: tied, d };
}

// ==================== 排名分发器 ====================
// 「这一轮的名次怎么算」只有一个入口，全站都从这里走。
// 老赛事原封不动：狗王杯走个人排名，其余走队伍排名（行为与以前逐字节一致）。
// 新赛事（有 events 行）走赛事引擎 —— 名次来自小组积分榜 + 淘汰签表，而不是简单循环赛胜负。
// 之所以做成分发器而不是在赛事侧另起一套积分：只有这样，总积分榜、荣誉、选手资料页、
// 赛事查询才会自动把新赛事算进去，真正做到「地位同等」，且不会出现两套口径。

// 一名参赛单元包含哪些选手。团体赛一个单元可以有多人。
// 老赛事的排名行没有 member_ids，就退化成 player1/player2 —— 这也是它零回归的原因。
function membersOf(rank) {
  if (rank && Array.isArray(rank.member_ids) && rank.member_ids.length) return rank.member_ids;
  if (!rank) return [];
  return [rank.player1_id, rank.player2_id].filter(Boolean);
}

// roundId 名次。tournamentName 可选；不传会自动查（多一次查询，换来调用点不必都改）。
function roundRankings(roundId, level, tournamentName) {
  const ed = editionByRound(roundId);
  if (ed) return computeEventRanking(ed, level);
  let tname = tournamentName;
  if (tname === undefined) {
    const r = query('SELECT t.name AS n FROM rounds r JOIN tournaments t ON t.id = r.tournament_id WHERE r.id = ?', [roundId])[0];
    tname = r ? r.n : '';
  }
  if (tname === '狗王杯') return calculatePlayerRankings(roundId, level);
  return calculateRoundRankings(roundId, level);
}

// ==================== Points Calculation ====================

// upToRound（可选）：只统计「到该轮为止」的比赛，用于按时间回放历史榜单。
// 不传 = 全量（现状行为，所有既有调用方不受影响）。
function computePoints(excludeRoundId, upToRound) {
  const tournaments = query('SELECT * FROM tournaments');
  const allPlayers = query('SELECT id, name, gender, real_name FROM players ORDER BY name');

  const playerPoints = {};
  for (const p of allPlayers) {
    playerPoints[p.id] = { player_id: p.id, name: p.name, real_name: p.real_name, gender: p.gender, tournaments: {}, total_points: 0 };
  }

  for (const tour of tournaments) {
    let allRounds = query('SELECT * FROM rounds WHERE tournament_id = ? ORDER BY level, date ASC, id ASC', [tour.id]);
    if (!allRounds.length) continue;
    if (excludeRoundId) allRounds = allRounds.filter(r => r.id !== excludeRoundId);
    // 回放截断：日期是统一的 YYYY-MM-DD，字符串比较可直接用。
    // 同日多轮靠 id 定序 —— 已核查全库同日最多 2 轮且 id 单调，排序稳定。
    if (upToRound) allRounds = allRounds.filter(r =>
      r.date < upToRound.date || (r.date === upToRound.date && r.id <= upToRound.id));
    if (!allRounds.length) continue;

    const levelGroups = {};
    for (const round of allRounds) {
      const lvl = round.level;
      if (!levelGroups[lvl]) levelGroups[lvl] = [];
      levelGroups[lvl].push(round);
    }

    for (const [lvlStr, rounds] of Object.entries(levelGroups)) {
      const lvl = parseInt(lvlStr);
      const acc = {};
      for (const p of allPlayers) {
        acc[p.id] = { points: 0, lastD: null };
      }

    // 新版「创建赛事」的赛事一律以 events 表判定，绝不用名字猜
    // （用户可以给新赛事起名叫「狗王杯」，按名字判定会把它错当成自由双打）。
    const ev = eventByTournamentId(tour.id);
    const isFree = !ev && tour.name === '狗王杯';
    for (const round of rounds) {
      const ed = ev ? editionByRound(round.id) : null;
      const result = ed
        ? computeEventRanking(ed, lvl)
        : (isFree ? calculatePlayerRankings(round.id, lvl) : calculateRoundRankings(round.id, lvl));
      const { rankings, d } = result;
      const participants = new Set();

      for (const rank of rankings) {
        if (isFree) {
          participants.add(rank.player_id);
          if (acc[rank.player_id]) {
            acc[rank.player_id].points = rank.points_earned;
            acc[rank.player_id].lastD = d;
          }
        } else {
          // 一名参赛单元可能不止两个人（团体赛 4~8 人），故统一走 member_ids。
          // 老赛事没有 member_ids 字段，membersOf() 会退化成 player1/player2，行为不变。
          for (const pid of membersOf(rank)) {
            participants.add(pid);
            if (acc[pid]) {
              acc[pid].points = rank.points_earned;
              acc[pid].lastD = d;
            }
          }
        }
      }

        for (const p of allPlayers) {
          if (!participants.has(p.id) && acc[p.id].lastD !== null) {
            acc[p.id].points = Math.max(0, acc[p.id].points - Math.floor(acc[p.id].lastD / 2));
          }
        }
      }

      const latestRound = rounds[rounds.length - 1];
      const latestEd = ev ? editionByRound(latestRound.id) : null;
      const latestRank = latestEd
        ? computeEventRanking(latestEd, lvl)
        : (isFree ? calculatePlayerRankings(latestRound.id, lvl) : calculateRoundRankings(latestRound.id, lvl));
      const latestParticipants = new Set();
      for (const rank of latestRank.rankings) {
        if (isFree) {
          latestParticipants.add(rank.player_id);
        } else {
          for (const pid of membersOf(rank)) latestParticipants.add(pid);
        }
      }

      const key = tour.name + '(' + lvl + '级)';
      for (const p of allPlayers) {
        if (acc[p.id].points === 0 && acc[p.id].lastD === null) continue;
        const rank = latestRank.rankings.find(r => isFree ? r.player_id === p.id : membersOf(r).includes(p.id));
        if (latestParticipants.has(p.id) && rank) {
          playerPoints[p.id].tournaments[key] = {
            points: acc[p.id].points, edition: latestRound.edition, level: lvl,
            participated: true, rank: rank.rank, d: acc[p.id].lastD, type: tour.type
          };
        } else {
          playerPoints[p.id].tournaments[key] = {
            points: acc[p.id].points, edition: latestRound.edition, level: lvl,
            participated: false, deducted: true, rank: null, d: acc[p.id].lastD, type: tour.type
          };
        }
      }
    }
  }

  for (const pid in playerPoints) {
    const pts = Object.values(playerPoints[pid].tournaments).map(t => t.points).sort((a, b) => b - a);
    // 男生取积分最高的4个赛事，女生取3个
    const topN = playerPoints[pid].gender === 'male' ? 4 : 3;
    playerPoints[pid].total_points = pts.slice(0, topN).reduce((s, v) => s + v, 0);
  }

  const result = Object.values(playerPoints).sort((a, b) => b.total_points - a.total_points);
  result.forEach((p, idx) => p.overall_rank = idx + 1);
  const ranks = {};
  result.filter(p => p.total_points > 0).forEach((p, idx) => ranks[p.player_id] = idx + 1);
  return { points: result, ranks };
}

app.get('/api/points', (req, res) => {
  const excludeRoundId = req.query.excludeRoundId ? parseInt(req.query.excludeRoundId) : null;
  const { points } = computePoints(excludeRoundId);
  res.json(points);
});

function computeGenderRanks(points) {
  const male = points.filter(p => p.gender === 'male').sort((a, b) => b.total_points - a.total_points);
  const female = points.filter(p => p.gender === 'female').sort((a, b) => b.total_points - a.total_points);
  const ranks = {};
  male.forEach((p, idx) => ranks[p.player_id] = idx + 1);
  female.forEach((p, idx) => ranks[p.player_id] = idx + 1);
  return ranks;
}

// ==================== 年度最高名次（总积分榜按年切片） ====================
// 选手页「年度最高」用：把「总积分榜」按时间回放，但只在「同一年度内」比较，
// 取每人本年度排到过的最好名次；对外取「最近一个自己有有效排名的年度」
// （跨年、还没比赛之前继续显示上一年度成绩，不会突然变「无」）。
// 名次口径与「积分排名」页完全一致：分男/女各自排序，同性别第 idx+1 名。
//
// 【为什么改成年度口径】
//  生涯口径会把 2024-12 那两场（当时全榜只有 7 个男生有分）的虚高名次永久保留，
//  只能靠门槛去拦。年度口径下 2024 年度因从未达标而整体失效，虚高名次自然废弃。
//  代价是数字普遍变差：年度时点是生涯时点的子集，且榜单分母逐年变大。
//  实测 2026 年度 vs 旧生涯口径：26 人数字变大 / 0 人变小 / 35 人不变。
//
// 两道门槛（缺一不可，否则名次虚高）：
//  1) 只记录「该选手自己积分 > 0」的时点 —— 没上榜就谈不上名次。
//  2) 榜上有分的人数必须达标才作数（见下）。没有这条，2024-12 ~ 2025-05 这段
//     （全榜最多 15 个男生有分）会让参赛者人人拿到"年度最高第1名" ——
//     实测 6 人并列第1、10 人并列第2，毫无区分度。
//
// 【门槛怎么定，以及为什么不能拿「全库注册人数」当分母】
//   need = max(绝对下限, 该性别「截至该时点实际打过比赛的人数」的一半)
//   - 绝对下限（男17/女14）防止榜单太小时名次自带光环：只看比例不行，
//     第一场已参赛 7 人 → 一半才 4，7 个人里排第 1 照样算数，等于没门槛。
//   - 分母用「已参赛人数」而不是「全库人数」：players 表没有注册时间，
//     且只要往选手库加一批还没打比赛的新人，「全库人数」就会涨 ——
//     players 加 40 个男的，门槛从 17 顶到 37，而榜上有分的还是 33 人，
//     从此再也够不到，所有人的最高排名会卡死在旧值。用已参赛人数则不受影响。
//   - 圈子真的变大（新人也开始打球）时，门槛会自动跟着抬高，含金量不被稀释。
//   - 门槛不能再收紧：实测「男25/女20」会把真正当过榜首的选手误伤成第2名。
// 与 honorsCache 同款：全量推导 + 单点缓存 + 写操作失效。
const CAREER_MIN_RANKED = { male: 17, female: 14 };

let yearBestCache = null;

function computeYearBestRanks() {
  const rounds = query('SELECT id, tournament_id, edition, date FROM rounds ORDER BY date ASC, id ASC');
  const tourName = {};
  for (const t of query('SELECT id, name FROM tournaments')) tourName[t.id] = t.name;
  const genderOf = {};
  for (const p of query('SELECT id, gender FROM players')) genderOf[p.id] = p.gender;

  // 每轮有哪些人下场（单打 player2_id 可能为空，双打两人都算）
  const roundPlayers = {};
  for (const t of query('SELECT round_id, player1_id, player2_id FROM teams')) {
    const s = roundPlayers[t.round_id] || (roundPlayers[t.round_id] = []);
    if (t.player1_id) s.push(t.player1_id);
    if (t.player2_id) s.push(t.player2_id);
  }
  // 新版赛事不写 teams 表（团体赛一个参赛单元有 4~8 人，装不进 player1/player2 两列），
  // 所以「已参赛人数」的分母要额外把赛事单元成员并进来，否则门槛会算小、名次虚高。
  // 镜像轮次挂在届上（event_editions.round_id）；events.round_id 那路是给更早的
  // 迁移数据兜底，两路都查（同一人重复 push 无害，下游都按 Set 用）。
  for (const m of query(`SELECT ev.round_id AS round_id, m.player_id AS player_id
                         FROM event_entry_members m
                         JOIN event_entries e ON e.id = m.entry_id
                         JOIN events ev ON ev.id = e.event_id
                         WHERE ev.round_id IS NOT NULL`)) {
    const s = roundPlayers[m.round_id] || (roundPlayers[m.round_id] = []);
    s.push(m.player_id);
  }
  for (const m of query(`SELECT ed.round_id AS round_id, m.player_id AS player_id
                         FROM event_entry_members m
                         JOIN event_entries e ON e.id = m.entry_id
                         JOIN event_editions ed ON ed.id = e.edition_id
                         WHERE ed.round_id IS NOT NULL`)) {
    const s = roundPlayers[m.round_id] || (roundPlayers[m.round_id] = []);
    s.push(m.player_id);
  }

  const byYear = {};                                       // year -> { pid -> 该年度最好名次 }
  const played = { male: new Set(), female: new Set() };   // 累计已参赛选手
  for (const cut of rounds) {
    for (const pid of (roundPlayers[cut.id] || [])) {
      const g = genderOf[pid];
      if (g === 'male' || g === 'female') played[g].add(pid);
    }

    const { points } = computePoints(null, cut);
    const ranks = computeGenderRanks(points);   // 全量参与排名，保证名次跟榜单页对得上
    const ranked = { male: 0, female: 0 };
    for (const p of points) if (p.total_points > 0) ranked[p.gender]++;

    const need = {};
    for (const g of ['male', 'female']) {
      need[g] = Math.max(CAREER_MIN_RANKED[g], Math.ceil(played[g].size / 2));
    }

    const yr = cut.date.slice(0, 4);
    const bag = byYear[yr] || (byYear[yr] = {});
    for (const p of points) {
      if (!(p.total_points > 0)) continue;                    // 该时点自己没上榜 → 不记
      if (ranked[p.gender] < need[p.gender]) continue;         // 榜单太小 → 名次不作数
      const r = ranks[p.player_id];
      if (!r) continue;
      const cur = bag[p.player_id];
      if (!cur || r < cur.rank) {
        bag[p.player_id] = {
          rank: r,
          date: cut.date,
          tournament: tourName[cut.tournament_id] || '',
          edition: cut.edition
        };
      }
    }
  }

  // 只保留「最近一个自己有有效排名的年度」：按年份升序覆盖，越晚的年度最终胜出。
  // 于是跨年、还没比赛（或本年度尚未达标 / 自己本年度没参赛）时，
  // 会自然沿用上一年度的成绩，而不是突然变「无」。
  const best = {};
  for (const y of Object.keys(byYear).sort()) {
    for (const pid of Object.keys(byYear[y])) {
      best[pid] = { ...byYear[y][pid], year: y };
    }
  }
  return best;
}

// 趋势基线 = 「最新一个已经打出成绩的一轮」。
// 不能简单取 rounds 里最新的一行：赛事引擎一建届次就会落一条镜像 rounds，
// 这种空轮次（还没录成绩/只录了名单）被排除后积分一个都不变，
// 于是整张榜的升降箭头会集体消失——只剩空轮次比总决赛新时就正好踩中。
function latestScoredRoundId() {
  const rows = query(`
    SELECT r.id FROM rounds r
    WHERE EXISTS (SELECT 1 FROM matches m WHERE m.round_id = r.id)
       OR EXISTS (SELECT 1 FROM event_editions e
                  JOIN event_ties t ON t.edition_id = e.id
                  WHERE e.round_id = r.id AND t.winner_entry_id IS NOT NULL)
    ORDER BY r.date DESC, r.id DESC LIMIT 1`);
  return rows.length ? rows[0].id : null;
}

app.get('/api/points/trend', (req, res) => {
  const latestRoundId = latestScoredRoundId();
  if (latestRoundId === null) return res.json({ current: computePoints().points, deltas: {} });

  const current = computePoints();
  const prev = computePoints(latestRoundId);

  const curGenderRanks = computeGenderRanks(current.points);
  const prevGenderRanks = computeGenderRanks(prev.points);

  const deltas = {};
  for (const pid in curGenderRanks) {
    const curRank = curGenderRanks[pid];
    const prevRank = prevGenderRanks[pid];
    if (prevRank !== undefined && prevRank !== curRank) {
      deltas[pid] = prevRank - curRank;
    }
  }
  res.json({ current: current.points, deltas });
});

// ==================== Query by Edition ====================

app.get('/api/editions', (req, res) => {
  const editions = query(`
    SELECT DISTINCT r.edition, t.name as tournament_name, t.id as tournament_id
    FROM rounds r
    JOIN tournaments t ON r.tournament_id = t.id
    ORDER BY r.edition DESC
  `);
  const grouped = {};
  for (const e of editions) {
    if (!grouped[e.edition]) grouped[e.edition] = { edition: e.edition, tournaments: [] };
    grouped[e.edition].tournaments.push({ id: e.tournament_id, name: e.tournament_name });
  }
  res.json(Object.values(grouped));
});

app.get('/api/query/edition/:edition', (req, res) => {
  const edition = parseInt(req.params.edition);
  const rounds = query(`
    SELECT r.id, r.tournament_id, r.edition, r.round_number, r.date, r.level as round_level,
           t.name as tournament_name, t.type as tournament_type
    FROM rounds r
    JOIN tournaments t ON r.tournament_id = t.id
    WHERE r.edition = ?
    ORDER BY r.date ASC, r.id ASC
  `, [edition]);
  const result = [];
  for (const round of rounds) {
    const ranking = roundRankings(round.id, round.round_level, round.tournament_name);
    const teams = query(`
      SELECT t.id as team_id, t.player1_id, t.player2_id,
             p1.name as player1_name, p2.name as player2_name
      FROM teams t
      JOIN players p1 ON t.player1_id = p1.id
      LEFT JOIN players p2 ON t.player2_id = p2.id
      WHERE t.round_id = ?
    `, [round.id]);
    result.push({ ...round, teams, ranking });
  }
  res.json(result);
});

app.get('/api/query/round/:roundId', (req, res) => {
  const round = query(`
    SELECT r.*, t.name as tournament_name, t.type as tournament_type
    FROM rounds r
    JOIN tournaments t ON r.tournament_id = t.id
    WHERE r.id = ?
  `, [req.params.roundId])[0];
  if (!round) return res.status(404).json({ error: '轮次不存在' });
  const ranking = roundRankings(round.id, round.level, round.tournament_name);
  const teams = query(`
    SELECT t.id as team_id, t.player1_id, t.player2_id,
           p1.name as player1_name, p2.name as player2_name
    FROM teams t
    JOIN players p1 ON t.player1_id = p1.id
    LEFT JOIN players p2 ON t.player2_id = p2.id
    WHERE t.round_id = ?
  `, [round.id]);
  const matches = query(`
    SELECT m.*, p1.name as t1p1name, p2.name as t1p2name, p3.name as t2p1name, p4.name as t2p2name
    FROM matches m
    JOIN teams t1 ON m.team1_id = t1.id
    JOIN teams t2 ON m.team2_id = t2.id
    JOIN players p1 ON t1.player1_id = p1.id
    LEFT JOIN players p2 ON t1.player2_id = p2.id
    JOIN players p3 ON t2.player1_id = p3.id
    LEFT JOIN players p4 ON t2.player2_id = p4.id
    WHERE m.round_id = ?
  `, [round.id]);
  res.json({ ...round, teams, ranking, matches });
});

// ==================== Honors（荣誉：冠/亚/季） ====================
// 荣誉口径（产品定义，别改）：
//   把每一轮(round)按赛事类型排名，取前 3 名，对应 冠军/亚军/季军。
//   - 常规赛事（含双打）：按「队」排名，队里两名选手共享该名次。
//   - 狗王杯：轮内按「个人」排名（calculatePlayerRankings），只取男选手 —— 与
//     个人资料页的胜场/场次口径完全一致，避免两处数字打架。
//   同一级别多冠时取"最近一届"作为门面展示，见 pickTopHonor()。
// 数据现状：25 轮，每 (赛事,届) 恰好 1 轮，所以无需按届再聚合；
// 将来若出现一届多轮，需把这里改成按 (tournament_id, edition) 取最好名次。
const HONOR_ICON = { 1: '🏆', 2: '🥈', 3: '🥉' };
const HONOR_LABEL = { 1: '冠军', 2: '亚军', 3: '季军' };

// 算一次全量荣誉，按 player_id 归集。调用方（个人页/全站榜）自行裁剪。
function computeAllHonors() {
  const rounds = query(`
    SELECT r.id, r.edition, r.level, r.date, r.tournament_id,
           t.name AS tournament_name, t.type AS tournament_type, t.icon AS tournament_icon
    FROM rounds r JOIN tournaments t ON r.tournament_id = t.id
    ORDER BY r.id
  `);

  const byPlayer = {};
  const push = (pid, rec) => {
    if (!pid) return;
    if (!byPlayer[pid]) byPlayer[pid] = [];
    byPlayer[pid].push(rec);
  };

  for (const rd of rounds) {
    const isFree = rd.tournament_name === '狗王杯';
    // 分发器已内置「新赛事走赛事引擎 / 狗王杯走个人排名 / 其余走队伍排名」的判断，
    // 这里统一调用即可 —— 新赛事的冠亚季会自然出现在荣誉里。
    const { rankings } = roundRankings(rd.id, rd.level, rd.tournament_name);
    for (const row of rankings) {
      if (row.rank > 3) continue;   // 只关心前三
      const base = {
        tier: row.rank,
        tier_label: HONOR_LABEL[row.rank],
        tier_icon: HONOR_ICON[row.rank],
        tournament_id: rd.tournament_id,
        tournament_name: rd.tournament_name,
        tournament_icon: rd.tournament_icon || '',
        edition: rd.edition,
        level: rd.level,
        date: rd.date,
        wins: row.wins,
        losses: row.losses
      };
      if (isFree) {
        push(row.player_id, { ...base, partner_name: null });
      } else {
        // 奖给参赛单元里的每个人，两人单元互相记为搭档。
        // 三人及以上（团体赛队伍）没有「搭档」概念，一律留空，不能取「另一个队员」硬凑。
        const ids = membersOf(row);
        for (const pid of ids) {
          let partnerName = null;
          if (ids.length === 2) {
            const other = ids.find(x => x !== pid);
            const op = other ? query('SELECT name, real_name FROM players WHERE id = ?', [other])[0] : null;
            partnerName = op ? (op.real_name || op.name) : null;
          }
          push(pid, { ...base, partner_name: partnerName });
        }
      }
    }
  }

  // 排序：级别降序 → 同级别按时间近的在前（门面展示"同级取最近"依赖这个顺序）
  for (const pid of Object.keys(byPlayer)) {
    byPlayer[pid].sort((a, b) =>
      (b.level - a.level) || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || (b.edition - a.edition)
    );
  }
  return byPlayer;
}

// 从荣誉列表里挑"门面"：优先冠军(按级别最高、同级最近) → 无冠则亚军 → 无亚则季军。
// 返回 null 表示这位选手还没有任何前三。
function pickTopHonor(honors) {
  if (!honors || !honors.length) return null;
  for (const tier of [1, 2, 3]) {
    const hit = honors.find(h => h.tier === tier);   // honors 已按级别+时间排好
    if (hit) return hit;
  }
  return null;
}

// 汇总每人冠/亚/季数量，供列表与详情共用
function summarizeHonors(honors) {
  const s = { gold: 0, silver: 0, bronze: 0, total: 0 };
  for (const h of honors || []) {
    if (h.tier === 1) s.gold++;
    else if (h.tier === 2) s.silver++;
    else if (h.tier === 3) s.bronze++;
  }
  s.total = s.gold + s.silver + s.bronze;
  return s;
}

// 选手查询列表用：一次算出所有人的冠亚季 + 门面荣誉。
// 单独开接口而不是塞进 /api/players/with-editions —— 那个接口被列表和联想复用，
// 荣誉计算要跑全部 25 轮排名，开销大得多，不该让联想也跟着背。
let honorsCache = null;
app.get('/api/players/with-honors', (req, res) => {
  const players = query('SELECT id, name, gender, real_name, avatar FROM players ORDER BY name');
  if (!honorsCache) honorsCache = computeAllHonors();
  res.json(players.map(p => {
    const h = honorsCache[p.id] || [];
    return { ...p, honors: summarizeHonors(h), top_honor: pickTopHonor(h) };
  }));
});

// 个人荣誉清单页用：返回该选手全部荣誉（已按级别降序、同级近的在前）+ 汇总
app.get('/api/player/:name/honors', (req, res) => {
  let player = query('SELECT id, name, real_name FROM players WHERE name = ?', [req.params.name])[0];
  if (!player) player = query('SELECT id, name, real_name FROM players WHERE real_name = ?', [req.params.name])[0];
  if (!player) return res.status(404).json({ error: '选手不存在' });
  const honors = computeAllHonors()[player.id] || [];
  res.json({ player, honors, summary: summarizeHonors(honors) });
});

// ==================== Player Stats ====================

app.get('/api/player/:name', (req, res) => {
  let player = query('SELECT id, name, gender, bio, avatar, real_name, partner1_id, partner2_id, partner3_id, rival1_id, rival2_id, rival3_id, rival4_id, rival5_id FROM players WHERE name = ?', [req.params.name])[0];
  if (!player) player = query('SELECT id, name, gender, bio, avatar, real_name, partner1_id, partner2_id, partner3_id, rival1_id, rival2_id, rival3_id, rival4_id, rival5_id FROM players WHERE real_name = ?', [req.params.name])[0];
  if (!player) return res.status(404).json({ error: '选手不存在' });

  const roundIds = [...new Set([
    ...query('SELECT DISTINCT round_id FROM teams WHERE player1_id = ?', [player.id]).map(r => r.round_id),
    ...query('SELECT DISTINCT round_id FROM teams WHERE player2_id = ?', [player.id]).map(r => r.round_id),
    // 新版赛事：选手是通过参赛单元成员表挂上来的，不在 teams 里。
    // 漏掉这一段的话，新赛事会进总积分榜，却不进这位选手的「比赛记录」，两处数字打架。
    ...query(`SELECT DISTINCT ed.round_id AS round_id
              FROM event_entry_members m
              JOIN event_entries e ON e.id = m.entry_id
              JOIN event_editions ed ON ed.id = e.edition_id
              WHERE m.player_id = ? AND ed.round_id IS NOT NULL`, [player.id]).map(r => r.round_id)
  ])];

  let totalWins = 0, totalMatches = 0;
  const pointsHistory = [];

  for (const rid of roundIds) {
    const round = query('SELECT r.*, t.name as tournament_name FROM rounds r JOIN tournaments t ON r.tournament_id = t.id WHERE r.id = ?', [rid])[0];
    if (!round) continue;
    const isFree = round.tournament_name === '狗王杯';
    const { rankings } = roundRankings(rid, round.level, round.tournament_name);
    const playerRank = isFree
      ? rankings.find(r => r.player_id === player.id)
      : rankings.find(r => membersOf(r).includes(player.id));
    if (playerRank) {
      totalWins += playerRank.wins;
      totalMatches += playerRank.wins + playerRank.losses;
      pointsHistory.push({
        tournament: round.tournament_name, edition: round.edition, round: round.round_number, date: round.date,
        level: round.level, rank: playerRank.rank, wins: playerRank.wins, losses: playerRank.losses,
        net_points: playerRank.net_points, points_earned: playerRank.points_earned
      });
    }
  }

  // Ensure bio/avatar exist for old players
  if (!player.bio) player.bio = '';
  if (!player.avatar) player.avatar = '';

  // Fetch partners
  const partners = [];
  for (const pid of [player.partner1_id, player.partner2_id, player.partner3_id]) {
    if (pid) {
      const p = query('SELECT id, name, real_name, gender, avatar FROM players WHERE id = ?', [pid])[0];
      if (p) partners.push(p);
    }
  }

  // Fetch rivals
  const rivals = [];
  for (const pid of [player.rival1_id, player.rival2_id, player.rival3_id, player.rival4_id, player.rival5_id]) {
    if (pid) {
      const p = query('SELECT id, name, real_name, gender, avatar FROM players WHERE id = ?', [pid])[0];
      if (p) rivals.push(p);
    }
  }

  // 年度最高名次：总积分榜按年切片，取「最近一个自己有有效排名的年度」的最好名次
  if (!yearBestCache) yearBestCache = computeYearBestRanks();
  const yearBest = yearBestCache[player.id] || null;

  res.json({
    player: { ...player, partners, rivals },
    stats: {
      total_matches: totalMatches, total_wins: totalWins,
      win_rate: totalMatches > 0 ? Math.round((totalWins / totalMatches) * 100) : 0,
      year_best_rank: yearBest ? yearBest.rank : null,
      year_best_year: yearBest ? yearBest.year : null,
      year_best_date: yearBest ? yearBest.date : null,
      year_best_tournament: yearBest ? yearBest.tournament : null,
      year_best_edition: yearBest ? yearBest.edition : null
    },
    points_history: pointsHistory
  });
});

app.put('/api/players/:id/partners', (req, res) => {
  const id = parseInt(req.params.id);
  const player = query('SELECT * FROM players WHERE id = ?', [id])[0];
  if (!player) return res.status(404).json({ error: '选手不存在' });
  const { partner1_id, partner2_id, partner3_id } = req.body;
  for (const [key, val] of [['partner1_id', partner1_id], ['partner2_id', partner2_id], ['partner3_id', partner3_id]]) {
    if (val !== undefined) {
      if (val !== null && !query('SELECT id FROM players WHERE id = ?', [val]).length) {
        return res.status(400).json({ error: '搭档不存在' });
      }
      query(`UPDATE players SET ${key} = ? WHERE id = ?`, [val, id]);
    }
  }
  res.json({ success: true });
});

app.put('/api/players/:id/rivals', (req, res) => {
  const id = parseInt(req.params.id);
  const player = query('SELECT * FROM players WHERE id = ?', [id])[0];
  if (!player) return res.status(404).json({ error: '选手不存在' });
  const { rival1_id, rival2_id, rival3_id, rival4_id, rival5_id } = req.body;
  for (const [key, val] of [['rival1_id', rival1_id], ['rival2_id', rival2_id], ['rival3_id', rival3_id], ['rival4_id', rival4_id], ['rival5_id', rival5_id]]) {
    if (val !== undefined) {
      if (val !== null && !query('SELECT id FROM players WHERE id = ?', [val]).length) {
        return res.status(400).json({ error: '对手不存在' });
      }
      query(`UPDATE players SET ${key} = ? WHERE id = ?`, [val, id]);
    }
  }
  res.json({ success: true });
});

// ==================== Head to Head ====================

// 新版赛事引擎的交手记录。
// 引擎的赛果全存在 event_ties / event_tie_items / event_tie_games 里，matches、teams
// 一张表都不沾（团体赛一个单元 4~8 人，也塞不进 teams 的 player1/player2 两列）。
// 于是「对阵信息」必须在这里单独再取一遍并回去 —— 否则新赛事永远不出现在 H2H 里。
// 通用对阵：A 方 id 数组（1~2 人）vs B 方 id 数组（1~2 人）。
// 口径：同侧所有人必须都在同一边——双打时两人都得同队才算这组固定搭档出场。
function eventHeadToHead(aIds, bIds) {
  const out = [];
  const hasAll = (arr, ids) => ids.every(id => arr.includes(id));
  const eds = query('SELECT * FROM event_editions WHERE round_id IS NOT NULL');
  if (!eds.length) return out;
  const pmap = {};
  for (const p of query('SELECT id, name, real_name FROM players')) pmap[p.id] = p;
  const who = ids => ids.map(id => ({ id, name: (pmap[id] || {}).name || '', real_name: (pmap[id] || {}).real_name || '' }));

  for (const ed of eds) {
    const ctx = editionCtx(ed.id);
    if (!ctx) continue;
    const event = ctx.event;
    const trow = query('SELECT name FROM tournaments WHERE id = ?', [event.tournament_id])[0];
    const tourName = (trow && trow.name) || event.name;
    const graph = loadEventGraph(ed.id);
    for (const t of graph.ties) {
      if (!t.winner_entry_id || !t.side1_entry_id || !t.side2_entry_id) continue;
      const m1 = tieSideMembers(graph, t, 1);
      const m2 = tieSideMembers(graph, t, 2);
      if (!((hasAll(m1, aIds) && hasAll(m2, bIds)) || (hasAll(m2, aIds) && hasAll(m1, bIds)))) continue;

      const oc = tieOutcome(graph, t, ctx.gameNeed);
      // 有局分就显示局分（与老赛事的 15:13 同观感）；没录局分退化成大场比分
      const hasPts = (oc.p1 || oc.p2) > 0;
      out.push({
        date: ed.date, tournament: tourName, edition: ed.edition, round: 1,
        team1: { players: who(m1), score: hasPts ? oc.p1 : oc.i1 },
        team2: { players: who(m2), score: hasPts ? oc.p2 : oc.i2 }
      });
    }
  }
  return out;
}

app.get('/api/headtohead', (req, res) => {
  // A 方 / B 方各 1~2 人：a1（必填）+ a2（可选搭档） vs b1（必填）+ b2（可选搭档）
  const { a1, a2, b1, b2, name1, name2 } = req.query;
  const na1 = String(a1 || name1 || '').trim();   // 兼容旧参数 name1/name2
  const nb1 = String(b1 || name2 || '').trim();
  const na2 = String(a2 || '').trim();
  const nb2 = String(b2 || '').trim();
  if (!na1 || !nb1) return res.status(400).json({ error: 'A 方和 B 方都至少需要一位选手' });

  const findP = nm => {
    let p = query('SELECT id, name, gender, bio, avatar, real_name FROM players WHERE name = ?', [nm])[0];
    if (!p) p = query('SELECT id, name, gender, bio, avatar, real_name FROM players WHERE real_name = ?', [nm])[0];
    return p;
  };
  const A = [na1, na2].filter(Boolean).map(findP);
  const B = [nb1, nb2].filter(Boolean).map(findP);
  if (A.some(p => !p) || B.some(p => !p)) return res.status(404).json({ error: '选手不存在' });
  const aIds = A.map(p => p.id), bIds = B.map(p => p.id);
  if (new Set(aIds.concat(bIds)).size !== aIds.length + bIds.length) {
    return res.status(400).json({ error: '同一位选手不要重复填写' });
  }

  // 候选场次：两边各至少有一个相关选手，再在内存里做「同侧全员都在」的精确过滤
  const ids = aIds.concat(bIds);
  const ph = ids.map(() => '?').join(',');
  const allMatches = query(`
    SELECT m.*, r.date, r.edition, r.round_number, t.name as tournament_name,
           t1.player1_id as t1p1id, tp1.name as t1p1name, tp1.real_name as t1p1real,
           t1.player2_id as t1p2id, tp2.name as t1p2name, tp2.real_name as t1p2real,
           t2.player1_id as t2p1id, tp3.name as t2p1name, tp3.real_name as t2p1real,
           t2.player2_id as t2p2id, tp4.name as t2p2name, tp4.real_name as t2p2real
    FROM matches m
    JOIN rounds r ON m.round_id = r.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN teams t1 ON m.team1_id = t1.id
    JOIN teams t2 ON m.team2_id = t2.id
    JOIN players tp1 ON t1.player1_id = tp1.id
    LEFT JOIN players tp2 ON t1.player2_id = tp2.id
    JOIN players tp3 ON t2.player1_id = tp3.id
    LEFT JOIN players tp4 ON t2.player2_id = tp4.id
    WHERE (t1.player1_id IN (${ph}) OR t1.player2_id IN (${ph}))
      AND (t2.player1_id IN (${ph}) OR t2.player2_id IN (${ph}))
    ORDER BY r.date DESC
  `, ids.concat(ids, ids, ids));

  const hasAll = (arr, list) => list.every(id => arr.includes(id));
  const filtered = allMatches.filter(m => {
    const t1p = [m.t1p1id]; if (m.t1p2id) t1p.push(m.t1p2id);
    const t2p = [m.t2p1id]; if (m.t2p2id) t2p.push(m.t2p2id);
    // 同侧全员都在同一边才算（双打两人拆开当对手的场次不算这组搭档的对局）
    return (hasAll(t1p, aIds) && hasAll(t2p, bIds)) || (hasAll(t2p, aIds) && hasAll(t1p, bIds));
  });

  let aWins = 0, bWins = 0;
  const legacyMatches = filtered.map(m => ({
    date: m.date, tournament: m.tournament_name, edition: m.edition, round: m.round_number,
    team1: { players: [{ id: m.t1p1id, name: m.t1p1name, real_name: m.t1p1real || '' }, m.t1p2id ? { id: m.t1p2id, name: m.t1p2name, real_name: m.t1p2real || '' } : null].filter(Boolean), score: m.team1_score },
    team2: { players: [{ id: m.t2p1id, name: m.t2p1name, real_name: m.t2p1real || '' }, m.t2p2id ? { id: m.t2p2id, name: m.t2p2name, real_name: m.t2p2real || '' } : null].filter(Boolean), score: m.team2_score }
  }));
  // 胜负按「A 方第一位选手在哪边」判定
  const aAnchor = aIds[0];
  const countWin = m => {
    const aOnT1 = m.team1.players.some(x => x.id === aAnchor);
    if (aOnT1 ? m.team1.score > m.team2.score : m.team2.score > m.team1.score) aWins++;
    else bWins++;
  };
  legacyMatches.forEach(countWin);

  // 并上新版赛事引擎的交手记录，再按日期倒序
  const eventMatches = eventHeadToHead(aIds, bIds);
  eventMatches.forEach(countWin);
  const matches = legacyMatches.concat(eventMatches)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  res.json({
    teamA: A, teamB: B,
    player1: A[0], player2: B[0],   // 兼容旧字段
    head_to_head: { a_wins: aWins, b_wins: bWins, p1_wins: aWins, p2_wins: bWins, total: matches.length },
    matches
  });
});

// ==================== All Rounds with Teams ====================

app.get('/api/all-rounds', (req, res) => {
  const rounds = query(`
    SELECT r.id, r.tournament_id, r.edition, r.round_number, r.date,
           t.name as tournament_name, t.type as tournament_type
    FROM rounds r
    JOIN tournaments t ON r.tournament_id = t.id
    ORDER BY r.date ASC, r.id ASC
  `);
  for (const round of rounds) {
    round.teams = query(`
      SELECT t.id as team_id, t.player1_id, t.player2_id, p1.name as player1_name, p2.name as player2_name
      FROM teams t
      JOIN players p1 ON t.player1_id = p1.id
      LEFT JOIN players p2 ON t.player2_id = p2.id
      WHERE t.round_id = ?
    `, [round.id]);
  }
  res.json(rounds);
});

// ==================== Round Lookup ====================

app.get('/api/rounds/lookup', (req, res) => {
  const { tournamentId, edition } = req.query;
  if (!tournamentId || !edition) return res.status(400).json({ error: '需要赛事ID和届数' });
  const round = query(`
    SELECT r.id, r.tournament_id, r.edition, r.date, r.level as round_level,
           t.name as tournament_name, t.type as tournament_type
    FROM rounds r
    JOIN tournaments t ON r.tournament_id = t.id
    WHERE r.tournament_id = ? AND r.edition = ?
    ORDER BY r.date DESC, r.id DESC LIMIT 1
  `, [parseInt(tournamentId), parseInt(edition)]);
  if (!round.length) return res.json({ exists: false });
  const r = round[0];
  const teams = query(`
    SELECT t.id as team_id, t.player1_id, t.player2_id,
           p1.name as player1_name, p1.gender as player1_gender,
           p2.name as player2_name
    FROM teams t
    JOIN players p1 ON t.player1_id = p1.id
    LEFT JOIN players p2 ON t.player2_id = p2.id
    WHERE t.round_id = ?
  `, [r.id]);
  const matches = query(`
    SELECT m.id, m.round_id, m.team1_id, m.team2_id, m.team1_score, m.team2_score,
           t1.player1_id as t1p1id, p1.name as t1p1name,
           t1.player2_id as t1p2id, p2.name as t1p2name,
           t2.player1_id as t2p1id, p3.name as t2p1name,
           t2.player2_id as t2p2id, p4.name as t2p2name
    FROM matches m
    JOIN teams t1 ON m.team1_id = t1.id
    JOIN teams t2 ON m.team2_id = t2.id
    JOIN players p1 ON t1.player1_id = p1.id
    LEFT JOIN players p2 ON t1.player2_id = p2.id
    JOIN players p3 ON t2.player1_id = p3.id
    LEFT JOIN players p4 ON t2.player2_id = p4.id
    WHERE m.round_id = ?
  `, [r.id]);
  res.json({ exists: true, round: r, teams, matches });
});

// ==================== Filtered Round Query ====================

app.get('/api/query/rounds', (req, res) => {
  const { tournamentId, edition } = req.query;
  let sql = `
    SELECT r.id, r.tournament_id, r.edition, r.date, r.level as round_level,
           t.name as tournament_name, t.type as tournament_type
    FROM rounds r
    JOIN tournaments t ON r.tournament_id = t.id
    WHERE 1=1
  `;
  const params = [];
  if (tournamentId) { sql += ' AND r.tournament_id = ?'; params.push(parseInt(tournamentId)); }
  if (edition) { sql += ' AND r.edition = ?'; params.push(parseInt(edition)); }
  sql += ' ORDER BY r.date ASC, r.id ASC';

  const rounds = query(sql, params);
  for (const round of rounds) {
    const ranking = roundRankings(round.id, round.round_level, round.tournament_name);
    round.ranking = ranking;
    round.teams = query(`
      SELECT t.id as team_id, t.player1_id, t.player2_id,
             p1.name as player1_name, p1.real_name as player1_real, p2.name as player2_name, p2.real_name as player2_real
      FROM teams t
      JOIN players p1 ON t.player1_id = p1.id
      LEFT JOIN players p2 ON t.player2_id = p2.id
      WHERE t.round_id = ?
    `, [round.id]);
    round.matches = query(`
      SELECT m.id, m.round_id, m.team1_id, m.team2_id, m.team1_score, m.team2_score,
             p1.name as t1p1name, p1.real_name as t1p1real, p2.name as t1p2name, p2.real_name as t1p2real,
             p3.name as t2p1name, p3.real_name as t2p1real, p4.name as t2p2name, p4.real_name as t2p2real
      FROM matches m
      JOIN teams t1 ON m.team1_id = t1.id
      JOIN teams t2 ON m.team2_id = t2.id
      JOIN players p1 ON t1.player1_id = p1.id
      LEFT JOIN players p2 ON t1.player2_id = p2.id
      JOIN players p3 ON t2.player1_id = p3.id
      LEFT JOIN players p4 ON t2.player2_id = p4.id
      WHERE m.round_id = ?
      ORDER BY m.id
    `, [round.id]);
  }
  res.json(rounds);
});

// ==================== 创建赛事（新版赛事引擎） ====================
//
// 【两层结构：赛事定义 vs 届次】
//   events          = 赛事定义，只描述「赛制」：类型（单项/团体）、赛制、局制、团体项目与
//                     出场顺序、小组配置、季军赛。和老 tournaments 一样可以办很多届，
//                     本身不带日期、级别、参赛名单。
//   event_editions  = 某一届。日期、级别、参赛单元、对阵、比分全在这一层；
//                     edition.round_id 是镜像到 rounds 的行 —— 积分 / 荣誉 / 选手资料页都认它。
//
// 统一模型：届(edition) → 对抗(tie) → 单项(tie_item) → 局(tie_game)
//   · 单项赛：一个 tie 就是一场比赛，挂 1 个 tie_item，按局制逐局录分。
//   · 团体赛：一个 tie 是一场团体对抗，挂 N 个 tie_item（管理员勾选的男单/女单/男双/女双/混双）。
// 一套录入 UI / 排名计算 / 净胜局净胜分通吃两种类型 —— 少一条分支就少一类 bug。
//
// 【为什么新赛事要镜像 tournaments + rounds】
//   赛事查询、积分排名、荣誉、选手资料页全部是老代码，它们认的是 tournaments/rounds/teams。
//   要让新赛事「地位同等」，最稳的做法不是再写一套页面，而是让新赛事也有一行 tournaments、
//   每一届各有一行 rounds，再让「排名分发器」把这些轮次的名次交给赛事引擎算（见 roundRankings）。
//   于是积分/荣誉/资料页一行都不用改，口径也不会分叉。

const TEAM_ITEM_DEFS = [
  { code: 'ms', name: '男单', size: 1, gender: 'male' },
  { code: 'ws', name: '女单', size: 1, gender: 'female' },
  { code: 'md', name: '男双', size: 2, gender: 'male' },
  { code: 'wd', name: '女双', size: 2, gender: 'female' },
  { code: 'xd', name: '混双', size: 2, gender: 'mixed' }
];
const TEAM_ITEM_MAP = Object.fromEntries(TEAM_ITEM_DEFS.map(d => [d.code, d]));

// 赛制四选一。rr = 单循环（只循环不淘汰，小组数可配，1 组就是全员大循环）
// free = 非固搭双打（狗王杯那类）：没有固定组合，每场临时配对，名次记在个人头上
const EVENT_FORMATS = [
  { code: 'rr', name: '单循环赛', hasGroup: true },
  { code: 'ko', name: '淘汰赛', hasGroup: false },
  { code: 'group_ko', name: '小组赛+淘汰赛', hasGroup: true },
  { code: 'free', name: '非固搭双打', hasGroup: false }
];
const EVENT_FORMAT_MAP = Object.fromEntries(EVENT_FORMATS.map(f => [f.code, f]));
const eventFormatLabel = f => (EVENT_FORMAT_MAP[f] || { name: f }).name;
const formatHasGroup = f => !!(EVENT_FORMAT_MAP[f] || EVENT_FORMAT_MAP.rr).hasGroup;

// 非固搭双打的项目。它决定按什么性别统计个人战绩（狗王杯只统计男选手，这里放开）。
const FREE_KINDS = [
  { code: 'md', name: '男双', gender: 'male' },
  { code: 'wd', name: '女双', gender: 'female' },
  { code: 'xd', name: '混双', gender: null }          // null = 男女都算
];
const FREE_KIND_MAP = Object.fromEntries(FREE_KINDS.map(k => [k.code, k]));
const freeKindLabel = k => (FREE_KIND_MAP[k] || FREE_KINDS[0]).name;
// 非固搭的赛事类型（写进 tournaments.type，让分男女的页面能认出来）
const TOUR_TYPE_OF_FREE_KIND = { md: 'mens_doubles', wd: 'womens_doubles', xd: 'mixed_doubles' };

// 种子排序依据。entry = 按录入顺序（原行为）；points = 按参赛单元成员的总积分之和降序。
// 种子只影响「蛇形分组的先后」和「固定交叉时的落位」，不影响任何比分计算。
const SEED_BY_DEFS = [{ code: 'entry', name: '按录入顺序' }, { code: 'points', name: '按总积分（种子）' }];
const SEED_BY_MAP = Object.fromEntries(SEED_BY_DEFS.map(d => [d.code, d]));
const seedByLabel = s => (SEED_BY_MAP[s] || SEED_BY_DEFS[0]).name;

// 分组方式。snake = 按种子蛇形自动分；manual = 管理员在本届设置里手动指定每个单元的组号。
const GROUP_MODE_DEFS = [{ code: 'snake', name: '自动蛇形分组' }, { code: 'manual', name: '手动指定分组' }];
const GROUP_MODE_MAP = Object.fromEntries(GROUP_MODE_DEFS.map(d => [d.code, d]));
const groupModeLabel = s => (GROUP_MODE_MAP[s] || GROUP_MODE_DEFS[0]).name;

// 淘汰赛对阵方式。
//   seed         标准种子位固定交叉：A1 打 B2、B1 打 A2（原行为，最强与最弱分在同一半区）
//   random       随机抽签：出线者打乱后随机落位，可能同组相遇
//   random_avoid 随机抽签 + 首轮强制回避同组（同组出线的两人不会在首轮碰面）
const KO_MODE_DEFS = [
  { code: 'seed', name: '固定交叉（种子位）' },
  { code: 'random', name: '随机抽签' },
  { code: 'random_avoid', name: '随机抽签 + 首轮回避同组' }
];
const KO_MODE_MAP = Object.fromEntries(KO_MODE_DEFS.map(d => [d.code, d]));
const koModeLabel = s => (KO_MODE_MAP[s] || KO_MODE_DEFS[0]).name;

// 局制：1 = 一局定胜负，3 = 三局两胜
const eventBestOfLabel = n => (parseInt(n) === 1 ? '一局定胜负' : '三局两胜');
// 一个单项要赢几局才算拿下：1 局制赢 1 局，3 局制赢 2 局
function gameNeedOf(event) { return Math.floor((event.best_of || 3) / 2) + 1; }

let eventEditionRoundMap = null;   // round_id -> edition（每一届各有一行 rounds）
let eventTourneyMap = null;        // tournament_id -> event

function editionByRound(roundId) {
  if (!eventEditionRoundMap) {
    eventEditionRoundMap = {};
    for (const e of query('SELECT * FROM event_editions WHERE round_id IS NOT NULL')) eventEditionRoundMap[String(e.round_id)] = e;
  }
  return eventEditionRoundMap[String(roundId)] || null;
}
function eventByTournamentId(tid) {
  if (!eventTourneyMap) {
    eventTourneyMap = {};
    for (const e of query('SELECT * FROM events WHERE tournament_id IS NOT NULL')) eventTourneyMap[String(e.tournament_id)] = e;
  }
  return eventTourneyMap[String(tid)] || null;
}

// sql.js 没有 lastInsertRowid 返回值，只能再查一次
function lastInsertId() {
  const r = db.exec('SELECT last_insert_rowid()');
  return r.length && r[0].values.length ? r[0].values[0][0] : null;
}

// 老库里可能有 format='group'（早期叫「仅小组赛」），统一折算成 rr，后面就不用到处兼容了
function eventRow(id) {
  const e = query('SELECT * FROM events WHERE id = ?', [id])[0] || null;
  if (e && e.format === 'group') e.format = 'rr';
  return e;
}
function editionRow(id) { return query('SELECT * FROM event_editions WHERE id = ?', [id])[0] || null; }

function koMaxRound(editionId) {
  const r = query("SELECT MAX(ko_round) AS m FROM event_ties WHERE edition_id = ? AND stage = 'ko'", [editionId])[0];
  return r && r.m ? r.m : 0;
}

function lowerMaxRound(editionId) {
  const r = query("SELECT MAX(ko_round) AS m FROM event_ties WHERE edition_id = ? AND stage = 'lower'", [editionId])[0];
  return r && r.m ? r.m : 0;
}

// 本届到底设不设败者组：届次层为空就跟随赛事（赛制）层的开关。
function effectiveLower(event, ed) {
  if (!event) return false;
  const v = ed ? ed.lower_bracket : null;
  return (v === null || v === undefined) ? !!event.lower_bracket : !!v;
}

// 届次 + 赛事定义 + 局制阈值。引擎里几乎每个函数都要这三样，一次取齐。
function editionCtx(editionId) {
  const ed = editionRow(editionId);
  if (!ed) return null;
  const event = eventRow(ed.event_id);
  if (!event) return null;
  return { ed, event, gameNeed: gameNeedOf(event) };
}

// 把一届赛事整个读进内存算一遍。规模很小（几十个单元、上百场对抗），
// 一次全量读 + 内存推导比来回查库清晰得多，也好测。
function loadEventGraph(editionId) {
  const ed = editionRow(editionId);
  const eventId = ed ? ed.event_id : 0;
  const items = query('SELECT * FROM event_items WHERE event_id = ? ORDER BY seq, id', [eventId]);
  const entries = query('SELECT * FROM event_entries WHERE edition_id = ? ORDER BY seq, id', [editionId]);
  const ties = query('SELECT * FROM event_ties WHERE edition_id = ? ORDER BY stage, ko_round, slot, seq, id', [editionId]);
  const tieItems = query(`SELECT ti.* FROM event_tie_items ti
                          JOIN event_ties t ON t.id = ti.tie_id
                          WHERE t.edition_id = ? ORDER BY ti.tie_id, ti.seq, ti.id`, [editionId]);
  const games = query(`SELECT g.* FROM event_tie_games g
                       JOIN event_tie_items ti ON ti.id = g.tie_item_id
                       JOIN event_ties t ON t.id = ti.tie_id
                       WHERE t.edition_id = ? ORDER BY g.tie_item_id, g.game_no`, [editionId]);

  const gamesByItem = {}, itemsByTie = {};
  for (const g of games) (gamesByItem[g.tie_item_id] || (gamesByItem[g.tie_item_id] = [])).push(g);
  for (const it of tieItems) (itemsByTie[it.tie_id] || (itemsByTie[it.tie_id] = [])).push(it);

  const membersMap = {};
  for (const r of query(`SELECT m.entry_id, m.player_id FROM event_entry_members m
                         JOIN event_entries e ON e.id = m.entry_id
                         WHERE e.edition_id = ? ORDER BY m.entry_id, m.seq, m.id`, [editionId])) {
    (membersMap[r.entry_id] || (membersMap[r.entry_id] = [])).push(r.player_id);
  }

  const entryById = {};
  for (const e of entries) entryById[e.id] = e;
  return { items, entries, ties, tieItems, gamesByItem, itemsByTie, membersMap, entryById };
}

// 一场对抗的完整结果。大场 need = ⌊N/2⌋+1（N 项多数胜），单项 gameNeed 来自赛事局制。
// 关键点：一旦一方先赢够 need，后面还没打的单项一律记为「未进行」（side = -1），
// 且它们的局分不再计入净胜局/净胜分 —— 否则 3:0 领先时再补几场「垃圾局」会污染小分。
function tieOutcome(graph, tie, gameNeed) {
  const list = graph.itemsByTie[tie.id] || [];
  const need = Math.floor(list.length / 2) + 1;
  const gn = gameNeed || 2;
  let i1 = 0, i2 = 0, g1 = 0, g2 = 0, p1 = 0, p2 = 0, stopped = false;
  const perItem = [];
  for (const it of list) {
    if (stopped) {
      perItem.push({ item_id: it.id, seq: it.seq, code: it.code, name: it.name, side: -1, w1: 0, w2: 0, skipped: true });
      continue;
    }
    const gs = graph.gamesByItem[it.id] || [];
    let w1 = 0, w2 = 0;
    for (const g of gs) {
      if (g.s1 > g.s2) w1++; else if (g.s2 > g.s1) w2++;
      p1 += g.s1; p2 += g.s2;
    }
    g1 += w1; g2 += w2;
    let side = 0;
    if (w1 >= gn) side = 1; else if (w2 >= gn) side = 2;
    if (side === 1) i1++; else if (side === 2) i2++;
    perItem.push({ item_id: it.id, seq: it.seq, code: it.code, name: it.name, side, w1, w2, skipped: false });
    if (i1 >= need || i2 >= need) stopped = true;
  }
  let winner = 0;
  if (i1 >= need) winner = 1; else if (i2 >= need) winner = 2;
  return { i1, i2, g1, g2, p1, p2, need, perItem, winner, decided: !!winner };
}

// 一场对抗某一侧有哪些人。
// 非固搭双打一侧是两个人临时搭档（分属两个参赛单元），所以要看 sideN_entry_id + sideN_entry2_id；
// 其余赛制第二位恒为空，行为与以前逐字节一致。
function tieSideMembers(graph, tie, side) {
  const eids = side === 1 ? [tie.side1_entry_id, tie.side1_entry2_id] : [tie.side2_entry_id, tie.side2_entry2_id];
  const out = [];
  for (const eid of eids) {
    if (!eid) continue;
    for (const pid of (graph.membersMap[eid] || [])) out.push(pid);
  }
  return out;
}

// 某个参赛单元在这一届里的战绩（小组赛 + 淘汰赛一起算）
function tallyForEntry(graph, entryId, gameNeed) {
  let wins = 0, losses = 0, gw = 0, gl = 0, pf = 0, pa = 0;
  for (const t of graph.ties) {
    if (t.side1_entry_id !== entryId && t.side2_entry_id !== entryId) continue;
    if (!t.side1_entry_id || !t.side2_entry_id) continue;   // 轮空不计入战绩
    const o = tieOutcome(graph, t, gameNeed);
    const is1 = t.side1_entry_id === entryId;
    gw += is1 ? o.g1 : o.g2;
    gl += is1 ? o.g2 : o.g1;
    pf += is1 ? o.p1 : o.p2;
    pa += is1 ? o.p2 : o.p1;
    if (o.winner) {
      const w = o.winner === 1 ? t.side1_entry_id : t.side2_entry_id;
      if (w === entryId) wins++; else losses++;
    }
  }
  return { wins, losses, games_won: gw, games_lost: gl, net_games: gw - gl, net_points: pf - pa, pts_for: pf, pts_against: pa };
}

// 参赛单元的种子值 = 成员的总积分之和（口径由和哥定：单人赛就是该选手积分，
// 双打 / 团体取成员之和）。只用于「排序」与「给管理员看」，不参与任何比分计算。
function entrySeedMap(graph) {
  const pts = {};
  for (const row of computePoints().points) pts[row.player_id] = row.total_points || 0;
  const map = {};
  for (const e of graph.entries) {
    const members = graph.membersMap[e.id] || [];
    let s = 0;
    for (const pid of members) s += (pts[pid] || 0);
    map[e.id] = s;
  }
  return map;
}

// 按种子值降序排名（同分按录入顺序，保证稳定可预期）
function seedRanks(graph, seedMap) {
  const arr = graph.entries.slice().sort((a, b) => {
    const d = (seedMap[b.id] || 0) - (seedMap[a.id] || 0);
    if (d) return d;
    return (a.seq != null ? a.seq : a.id) - (b.seq != null ? b.seq : b.id);
  });
  const rank = {};
  arr.forEach((e, i) => { rank[e.id] = i + 1; });
  return rank;
}

// 种子顺序（entry id 数组）：entry = 录入顺序；points = 总积分降序。
// 蛇形分组与固定交叉都基于它 —— 换依据只改这一处。
function seedOrder2(graph, seedBy) {
  const arr = graph.entries.slice();
  if (seedBy === 'points') {
    const sm = entrySeedMap(graph);
    arr.sort((a, b) => {
      const d = (sm[b.id] || 0) - (sm[a.id] || 0);
      if (d) return d;
      return (a.seq != null ? a.seq : a.id) - (b.seq != null ? b.seq : b.id);
    });
  } else {
    arr.sort((a, b) => (a.seq != null ? a.seq : a.id) - (b.seq != null ? b.seq : b.id));
  }
  return arr.map(e => e.id);
}

// 小组积分榜。先后手规则（产品定义，别改）：
//   大场胜场 > 净胜大场 > 净胜局 > 净胜分 > 交手记录
// 前四项全等的区间内，再用「区间内循环赛小分」重排一次（交手记录）。
function groupStandings(graph, groupNo, gameNeed) {
  const entries = graph.entries.filter(e => e.group_no === groupNo);
  const s = {};
  for (const e of entries) {
    s[e.id] = {
      entry_id: e.id, label: e.label, group_no: groupNo,
      tie_wins: 0, tie_losses: 0, item_wins: 0, item_losses: 0,
      games_won: 0, games_lost: 0, pts_for: 0, pts_against: 0
    };
  }
  const h2h = {};
  for (const t of graph.ties) {
    if (t.stage !== 'group' || t.group_no !== groupNo) continue;
    const A = s[t.side1_entry_id], B = s[t.side2_entry_id];
    if (!A || !B) continue;
    const o = tieOutcome(graph, t, gameNeed);
    A.item_wins += o.i1; B.item_losses += o.i1;
    B.item_wins += o.i2; A.item_losses += o.i2;
    A.games_won += o.g1; A.games_lost += o.g2;
    B.games_won += o.g2; B.games_lost += o.g1;
    A.pts_for += o.p1; A.pts_against += o.p2;
    B.pts_for += o.p2; B.pts_against += o.p1;
    if (o.winner) {
      const w = o.winner === 1 ? t.side1_entry_id : t.side2_entry_id;
      const l = o.winner === 1 ? t.side2_entry_id : t.side1_entry_id;
      s[w].tie_wins++; s[l].tie_losses++;
      h2h[w + '|' + l] = true;
    }
  }
  const arr = Object.values(s);
  for (const r of arr) {
    r.net_ties = r.tie_wins - r.tie_losses;
    r.net_games = r.games_won - r.games_lost;
    r.net_points = r.pts_for - r.pts_against;
    r.played = r.tie_wins + r.tie_losses;
  }
  const keyOf = r => [r.tie_wins, r.net_ties, r.net_games, r.net_points].join('|');
  arr.sort((a, b) => (b.tie_wins - a.tie_wins) || (b.net_ties - a.net_ties)
    || (b.net_games - a.net_games) || (b.net_points - a.net_points));
  let i = 0;
  while (i < arr.length) {
    let j = i;
    while (j + 1 < arr.length && keyOf(arr[i]) === keyOf(arr[j + 1])) j++;
    if (j > i) {
      const part = arr.slice(i, j + 1);
      const sc = {};
      for (const a of part) sc[a.entry_id] = 0;
      for (const a of part) for (const b of part) if (a !== b && h2h[a.entry_id + '|' + b.entry_id]) sc[a.entry_id]++;
      part.sort((a, b) => sc[b.entry_id] - sc[a.entry_id]);
      for (let k = 0; k < part.length; k++) arr[i + k] = part[k];
    }
    i = j + 1;
  }
  arr.forEach((r, idx) => r.rank = idx + 1);
  return arr;
}

// 淘汰赛名次：冠军 → 亚军 →（季军赛赢家/输家，否则半决赛两个负者）→ 按被淘汰轮次从晚到早
function koOrder(graph, entrySeq) {
  const koTies = graph.ties.filter(t => t.stage === 'ko');
  if (!koTies.length) return null;
  const maxRound = Math.max(...koTies.map(t => t.ko_round));
  const finalTie = koTies.find(t => t.ko_round === maxRound && t.slot === 0) || koTies.find(t => t.ko_round === maxRound);

  const elim = {};
  for (const t of koTies) {
    if (!t.winner_entry_id || !t.side1_entry_id || !t.side2_entry_id) continue;
    elim[t.winner_entry_id === t.side1_entry_id ? t.side2_entry_id : t.side1_entry_id] = t.ko_round;
  }

  const order = [];
  const push = id => { if (id && !order.includes(id)) order.push(id); };

  const fw = finalTie ? finalTie.winner_entry_id : null;
  const fl = finalTie && finalTie.side1_entry_id && finalTie.side2_entry_id
    ? (fw === finalTie.side1_entry_id ? finalTie.side2_entry_id : finalTie.side1_entry_id) : null;
  push(fw); push(fl);

  const tp = graph.ties.find(t => t.stage === 'third' && t.winner_entry_id);
  if (tp) {
    push(tp.winner_entry_id);
    push(tp.winner_entry_id === tp.side1_entry_id ? tp.side2_entry_id : tp.side1_entry_id);
  }

  Object.keys(elim).map(Number)
    .filter(id => !order.includes(id))
    .sort((a, b) => (elim[b] - elim[a]) || ((entrySeq[a] || 0) - (entrySeq[b] || 0)))
    .forEach(push);
  return order;
}

// 败者组名次：5-6 名决赛（赢家 → 输家）→ 7-8 名名次赛（赢家 → 输家）→ 其余败者组参赛者
// 只负责把「败者组内部的先后」排出来，插到主淘汰赛名次之后。
function lowerOrder(graph, entrySeq) {
  const ties = graph.ties.filter(t => t.stage === 'lower');
  if (!ties.length) return null;
  const maxR = Math.max(...ties.map(t => t.ko_round));
  const sideOf = (t, who) => (who === 'win' ? t.winner_entry_id
    : (t.winner_entry_id === t.side1_entry_id ? t.side2_entry_id : t.side1_entry_id));

  const order = [];
  const push = id => { if (id && !order.includes(id)) order.push(id); };

  const finalT = ties.find(t => t.ko_round === maxR && t.slot === 0);
  const lastT = ties.find(t => t.ko_round === maxR && t.slot === 1);
  if (finalT && finalT.winner_entry_id && finalT.side1_entry_id && finalT.side2_entry_id) {
    push(sideOf(finalT, 'win')); push(sideOf(finalT, 'lose'));
  }
  if (lastT && lastT.winner_entry_id && lastT.side1_entry_id && lastT.side2_entry_id) {
    push(sideOf(lastT, 'win')); push(sideOf(lastT, 'lose'));
  }
  // 剩下的（例如半决赛负者还没打 7-8 名）：按被淘汰轮次从晚到早
  const elim = {};
  for (const t of ties) {
    if (!t.winner_entry_id || !t.side1_entry_id || !t.side2_entry_id) continue;
    elim[sideOf(t, 'lose')] = t.ko_round;
  }
  Object.keys(elim).map(Number)
    .filter(id => !order.includes(id))
    .sort((a, b) => (elim[b] - elim[a]) || ((entrySeq[a] || 0) - (entrySeq[b] || 0)))
    .forEach(push);
  // 兜底：败者组里挂了名但一场没打的也要排在「非败者组」的人之前
  for (const t of ties) { push(t.side1_entry_id); push(t.side2_entry_id); }
  return order;
}

// 本届最终名次（1..n）。这就是喂给积分系统的排序。
// 非固搭双打：名次记在个人头上（与狗王杯完全同口径）。
// 一场 4 个人，搭档每场不同，所以只累计个人：胜场、小分得失。
// 只有「打出胜负」的场次才计入，没录比分或录了一半的不算。
function freePlayerStats(graph, gameNeed) {
  const stats = {};
  for (const t of graph.ties) {
    if (t.stage !== 'free') continue;
    const o = tieOutcome(graph, t, gameNeed);
    if (!o.decided) continue;
    const ls = [t.side1_entry_id, t.side1_entry2_id].filter(Boolean);
    const rs = [t.side2_entry_id, t.side2_entry2_id].filter(Boolean);
    for (const eid of ls) {
      const s = stats[eid] || (stats[eid] = { wins: 0, losses: 0, pf: 0, pa: 0 });
      if (o.winner === 1) s.wins++; else s.losses++;
      s.pf += o.p1; s.pa += o.p2;
    }
    for (const eid of rs) {
      const s = stats[eid] || (stats[eid] = { wins: 0, losses: 0, pf: 0, pa: 0 });
      if (o.winner === 2) s.wins++; else s.losses++;
      s.pf += o.p2; s.pa += o.p1;
    }
  }
  return stats;
}

// 非固搭的排名表。排序 = 胜场降序 → 净胜分降序；两者都相同才算并列，
// 并列者同名次、积分取所跨名次的平均值（与狗王杯 calculatePlayerRankings 一致）。
function freeRanking(graph, level, gameNeed) {
  const lvl = level || 1000;
  const stats = freePlayerStats(graph, gameNeed);
  const rows = Object.entries(stats).map(([eid, s]) => ({ entry_id: parseInt(eid), ...s }));
  rows.sort((a, b) => b.wins - a.wins || (b.pf - b.pa) - (a.pf - a.pa));
  const n = rows.length;
  const d = n ? Math.round(lvl / n) : 0;
  const out = [];
  let i = 0;
  while (i < n) {
    let j = i;
    const netI = rows[i].pf - rows[i].pa;
    while (j + 1 < n && rows[j + 1].wins === rows[i].wins && (rows[j + 1].pf - rows[j + 1].pa) === netI) j++;
    let sum = 0;
    for (let k = i; k <= j; k++) sum += Math.max(0, lvl - d * k);
    const avg = Math.round(sum / (j - i + 1));
    for (let k = i; k <= j; k++) {
      const r = rows[k];
      const members = graph.membersMap[r.entry_id] || [];
      out.push({
        rank: i + 1, entry_id: r.entry_id,
        label: (graph.entryById[r.entry_id] || {}).label || '',
        member_ids: members,
        player1_id: members[0] || null, player2_id: null,
        wins: r.wins, losses: r.losses,
        games_won: 0, games_lost: 0,
        net_points: r.pf - r.pa,
        points_earned: avg
      });
    }
    i = j + 1;
  }
  return { rankings: out, d, teamCount: n };
}

function finalOrder(event, graph, gameNeed) {
  // 非固搭双打：名次按个人累计排（有战绩的在前，一场没打的按录入顺序垫底）
  if (event.format === 'free') {
    const rk = freeRanking(graph, null, gameNeed);
    const seen = new Set();
    const out = [];
    for (const r of rk.rankings) { const e = graph.entryById[r.entry_id]; if (e) { out.push(e); seen.add(r.entry_id); } }
    for (const e of graph.entries) if (!seen.has(e.id)) out.push(e);
    return out;
  }
  const entrySeq = {};
  graph.entries.forEach((e, i) => { entrySeq[e.id] = e.seq != null ? e.seq : i; });
  const groupNos = [...new Set(graph.entries.filter(e => e.group_no > 0).map(e => e.group_no))].sort((a, b) => a - b);
  const tables = {};
  for (const g of groupNos) tables[g] = groupStandings(graph, g, gameNeed);

  const order = [], seen = new Set();
  const add = id => { if (id && !seen.has(id)) { seen.add(id); order.push(id); } };
  const metricDesc = (a, b) => (b.tie_wins - a.tie_wins) || (b.net_ties - a.net_ties)
    || (b.net_games - a.net_games) || (b.net_points - a.net_points);

  const ko = koOrder(graph, entrySeq);
  if (ko) {
    for (const id of ko) add(id);
    // 败者组（5~8 名）排在四强之后、没出线的之前
    const lo = lowerOrder(graph, entrySeq);
    if (lo) for (const id of lo) add(id);
    if (event.format === 'group_ko') {
      // 没出线的：先各组第 (出线名额+1) 名，再下一档……同档内按四项指标降序
      const adv = event.advance_per_group || 0;
      const rest = [];
      for (const g of groupNos) for (const r of tables[g]) if (r.rank > adv) rest.push(r);
      rest.sort((a, b) => (a.rank - b.rank) || metricDesc(a, b));
      for (const r of rest) add(r.entry_id);
    }
  } else {
    // 单循环：各组同名次合并 —— 所有第 1 名在前，再所有第 2 名……
    const all = [];
    for (const g of groupNos) for (const r of tables[g]) all.push(r);
    all.sort((a, b) => (a.rank - b.rank) || metricDesc(a, b));
    for (const r of all) add(r.entry_id);
  }
  // 兜底：还没进榜的（未分组 / 签表未生成 / 被删过）按录入顺序补齐，
  // 保证「名次表长度 = 参赛单元数」，否则积分分母 d 会算错。
  for (const e of graph.entries) add(e.id);
  return order.map(id => graph.entryById[id]).filter(Boolean);
}

// 这一届是否已经有「已决出的对抗」。
// 没有任何赛果时必须不产出名次：一建好届次就有镜像 rounds 行，
// 如果照样按录入顺序排 1..n，一场没打就会把冠亚季直接发进荣誉体系、并进积分榜。
// （老模型里空轮次不可达，这是赛事引擎独有的新情况。）
function eventHasResults(graph) {
  return graph.ties.some(t => t.winner_entry_id);
}

// 赛事引擎的排名，形态与 calculateRoundRankings 一致（rankings / d / teamCount），
// 让积分、荣誉、选手资料页的既有代码可以直接吃下去。传进来的是「届」。
function computeEventRanking(ed, level) {
  const event = eventRow(ed.event_id);
  if (!event) return { rankings: [], d: 0, teamCount: 0, event_id: 0, kind: '' };
  const gameNeed = gameNeedOf(event);
  const graph = loadEventGraph(ed.id);
  if (!eventHasResults(graph)) return { rankings: [], d: 0, teamCount: 0, event_id: event.id, kind: event.kind };
  // 非固搭双打：名次在个人头上，且有并列，必须走专属排名（不是 finalOrder 那套）
  if (event.format === 'free') {
    const fr = freeRanking(graph, level || ed.level || 1000, gameNeed);
    return { rankings: fr.rankings, d: fr.d, teamCount: fr.teamCount, event_id: event.id, kind: event.kind };
  }
  const ordered = finalOrder(event, graph, gameNeed);
  const n = ordered.length;
  const lvl = level || ed.level || 1000;
  const d = n ? Math.round(lvl / n) : 0;
  const rankings = ordered.map((e, i) => {
    const members = graph.membersMap[e.id] || [];
    const t = tallyForEntry(graph, e.id, gameNeed);
    return {
      rank: i + 1,
      entry_id: e.id,
      label: e.label,
      member_ids: members,
      // player1/player2 只是给老代码兜底用；真实成员一律看 member_ids
      player1_id: members[0] || null,
      player2_id: members[1] || null,
      wins: t.wins, losses: t.losses,
      games_won: t.games_won, games_lost: t.games_lost,
      net_points: t.net_points,
      points_earned: Math.max(0, lvl - d * i)
    };
  });
  return { rankings, d, teamCount: n, event_id: event.id, kind: event.kind };
}

// ---------- 赛事引擎内部写入（全部按届作用域） ----------

function clearStage(editionId, stage) {
  query(`DELETE FROM event_tie_games WHERE tie_item_id IN
         (SELECT ti.id FROM event_tie_items ti JOIN event_ties t ON t.id = ti.tie_id
          WHERE t.edition_id = ? AND t.stage = ?)`, [editionId, stage]);
  query(`DELETE FROM event_tie_items WHERE tie_id IN
         (SELECT id FROM event_ties WHERE edition_id = ? AND stage = ?)`, [editionId, stage]);
  query('DELETE FROM event_ties WHERE edition_id = ? AND stage = ?', [editionId, stage]);
}

function createTie(event, editionId, spec) {
  query(`INSERT INTO event_ties (event_id, edition_id, stage, group_no, ko_round, slot, side1_entry_id, side2_entry_id, winner_entry_id, state, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`,
    [event.id, editionId, spec.stage, spec.group_no || 0, spec.ko_round || 0, spec.slot || 0,
     spec.side1 || null, spec.side2 || null, spec.seq || 0]);
  const tieId = lastInsertId();
  const items = event.kind === 'team'
    ? query('SELECT code, name FROM event_items WHERE event_id = ? ORDER BY seq, id', [event.id])
    : [{ code: '', name: '比赛' }];
  items.forEach((it, i) => {
    query(`INSERT INTO event_tie_items (tie_id, code, name, seq, side1_players, side2_players, winner_side)
           VALUES (?, ?, ?, ?, '', '', 0)`, [tieId, it.code || '', it.name || '', i + 1]);
  });
  return tieId;
}

// 清空一场对抗的赛果（对阵变了 / 重新生成时用）。保留 sides，不动 stage。
function resetTie(tieId) {
  query("UPDATE event_ties SET winner_entry_id = NULL, state = 'pending' WHERE id = ?", [tieId]);
  query("UPDATE event_tie_items SET winner_side = 0, side1_players = '', side2_players = '' WHERE tie_id = ?", [tieId]);
  query('DELETE FROM event_tie_games WHERE tie_item_id IN (SELECT id FROM event_tie_items WHERE tie_id = ?)', [tieId]);
}

// 胜者进入下一轮。若下一轮的这一侧原本是别人，说明树状结构变了：
// 把那一场连同比分一起作废，并继续往下传空，否则会留下「比分属于已被淘汰的人」的脏数据。
function propagate(tie, winnerEntry) {
  if (tie.stage === 'lower') { propagateLower(tie.edition_id); return; }
  if (tie.stage !== 'ko') return;
  const maxRound = koMaxRound(tie.edition_id);
  if (tie.ko_round >= maxRound) return;
  const nextSlot = Math.floor(tie.slot / 2);
  const nextSide = (tie.slot % 2) + 1;
  const nt = query(`SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'ko' AND ko_round = ? AND slot = ?`,
    [tie.edition_id, tie.ko_round + 1, nextSlot])[0];
  if (!nt) return;
  const col = nextSide === 1 ? 'side1_entry_id' : 'side2_entry_id';
  if (nt[col] === winnerEntry) return;
  query(`UPDATE event_ties SET ${col} = ? WHERE id = ?`, [winnerEntry, nt.id]);
  resetTie(nt.id);
  propagate(query('SELECT * FROM event_ties WHERE id = ?', [nt.id])[0], null);
}

// 轮空自动晋级：签表大小是 2 的幂，出线数不足时首轮会出现单边，直接送到下一轮
function autoAdvanceByes(editionId) {
  const R = koMaxRound(editionId);
  for (let r = 1; r <= R; r++) {
    const ties = query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'ko' AND ko_round = ? ORDER BY slot", [editionId, r]);
    for (const t of ties) {
      if (t.side1_entry_id && !t.side2_entry_id) {
        query("UPDATE event_ties SET winner_entry_id = ?, state = 'done' WHERE id = ?", [t.side1_entry_id, t.id]);
        propagate(t, t.side1_entry_id);
      } else if (!t.side1_entry_id && t.side2_entry_id) {
        query("UPDATE event_ties SET winner_entry_id = ?, state = 'done' WHERE id = ?", [t.side2_entry_id, t.id]);
        propagate(t, t.side2_entry_id);
      }
    }
  }
}

// 败者组（决 5~8 名）：8 个参赛单元分 2 组、每组出线 2 个时，四个「没出线」的再打一个小淘汰，
// 半决赛 → 5-6 名决赛 + 7-8 名名次赛，名次插到四强之后。
// 返回 null = 已生成；否则返回不生成的原因（字符串）。

// 败者组的四个名额：各组「出线名额之后」的人，按名次优先再按组排（A3 B3 A4 B4），
// 与上边出线名单同一个顺序口径，这样半决赛天然是 A3-B4、B3-A4，不会首轮碰同组。
function lowerSeedsFromTables(tables, groupNos, adv) {
  const seeds = [];
  const size = Math.max(...groupNos.map(g => (tables[g] || []).length));
  for (let r = adv; r < size; r++) {
    for (const g of groupNos) {
      const row = (tables[g] || [])[r];
      if (row) seeds.push(row.entry_id);
    }
  }
  return seeds;
}

function buildLowerBracket(ed, event, graph, gameNeed) {
  const groupNos = [...new Set(graph.entries.filter(e => e.group_no > 0).map(e => e.group_no))].sort((a, b) => a - b);
  clearStage(ed.id, 'lower');
  if (!effectiveLower(event, ed)) return '本届没有开启败者组';
  if (event.format !== 'group_ko') return '败者组只对「小组赛+淘汰赛」赛制生效';
  if (graph.entries.length !== 8) return `败者组要求正好 8 个${event.kind === 'team' ? '队伍' : '选手'}，本届是 ${graph.entries.length} 个`;
  const tables = {};
  for (const g of groupNos) tables[g] = groupStandings(graph, g, gameNeed);
  const adv = Math.max(1, event.advance_per_group || 1);
  const seeds = lowerSeedsFromTables(tables, groupNos, adv);
  if (seeds.length !== 4) return `败者组需要 4 个未出线单元，当前是 ${seeds.length} 个`;
  const undecided = graph.ties.filter(t => t.stage === 'group' && !t.winner_entry_id);
  if (undecided.length) return `还有 ${undecided.length} 场小组赛未完成，先打完再生成`;

  // ko_round 1：种子位固定交叉（1v4、2v3）；ko_round 2：slot 0 = 5-6 名决赛，slot 1 = 7-8 名名次赛
  createTie(event, ed.id, { stage: 'lower', ko_round: 1, slot: 0, seq: 1, side1: seeds[0], side2: seeds[3] });
  createTie(event, ed.id, { stage: 'lower', ko_round: 1, slot: 1, seq: 2, side1: seeds[1], side2: seeds[2] });
  createTie(event, ed.id, { stage: 'lower', ko_round: 2, slot: 0, seq: 1 });
  createTie(event, ed.id, { stage: 'lower', ko_round: 2, slot: 1, seq: 2 });
  propagateLower(ed.id);
  return null;
}

// 败者组两轮的进出：
//   半决赛胜者 → 5-6 名决赛（slot 0），按 slot 决定坐哪边；
//   半决赛负者 → 7-8 名名次赛（slot 1），同样按 slot 决定坐哪边。
// 换了人就把下游那一场连同比分作废再重算，否则会出现「比分属于已被淘汰的人」。
function propagateLower(editionId) {
  const R = lowerMaxRound(editionId);
  if (R < 2) return;
  const get = (r, slot) => query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'lower' AND ko_round = ? AND slot = ?",
    [editionId, r, slot])[0];
  const put = (tie, side, entry) => {
    if (!tie) return false;
    const col = side === 1 ? 'side1_entry_id' : 'side2_entry_id';
    if (tie[col] === entry) return false;
    query(`UPDATE event_ties SET ${col} = ? WHERE id = ?`, [entry, tie.id]);
    resetTie(tie.id);
    return true;
  };
  let changed = false;
  for (let r = 1; r < R; r++) {
    const round = query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'lower' AND ko_round = ? ORDER BY slot",
      [editionId, r]);
    for (const t of round) {
      if (!t.winner_entry_id || !t.side1_entry_id || !t.side2_entry_id) continue;
      const win = t.winner_entry_id;
      const lose = win === t.side1_entry_id ? t.side2_entry_id : t.side1_entry_id;
      const side = (t.slot % 2) + 1;
      changed = put(get(r + 1, 0), side, win) || changed;
      if (r + 1 === R) changed = put(get(r + 1, 1), side, lose) || changed;
    }
  }
  if (changed) propagateLower(editionId);   // 下游换了人，继续往下传
}

// 小组赛结果改了要重填败者组的四个人（和季军赛一个道理），否则会挂着旧人。
function fillLowerBracket(editionId, event, graph, gameNeed) {
  // 本届没开败者组就不用管：有没有这笔 stage='lower' 的行就是唯一依据
  const semis = query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'lower' AND ko_round = 1 ORDER BY slot", [editionId]);
  if (semis.length !== 2) return;
  const groupNos = [...new Set(graph.entries.filter(e => e.group_no > 0).map(e => e.group_no))].sort((a, b) => a - b);
  const tables = {};
  for (const g of groupNos) tables[g] = groupStandings(graph, g, gameNeed);
  const adv = Math.max(1, event.advance_per_group || 1);
  const seeds = lowerSeedsFromTables(tables, groupNos, adv);
  if (seeds.length !== 4) return;
  const want = [[seeds[0], seeds[3]], [seeds[1], seeds[2]]];
  let changed = false;
  semis.forEach((t, i) => {
    const [a, b] = want[i];
    if (t.side1_entry_id !== a || t.side2_entry_id !== b) {
      query('UPDATE event_ties SET side1_entry_id = ?, side2_entry_id = ? WHERE id = ?', [a, b, t.id]);
      resetTie(t.id);
      changed = true;
    }
  });
  if (changed) propagateLower(editionId);
}

// 季军赛的两个名额来自半决赛负者。半决赛结果一变就要重填，否则季军赛会挂着旧人。
function fillThirdPlace(editionId, event) {
  if (!event || !event.third_place) return;
  const R = koMaxRound(editionId);
  if (R < 2) return;
  const tp = query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'third' LIMIT 1", [editionId])[0];
  if (!tp) return;
  const semis = query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'ko' AND ko_round = ? ORDER BY slot", [editionId, R - 1]);
  const losers = semis.map(t => {
    if (!t.winner_entry_id || !t.side1_entry_id || !t.side2_entry_id) return null;
    return t.winner_entry_id === t.side1_entry_id ? t.side2_entry_id : t.side1_entry_id;
  });
  const s1 = losers[0] || null, s2 = losers[1] || null;
  if (tp.side1_entry_id === s1 && tp.side2_entry_id === s2) return;
  query('UPDATE event_ties SET side1_entry_id = ?, side2_entry_id = ? WHERE id = ?', [s1, s2, tp.id]);
  resetTie(tp.id);
}

// 写库之后重算一场对抗：单项胜负 → 提前终止 → 大场胜负 → 向下传递
function settleTie(editionId, tieId, gameNeed) {
  const tie = query('SELECT * FROM event_ties WHERE id = ?', [tieId])[0];
  if (!tie) return;
  const items = query('SELECT * FROM event_tie_items WHERE tie_id = ? ORDER BY seq, id', [tieId]);
  const need = Math.floor(items.length / 2) + 1;
  const gn = gameNeed || 2;
  let i1 = 0, i2 = 0, stopped = false;
  for (const it of items) {
    if (stopped) {
      query('UPDATE event_tie_items SET winner_side = -1 WHERE id = ?', [it.id]);
      query('DELETE FROM event_tie_games WHERE tie_item_id = ?', [it.id]);
      continue;
    }
    const gs = query('SELECT s1, s2 FROM event_tie_games WHERE tie_item_id = ? ORDER BY game_no', [it.id]);
    let w1 = 0, w2 = 0;
    for (const g of gs) { if (g.s1 > g.s2) w1++; else if (g.s2 > g.s1) w2++; }
    let side = 0;
    if (w1 >= gn) side = 1; else if (w2 >= gn) side = 2;
    if (side === 1) i1++; else if (side === 2) i2++;
    query('UPDATE event_tie_items SET winner_side = ? WHERE id = ?', [side, it.id]);
    if (i1 >= need || i2 >= need) stopped = true;
  }
  let winnerEntry = null;
  if (i1 >= need) winnerEntry = tie.side1_entry_id;
  else if (i2 >= need) winnerEntry = tie.side2_entry_id;
  query('UPDATE event_ties SET winner_entry_id = ?, state = ? WHERE id = ?', [winnerEntry, winnerEntry ? 'done' : 'pending', tieId]);
  propagate(query('SELECT * FROM event_ties WHERE id = ?', [tieId])[0], winnerEntry);
}

function updateEventStatus(editionId) {
  const rows = query('SELECT state FROM event_ties WHERE edition_id = ?', [editionId]);
  const allDone = rows.length > 0 && rows.every(r => r.state === 'done');
  query('UPDATE event_editions SET status = ? WHERE id = ?', [allDone ? 'done' : 'ready', editionId]);
}

// ---------- 赛事引擎内部校验 ----------

function playerGenderMap() {
  const m = {};
  for (const p of query('SELECT id, gender FROM players')) m[p.id] = p.gender;
  return m;
}

// 单项排阵校验：人数 + 性别构成 + 不得重复 + 必须来自本队名单。
// 只校验「已经排了阵」的单项（空 = 还没排，允许）。
function validateLineup(def, ids, genderOf, teamMembers) {
  if (!ids.length) return null;
  if (ids.length !== def.size) return `${def.name}需要 ${def.size} 名选手`;
  if (new Set(ids).size !== ids.length) return `${def.name}不能重复上同一名选手`;
  const gs = ids.map(id => genderOf[id]);
  if (gs.some(g => !g)) return `${def.name}中有选手不存在`;
  if (def.gender === 'male' && gs.some(g => g !== 'male')) return `${def.name}只能上男选手`;
  if (def.gender === 'female' && gs.some(g => g !== 'female')) return `${def.name}只能上女选手`;
  if (def.gender === 'mixed' && !(gs.includes('male') && gs.includes('female'))) return `${def.name}需要 1 男 1 女`;
  if (teamMembers && teamMembers.length) {
    for (const id of ids) if (!teamMembers.includes(id)) return `${def.name}的选手必须来自本队名单`;
  }
  return null;
}

function seedOrder(size) {
  let arr = [1, 2];
  while (arr.length < size) {
    const m = arr.length * 2, next = [];
    for (const s of arr) { next.push(s); next.push(m + 1 - s); }
    arr = next;
  }
  return arr.slice(0, size);
}

// ---------- REST：赛事定义（只有赛制，没有日期/级别/名单） ----------

function defaultEntryLabel(kind, players, nameOf) {
  const names = players.map(p => nameOf[p] || ('#' + p));
  if (kind === 'team') return names.join(' / ');
  return names.join(' + ');
}

// 校验并规范化一份参赛名单。建届与改届共用，避免两处规则走偏。
function normalizeEntries(event, rawEntries) {
  const genderOf = playerGenderMap();
  const nameOf = {};
  for (const p of query('SELECT id, name, real_name FROM players')) nameOf[p.id] = p.real_name || p.name;

  const list = Array.isArray(rawEntries) ? rawEntries : [];
  if (list.length < 2) return { error: '至少需要 2 个参赛单元' };
  const out = [];
  for (const e of list) {
    const players = (e.players || []).map(Number).filter(Boolean);
    if (!players.length) return { error: '每个参赛单元至少要选 1 名选手' };
    for (const pid of players) if (!genderOf[pid]) return { error: '有选手不存在（id ' + pid + '），请刷新选手列表' };
    if (new Set(players).size !== players.length) return { error: '同一个参赛单元里不能有重复选手' };
    if (event.format === 'free') {
      // 非固搭双打：名单里是一个个的人，搭档是每场临时配的，单元里不能有 2 人
      if (players.length !== 1) return { error: '非固搭双打的名单只能是「一个个人」，搭档在录每场比分时临时配' };
    } else if (event.kind === 'individual') {
      if (players.length > 2) return { error: '单项赛每个参赛单元最多 2 名选手（单打 1 名 / 双打 2 名）' };
    } else if (players.length < 2) {
      return { error: '团体赛每支队伍至少 2 名队员' };
    }
    const label = String(e.label || '').trim() || defaultEntryLabel(event.kind, players, nameOf);
    out.push({ label, players });
  }
  // 同一届里一个人只能代表一个参赛单元
  const seenPid = {};
  for (const e of out) for (const pid of e.players) {
    if (seenPid[pid]) return { error: `选手「${nameOf[pid]}」在本届名单里出现了多次` };
    seenPid[pid] = true;
  }
  const labels = {};
  for (const e of out) {
    if (labels[e.label]) return { error: `参赛单元名称重复：${e.label}` };
    labels[e.label] = true;
  }
  return { entries: out, genderOf };
}

// 赛事类型 → tournaments.type：决定它出现在「积分排名」的哪个性别榜。
// 名单按届录入，所以每存一次名单就按本届实际阵容重算一次。
function tournamentTypeFor(event, entries, genderOf) {
  if (event.kind === 'team') return 'team';
  // 非固搭双打：参赛单元是「个人」，但打的是双打 —— 类型按项目定，不能按名单里几人算成 singles
  if (event.format === 'free') return TOUR_TYPE_OF_FREE_KIND[event.free_kind] || 'mens_doubles';
  if (entries.every(e => e.players.length === 1)) {
    let male = 0, female = 0;
    for (const e of entries) (genderOf[e.players[0]] === 'male' ? male++ : female++);
    return male && !female ? 'singles' : (!male && female ? 'womens_singles' : 'mixed_singles');
  }
  let male = 0, female = 0;
  for (const e of entries) for (const pid of e.players) (genderOf[pid] === 'male' ? male++ : female++);
  return male && !female ? 'mens_doubles' : (!male && female ? 'womens_doubles' : 'mixed_doubles');
}

function writeEditionEntries(editionId, eventId, entries) {
  entries.forEach((en, i) => {
    query('INSERT INTO event_entries (event_id, edition_id, label, group_no, seq) VALUES (?, ?, ?, 0, ?)', [eventId, editionId, en.label, i + 1]);
    const eid = lastInsertId();
    en.players.forEach((pid, k) => query('INSERT INTO event_entry_members (entry_id, player_id, seq) VALUES (?, ?, ?)', [eid, pid, k + 1]));
  });
}

app.get('/api/events', (req, res) => {
  const evs = query('SELECT * FROM events ORDER BY id DESC');
  const icnt = {};
  for (const r of query('SELECT event_id, COUNT(*) AS c FROM event_items GROUP BY event_id')) icnt['i' + r.event_id] = r.c;
  const ecnt = {};
  for (const r of query('SELECT event_id, COUNT(*) AS c FROM event_editions GROUP BY event_id')) ecnt['d' + r.event_id] = r.c;
  res.json(evs.map(e => ({
    id: e.id, name: e.name, kind: e.kind, format: e.format, best_of: e.best_of,
    icon: e.icon, third_place: e.third_place, lower_bracket: e.lower_bracket, group_count: e.group_count,
    free_kind: e.free_kind || 'md',
    advance_per_group: e.advance_per_group, tournament_id: e.tournament_id,
    seed_by: e.seed_by, group_mode: e.group_mode, ko_mode: e.ko_mode,
    item_count: icnt['i' + e.id] || 0,
    edition_count: ecnt['d' + e.id] || 0
  })));
});

// 只建「赛事定义」：赛制层面的一切，不含日期 / 级别 / 参赛名单。
app.post('/api/events', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const kind = b.kind, format = b.format;
  const bestOf = parseInt(b.best_of) || 3;
  if (!name) return res.status(400).json({ error: '请填写赛事名称' });
  if (!['individual', 'team'].includes(kind)) return res.status(400).json({ error: '赛事类型无效' });
  if (!EVENT_FORMAT_MAP[format]) return res.status(400).json({ error: '赛制无效' });
  if (![1, 3].includes(bestOf)) return res.status(400).json({ error: '局制无效' });
  // 非固搭双打：名单里是一个个的人（参赛单元 = 个人），项目决定按什么性别统计
  const freeKind = FREE_KIND_MAP[b.free_kind] ? b.free_kind : 'md';
  if (format === 'free' && kind !== 'individual') {
    return res.status(400).json({ error: '非固搭双打按个人参赛，赛事类型需为「单项赛」' });
  }

  let itemCodes = [];
  if (kind === 'team') {
    itemCodes = (Array.isArray(b.items) ? b.items : []).filter(c => TEAM_ITEM_MAP[c]);
    if (!itemCodes.length) return res.status(400).json({ error: '请至少勾选一个团体项目' });
    if (itemCodes.length % 2 === 0) {
      // 偶数项会出现 N/2 : N/2 的平局，N 项多数胜必须奇数才成立
      return res.status(400).json({ error: '团体项目数需为奇数（1 / 3 / 5 项），否则会出现无法分出胜负的平局' });
    }
  }

  let gc = 0, apg = 0;
  if (formatHasGroup(format)) gc = Math.max(1, parseInt(b.group_count) || 1);
  if (format === 'group_ko') apg = Math.max(1, parseInt(b.advance_per_group) || 1);
  // 出线名额上限留到建届时按实际队数再卡一次（赛制层不知道会有多少队）
  const seedBy = SEED_BY_MAP[b.seed_by] ? b.seed_by : 'entry';
  const groupMode = GROUP_MODE_MAP[b.group_mode] ? b.group_mode : 'snake';
  const koMode = (format === 'rr') ? 'seed' : (KO_MODE_MAP[b.ko_mode] ? b.ko_mode : 'seed');

  try {
    let eventId, tournamentId;
    tx(() => {
      // 镜像的 tournaments 行：让新赛事在赛事查询 / 积分排名里与老赛事地位同等。
      // type 先按类型给个中性值，建届录名单时会按本届实际阵容重算。
      const tourType = kind === 'team' ? 'team'
        : (format === 'free' ? TOUR_TYPE_OF_FREE_KIND[freeKind] : 'mixed_singles');
      query('INSERT INTO tournaments (name, type, level, icon) VALUES (?, ?, ?, ?)',
        [name, tourType, 1000, '']);
      tournamentId = lastInsertId();
      query(`INSERT INTO events (name, kind, format, best_of, free_kind, level, date, icon, third_place, lower_bracket, group_count, advance_per_group, seed_by, group_mode, ko_mode, status, tournament_id, created_at)
             VALUES (?, ?, ?, ?, ?, 1000, '', '', ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        [name, kind, format, bestOf, freeKind, b.third_place ? 1 : 0, b.lower_bracket ? 1 : 0, gc, apg, seedBy, groupMode, koMode, tournamentId, new Date().toISOString()]);
      eventId = lastInsertId();
      if (kind === 'team') {
        itemCodes.forEach((code, i) => {
          query('INSERT INTO event_items (event_id, code, name, seq) VALUES (?, ?, ?, ?)', [eventId, code, TEAM_ITEM_MAP[code].name, i + 1]);
        });
      }
    });
    res.json({ id: eventId, tournament_id: tournamentId });
  } catch (e) {
    res.status(400).json({ error: /UNIQUE/.test(e.message) ? '已有同名赛事，请换个名称' : e.message });
  }
});

// 赛事定义 + 团体项目 + 历届概览
app.get('/api/events/:id', (req, res) => {
  const event = eventRow(parseInt(req.params.id));
  if (!event) return res.status(404).json({ error: '赛事不存在' });
  const items = query('SELECT * FROM event_items WHERE event_id = ? ORDER BY seq, id', [event.id]);
  const eds = query('SELECT * FROM event_editions WHERE event_id = ? ORDER BY edition DESC, id DESC', [event.id]);
  const ecnt = {}, tcnt = {}, dcnt = {};
  for (const r of query('SELECT edition_id, COUNT(*) AS c FROM event_entries GROUP BY edition_id')) ecnt[r.edition_id] = r.c;
  for (const r of query('SELECT edition_id, COUNT(*) AS c FROM event_ties GROUP BY edition_id')) tcnt[r.edition_id] = r.c;
  for (const r of query("SELECT edition_id, COUNT(*) AS c FROM event_ties WHERE state = 'done' GROUP BY edition_id")) dcnt[r.edition_id] = r.c;
  res.json({
    event, items,
    editions: eds.map(e => ({
      ...e,
      entry_count: ecnt[e.id] || 0,
      tie_count: tcnt[e.id] || 0,
      done_count: dcnt[e.id] || 0
    }))
  });
});

app.delete('/api/events/:id', (req, res) => {
  const event = eventRow(parseInt(req.params.id));
  if (!event) return res.status(404).json({ error: '赛事不存在' });
  tx(() => {
    for (const ed of query('SELECT * FROM event_editions WHERE event_id = ?', [event.id])) deleteEditionData(ed);
    query('DELETE FROM event_editions WHERE event_id = ?', [event.id]);
    query('DELETE FROM event_items WHERE event_id = ?', [event.id]);
    query('DELETE FROM events WHERE id = ?', [event.id]);
    // 镜像行一并撤掉，否则积分榜/赛事查询里会留一个空赛事
    if (event.tournament_id) {
      for (const r of query('SELECT id FROM rounds WHERE tournament_id = ?', [event.tournament_id])) {
        query('DELETE FROM matches WHERE round_id = ?', [r.id]);
        query('DELETE FROM teams WHERE round_id = ?', [r.id]);
      }
      query('DELETE FROM rounds WHERE tournament_id = ?', [event.tournament_id]);
      query('DELETE FROM tournaments WHERE id = ?', [event.tournament_id]);
    }
  });
  res.json({ success: true });
});

// 改赛制：名称 / 类型 / 赛制 / 局制 / 季军赛 / 小组配置 / 团体项目与顺序
app.put('/api/events/:id/config', (req, res) => {
  const event = eventRow(parseInt(req.params.id));
  if (!event) return res.status(404).json({ error: '赛事不存在' });
  const b = req.body || {};
  try {
    tx(() => {
      if (b.third_place !== undefined) query('UPDATE events SET third_place = ? WHERE id = ?', [b.third_place ? 1 : 0, event.id]);
      if (b.lower_bracket !== undefined) query('UPDATE events SET lower_bracket = ? WHERE id = ?', [b.lower_bracket ? 1 : 0, event.id]);
      if (b.name) {
        query('UPDATE events SET name = ? WHERE id = ?', [String(b.name).trim(), event.id]);
        if (event.tournament_id) query('UPDATE tournaments SET name = ? WHERE id = ?', [String(b.name).trim(), event.tournament_id]);
      }
      if (b.best_of !== undefined) {
        const bo = parseInt(b.best_of) || 3;
        if (![1, 3].includes(bo)) throw new Error('局制无效');
        query('UPDATE events SET best_of = ? WHERE id = ?', [bo, event.id]);
      }
      if (b.format !== undefined && EVENT_FORMAT_MAP[b.format]) {
        query('UPDATE events SET format = ? WHERE id = ?', [b.format, event.id]);
      }
      if (b.free_kind !== undefined && FREE_KIND_MAP[b.free_kind]) {
        query('UPDATE events SET free_kind = ? WHERE id = ?', [b.free_kind, event.id]);
        if (event.tournament_id && event.format === 'free') {
          query('UPDATE tournaments SET type = ? WHERE id = ?', [TOUR_TYPE_OF_FREE_KIND[b.free_kind], event.tournament_id]);
        }
      }
      if (b.group_count !== undefined) query('UPDATE events SET group_count = ? WHERE id = ?', [Math.max(1, parseInt(b.group_count) || 1), event.id]);
      if (b.advance_per_group !== undefined) query('UPDATE events SET advance_per_group = ? WHERE id = ?', [Math.max(1, parseInt(b.advance_per_group) || 1), event.id]);
      if (b.seed_by !== undefined && SEED_BY_MAP[b.seed_by]) query('UPDATE events SET seed_by = ? WHERE id = ?', [b.seed_by, event.id]);
      if (b.group_mode !== undefined && GROUP_MODE_MAP[b.group_mode]) query('UPDATE events SET group_mode = ? WHERE id = ?', [b.group_mode, event.id]);
      if (b.ko_mode !== undefined && KO_MODE_MAP[b.ko_mode]) query('UPDATE events SET ko_mode = ? WHERE id = ?', [b.ko_mode, event.id]);
      // 项目顺序：只改 seq，不动已有对阵（对阵是按 tie_item 存的，单项按 seq 渲染）
      if (Array.isArray(b.items) && event.kind === 'team') {
        const codes = b.items.filter(c => TEAM_ITEM_MAP[c]);
        const exist = query('SELECT id, code FROM event_items WHERE event_id = ?', [event.id]);
        const byCode = {};
        for (const r of exist) byCode[r.code] = r;
        for (const r of exist) if (!codes.includes(r.code)) query('DELETE FROM event_items WHERE id = ?', [r.id]);
        codes.forEach((code, i) => {
          if (byCode[code]) query('UPDATE event_items SET seq = ? WHERE id = ?', [i + 1, byCode[code].id]);
          else query('INSERT INTO event_items (event_id, code, name, seq) VALUES (?, ?, ?, ?)', [event.id, code, TEAM_ITEM_MAP[code].name, i + 1]);
        });
      }
    });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- REST：届次（日期 / 级别 / 参赛名单 / 对阵 / 比分） ----------

// 建一届。同名赛事同届数只能有一个（与老 rounds 的口径一致）。
app.post('/api/events/:id/editions', (req, res) => {
  const event = eventRow(parseInt(req.params.id));
  if (!event) return res.status(404).json({ error: '赛事不存在' });
  const b = req.body || {};
  const editionNo = Math.max(1, parseInt(b.edition) || 1);
  if (query('SELECT id FROM event_editions WHERE event_id = ? AND edition = ?', [event.id, editionNo]).length) {
    return res.status(400).json({ error: `第 ${editionNo} 届已存在` });
  }
  const norm = normalizeEntries(event, b.entries);
  if (norm.error) return res.status(400).json({ error: norm.error });
  const entries = norm.entries;

  const date = b.date || new Date().toISOString().slice(0, 10);
  const level = parseInt(b.level) || 1000;
  if (event.format === 'group_ko') {
    const G = Math.max(1, event.group_count || 1);
    const apg = Math.max(1, event.advance_per_group || 1);
    if (entries.length < G * 2) return res.status(400).json({ error: `小组+淘汰赛制需要至少 ${G * 2} 个参赛单元（${G} 组 × 每组至少 2 个）` });
    if (apg >= Math.ceil(entries.length / G)) {
      return res.status(400).json({ error: '出线名额不能大于等于小组人数（每个小组至少要淘汰 1 个）' });
    }
  }
  // 非固搭双打：一场 4 人上场，且名单里每个人都可以先不录满，边打边加
  if (event.format === 'free' && entries.length < 4) {
    return res.status(400).json({ error: '非固搭双打至少需要 4 人（每场 4 人上场）' });
  }

  try {
    let editionId, roundId;
    tx(() => {
      query('INSERT INTO rounds (tournament_id, edition, round_number, date, level) VALUES (?, ?, 1, ?, ?)',
        [event.tournament_id, editionNo, date, level]);
      roundId = lastInsertId();
      query(`INSERT INTO event_editions (event_id, edition, date, level, status, round_id, created_at)
             VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
        [event.id, editionNo, date, level, roundId, new Date().toISOString()]);
      editionId = lastInsertId();
      writeEditionEntries(editionId, event.id, entries);
      if (event.tournament_id) {
        query('UPDATE tournaments SET type = ?, level = ? WHERE id = ?',
          [tournamentTypeFor(event, entries, norm.genderOf), level, event.tournament_id]);
      }
    });
    res.json({ id: editionId, round_id: roundId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 一届的完整详情。管理端工作台与前台「赛事查询」共用这一个接口。
app.get('/api/editions/:id', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event, gameNeed } = ctx;
  const graph = loadEventGraph(ed.id);

  const rows = graph.ties.map(t => ({
    ...t,
    items: (graph.itemsByTie[t.id] || []).map(it => ({
      ...it,
      side1_players: it.side1_players ? JSON.parse(it.side1_players) : [],
      side2_players: it.side2_players ? JSON.parse(it.side2_players) : [],
      games: graph.gamesByItem[it.id] || []
    })),
    outcome: tieOutcome(graph, t, gameNeed)
  }));

  const groupNos = [...new Set(graph.entries.filter(e => e.group_no > 0).map(e => e.group_no))].sort((a, b) => a - b);
  const standings = {};
  for (const g of groupNos) standings[g] = groupStandings(graph, g, gameNeed);
  // 与 computeEventRanking 保持同一口径：一场没打就不显示名次，否则等于是「按录入顺序冒充结果」
  const ordered = eventHasResults(graph) ? finalOrder(event, graph, gameNeed) : [];
  // 最终名次要带积分：前台只读页按老赛事卡片的样式展示「排名 + 积分」，
  // 这里直接复用 computeEventRanking 的 points_earned，保证与总积分榜同一个数。
  const rk = eventHasResults(graph) ? computeEventRanking(ed, ed.level) : null;
  const ptsByEntry = {};
  if (rk) for (const r of rk.rankings) ptsByEntry[r.entry_id] = r.points_earned;
  // 非固搭双打：名次来自个人累计（含并列），不能套用 finalOrder 的 index+1
  const freeRk = event.format === 'free' ? freeRanking(graph, ed.level, gameNeed) : null;
  const finalRanks = freeRk
    ? freeRk.rankings.map(r => ({
      rank: r.rank, entry_id: r.entry_id, label: r.label, member_ids: r.member_ids, points: r.points_earned,
      wins: r.wins, losses: r.losses, net_points: r.net_points
    }))
    : ordered.map((e, i) => ({
      rank: i + 1, entry_id: e.id, label: e.label,
      member_ids: graph.membersMap[e.id] || [],
      points: ptsByEntry[e.id] != null ? ptsByEntry[e.id] : null
    }));

  // 种子值：参赛单元成员的总积分之和（口径由和哥定）。只用于排序与展示，不参与任何比分计算。
  // seed_rank 以「定格值」为准：生成分组 / 生成签表那一刻写进 event_entries.seed_rank，
  // 之后比分引起积分变化也不会改 —— 否则赛后打开签表，种子号和当时的对阵逻辑会对不上。
  // 还没定格（0）时才按当前积分实时算：没生成过对阵的新名单、以及升级前的历史数据。
  const seedMap = entrySeedMap(graph);
  const seedRank = seedRanks(graph, seedMap);

  res.json({
    edition: ed, event, items: graph.items, best_of: event.best_of,
    entries: graph.entries.map(e => ({ ...e, members: graph.membersMap[e.id] || [], seed: seedMap[e.id] || 0, seed_rank: e.seed_rank || seedRank[e.id] || 0 })),
    ties: rows, standings, final_ranks: finalRanks,
    ko_rounds: koMaxRound(ed.id),
    lower_rounds: lowerMaxRound(ed.id),
    lower_bracket: effectiveLower(event, ed)
  });
});

// 手动分组：由管理员指定每个参赛单元进哪个组。写的是 event_entries.group_no，
// 之后「生成循环对阵」会直接沿用这份分组，不再做蛇形分配。
app.post('/api/editions/:id/set-groups', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event } = ctx;
  if (!formatHasGroup(event.format)) return res.status(400).json({ error: '该赛事赛制没有小组赛' });
  const G = Math.max(1, event.group_count || 1);
  const b = req.body || {};

  const entries = query('SELECT * FROM event_entries WHERE edition_id = ? ORDER BY seq, id', [ed.id]);
  if (!entries.length) return res.status(400).json({ error: '本届还没有参赛单元' });

  let assign;
  if (Array.isArray(b.assign)) {
    // 手动指定：[[entryId, groupNo], ...]
    const byId = {};
    for (const e of entries) byId[e.id] = e;
    const got = {};
    for (const [eid, g] of b.assign) {
      const id = parseInt(eid), gn = parseInt(g);
      if (!byId[id]) return res.status(400).json({ error: '参赛单元不在本届名单里' });
      if (!(gn >= 1 && gn <= G)) return res.status(400).json({ error: `组号只能是 1 ~ ${G}` });
      got[id] = gn;
    }
    for (const e of entries) if (!got[e.id]) return res.status(400).json({ error: `「${e.label}」还没指定小组` });
    assign = got;
  } else {
    // 自动：按种子顺序蛇形分组（前端「按积分自动蛇形分组」按钮走这条）
    const graph = loadEventGraph(ed.id);
    const order = seedOrder2(graph, b.seed_by || event.seed_by);
    const a = {};
    order.forEach((eid, i) => {
      const round = Math.floor(i / G), pos = i % G;
      a[eid] = ((round % 2 === 0) ? pos : (G - 1 - pos)) + 1;
    });
    assign = a;
  }

  const cnt = {};
  for (const e of entries) cnt[assign[e.id]] = (cnt[assign[e.id]] || 0) + 1;
  for (let g = 1; g <= G; g++) {
    if (!cnt[g]) return res.status(400).json({ error: `第 ${g} 组是空的，请每个组至少放 1 个参赛单元` });
  }
  for (const g of Object.keys(cnt)) {
    if (cnt[g] < 2) return res.status(400).json({ error: `第 ${g} 组只有 1 个参赛单元，打不了循环赛` });
  }

  try {
    tx(() => {
      // 种子排名定格：把当前种子顺序写进 event_entries.seed_rank（手动指定分组也照写，
      // 让签表 / 分组面板上的种子号从此稳定，不随后续积分变化跳动）。
      // 重新生成分组 / 改名单会清掉重来，所以这里永远反映「最近一次排对阵时」的口径。
      const g0 = loadEventGraph(ed.id);
      const so = seedOrder2(g0, b.seed_by || event.seed_by);
      const seedOf = {};
      so.forEach((eid, i) => { seedOf[eid] = i + 1; });
      for (const e of entries) query('UPDATE event_entries SET group_no = ?, seed_rank = ?, qual_label = ? WHERE id = ?', [assign[e.id], seedOf[e.id] || 0, '', e.id]);
      // 分组变了，已有对阵必然失效
      clearStage(ed.id, 'group'); clearStage(ed.id, 'ko'); clearStage(ed.id, 'third'); clearStage(ed.id, 'lower');
      updateEventStatus(ed.id);
    });
    res.json({ success: true, groups: G, assign });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 改届：日期 / 级别 / 届数 / 参赛名单。改名单会把本届已生成的对阵清空（名单变了对阵必然失效）。
app.put('/api/editions/:id', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event } = ctx;
  const b = req.body || {};
  try {
    tx(() => {
      if (b.edition !== undefined) {
        const n = Math.max(1, parseInt(b.edition) || 1);
        if (n !== ed.edition && query('SELECT id FROM event_editions WHERE event_id = ? AND edition = ?', [event.id, n]).length) {
          throw new Error(`第 ${n} 届已存在`);
        }
        query('UPDATE event_editions SET edition = ? WHERE id = ?', [n, ed.id]);
        if (ed.round_id) query('UPDATE rounds SET edition = ? WHERE id = ?', [n, ed.round_id]);
      }
      const date = b.date || ed.date;
      const level = b.level !== undefined ? (parseInt(b.level) || 1000) : ed.level;
      if (b.date) {
        query('UPDATE event_editions SET date = ? WHERE id = ?', [b.date, ed.id]);
        if (ed.round_id) query('UPDATE rounds SET date = ? WHERE id = ?', [b.date, ed.round_id]);
      }
      if (b.level !== undefined) {
        query('UPDATE event_editions SET level = ? WHERE id = ?', [level, ed.id]);
        if (ed.round_id) query('UPDATE rounds SET level = ? WHERE id = ?', [level, ed.round_id]);
        if (event.tournament_id) query('UPDATE tournaments SET level = ? WHERE id = ?', [level, event.tournament_id]);
      }
      if (Array.isArray(b.entries)) {
        const norm = normalizeEntries(event, b.entries);
        if (norm.error) throw new Error(norm.error);
        if (event.format === 'group_ko') {
          const G = Math.max(1, event.group_count || 1);
          const apg = Math.max(1, event.advance_per_group || 1);
          if (norm.entries.length < G * 2) throw new Error(`小组+淘汰赛制需要至少 ${G * 2} 个参赛单元（${G} 组 × 每组至少 2 个）`);
          if (apg >= Math.ceil(norm.entries.length / G)) throw new Error('出线名额不能大于等于小组人数（每个小组至少要淘汰 1 个）');
        }
        // 名单变了 → 旧对阵全部作废
        clearStage(ed.id, 'group'); clearStage(ed.id, 'ko'); clearStage(ed.id, 'third'); clearStage(ed.id, 'lower');
        // 非固搭双打不一样：已经打过的场次是个人成绩，不能因为改名单就抹掉。
        // 参赛单元会重建（id 全变），所以先记下「旧单元 → 选手」，重建后按选手接回去。
        const freeOld = event.format === 'free' ? freeEntryPidMap(ed.id) : null;
        query('DELETE FROM event_entry_members WHERE entry_id IN (SELECT id FROM event_entries WHERE edition_id = ?)', [ed.id]);
        query('DELETE FROM event_entries WHERE edition_id = ?', [ed.id]);
        writeEditionEntries(ed.id, event.id, norm.entries);
        if (freeOld) {
          remapFreeTies(ed.id, freeOld);
          if (query("SELECT COUNT(*) AS c FROM event_ties WHERE edition_id = ? AND stage = 'free'", [ed.id])[0].c) updateEventStatus(ed.id);
          else query("UPDATE event_editions SET status = 'draft' WHERE id = ?", [ed.id]);
        } else {
          query("UPDATE event_editions SET status = 'draft' WHERE id = ?", [ed.id]);
        }
        if (event.tournament_id) {
          query('UPDATE tournaments SET type = ? WHERE id = ?', [tournamentTypeFor(event, norm.entries, norm.genderOf), event.tournament_id]);
        }
      }
    });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 本届「败者组（决 5~8 名）」开关。
// 届次层的三个取值：null 跟随赛事（赛制）默认 | 0 本届不设 | 1 本届设 —— 存 NULL 是刻意的，
// 这样改一次赛制，所有没单独表态的届次自动跟着变。
// 开了但条件还没到（名单不是 8 个 / 小组赛没打完）时不报错，把原因回给前端提示：
// 等条件满足后点「重新生成淘汰签表」就会把败者组一起生成出来。
app.put('/api/editions/:id/lower-bracket', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event, gameNeed } = ctx;
  const b = req.body || {};
  const val = (b.on === null || b.on === undefined || b.on === 'default') ? null : (b.on ? 1 : 0);
  let reason = null;
  try {
    tx(() => {
      query('UPDATE event_editions SET lower_bracket = ? WHERE id = ?', [val, ed.id]);
      const ed2 = editionRow(ed.id);
      if (effectiveLower(event, ed2)) {
        reason = buildLowerBracket(ed2, event, loadEventGraph(ed.id), gameNeed);
      } else {
        clearStage(ed.id, 'lower');
      }
      updateEventStatus(ed.id);
    });
    res.json({ success: true, lower_bracket: effectiveLower(event, editionRow(ed.id)), reason });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 删掉一届：对阵 / 名单 / 镜像轮次一起撤，积分榜与荣誉同步回落
function deleteEditionData(ed) {
  query(`DELETE FROM event_tie_games WHERE tie_item_id IN
         (SELECT ti.id FROM event_tie_items ti JOIN event_ties t ON t.id = ti.tie_id WHERE t.edition_id = ?)`, [ed.id]);
  query(`DELETE FROM event_tie_items WHERE tie_id IN (SELECT id FROM event_ties WHERE edition_id = ?)`, [ed.id]);
  query('DELETE FROM event_ties WHERE edition_id = ?', [ed.id]);
  query('DELETE FROM event_entry_members WHERE entry_id IN (SELECT id FROM event_entries WHERE edition_id = ?)', [ed.id]);
  query('DELETE FROM event_entries WHERE edition_id = ?', [ed.id]);
  if (ed.round_id) {
    query('DELETE FROM matches WHERE round_id = ?', [ed.round_id]);
    query('DELETE FROM teams WHERE round_id = ?', [ed.round_id]);
    query('DELETE FROM rounds WHERE id = ?', [ed.round_id]);
  }
}

app.delete('/api/editions/:id', (req, res) => {
  const ed = editionRow(parseInt(req.params.id));
  if (!ed) return res.status(404).json({ error: '该届不存在' });
  tx(() => {
    deleteEditionData(ed);
    query('DELETE FROM event_editions WHERE id = ?', [ed.id]);
  });
  res.json({ success: true });
});

// 生成小组循环对阵。分组来源二选一：
//   group_mode = manual 且本届已经分好组 → 完全沿用管理员指定的分组，一个都不动；
//   否则按种子顺序蛇形分配（种子依据看 seed_by）。
app.post('/api/editions/:id/generate-groups', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event } = ctx;
  if (event.format === 'free') return res.status(400).json({ error: '非固搭双打没有小组赛，请直接录入每场比分' });
  if (!formatHasGroup(event.format)) return res.status(400).json({ error: '该赛事赛制为「淘汰赛」，没有小组赛' });
  const entries = query('SELECT * FROM event_entries WHERE edition_id = ? ORDER BY seq, id', [ed.id]);
  if (entries.length < 2) return res.status(400).json({ error: '至少需要 2 个参赛单元' });
  const G = Math.max(1, Math.min(event.group_count || 1, Math.floor(entries.length / 2) || 1));
  const force = !!(req.body && req.body.force);   // force=1：即使已手动分好组也重新按种子分

  // 已有的手动分组（group_no 全部落在 1..G 内且每组 >= 2）才作数
  const already = {};
  let manualOK = entries.length > 0;
  for (const e of entries) {
    const g = e.group_no || 0;
    if (!(g >= 1 && g <= G)) { manualOK = false; break; }
    already[e.id] = g;
  }
  if (manualOK) {
    const cnt = {};
    for (const e of entries) cnt[already[e.id]] = (cnt[already[e.id]] || 0) + 1;
    for (let g = 1; g <= G; g++) if (!cnt[g] || cnt[g] < 2) manualOK = false;
  }
  // 「已经分好组」就是权威：手动分过 / 上次生成留下的分组都认，只有 force 才重排。
  const useManual = manualOK && !force;

  try {
    tx(() => {
      clearStage(ed.id, 'group');
      // assign：entryId -> 组号（1..G）
      let assign;
      if (useManual) {
        assign = already;
      } else {
        // 蛇形分配：第 1 轮正序、第 2 轮倒序…… 让各组实力尽量均匀
        const graph = loadEventGraph(ed.id);
        const order = seedOrder2(graph, event.seed_by);
        assign = {};
        order.forEach((eid, i) => {
          const round = Math.floor(i / G), pos = i % G;
          assign[eid] = ((round % 2 === 0) ? pos : (G - 1 - pos)) + 1;
        });
      }
      // 种子排名定格：order 就是本次分组所用的种子顺序，把它写进 event_entries.seed_rank，
      // 之后积分怎么变都不影响已排好的分组与签表（重新生成才会刷新）
      const seedOf = {};
      order.forEach((eid, i) => { seedOf[eid] = i + 1; });
      entries.forEach(e => query('UPDATE event_entries SET group_no = ?, seed_rank = ?, qual_label = ? WHERE id = ?', [assign[e.id], seedOf[e.id] || 0, '', e.id]));
      for (let g = 1; g <= G; g++) {
        const list = entries.filter(e => assign[e.id] === g);
        let seq = 1;
        for (let a = 0; a < list.length; a++) {
          for (let b = a + 1; b < list.length; b++) {
            createTie(event, ed.id, { stage: 'group', group_no: g, side1: list[a].id, side2: list[b].id, seq: seq++ });
          }
        }
      }
      // 分组变了，淘汰赛要重来
      clearStage(ed.id, 'ko');
      clearStage(ed.id, 'third');
      clearStage(ed.id, 'lower');
      updateEventStatus(ed.id);
    });
    res.json({ success: true, groups: G });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 生成淘汰签表。小组赛+淘汰赛时，必须先打完小组赛，否则出线名单是错的。
app.post('/api/editions/:id/generate-ko', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event, gameNeed } = ctx;
  // 单循环 = 只循环不淘汰，生成签表会把赛制悄悄改成「小组+淘汰」，这里直接挡掉
  if (event.format === 'rr') return res.status(400).json({ error: '该赛事赛制为「单循环赛」，没有淘汰赛' });
  const graph = loadEventGraph(ed.id);

  // 出线者按「种子位」排好序的名单。三种对阵方式的差别只在这份名单怎么排：
  //   seed         名次优先再按组（A1 B1 A2 B2）→ 标准种子位天然错开，A1 打 B2、B1 打 A2
  //   random       打乱后随机落位，可能同组相遇
  //   random_avoid 打乱但强制首轮回避同组
  let qualifiers = [];
  const qualGroup = {};                       // entryId -> 小组号（仅 group_ko 有）
  const qualLabel = {};                       // entryId -> 淘汰赛身份标签（生成时按真实组号/名次记录）
  if (event.format === 'group_ko') {
    const undecided = graph.ties.filter(t => t.stage === 'group' && !t.winner_entry_id);
    if (undecided.length) {
      return res.status(400).json({ error: `还有 ${undecided.length} 场小组赛未完成，请先打完再生成淘汰签表` });
    }
    const G = Math.max(1, event.group_count || 1), adv = Math.max(1, event.advance_per_group || 1);
    const tables = {};
    for (let g = 1; g <= G; g++) tables[g] = groupStandings(graph, g, gameNeed);
    for (let r = 0; r < adv; r++) for (let g = 1; g <= G; g++) {
      const row = tables[g][r];
      // 身份标签用真实的组号/名次直接记，不靠下标反推 —— 某组出线不足时顺序有空洞也不会错位
      if (row) { qualifiers.push(row.entry_id); qualGroup[row.entry_id] = g; qualLabel[row.entry_id] = String.fromCharCode(64 + g) + (r + 1); }
    }
  } else {
    // 纯淘汰赛：没有小组名次，种子就按赛事配置的依据排（录入顺序 / 总积分）
    qualifiers = seedOrder2(graph, event.seed_by);
    qualifiers.forEach((eid, i) => { qualLabel[eid] = String(i + 1); });
  }
  if (qualifiers.length < 2) return res.status(400).json({ error: '可参赛/可出线的单元不足 2 个，无法生成淘汰签表' });

  const koMode = KO_MODE_MAP[event.ko_mode] ? event.ko_mode : 'seed';
  const size = Math.pow(2, Math.ceil(Math.log2(qualifiers.length)));
  const R = Math.round(Math.log2(size));
  const order = seedOrder(size);

  // 首轮有多少场「两个人都到齐」的对阵（有 bye 的场次天然不会同组相遇，不用管）
  const firstRoundPairs = Math.floor(size / 2);
  const shuffle = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };
  // 按 seedOrder 落位后，检查首轮每个 slot 上的两人是否同组
  const firstRoundClash = arr => {
    for (let i = 0; i < firstRoundPairs; i++) {
      const a = arr[order[i * 2] - 1], b = arr[order[i * 2 + 1] - 1];
      if (a && b && qualGroup[a] && qualGroup[a] === qualGroup[b]) return true;
    }
    return false;
  };
  let placed = qualifiers;
  if (koMode === 'random') {
    placed = shuffle(qualifiers);
  } else if (koMode === 'random_avoid') {
    // 抽不到就多抽几次；真的抽不出来（例如某组出线人数过多）就退回普通随机，
    // 不让它卡住 —— 签表生成后管理员还能用「点两个位置交换」手工调。
    let ok = false;
    for (let t = 0; t < 300 && !ok; t++) {
      const cand = shuffle(qualifiers);
      if (!firstRoundClash(cand)) { placed = cand; ok = true; }
    }
    if (!ok) placed = shuffle(qualifiers);
  }

  let lowerReason = null;
  try {
    tx(() => {
      clearStage(ed.id, 'ko');
      clearStage(ed.id, 'third');
      clearStage(ed.id, 'lower');
      // 身份标签：group_ko = 小组名次「A1/B2」，纯 KO = 种子位数字（qualLabel 在上面按真实组号/名次构建）。
      // 签表上优先显示它：group_ko 的半决赛是「小组第一 VS 另一组第二」，
      // 显示种子号会让人误以为种子错位，显示 A1/B2 才和对阵逻辑自洽。
      // 纯淘汰赛同时把种子排名定格为本次排布所用的种子顺序；group_ko 的种子号沿用生成分组时定格的值。
      for (const e of graph.entries) {
        if (event.format === 'group_ko') query('UPDATE event_entries SET qual_label = ? WHERE id = ?', [qualLabel[e.id] || '', e.id]);
        else query('UPDATE event_entries SET seed_rank = ?, qual_label = ? WHERE id = ?', [qualifiers.indexOf(e.id) + 1, qualLabel[e.id] || '', e.id]);
      }
      for (let i = 0; i < size / 2; i++) {
        const s1 = order[i * 2], s2 = order[i * 2 + 1];
        createTie(event, ed.id, {
          stage: 'ko', ko_round: 1, slot: i, seq: i + 1,
          side1: s1 <= placed.length ? placed[s1 - 1] : null,
          side2: s2 <= placed.length ? placed[s2 - 1] : null
        });
      }
      for (let r = 2; r <= R; r++) {
        const cnt = size / Math.pow(2, r);
        for (let i = 0; i < cnt; i++) createTie(event, ed.id, { stage: 'ko', ko_round: r, slot: i, seq: i + 1 });
      }
      if (event.third_place && R >= 2) createTie(event, ed.id, { stage: 'third', ko_round: R, slot: 0, seq: 1 });
      autoAdvanceByes(ed.id);
      updateEventStatus(ed.id);
      lowerReason = buildLowerBracket(ed, event, loadEventGraph(ed.id), gameNeed);
      if (lowerReason === null) updateEventStatus(ed.id);
    });
    res.json({ success: true, size, rounds: R, qualifiers: qualifiers.length, lower_reason: lowerReason });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 手动调整签表：交换两个位置上的参赛单元。
// 约束：所有淘汰赛都还没开打才允许 —— 一旦有比分，改了上游就要连带作废下游，风险大于收益，
// 这种情况请用「重新生成淘汰签表」。
app.post('/api/editions/:id/ko-swap', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed } = ctx;
  // 主淘汰赛和败者组共用这套「还没开打就能换位」的逻辑，stage 由前端传。
  const stage = (req.body.stage === 'lower') ? 'lower' : 'ko';
  const { a, b } = req.body || {};
  if (!a || !b || a.ko_round !== b.ko_round) {
    return res.status(400).json({ error: '只能在同一轮内交换位置' });
  }
  const ta = query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = ? AND ko_round = ? AND slot = ?", [ed.id, stage, a.ko_round, a.slot])[0];
  const tb = query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = ? AND ko_round = ? AND slot = ?", [ed.id, stage, b.ko_round, b.slot])[0];
  if (!ta || !tb) return res.status(404).json({ error: '签表位置不存在' });
  const played = query("SELECT COUNT(*) AS c FROM event_ties WHERE edition_id = ? AND stage IN ('ko','third','lower') AND winner_entry_id IS NOT NULL", [ed.id])[0].c;
  if (played > 0) return res.status(400).json({ error: '淘汰赛已开打，无法再调整签表。如需重排请点「重新生成淘汰签表」' });

  const colA = a.side === 1 ? 'side1_entry_id' : 'side2_entry_id';
  const colB = b.side === 1 ? 'side1_entry_id' : 'side2_entry_id';
  try {
    tx(() => {
      const va = ta[colA], vb = tb[colB];
      if (ta.id === tb.id) {
        query(`UPDATE event_ties SET ${colA} = ?, ${colB} = ? WHERE id = ?`, [vb, va, ta.id]);
      } else {
        query(`UPDATE event_ties SET ${colA} = ? WHERE id = ?`, [vb, ta.id]);
        query(`UPDATE event_ties SET ${colB} = ? WHERE id = ?`, [va, tb.id]);
      }
      // 轮空关系可能变了：清掉全部胜负再重推一遍轮空
      query("UPDATE event_ties SET winner_entry_id = NULL, state = 'pending' WHERE edition_id = ? AND stage IN ('ko','third','lower')", [ed.id]);
      autoAdvanceByes(ed.id);
      updateEventStatus(ed.id);
    });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 录入 / 修改一场对抗的结果
app.post('/api/editions/:id/tie/:tieId', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event, gameNeed } = ctx;
  const tie = query('SELECT * FROM event_ties WHERE id = ? AND edition_id = ?', [parseInt(req.params.tieId), ed.id])[0];
  if (!tie) return res.status(404).json({ error: '该场对抗不存在' });
  if (!tie.side1_entry_id || !tie.side2_entry_id) {
    return res.status(400).json({ error: '对阵双方还没确定（等待上一轮结果）' });
  }

  const body = req.body || {};
  const itemsIn = Array.isArray(body.items) ? body.items : [];
  const genderOf = playerGenderMap();
  const membersMap = {};
  for (const r of query(`SELECT m.entry_id, m.player_id FROM event_entry_members m
                         JOIN event_entries e ON e.id = m.entry_id
                         WHERE e.edition_id = ? ORDER BY m.seq`, [ed.id])) {
    (membersMap[r.entry_id] || (membersMap[r.entry_id] = [])).push(r.player_id);
  }

  // 先全量校验，任何一项不合法就整体拒绝 —— 免得录到一半写进去一半
  const prepared = [];
  for (const it of itemsIn) {
    const row = query('SELECT * FROM event_tie_items WHERE id = ? AND tie_id = ?', [parseInt(it.item_id), tie.id])[0];
    if (!row) continue;
    const s1 = (it.side1_players || []).map(Number).filter(Boolean);
    const s2 = (it.side2_players || []).map(Number).filter(Boolean);
    const def = TEAM_ITEM_MAP[row.code];
    if (event.kind === 'team' && def) {
      const e1 = validateLineup(def, s1, genderOf, membersMap[tie.side1_entry_id]);
      if (e1) return res.status(400).json({ error: `左方 ${e1}` });
      const e2 = validateLineup(def, s2, genderOf, membersMap[tie.side2_entry_id]);
      if (e2) return res.status(400).json({ error: `右方 ${e2}` });
      if (s1.length && s2.length) {
        for (const pid of s1) if (s2.includes(pid)) return res.status(400).json({ error: `${def.name}中双方不能有同一名选手` });
      }
    } else if (s1.length > 2 || s2.length > 2) {
      return res.status(400).json({ error: '单项赛每方最多 2 名选手' });
    }
    const games = (Array.isArray(it.games) ? it.games : []).map(g => ({
      s1: Math.max(0, parseInt(g.s1) || 0),
      s2: Math.max(0, parseInt(g.s2) || 0)
    })).filter(g => g.s1 || g.s2).slice(0, event.best_of || 3);   // 一局制只认第一局
    prepared.push({ row, s1, s2, games });
  }

  try {
    tx(() => {
      for (const p of prepared) {
        query('UPDATE event_tie_items SET side1_players = ?, side2_players = ? WHERE id = ?',
          [JSON.stringify(p.s1), JSON.stringify(p.s2), p.row.id]);
        query('DELETE FROM event_tie_games WHERE tie_item_id = ?', [p.row.id]);
        p.games.forEach((g, i) => query('INSERT INTO event_tie_games (tie_item_id, game_no, s1, s2) VALUES (?, ?, ?, ?)',
          [p.row.id, i + 1, g.s1, g.s2]));
      }
      settleTie(ed.id, tie.id, gameNeed);
      fillThirdPlace(ed.id, event);
      fillLowerBracket(ed.id, event, loadEventGraph(ed.id), gameNeed);
      updateEventStatus(ed.id);
    });
    const fresh = query('SELECT * FROM event_ties WHERE id = ?', [tie.id])[0];
    res.json({ success: true, tie: fresh });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 非固搭双打：手动录入每场（4 人临时配对 + 比分） ----------

// 本届里这个人的参赛单元；没有就现场加一个，名单可以边打边补（与老狗王杯的习惯一致）
function ensurePlayerEntry(editionId, eventId, pid, nameOf) {
  const m = query(`SELECT m.entry_id FROM event_entry_members m
                   JOIN event_entries e ON e.id = m.entry_id
                   WHERE e.edition_id = ? AND m.player_id = ?`, [editionId, pid])[0];
  if (m) return m.entry_id;
  const mx = query('SELECT MAX(seq) AS s FROM event_entries WHERE edition_id = ?', [editionId])[0];
  query('INSERT INTO event_entries (event_id, edition_id, label, group_no, seq) VALUES (?, ?, ?, 0, ?)',
    [eventId, editionId, nameOf[pid] || ('选手' + pid), (mx && mx.s || 0) + 1]);
  const eid = lastInsertId();
  query('INSERT INTO event_entry_members (entry_id, player_id, seq) VALUES (?, ?, 1)', [eid, pid]);
  return eid;
}

function createFreeTie(event, editionId, e1, e2, e3, e4, seq) {
  query(`INSERT INTO event_ties (event_id, edition_id, stage, group_no, ko_round, slot,
         side1_entry_id, side1_entry2_id, side2_entry_id, side2_entry2_id, winner_entry_id, state, seq)
         VALUES (?, ?, 'free', 0, 0, 0, ?, ?, ?, ?, NULL, 'pending', ?)`,
    [event.id, editionId, e1, e2, e3, e4, seq]);
  const tieId = lastInsertId();
  query(`INSERT INTO event_tie_items (tie_id, code, name, seq, side1_players, side2_players, winner_side)
         VALUES (?, '', '比赛', 1, '', '', 0)`, [tieId]);
  return tieId;
}

// 这四个人凑的一场，本届里是否已经录过。
// 认场次的口径是「4 个人 + 怎么搭」：
//   · 同样 4 个人、同样的两边坐法（左右互换也算）→ 同一场，重复录入只覆盖比分；
//   · 同样 4 个人、换成另一种搭法 → 新的一场（常见赛程：同 4 人打两三种搭配，如欣欣杯）。
// 特例：这 4 人已有一场但还没录比分（比如一键生成时挑的搭配和实际打得不一样），
// 直接沿用那一场把搭配改成实际打法，不留一个空壳重复场次。
function findFreeTie(editionId, e1, e2, e3, e4) {
  const pairKey = (a, b) => [a, b].map(Number).sort((x, y) => x - y).join(',');
  const fourKey = arr => arr.map(Number).sort((x, y) => x - y).join(',');
  const want4 = fourKey([e1, e2, e3, e4]);
  const wantL = pairKey(e1, e2), wantR = pairKey(e3, e4);
  let unscored = null;
  for (const t of query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'free'", [editionId])) {
    const four = [t.side1_entry_id, t.side1_entry2_id, t.side2_entry_id, t.side2_entry2_id];
    if (!four.every(Boolean) || fourKey(four) !== want4) continue;
    const l = pairKey(t.side1_entry_id, t.side1_entry2_id);
    const r = pairKey(t.side2_entry_id, t.side2_entry2_id);
    if ((l === wantL && r === wantR) || (l === wantR && r === wantL)) return { tie: t };
    if (!unscored && !query(`SELECT 1 AS x FROM event_tie_games g JOIN event_tie_items i ON i.id = g.tie_item_id
                             WHERE i.tie_id = ? LIMIT 1`, [t.id]).length) unscored = t;
  }
  return unscored ? { tie: unscored } : null;
}

// ---------- 非固搭双打：一键生成全部对局 ----------
//
// 排法：任取 4 人凑一场，这 4 人怎么分成两边由算法挑。
//   6 人 → C(6,4) = 15 场（与狗王杯的场次数一致）
//   5 人 → 5 场　7 人 → 35 场　8 人 → 70 场
// 挑的目标是「尽量平均」：每一对搭档、每一对对手出现的次数越齐越好。
// 数学上就是让所有搭档次数的平方和 + 所有对手次数的平方和最小（平方和越小越平均）。
// 4 个位置拆成两边只有 3 种拆法：
const FREE_SPLITS = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];

function deleteTieData(tieId) {
  query('DELETE FROM event_tie_games WHERE tie_item_id IN (SELECT id FROM event_tie_items WHERE tie_id = ?)', [tieId]);
  query('DELETE FROM event_tie_items WHERE tie_id = ?', [tieId]);
  query('DELETE FROM event_ties WHERE id = ?', [tieId]);
}

// 参赛单元 → 选手（非固搭双打里一个单元就是一个人）
function freeEntryPidMap(editionId) {
  const m = {};
  for (const r of query(`SELECT m.entry_id AS eid, m.player_id AS pid FROM event_entry_members m
                         JOIN event_entries e ON e.id = m.entry_id WHERE e.edition_id = ?`, [editionId])) m[r.eid] = r.pid;
  return m;
}

// 改名单后把已录的场次接回新单元：按选手认人，不认 id。
// 选手被移出名单的那一场才删掉（人都不在了，这场没法算）。
function remapFreeTies(editionId, oldPid) {
  const now = {};
  for (const r of query(`SELECT m.entry_id AS eid, m.player_id AS pid FROM event_entry_members m
                         JOIN event_entries e ON e.id = m.entry_id WHERE e.edition_id = ?`, [editionId])) now[r.pid] = r.eid;
  const cols = ['side1_entry_id', 'side1_entry2_id', 'side2_entry_id', 'side2_entry2_id'];
  let dropped = 0;
  for (const t of query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'free'", [editionId])) {
    const fresh = [], seen = {};
    let ok = true;
    for (const c of cols) {
      const ne = now[oldPid[t[c]]];
      if (!ne || seen[ne]) { ok = false; break; }   // 人没了 / 4 个位置出现重复的人
      seen[ne] = true; fresh.push(ne);
    }
    if (!ok) { deleteTieData(t.id); dropped++; continue; }
    query('UPDATE event_ties SET side1_entry_id = ?, side1_entry2_id = ?, side2_entry_id = ?, side2_entry2_id = ? WHERE id = ?',
      [...fresh, t.id]);
  }
  return dropped;
}

// 排出本届全部对局骨架。ids = 参赛单元 id（每人一个单元），pidOf = 单元 → 选手 id。
// 混双只取「2 男 2 女」的 4 人组，且只保留「每边 1 男 1 女」的拆法。
function freePlan(ids, pidOf, genderOf, kind) {
  const combos = [];
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      for (let c = b + 1; c < ids.length; c++) {
        for (let d = c + 1; d < ids.length; d++) {
          const four = [ids[a], ids[b], ids[c], ids[d]];
          const gs = four.map(id => genderOf[pidOf[id]]);
          if (kind === 'md' && gs.some(g => g !== 'male')) continue;
          if (kind === 'wd' && gs.some(g => g !== 'female')) continue;
          if (kind === 'xd' && gs.filter(g => g === 'male').length !== 2) continue;
          combos.push(four);
        }
      }
    }
  }
  // 这一场里某一边是不是符合项目要求（混双要求 1 男 1 女）
  const splitOk = (four, sp) => {
    if (kind !== 'xd') return true;
    for (const pair of sp) {
      const gs = pair.map(k => genderOf[pidOf[four[k]]]);
      if (!(gs.includes('male') && gs.includes('female'))) return false;
    }
    return true;
  };
  const cands = combos.map(c => FREE_SPLITS.filter(sp => splitOk(c, sp)));

  const pk = (x, y) => (x < y ? x + ':' + y : y + ':' + x);
  const pc = {}, oc = {};                       // 搭档次数 / 对手次数
  const bump = (m, k, dv) => { m[k] = (m[k] || 0) + dv; };
  const apply = (i, sp, dv) => {
    const c = combos[i];
    const p = sp[0].map(k => c[k]), q = sp[1].map(k => c[k]);
    bump(pc, pk(p[0], p[1]), dv);
    bump(pc, pk(q[0], q[1]), dv);
    for (const x of p) for (const y of q) bump(oc, pk(x, y), dv);
  };
  // 采用某拆法后，平方和会涨多少：次数 k → k+1，平方和多 2k+1
  const marginal = (i, sp) => {
    const c = combos[i];
    const p = sp[0].map(k => c[k]), q = sp[1].map(k => c[k]);
    let cost = 2 * (pc[pk(p[0], p[1])] || 0) + 1 + 2 * (pc[pk(q[0], q[1])] || 0) + 1;
    for (const x of p) for (const y of q) cost += 2 * (oc[pk(x, y)] || 0) + 1;
    return cost;
  };
  const pick = i => {
    let best = cands[i][0], bc = Infinity;
    for (const sp of cands[i]) { const c = marginal(i, sp); if (c < bc) { bc = c; best = sp; } }
    return best;
  };

  const choice = combos.map(() => null);
  for (let i = 0; i < combos.length; i++) { choice[i] = pick(i); apply(i, choice[i], 1); }
  // 第一遍是贪心（前面的场次占便宜），再反复微调：换一种拆法能更平均就换
  for (let pass = 0; pass < 60; pass++) {
    let changed = false;
    for (let i = 0; i < combos.length; i++) {
      if (cands[i].length < 2) continue;
      apply(i, choice[i], -1);
      const best = pick(i);
      apply(i, best, 1);
      if (best !== choice[i]) { choice[i] = best; changed = true; }
    }
    if (!changed) break;
  }
  return combos.map((c, i) => ({ s1: choice[i][0].map(k => c[k]), s2: choice[i][1].map(k => c[k]) }));
}

// 生成全部对局骨架。已经存在的那 4 人组合不会重复生成（已录比分的场次一个都不动），
// 名单里已经被删掉的人参与的场次会被作废。
app.post('/api/editions/:id/free-generate', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event } = ctx;
  if (event.format !== 'free') return res.status(400).json({ error: '该赛事不是「非固搭双打」赛制' });
  const kind = FREE_KIND_MAP[event.free_kind] ? event.free_kind : 'md';
  const kindDef = FREE_KIND_MAP[kind];

  const pidOf = {};
  for (const r of query(`SELECT m.entry_id AS eid, m.player_id AS pid FROM event_entry_members m
                         JOIN event_entries e ON e.id = m.entry_id WHERE e.edition_id = ?`, [ed.id])) pidOf[r.eid] = r.pid;
  const ids = query('SELECT id FROM event_entries WHERE edition_id = ? ORDER BY seq, id', [ed.id])
    .map(e => e.id).filter(id => pidOf[id]);
  if (ids.length < 4) return res.status(400).json({ error: '非固搭双打至少需要 4 人（每场 4 人上场）' });
  const total4 = ids.length * (ids.length - 1) * (ids.length - 2) * (ids.length - 3) / 24;
  if (total4 > 220) {
    return res.status(400).json({ error: `${ids.length} 人两两搭配是 ${total4} 场，太多了。非固搭双打建议 4~9 人` });
  }
  const genderOf = playerGenderMap();
  const plan = freePlan(ids, pidOf, genderOf, kind);
  if (!plan.length) {
    return res.status(400).json({
      error: kind === 'xd' ? '混双每场要 2 男 2 女，本届名单凑不出这样的 4 人'
        : `${kindDef.name}需要 4 名${kind === 'md' ? '男' : '女'}选手，本届名单不够`
    });
  }

  const key4 = arr => arr.filter(Boolean).map(Number).sort((a, b) => a - b).join(',');
  try {
    let added = 0, dropped = 0;
    tx(() => {
      const have = new Set();
      const valid = new Set(ids);
      for (const t of query("SELECT * FROM event_ties WHERE edition_id = ? AND stage = 'free'", [ed.id])) {
        const four = [t.side1_entry_id, t.side1_entry2_id, t.side2_entry_id, t.side2_entry2_id];
        // 名单改过：这一场有人不在本届了，留着也没法算，作废
        if (four.some(x => !x || !valid.has(x))) { deleteTieData(t.id); dropped++; continue; }
        have.add(key4(four));
      }
      const mx = query("SELECT MAX(seq) AS s FROM event_ties WHERE edition_id = ? AND stage = 'free'", [ed.id])[0];
      let seq = (mx && mx.s) || 0;
      for (const m of plan) {
        if (have.has(key4([...m.s1, ...m.s2]))) continue;
        createFreeTie(event, ed.id, m.s1[0], m.s1[1], m.s2[0], m.s2[1], ++seq);
        added++;
      }
      if (added || dropped) updateEventStatus(ed.id);
    });
    res.json({ success: true, added, dropped, total: plan.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 录入 / 更新一场。左右两人 = p1+p2，另两人 = p3+p4；同一场重复录入是更新比分，不会多出一场。
app.post('/api/editions/:id/free-match', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event, gameNeed } = ctx;
  if (event.format !== 'free') return res.status(400).json({ error: '该赛事不是「非固搭双打」赛制' });

  const b = req.body || {};
  const pids = [b.p1, b.p2, b.p3, b.p4].map(x => parseInt(x) || 0);
  if (pids.some(x => !x)) return res.status(400).json({ error: '请选择 4 名选手' });
  if (new Set(pids).size !== 4) return res.status(400).json({ error: '同一场的 4 名选手不能重复' });

  const genderOf = playerGenderMap();
  for (const pid of pids) if (!genderOf[pid]) return res.status(400).json({ error: '有选手不存在，请刷新选手列表' });
  const kindDef = FREE_KIND_MAP[event.free_kind] || FREE_KINDS[0];
  if (kindDef.gender) {
    const bad = pids.filter(pid => genderOf[pid] !== kindDef.gender);
    if (bad.length) return res.status(400).json({ error: `${kindDef.name}项目只能上${kindDef.gender === 'male' ? '男' : '女'}选手` });
  } else {
    // 混双：每一边必须 1 男 1 女
    for (const pair of [[pids[0], pids[1]], [pids[2], pids[3]]]) {
      const gs = pair.map(pid => genderOf[pid]);
      if (!(gs.includes('male') && gs.includes('female'))) return res.status(400).json({ error: '混双每一边必须是 1 男 1 女' });
    }
  }

  const games = (Array.isArray(b.games) ? b.games : []).map(g => ({
    s1: Math.max(0, parseInt(g.s1) || 0), s2: Math.max(0, parseInt(g.s2) || 0)
  })).filter(g => g.s1 || g.s2).slice(0, event.best_of || 3);
  if (!games.length) return res.status(400).json({ error: '请填写比分' });

  const nameOf = {};
  for (const p of query('SELECT id, name, real_name FROM players')) nameOf[p.id] = p.real_name || p.name;

  try {
    let tieId = null;
    tx(() => {
      const [e1, e2, e3, e4] = pids.map(pid => ensurePlayerEntry(ed.id, event.id, pid, nameOf));
      const found = findFreeTie(ed.id, e1, e2, e3, e4);
      if (found) tieId = found.tie.id;
      else {
        const mx = query("SELECT COUNT(*) AS c FROM event_ties WHERE edition_id = ? AND stage = 'free'", [ed.id])[0];
        tieId = createFreeTie(event, ed.id, e1, e2, e3, e4, (mx && mx.c || 0) + 1);
      }
      // 沿用找到的那场（同搭配 → 覆盖比分；空壳场 → 改成实际搭配）；
      // 新搭配则上面已新建一场。两边坐谁一律按本次录入的方向写，比分同向存，不用交换
      query('UPDATE event_ties SET side1_entry_id = ?, side1_entry2_id = ?, side2_entry_id = ?, side2_entry2_id = ? WHERE id = ?',
        [e1, e2, e3, e4, tieId]);
      const item = query('SELECT * FROM event_tie_items WHERE tie_id = ? ORDER BY seq, id', [tieId])[0];
      query('UPDATE event_tie_items SET side1_players = ?, side2_players = ? WHERE id = ?',
        [JSON.stringify([e1, e2]), JSON.stringify([e3, e4]), item.id]);
      query('DELETE FROM event_tie_games WHERE tie_item_id = ?', [item.id]);
      games.forEach((g, i) => query('INSERT INTO event_tie_games (tie_item_id, game_no, s1, s2) VALUES (?, ?, ?, ?)',
        [item.id, i + 1, g.s1, g.s2]));
      settleTie(ed.id, tieId, gameNeed);
      updateEventStatus(ed.id);
    });
    res.json({ success: true, tie_id: tieId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 删掉一场（连带比分）。人留在名单里，方便继续用。
app.delete('/api/editions/:id/free-match/:tieId', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed } = ctx;
  const tie = query("SELECT * FROM event_ties WHERE id = ? AND edition_id = ? AND stage = 'free'", [parseInt(req.params.tieId), ed.id])[0];
  if (!tie) return res.status(404).json({ error: '这一场不存在' });
  tx(() => {
    query('DELETE FROM event_tie_games WHERE tie_item_id IN (SELECT id FROM event_tie_items WHERE tie_id = ?)', [tie.id]);
    query('DELETE FROM event_tie_items WHERE tie_id = ?', [tie.id]);
    query('DELETE FROM event_ties WHERE id = ?', [tie.id]);
    updateEventStatus(ed.id);
  });
  res.json({ success: true });
});

// 清空一场对抗的结果
app.post('/api/editions/:id/tie/:tieId/clear', (req, res) => {
  const ctx = editionCtx(parseInt(req.params.id));
  if (!ctx) return res.status(404).json({ error: '该届不存在' });
  const { ed, event } = ctx;
  const tie = query('SELECT * FROM event_ties WHERE id = ? AND edition_id = ?', [parseInt(req.params.tieId), ed.id])[0];
  if (!tie) return res.status(404).json({ error: '该场对抗不存在' });
  tx(() => {
    resetTie(tie.id);
    propagate(query('SELECT * FROM event_ties WHERE id = ?', [tie.id])[0], null);
    fillThirdPlace(ed.id, event);
    fillLowerBracket(ed.id, event, loadEventGraph(ed.id), gameNeed);
    updateEventStatus(ed.id);
  });
  res.json({ success: true });
});

// ==================== Auth ====================

app.get('/api/auth/security-question', (req, res) => {
  const row = query("SELECT value FROM settings WHERE key = 'security_question'");
  res.json({ question: row.length ? row[0].value : '' });
});

app.post('/api/auth/verify', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '请输入密码' });
  if (!/^\d{6}$/.test(password)) return res.status(400).json({ error: '密码必须为6位数字' });
  const row = query("SELECT value FROM settings WHERE key = 'password'");
  const valid = row.length && row[0].value === password;
  if (!valid) return res.status(403).json({ error: '密码错误' });
  res.json({ success: true });
});

app.post('/api/auth/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: '请填写当前密码和新密码' });
  if (!/^\d{6}$/.test(newPassword)) return res.status(400).json({ error: '新密码必须为6位数字' });
  const row = query("SELECT value FROM settings WHERE key = 'password'");
  if (!row.length || row[0].value !== currentPassword) return res.status(403).json({ error: '当前密码错误' });
  query("UPDATE settings SET value = ? WHERE key = 'password'", [newPassword]);
  res.json({ success: true });
});

app.post('/api/auth/forgot-password', (req, res) => {
  const { answer, newPassword } = req.body;
  if (!answer || !newPassword) return res.status(400).json({ error: '请填写答案和新密码' });
  if (!/^\d{6}$/.test(newPassword)) return res.status(400).json({ error: '新密码必须为6位数字' });
  const row = query("SELECT value FROM settings WHERE key = 'security_answer'");
  if (!row.length || row[0].value !== answer) return res.status(403).json({ error: '密保答案错误' });
  query("UPDATE settings SET value = ? WHERE key = 'password'", [newPassword]);
  res.json({ success: true });
});

app.post('/api/auth/change-security', (req, res) => {
  const { password, question, answer } = req.body;
  if (!password || !question || !answer) return res.status(400).json({ error: '请填写所有字段' });
  const row = query("SELECT value FROM settings WHERE key = 'password'");
  if (!row.length || row[0].value !== password) return res.status(403).json({ error: '密码错误' });
  query("UPDATE settings SET value = ? WHERE key = 'security_question'", [question]);
  query("UPDATE settings SET value = ? WHERE key = 'security_answer'", [answer]);
  res.json({ success: true });
});

// ==================== Database Backup ====================
app.get('/api/backup', (req, res) => {
  const DB_PATH = path.join(__dirname, 'data.db');
  saveDatabase();
  if (!require('fs').existsSync(DB_PATH)) {
    return res.status(404).json({ error: 'Database file not found' });
  }
  res.download(DB_PATH, `data_${new Date().toISOString().slice(0, 10)}.db`);
});

// ==================== Start Server ====================

const PORT = process.env.PORT || 3000;

let server;

// 启动自检：新赛事靠「每届镜像一行 rounds」接进老页面（积分榜 / 荣誉 / 选手资料）。
// round_id 一旦为空，整条链路会静默失效——不报错、不告警，页面上就是少一列。
// 2026-10-17 的总决赛正是这么断的，所以在这里钉一道。
function checkEventRoundMirror() {
  try {
    const bad = query('SELECT id, event_id, edition, date FROM event_editions WHERE round_id IS NULL');
    if (!bad.length) return;
    console.log('⚠️  有 %d 届新赛事缺少镜像轮次，它们的赛果不会出现在积分榜 / 荣誉 / 选手资料：', bad.length);
    for (const e of bad) console.log('    届 id=%d event_id=%d 第%s届 %s', e.id, e.event_id, e.edition, e.date);
  } catch (e) { /* 老库没有 event_editions 表就跳过 */ }
}

async function start() {
  await initDatabase();
  db = getDb();
  checkEventRoundMirror();
  server = app.listen(PORT, () => console.log(`羽毛球积分系统已启动: http://localhost:${PORT}`));
}

start();
