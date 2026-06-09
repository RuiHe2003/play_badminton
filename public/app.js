// ==================== Navigation ====================
document.querySelectorAll('[data-tab]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const tab = link.dataset.tab;
    document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
    link.classList.add('active');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'home') loadHome();
    if (tab === 'matches') initMatchPage();
    if (tab === 'rankings') loadRankings();
    if (tab === 'players') loadPlayerList();
    if (tab === 'query') initQueryPage();
  });
});

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || '请求失败');
  }
  return res.json();
}

const nameCache = {};
let cachedPlayers = [];
async function ensurePlayers() {
  if (cachedPlayers.length) return cachedPlayers;
  cachedPlayers = await api('/api/players');
  cachedPlayers.forEach(p => nameCache[p.id] = p.name);
  return cachedPlayers;
}
function pn(id) { return nameCache[id] || '未知'; }

// ==================== Home ====================
async function loadHome() {
  const el = document.getElementById('home-content');
  el.innerHTML = '<div class="loading">加载中...</div>';
  try {
    await ensurePlayers();
    const [points, tournaments] = await Promise.all([api('/api/points'), api('/api/tournaments')]);
    let html = '';
    for (const tour of tournaments) {
      const rounds = await api(`/api/tournaments/${tour.id}/rounds`);
      if (!rounds.length) continue;
      const latest = rounds[0];
      const rd = await api(`/api/rankings/${latest.id}`);
      html += `<div class="card"><h3>${tour.name} - 第${latest.edition}届 (${latest.date}) | d=${rd.d}</h3>
        <table><thead><tr><th>#</th><th>队伍</th><th>胜</th><th>负</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
      for (const r of rd.rankings) {
        const name = r.player2_id ? `${pn(r.player1_id)} + ${pn(r.player2_id)}` : pn(r.player1_id);
        html += `<tr><td>${r.rank <= 3 ? ['🥇','🥈','🥉'][r.rank-1] : r.rank}</td><td>${name}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.net_points}</td><td>${r.points_earned}</td></tr>`;
      }
      html += `</tbody></table></div>`;
    }
    function renderPointsTable(players, label) {
      if (!players.length) return '';
      let h = `<div class="card"><h3>🏆 ${label}总积分排名</h3><table><thead><tr><th>#</th><th>姓名</th>${tournaments.map(t => `<th>${t.name}</th>`).join('')}<th>总积分</th></tr></thead><tbody>`;
      players.forEach((p, i) => {
        const rank = i + 1;
        h += `<tr><td>${rank <= 3 ? ['🥇','🥈','🥉'][rank-1] : rank}</td><td>${p.name}</td>`;
        for (const tour of tournaments) {
          const t = p.tournaments[tour.name];
          h += `<td>${t ? t.points : 0}${t?.deducted ? '⚠️' : ''}</td>`;
        }
        h += `<td><strong>${p.total_points}</strong></td></tr>`;
      });
      h += `</tbody></table></div>`;
      return h;
    }
    const malePoints = points.filter(p => p.gender === 'male').sort((a, b) => b.total_points - a.total_points);
    const femalePoints = points.filter(p => p.gender === 'female').sort((a, b) => b.total_points - a.total_points);
    html += renderPointsTable(malePoints, '男子');
    html += renderPointsTable(femalePoints, '女子');
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="loading" style="color:#e53e3e">加载失败: ${e.message}</div>`; }
}

// ==================== Player Management ====================
async function loadPlayerList() {
  try {
    const players = await api('/api/players');
    document.getElementById('player-list').innerHTML =
      `<table><thead><tr><th>ID</th><th>姓名</th><th>性别</th><th>操作</th></tr></thead><tbody>
      ${players.map(p => `<tr><td>${p.id}</td><td>${p.name}</td><td>${p.gender === 'male' ? '男' : '女'}</td><td><button class="danger" onclick="deletePlayer(${p.id})" style="font-size:12px;padding:2px 10px">删除</button></td></tr>`).join('')}
    </tbody></table>`;
  } catch (e) { document.getElementById('player-list').innerHTML = '<div class="loading">加载失败</div>'; }
}

async function deletePlayer(id) {
  const name = cachedPlayers.find(p => p.id === id)?.name || '该选手';
  if (!confirm(`确定删除"${name}"？该选手的所有比赛数据将被清除！`)) return;
  try {
    await api(`/api/players/${id}`, { method: 'DELETE' });
    cachedPlayers = [];
    loadPlayerList();
  } catch (e) { alert('删除失败: ' + e.message); }
}

async function addPlayer() {
  const name = document.getElementById('player-name').value.trim();
  const gender = document.getElementById('player-gender').value;
  if (!name || !gender) return alert('请填写姓名和性别');
  try {
    await api('/api/players', { method: 'POST', body: JSON.stringify({ name, gender }) });
    document.getElementById('player-name').value = '';
    document.getElementById('player-gender').value = '';
    cachedPlayers = [];
    loadPlayerList();
  } catch (e) { alert(e.message); }
}

// ==================== Match Page ====================
const MS = { tid: null, type: '', tname: '', edition: 1, date: '', participants: [], roundId: null, roundNum: null, fixtures: [] };

async function initMatchPage() {
  Object.assign(MS, { tid: null, type: '', tname: '', edition: 1, date: '', participants: [], roundId: null, roundNum: null, fixtures: [] });
  document.getElementById('fixture-card').style.display = 'none';
  document.getElementById('live-rank-card').style.display = 'none';
  document.getElementById('round-actions').style.display = 'none';
  document.getElementById('participant-list').innerHTML = '<div class="loading">暂无参赛者，请添加</div>';

  const tournaments = await api('/api/tournaments');
  const sel = document.getElementById('round-tournament');
  sel.innerHTML = tournaments.map(t =>
    `<option value="${t.id}" data-type="${t.type}">${t.name} (${t.type === 'singles' ? '男单' : t.type === 'mixed_doubles' ? '混双' : '男双'})</option>`
  ).join('');
  sel.onchange = () => { updateEditionSelect(); refreshParticipantSelect(); };
  document.getElementById('round-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('round-edition').oninput = () => { checkExistingRoundForEdit(); };
  await updateEditionSelect();
  await refreshParticipantSelect();
}

async function updateEditionSelect() {
  const sel = document.getElementById('round-tournament');
  const opt = sel.options[sel.selectedIndex];
  const esel = document.getElementById('round-edition');
  if (!opt || !opt.value) { esel.value = ''; esel.placeholder = '先选赛事'; return; }
  const rounds = await api(`/api/tournaments/${opt.value}/rounds`);
  const maxEd = rounds.length ? Math.max(...rounds.map(r => r.edition)) : 0;
  esel.placeholder = `建议: 第${maxEd + 1}届`;
  esel.value = maxEd + 1;
  await checkExistingRoundForEdit();
}

async function refreshParticipantSelect() {
  const sel = document.getElementById('round-tournament');
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) {
    document.getElementById('participant-select').innerHTML = '<option value="">请先选择赛事</option>';
    return;
  }
  MS.tid = parseInt(opt.value);
  MS.type = opt.dataset.type;
  MS.tname = opt.text.split('(')[0].trim();
  MS.edition = parseInt(document.getElementById('round-edition').value) || 1;
  MS.date = document.getElementById('round-date').value;

  const players = await ensurePlayers();
  const isDoubles = MS.type !== 'singles';
  const psel = document.getElementById('participant-select');
  if (isDoubles) {
    psel.innerHTML = '<option value="">选择第一位选手</option>' +
      players.map(p => `<option value="${p.id}" data-gender="${p.gender}">${p.name} (${p.gender === 'male' ? '男' : '女'})</option>`).join('');
    psel.onchange = showSecondPlayerSelect;
  } else {
    psel.innerHTML = '<option value="">选择选手</option>' +
      players.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    const w = document.getElementById('p2-wrapper');
    if (w) w.remove();
    psel.onchange = null;
  }
  await checkExistingRoundForEdit();
}

async function checkExistingRoundForEdit() {
  const tid = document.getElementById('round-tournament').value;
  const edition = document.getElementById('round-edition').value;
  const info = document.getElementById('existing-round-info');
  const fixtureCard = document.getElementById('fixture-card');
  const liveRankCard = document.getElementById('live-rank-card');
  const roundActions = document.getElementById('round-actions');
  if (!tid || !edition) { info.style.display = 'none'; return; }
  try {
    const data = await api(`/api/rounds/lookup?tournamentId=${tid}&edition=${edition}`);
    if (data.exists) {
      MS.roundId = data.round.id;
      info.style.display = 'block';
    } else {
      info.style.display = 'none';
      MS.roundId = null;
    }
  } catch (e) { info.style.display = 'none'; }
}

async function loadExistingRound() {
  const tid = document.getElementById('round-tournament').value;
  const edition = document.getElementById('round-edition').value;
  try {
    const data = await api(`/api/rounds/lookup?tournamentId=${tid}&edition=${edition}`);
    if (!data.exists) return alert('该轮次数据不存在');
    const round = data.round;
    MS.roundId = round.id;
    MS.tid = round.tournament_id;
    MS.tname = round.tournament_name;
    MS.type = round.tournament_type;
    MS.edition = round.edition;
    MS.date = round.date;

    const teams = data.teams;
    MS.participants = teams.map(t => ({
      p1: t.player1_id,
      p2: t.player2_id,
      label: t.player2_id ? `${t.player1_name} + ${t.player2_name}` : t.player1_name
    }));

    renderPList();
    document.getElementById('existing-round-info').style.display = 'none';

    const n = MS.participants.length;
    MS.fixtures = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++)
      MS.fixtures.push({ i1: i, i2: j, tid1: null, tid2: null, s1: '', s2: '' });

    const saved = data.matches;
    for (let i = 0; i < n; i++) {
      for (const f of MS.fixtures) {
        if (f.i1 === i) f.tid1 = teams[i].team_id;
        if (f.i2 === i) f.tid2 = teams[i].team_id;
      }
    }
    for (const s of saved) {
      const f = MS.fixtures.find(x => (x.tid1 === s.team1_id && x.tid2 === s.team2_id) || (x.tid1 === s.team2_id && x.tid2 === s.team1_id));
      if (f) { if (s.team1_id === f.tid1) { f.s1 = s.team1_score; f.s2 = s.team2_score; } else { f.s1 = s.team2_score; f.s2 = s.team1_score; } }
    }

    showFixtureTable();
  } catch (e) { alert('加载失败: ' + e.message); }
}

function showSecondPlayerSelect() {
  const existing = document.getElementById('p2-wrapper');
  if (existing) existing.remove();
  const p1v = document.getElementById('participant-select').value;
  if (!p1v) return;
  const p1g = document.getElementById('participant-select').options[document.getElementById('participant-select').selectedIndex]?.dataset.gender;
  const isMixed = MS.type === 'mixed_doubles';
  const wrapper = document.createElement('div');
  wrapper.id = 'p2-wrapper';
  wrapper.style.display = 'inline-block';
  const s = document.createElement('select');
  s.id = 'p2-select';
  let opts = '<option value="">选择第二位选手</option>';
  for (const p of cachedPlayers) {
    if (p.id === parseInt(p1v)) continue;
    if (isMixed && p.gender === p1g) continue;
    opts += `<option value="${p.id}">${p.name} (${p.gender === 'male' ? '男' : '女'})</option>`;
  }
  s.innerHTML = opts;
  wrapper.appendChild(s);
  document.getElementById('participant-select').parentNode.insertBefore(wrapper, document.querySelector('#participant-area button'));
}

async function addParticipant() {
  const isDoubles = MS.type !== 'singles';
  const p1s = document.getElementById('participant-select');
  const p1v = parseInt(p1s.value);
  if (!p1v) return alert('请选择选手');
  const p1l = p1s.options[p1s.selectedIndex].text.split('(')[0].trim();

  if (isDoubles) {
    const p2s = document.getElementById('p2-select');
    if (!p2s) return alert('请选择第二位选手');
    const p2v = parseInt(p2s.value);
    if (!p2v) return alert('请选择第二位选手');
    if (MS.participants.some(p => (p.p1 === p1v && p.p2 === p2v) || (p.p1 === p2v && p.p2 === p1v))) return alert('该组合已存在');
    const p2l = p2s.options[p2s.selectedIndex].text.split('(')[0].trim();
    MS.participants.push({ p1: p1v, p2: p2v, label: `${p1l} + ${p2l}` });
    p1s.value = '';
    const w = document.getElementById('p2-wrapper');
    if (w) w.remove();
  } else {
    if (MS.participants.some(p => p.p1 === p1v)) return alert('该选手已添加');
    MS.participants.push({ p1: p1v, p2: null, label: p1l });
    p1s.value = '';
  }
  renderPList();
}

function removeP(idx) { MS.participants.splice(idx, 1); renderPList(); }

function renderPList() {
  const list = document.getElementById('participant-list');
  const acts = document.getElementById('round-actions');
  if (!MS.participants.length) { list.innerHTML = '<div class="loading">暂无参赛者，请添加</div>'; acts.style.display = 'none'; return; }
  list.innerHTML = MS.participants.map((p, i) =>
    `<div class="participant-item"><span>${i+1}. ${p.label}</span><button class="danger" onclick="removeP(${i})">删除</button></div>`
  ).join('');
  acts.style.display = MS.participants.length >= 2 ? 'block' : 'none';
}

async function createAndShowFixtures() {
  const date = document.getElementById('round-date').value;
  MS.edition = parseInt(document.getElementById('round-edition').value) || 1;
  MS.date = date;
  if (!date) return alert('请选择日期');
  if (MS.participants.length < 2) return alert('至少需要2个参赛队伍');
  try {
    const r = await api('/api/rounds', { method: 'POST', body: JSON.stringify({
      tournament_id: MS.tid, edition: MS.edition, date,
      participants: MS.participants.map(p => ({ player1_id: p.p1, player2_id: p.p2 }))
    })});
    MS.roundId = r.id;
    MS.roundNum = r.round_number;
  } catch (e) { return alert('创建轮次失败: ' + e.message); }

  MS.fixtures = [];
  const n = MS.participants.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++)
    MS.fixtures.push({ i1: i, i2: j, tid1: null, tid2: null, s1: '', s2: '' });

  const teams = await api(`/api/rounds/${MS.roundId}/teams`);
  for (let i = 0; i < n; i++) {
    for (const f of MS.fixtures) {
      if (f.i1 === i) f.tid1 = teams[i].team_id;
      if (f.i2 === i) f.tid2 = teams[i].team_id;
    }
  }

  try {
    const saved = await api(`/api/matches/${MS.roundId}`);
    for (const s of saved) {
      const f = MS.fixtures.find(x => (x.tid1 === s.team1_id && x.tid2 === s.team2_id) || (x.tid1 === s.team2_id && x.tid2 === s.team1_id));
      if (f) { if (s.team1_id === f.tid1) { f.s1 = s.team1_score; f.s2 = s.team2_score; } else { f.s1 = s.team2_score; f.s2 = s.team1_score; } }
    }
  } catch (e) {}

  showFixtureTable();
}

function showFixtureTable() {
  document.getElementById('fixture-title').textContent = `${MS.tname} - 第${MS.edition}届`;
  const parts = MS.participants;
  const n = parts.length;
  let html = '<div style="overflow-x:auto"><table style="min-width:400px"><thead><tr><th style="min-width:100px">队伍</th>';
  for (let i = 0; i < n; i++) html += `<th style="text-align:center;min-width:100px">${parts[i].label}</th>`;
  html += '</tr></thead><tbody>';
  for (let i = 0; i < n; i++) {
    html += `<tr><td><strong>${parts[i].label}</strong></td>`;
    for (let j = 0; j < n; j++) {
      if (i === j) { html += '<td style="text-align:center;background:#f0f2f5">—</td>'; continue; }
      const f = MS.fixtures.find(x => (x.i1 === i && x.i2 === j) || (x.i1 === j && x.i2 === i));
      if (!f) { html += '<td></td>'; continue; }
      const rev = f.i1 !== i;
      const v1 = rev ? f.s2 : f.s1;
      const v2 = rev ? f.s1 : f.s2;
      const bg = (v1 !== '' && v2 !== '') ? '#f0fff4' : '';
      const fi = MS.fixtures.indexOf(f);
      html += `<td style="text-align:center;padding:6px;${bg ? 'background:'+bg : ''}">
        <input type="number" class="ms" data-fi="${fi}" data-sd="${rev?'r':'f'}" value="${v1}" min="0" max="31"
          style="width:40px;padding:4px;text-align:center;border:1px solid #d2d6dc;border-radius:4px" oninput="onMS(this)">
        <span style="margin:0 2px">:</span>
        <input type="number" class="ms" data-fi="${fi}" data-sd="${rev?'f':'r'}" value="${v2}" min="0" max="31"
          style="width:40px;padding:4px;text-align:center;border:1px solid #d2d6dc;border-radius:4px" oninput="onMS(this)">
      </td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  document.getElementById('fixture-form').innerHTML = html;
  document.getElementById('fixture-card').style.display = 'block';
  document.getElementById('live-rank-card').style.display = 'block';
  updateLive();
}

