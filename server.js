const express = require('express');
const path = require('path');
const { initDatabase, saveDatabase, getDb } = require('./database');

const app = express();

// ==================== Auto Sleep ====================
let lastAccessTime = Date.now();
const IDLE_TIMEOUT = (parseInt(process.env.IDLE_TIMEOUT_MINUTES) || 3) * 60 * 1000;

app.use((req, res, next) => {
  lastAccessTime = Date.now();
  next();
});

const sleepTimer = setInterval(() => {
  if (Date.now() - lastAccessTime > IDLE_TIMEOUT) {
    console.log(`已闲置 ${IDLE_TIMEOUT / 60000} 分钟，进入休眠...`);
    clearInterval(sleepTimer);
    saveDatabase();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  }
}, 30000);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;

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
  saveDatabase();
  return null;
}

// ==================== Players ====================

app.get('/api/players', (req, res) => {
  res.json(query('SELECT id, name, gender, real_name FROM players ORDER BY name'));
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
  res.json(query('SELECT id, name, type, level FROM tournaments'));
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
  rankings = rankings.map((r, idx) => ({
    ...r, rank: idx + 1,
    net_points: r.points_for - r.points_against,
    points_earned: level - d * idx
  }));

  return { rankings, d, teamCount: n };
}

app.get('/api/rankings/:roundId', (req, res) => {
  res.json(calculateRoundRankings(parseInt(req.params.roundId), undefined));
});

// Per-player ranking for free-doubles tournaments (e.g. 狗王杯)
function calculatePlayerRankings(roundId, level) {
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
      if (!playerStats[pid]) playerStats[pid] = { wins: 0, losses: 0, pf: 0, pa: 0 };
      playerStats[pid].wins += t1w ? 1 : 0;
      playerStats[pid].losses += t1w ? 0 : 1;
      playerStats[pid].pf += m.team1_score;
      playerStats[pid].pa += m.team2_score;
    }
    for (const pid of t2players[0]) {
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
  rankings = rankings.map((r, idx) => ({ ...r, rank: idx + 1, points_earned: Math.max(0, level - d * idx) }));

  return { rankings, d };
}

// ==================== Points Calculation ====================

app.get('/api/points', (req, res) => {
  const tournaments = query('SELECT * FROM tournaments');
  const allPlayers = query('SELECT id, name, gender, real_name FROM players ORDER BY name');

  const playerPoints = {};
  for (const p of allPlayers) {
    playerPoints[p.id] = { player_id: p.id, name: p.name, real_name: p.real_name, gender: p.gender, tournaments: {}, total_points: 0 };
  }

  for (const tour of tournaments) {
    const allRounds = query('SELECT * FROM rounds WHERE tournament_id = ? ORDER BY level, date ASC, id ASC', [tour.id]);
    if (!allRounds.length) continue;

    // Group rounds by level
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

      const isFree = tour.name === '狗王杯';
      for (const round of rounds) {
        const result = isFree ? calculatePlayerRankings(round.id, lvl) : calculateRoundRankings(round.id, lvl);
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
            participants.add(rank.player1_id);
            if (acc[rank.player1_id]) {
              acc[rank.player1_id].points = rank.points_earned;
              acc[rank.player1_id].lastD = d;
            }
            if (rank.player2_id) {
              participants.add(rank.player2_id);
              if (acc[rank.player2_id]) {
                acc[rank.player2_id].points = rank.points_earned;
                acc[rank.player2_id].lastD = d;
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
      const latestRank = isFree ? calculatePlayerRankings(latestRound.id, lvl) : calculateRoundRankings(latestRound.id, lvl);
      const latestParticipants = new Set();
      for (const rank of latestRank.rankings) {
        if (isFree) {
          latestParticipants.add(rank.player_id);
        } else {
          latestParticipants.add(rank.player1_id);
          if (rank.player2_id) latestParticipants.add(rank.player2_id);
        }
      }

      const key = tour.name + '(' + lvl + '级)';
      for (const p of allPlayers) {
        if (acc[p.id].points === 0 && acc[p.id].lastD === null) continue;
        const rank = latestRank.rankings.find(r => isFree ? r.player_id === p.id : (r.player1_id === p.id || r.player2_id === p.id));
        if (latestParticipants.has(p.id) && rank) {
          playerPoints[p.id].tournaments[key] = {
            points: acc[p.id].points, edition: latestRound.edition, level: lvl,
            participated: true, rank: rank.rank, d: acc[p.id].lastD
          };
        } else {
          playerPoints[p.id].tournaments[key] = {
            points: acc[p.id].points, edition: latestRound.edition, level: lvl,
            participated: false, deducted: true, rank: null, d: acc[p.id].lastD
          };
        }
      }
    }
  }

  for (const pid in playerPoints) {
    let total = 0;
    for (const tname in playerPoints[pid].tournaments) {
      if (playerPoints[pid].tournaments[tname].level >= 750) total += playerPoints[pid].tournaments[tname].points;
    }
    playerPoints[pid].total_points = total;
  }

  const result = Object.values(playerPoints).sort((a, b) => b.total_points - a.total_points);
  result.forEach((p, idx) => p.overall_rank = idx + 1);
  res.json(result);
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
    const ranking = calculateRoundRankings(round.id, round.round_level);
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
  const ranking = calculateRoundRankings(round.id, round.level);
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

// ==================== Player Stats ====================

app.get('/api/player/:name', (req, res) => {
  let player = query('SELECT id, name, gender, bio, avatar, real_name FROM players WHERE name = ?', [req.params.name])[0];
  if (!player) player = query('SELECT id, name, gender, bio, avatar, real_name FROM players WHERE real_name = ?', [req.params.name])[0];
  if (!player) return res.status(404).json({ error: '选手不存在' });

  const roundIds = [...new Set([
    ...query('SELECT DISTINCT round_id FROM teams WHERE player1_id = ?', [player.id]).map(r => r.round_id),
    ...query('SELECT DISTINCT round_id FROM teams WHERE player2_id = ?', [player.id]).map(r => r.round_id)
  ])];

  let totalWins = 0, totalMatches = 0;
  let bestRank = Infinity;
  const pointsHistory = [];

  for (const rid of roundIds) {
    const roundInfo = query('SELECT level FROM rounds WHERE id = ?', [rid])[0];
    const { rankings } = calculateRoundRankings(rid, roundInfo ? roundInfo.level : 1000);
    const round = query('SELECT r.*, t.name as tournament_name FROM rounds r JOIN tournaments t ON r.tournament_id = t.id WHERE r.id = ?', [rid])[0];
    const playerRank = rankings.find(r => r.player1_id === player.id || r.player2_id === player.id);
    if (playerRank && round) {
      totalWins += playerRank.wins;
      totalMatches += playerRank.wins + playerRank.losses;
      if (playerRank.rank < bestRank) bestRank = playerRank.rank;
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

  res.json({
    player,
    stats: {
      total_matches: totalMatches, total_wins: totalWins,
      win_rate: totalMatches > 0 ? Math.round((totalWins / totalMatches) * 100) : 0,
      best_rank: bestRank === Infinity ? null : bestRank
    },
    points_history: pointsHistory
  });
});

// ==================== Head to Head ====================

app.get('/api/headtohead', (req, res) => {
  const { name1, name2 } = req.query;
  if (!name1 || !name2) return res.status(400).json({ error: '需要两个选手姓名' });
  let p1 = query('SELECT id, name, gender, bio, avatar, real_name FROM players WHERE name = ?', [name1])[0];
  if (!p1) p1 = query('SELECT id, name, gender, bio, avatar, real_name FROM players WHERE real_name = ?', [name1])[0];
  let p2 = query('SELECT id, name, gender, bio, avatar, real_name FROM players WHERE name = ?', [name2])[0];
  if (!p2) p2 = query('SELECT id, name, gender, bio, avatar, real_name FROM players WHERE real_name = ?', [name2])[0];
  if (!p1 || !p2) return res.status(404).json({ error: '选手不存在' });

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
    WHERE (t1.player1_id IN (?,?) OR t1.player2_id IN (?,?))
      AND (t2.player1_id IN (?,?) OR t2.player2_id IN (?,?))
    ORDER BY r.date DESC
  `, [p1.id, p2.id, p1.id, p2.id, p1.id, p2.id, p1.id, p2.id]);

  const filtered = allMatches.filter(m => {
    const t1p = [m.t1p1id]; if (m.t1p2id) t1p.push(m.t1p2id);
    const t2p = [m.t2p1id]; if (m.t2p2id) t2p.push(m.t2p2id);
    if (t1p.includes(p1.id) && t1p.includes(p2.id)) return false;
    if (t2p.includes(p1.id) && t2p.includes(p2.id)) return false;
    return (t1p.includes(p1.id) && t2p.includes(p2.id)) || (t1p.includes(p2.id) && t2p.includes(p1.id));
  });

  let p1Wins = 0, p2Wins = 0;
  for (const m of filtered) {
    const t1p = [m.t1p1id]; if (m.t1p2id) t1p.push(m.t1p2id);
    if ((t1p.includes(p1.id) && m.team1_score > m.team2_score) || (!t1p.includes(p1.id) && m.team2_score > m.team1_score)) p1Wins++;
    else p2Wins++;
  }

  res.json({ player1: p1, player2: p2, head_to_head: { p1_wins: p1Wins, p2_wins: p2Wins, total: filtered.length }, matches: filtered.map(m => ({
    date: m.date, tournament: m.tournament_name, edition: m.edition, round: m.round_number,
    team1: { players: [{ id: m.t1p1id, name: m.t1p1name, real_name: m.t1p1real || '' }, m.t1p2id ? { id: m.t1p2id, name: m.t1p2name, real_name: m.t1p2real || '' } : null].filter(Boolean), score: m.team1_score },
    team2: { players: [{ id: m.t2p1id, name: m.t2p1name, real_name: m.t2p1real || '' }, m.t2p2id ? { id: m.t2p2id, name: m.t2p2name, real_name: m.t2p2real || '' } : null].filter(Boolean), score: m.team2_score }
  })) });
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
    const ranking = calculateRoundRankings(round.id, round.round_level);
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

async function start() {
  await initDatabase();
  db = getDb();
  server = app.listen(PORT, () => console.log(`羽毛球积分系统已启动: http://localhost:${PORT}`));
}

start();