function onMS(el) {
  const fi = parseInt(el.dataset.fi);
  const sd = el.dataset.sd;
  let v = el.value === '' ? '' : parseInt(el.value);
  if (v !== '' && (v > 31 || v < 0)) {
    el.value = '';
    v = '';
  }
  const f = MS.fixtures[fi];
  if (sd === 'f') f.s1 = v; else f.s2 = v;
  document.querySelectorAll(`.ms[data-fi="${fi}"]`).forEach(inp => {
    inp.value = inp.dataset.sd === 'f' ? (f.s1 === '' ? '' : f.s1) : (f.s2 === '' ? '' : f.s2);
  });
  updateLive();
}

async function saveAllMatches() {
  for (const f of MS.fixtures) {
    if (f.s1 === '' || f.s2 === '') continue;
    if (f.s1 > 31 || f.s2 > 31 || f.s1 < 0 || f.s2 < 0) continue;
    try { await api('/api/matches', { method: 'POST', body: JSON.stringify({ round_id: MS.roundId, team1_id: f.tid1, team2_id: f.tid2, team1_score: parseInt(f.s1), team2_score: parseInt(f.s2) }) }); } catch (e) {}
  }
  const st = document.getElementById('save-all-status');
  st.textContent = '✅ 已保存'; st.style.color = '#38a169';
  updateLive();
}

function updateLive() {
  const n = MS.participants.length;
  const st = MS.participants.map((p, i) => ({ i, label: p.label, wins: 0, losses: 0, pf: 0, pa: 0 }));
  for (const f of MS.fixtures) {
    if (f.s1 === '' || f.s2 === '') continue;
    const s1 = parseInt(f.s1), s2 = parseInt(f.s2);
    st[f.i1].pf += s1; st[f.i2].pf += s2;
    st[f.i1].pa += s2; st[f.i2].pa += s1;
    if (s1 > s2) { st[f.i1].wins++; st[f.i2].losses++; }
    else { st[f.i2].wins++; st[f.i1].losses++; }
  }
  st.sort((a, b) => b.wins - a.wins || (b.pf - b.pa) - (a.pf - a.pa));
  const d = Math.round(1000 / n);
  let h = `<table><thead><tr><th>#</th><th>队伍</th><th>胜</th><th>负</th><th>得分</th><th>失分</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
  st.forEach((s, i) => {
    h += `<tr><td>${i+1 <= 3 ? ['🥇','🥈','🥉'][i] : i+1}</td><td>${s.label}</td><td>${s.wins}</td><td>${s.losses}</td><td>${s.pf}</td><td>${s.pa}</td><td>${s.pf-s.pa}</td><td><strong>${1000-d*i}</strong></td></tr>`;
  });
  h += `</tbody></table><p style="margin-top:8px;color:#718096;font-size:13px">参赛: ${n} | d=${d}</p>`;
  document.getElementById('live-rankings').innerHTML = h;
}

// ==================== Rankings ====================
async function loadRankings() {
  const el = document.getElementById('rankings-content');
  try {
    await ensurePlayers();
    const points = await api('/api/points');
    const tournaments = await api('/api/tournaments');
    function renderRankTable(players, label) {
      if (!players.length) return '';
      let h = `<div class="card"><h3>🏆 ${label}总积分排名</h3><table><thead><tr><th>#</th><th>姓名</th>${tournaments.map(t => `<th>${t.name}</th>`).join('')}<th>总积分</th></tr></thead><tbody>`;
      players.forEach((p, i) => {
        const rc = i === 0 ? 'badge-gold' : i === 1 ? 'badge-silver' : i === 2 ? 'badge-bronze' : '';
        h += `<tr><td><span class="badge ${rc}">${i + 1}</span></td><td><strong>${p.name}</strong></td>`;
        for (const tour of tournaments) {
          const t = p.tournaments[tour.name];
          h += `<td>${t ? t.points : 0}${t?.deducted ? '<br><small style="color:#e53e3e">(扣分)</small>' : ''}</td>`;
        }
        h += `<td><strong>${p.total_points}</strong></td></tr>`;
      });
      h += `</tbody></table></div>`;
      return h;
    }
    const malePoints = points.filter(p => p.gender === 'male').sort((a, b) => b.total_points - a.total_points);
    const femalePoints = points.filter(p => p.gender === 'female').sort((a, b) => b.total_points - a.total_points);
    let html = renderRankTable(malePoints, '男子');
    html += renderRankTable(femalePoints, '女子');
    for (const tour of tournaments) {
      const rounds = await api(`/api/tournaments/${tour.id}/rounds`);
      if (!rounds.length) continue;
      const latest = rounds[0];
      const rd = await api(`/api/rankings/${latest.id}`);
      html += `<div class="card"><h3>${tour.name} - 第${latest.edition}届 (${latest.date}) | d=${rd.d}</h3>
        <table><thead><tr><th>#</th><th>队伍</th><th>胜</th><th>负</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
      for (const r of rd.rankings) {
        const name = r.player2_id ? `${pn(r.player1_id)} + ${pn(r.player2_id)}` : pn(r.player1_id);
        html += `<tr><td>${r.rank <= 3 ? ['🥇','🥈','🥉'][r.rank-1] : r.rank}</td><td>${name}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.net_points}</td><td>${r.points_earned}</td></tr>`;
      }
      html += `</tbody></table></div>`;
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="loading" style="color:#e53e3e">加载失败: ${e.message}</div>`; }
}

// ==================== Query by Tournament + Edition ====================
async function initQueryPage() {
  const tournaments = await api('/api/tournaments');
  const sel = document.getElementById('query-tournament');
  sel.innerHTML = '<option value="">全部赛事</option>' +
    tournaments.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  document.getElementById('query-results').innerHTML = '<div class="loading">选择赛事和届数点击查询</div>';
}

async function queryRounds() {
  const tid = document.getElementById('query-tournament').value;
  const edition = document.getElementById('query-edition').value.trim();
  const el = document.getElementById('query-results');
  el.innerHTML = '<div class="loading">查询中...</div>';

  try {
    await ensurePlayers();
    const params = new URLSearchParams();
    if (tid) params.set('tournamentId', tid);
    if (edition) params.set('edition', edition);
    const data = await api(`/api/query/rounds?${params.toString()}`);
    if (!data.length) { el.innerHTML = '<div class="card"><div class="loading">未找到匹配的赛事</div></div>'; return; }

    let html = '';
    for (const round of data) {
      html += `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap">
          <h3>📋 ${round.tournament_name} - 第${round.edition}届 (${round.date})</h3>
          <div>
            <button class="danger" onclick="deleteRound(${round.id})" style="font-size:12px;padding:4px 10px">删除该轮</button>
          </div>
        </div>`;

      html += `<h4>排名</h4><table><thead><tr><th>#</th><th>队伍</th><th>胜</th><th>负</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
      for (const r of round.ranking.rankings) {
        const name = r.player2_id ? `${pn(r.player1_id)} + ${pn(r.player2_id)}` : pn(r.player1_id);
        html += `<tr><td>${r.rank}</td><td>${name}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.net_points}</td><td>${r.points_earned}</td></tr>`;
      }
      html += `</tbody></table>`;

      if (round.matches.length) {
        html += `<h4 style="margin-top:16px">比赛详情</h4><table><thead><tr><th>队伍1</th><th>比分</th><th>队伍2</th><th>操作</th></tr></thead><tbody>`;
        for (const m of round.matches) {
          const t1n = m.t1p2name ? `${m.t1p1name} + ${m.t1p2name}` : m.t1p1name;
          const t2n = m.t2p2name ? `${m.t2p1name} + ${m.t2p2name}` : m.t2p1name;
          html += `<tr id="match-row-${m.id}">
            <td>${t1n}</td>
            <td><strong>${m.team1_score} : ${m.team2_score}</strong></td>
            <td>${t2n}</td>
            <td>
              <button onclick="editMatch(${m.id}, ${m.team1_score}, ${m.team2_score})" style="font-size:12px;padding:4px 10px">编辑</button>
              <button class="danger" onclick="deleteMatch(${m.id})" style="font-size:12px;padding:4px 10px">删除</button>
            </td>
          </tr>`;
        }
        html += `</tbody></table>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">查询失败: ${e.message}</div></div>`; }
}

async function editMatch(mid, oldS1, oldS2) {
  const row = document.getElementById(`match-row-${mid}`);
  const newS1 = prompt('输入队伍1新比分:', oldS1);
  if (newS1 === null) return;
  const newS2 = prompt('输入队伍2新比分:', oldS2);
  if (newS2 === null) return;
  try {
    await api(`/api/matches/${mid}`, { method: 'PUT', body: JSON.stringify({ team1_score: parseInt(newS1), team2_score: parseInt(newS2) }) });
    alert('已更新');
    queryRounds();
  } catch (e) { alert('更新失败: ' + e.message); }
}

async function deleteMatch(mid) {
  if (!confirm('确定删除该场比赛？')) return;
  try {
    await api(`/api/matches/${mid}`, { method: 'DELETE' });
    alert('已删除');
    queryRounds();
  } catch (e) { alert('删除失败: ' + e.message); }
}

async function deleteRound(rid) {
  if (!confirm('确定删除该轮次（含所有比赛数据）？此操作不可撤销！')) return;
  try {
    await api(`/api/rounds/${rid}`, { method: 'DELETE' });
    alert('已删除');
    queryRounds();
  } catch (e) { alert('删除失败: ' + e.message); }
}

// ==================== Player Query ====================
async function queryPlayer() {
  const name = document.getElementById('query-player-name').value.trim();
  if (!name) return alert('请输入选手姓名');
  const el = document.getElementById('player-result');
  el.innerHTML = '<div class="loading">查询中...</div>';
  try {
    const data = await api(`/api/player/${encodeURIComponent(name)}`);
    const p = data.player, s = data.stats;
    let html = `<div class="player-stat-card"><h3>${p.name} <small style="color:#718096;font-weight:400">(${p.gender === 'male' ? '男' : '女'})</small></h3>
      <div class="stat-grid">
        <div class="stat-item"><div class="stat-value">${s.total_matches}</div><div class="stat-label">总场次</div></div>
        <div class="stat-item"><div class="stat-value">${s.total_wins}</div><div class="stat-label">总胜场</div></div>
        <div class="stat-item"><div class="stat-value">${s.win_rate || 0}%</div><div class="stat-label">胜率</div></div>
        <div class="stat-item"><div class="stat-value">${s.best_rank ? '第' + s.best_rank + '名' : '无'}</div><div class="stat-label">最高排名</div></div>
      </div></div>`;
    if (data.points_history.length) {
      html += `<div class="card"><h3>比赛记录</h3><table><thead><tr><th>赛事</th><th>届</th><th>日期</th><th>排名</th><th>胜/负</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
      for (const h of data.points_history) html += `<tr><td>${h.tournament}</td><td>第${h.edition}届</td><td>${h.date}</td><td>第${h.rank}名</td><td>${h.wins}胜 ${h.losses}负</td><td>${h.net_points}</td><td>${h.points_earned}</td></tr>`;
      html += `</tbody></table></div>`;
    } else html += `<div class="card"><div class="loading">暂无比赛记录</div></div>`;
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">${e.message}</div></div>`; }
}

// ==================== Head to Head ====================
async function queryHeadToHead() {
  const n1 = document.getElementById('h2h-name1').value.trim();
  const n2 = document.getElementById('h2h-name2').value.trim();
  if (!n1 || !n2) return alert('请输入两位选手姓名');
  const el = document.getElementById('h2h-result');
  el.innerHTML = '<div class="loading">查询中...</div>';
  try {
    const data = await api(`/api/headtohead?name1=${encodeURIComponent(n1)}&name2=${encodeURIComponent(n2)}`);
    const h2h = data.head_to_head;
    let html = `<div class="card h2h-summary"><div style="display:flex;justify-content:center;align-items:center;gap:24px">
      <div><strong style="font-size:20px">${data.player1.name}</strong><br><span class="badge badge-win">${h2h.p1_wins} 胜</span></div>
      <div class="big-score">${h2h.p1_wins} : ${h2h.p2_wins}</div>
      <div><strong style="font-size:20px">${data.player2.name}</strong><br><span class="badge badge-loss">${h2h.p2_wins} 胜</span></div>
    </div><div class="h2h-vs" style="margin-top:8px">共交手 ${h2h.total} 次</div></div>`;
    if (data.matches.length) {
      html += `<div class="card"><h3>交手记录</h3>`;
      for (const m of data.matches) {
        const t1 = m.team1.players.map(p => p.name).join(' + ');
        const t2 = m.team2.players.map(p => p.name).join(' + ');
        const win = (m.team1.players.some(p => p.name === data.player1.name) && m.team1.score > m.team2.score) || (m.team2.players.some(p => p.name === data.player1.name) && m.team2.score > m.team1.score);
        html += `<div class="match-history-item ${win ? '' : 'loss'}">
          <strong>${m.tournament}</strong> 第${m.edition}届 | ${m.date}<br>
          ${t1} <strong>${m.team1.score} : ${m.team2.score}</strong> ${t2}
          <span style="float:right">${win ? '✅' : '❌'}</span>
        </div>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">${e.message}</div></div>`; }
}

// ==================== Init ====================
loadHome();
