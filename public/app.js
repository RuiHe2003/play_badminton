// ==================== Navigation ====================
let currentAdminSub = 'players';
function displayName(p) { return p.real_name || p.name; }

document.querySelectorAll('[data-tab]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const tab = link.dataset.tab;
    document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
    link.classList.add('active');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

    document.getElementById('admin-subnav').style.display = 'none';
    document.getElementById('tab-players').style.display = '';
    document.getElementById('tab-matches').style.display = '';

    if (tab === 'admin') {
      if (!isAuthenticated) {
        document.getElementById('tab-admin').classList.add('active');
        showAuthInTab('admin');
        return;
      }
      showAdminContent();
      return;
    }

    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'home') loadHome();
    if (tab === 'rankings') loadRankings();
    if (tab === 'query') initQueryPage();
    if (tab === 'player-query') document.getElementById('player-result').innerHTML = '';
    if (tab === 'headtohead') document.getElementById('h2h-result').innerHTML = '';
  });
});

document.querySelectorAll('[data-subtab]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const sub = link.dataset.subtab;
    currentAdminSub = sub;
    document.querySelectorAll('[data-subtab]').forEach(a => a.classList.remove('active'));
    link.classList.add('active');
    document.getElementById('tab-players').style.display = sub === 'players' ? 'block' : 'none';
    document.getElementById('tab-matches').style.display = sub === 'matches' ? 'block' : 'none';
    if (sub === 'players') loadPlayerList();
    if (sub === 'matches') initMatchPage();
  });
});

function showAdminContent() {
  document.getElementById('admin-subnav').style.display = 'flex';
  document.getElementById('tab-admin').classList.add('active');
  document.getElementById('tab-players').style.display = 'block';
  document.getElementById('tab-matches').style.display = 'none';
  document.querySelectorAll('[data-subtab]').forEach(a => a.classList.remove('active'));
  document.querySelector('[data-subtab="players"]').classList.add('active');
  currentAdminSub = 'players';
  loadPlayerList();
}

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
  cachedPlayers.forEach(p => nameCache[p.id] = p.real_name || p.name);
  return cachedPlayers;
}
function pn(id) { return nameCache[id] || '未知'; }

// ==================== Home ====================
async function loadHome() {
  const el = document.getElementById('home-content');
  el.innerHTML = `
    <div class="home-top-row">
      <div class="home-card intro-card">
        <div class="home-card-icon">🏸</div>
        <h2 class="home-card-title">赛事介绍</h2>
        <p class="home-card-body">
          本系列羽毛球赛事自2024年正式开启，共设<strong>集帅杯</strong>（男单）、<strong>国王杯</strong>（混双）、<strong>龙王杯</strong>（双打）、<strong>希王杯</strong>（混双）四大竞赛项目。全部赛事均采用单循环赛制，参赛队伍/选手需两两依次完成对决。赛事最终依据总胜局数、净胜分数综合核算成绩，并以此完成最终名次排名。
        </p>
      </div>
      <div class="home-image-wrapper">
        <img src="/鸽子集帅.jpg" alt="鸽子集帅" class="home-image">
      </div>
    </div>
    <div class="home-card rules-card">
      <div class="home-card-icon">🏆</div>
      <h2 class="home-card-title">积分规则</h2>
      <div class="home-card-body">
        <div class="rule-item">
          <div class="rule-label">单轮排名</div>
          <div class="rule-desc">每轮比赛按胜场数排名，胜场相同则净胜分高者排名靠前。第1名得1000分，之后每名递减 d 分（d = 1000 ÷ 参赛队伍数，四舍五入）。</div>
        </div>
        <div class="rule-item">
          <div class="rule-label">跨届积分</div>
          <div class="rule-desc">选手参加某届比赛即获得该届排名对应积分；若缺席最新一届，则在上一届积分基础上扣除 d 分（最低为0）。同一赛事只保留最新一届积分。</div>
        </div>
        <div class="rule-item">
          <div class="rule-label">总积分榜</div>
          <div class="rule-desc">选手在所有赛事中的当前积分相加，按总积分降序排列。</div>
        </div>
      </div>
    </div>
  `;
}

// ==================== Player Management ====================
async function loadPlayerList() {
  try {
    const players = await api('/api/players');
    cachedPlayers = players;
    document.getElementById('player-list').innerHTML =
      `<table><thead><tr><th>ID</th><th>比赛ID</th><th>姓名</th><th>性别</th><th>操作</th></tr></thead><tbody>
      ${players.map(p => `<tr><td>${p.id}</td><td>${p.name}</td><td>${p.real_name || '-'}</td><td>${p.gender === 'male' ? '男' : '女'}</td><td><button onclick="editPlayer(${p.id})" style="font-size:12px;padding:2px 10px;margin-right:4px">编辑</button><button class="danger" onclick="deletePlayer(${p.id})" style="font-size:12px;padding:2px 10px">删除</button></td></tr>`).join('')}
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
async function editPlayer(id) {
  const player = cachedPlayers.find(p => p.id === id);
  if (!player) return;
  const body = {};
  const newName = prompt('比赛ID:', player.name);
  if (newName === null) return;
  if (newName && newName !== player.name) body.name = newName;
  const newRealName = prompt('姓名（留空不修改）:', player.real_name || '');
  if (newRealName === null) return;
  if (newRealName !== player.real_name) body.real_name = newRealName;
  const switchGender = confirm(`当前性别：${player.gender === 'male' ? '男' : '女'}。\n确定切换${player.gender === 'male' ? '女' : '男'}吗？`);
  if (switchGender) body.gender = player.gender === 'male' ? 'female' : 'male';
  if (!Object.keys(body).length) return;
  try {
    await api(`/api/players/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    cachedPlayers = [];
    loadPlayerList();
  } catch (e) { alert('修改失败: ' + e.message); }
}

async function addPlayer() {
  const name = document.getElementById('player-name').value.trim();
  const real_name = document.getElementById('player-real-name').value.trim();
  const gender = document.getElementById('player-gender').value;
  if (!name || !gender) return alert('请填写比赛ID和性别');
  try {
    await api('/api/players', { method: 'POST', body: JSON.stringify({ name, gender, real_name: real_name || '' }) });
    document.getElementById('player-name').value = '';
    document.getElementById('player-real-name').value = '';
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
  document.getElementById('save-edition-btn').style.display = 'none';
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
      players.map(p => `<option value="${p.id}" data-gender="${p.gender}">${displayName(p)}${p.real_name ? ' (' + p.name + ')' : ''} (${p.gender === 'male' ? '男' : '女'})</option>`).join('');
    psel.onchange = showSecondPlayerSelect;
  } else {
    psel.innerHTML = '<option value="">选择选手</option>' +
      players.map(p => `<option value="${p.id}">${displayName(p)}${p.real_name ? ' (' + p.name + ')' : ''}</option>`).join('');
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
  const editBtn = document.getElementById('save-edition-btn');
  const fixtureCard = document.getElementById('fixture-card');
  const liveRankCard = document.getElementById('live-rank-card');
  const roundActions = document.getElementById('round-actions');
  if (!tid || !edition) { info.style.display = 'none'; editBtn.style.display = 'none'; fixtureCard.style.display = 'none'; liveRankCard.style.display = 'none'; return; }
  try {
    const data = await api(`/api/rounds/lookup?tournamentId=${tid}&edition=${edition}`);
    if (data.exists) {
      MS.roundId = data.round.id;
      info.style.display = 'block';
      editBtn.style.display = 'inline-block';
      document.getElementById('save-round-status').textContent = '';
    } else {
      info.style.display = 'none';
      editBtn.style.display = 'none';
      MS.roundId = null;
    }
  } catch (e) { info.style.display = 'none'; editBtn.style.display = 'none'; }
}

async function saveRoundChanges() {
  if (!MS.roundId) return;
  const edition = parseInt(document.getElementById('round-edition').value);
  const date = document.getElementById('round-date').value;
  if (!edition || !date) return alert('请填写届数和日期');
  try {
    await api(`/api/rounds/${MS.roundId}`, {
      method: 'PUT',
      body: JSON.stringify({ edition, date })
    });
    MS.edition = edition;
    MS.date = date;
    document.getElementById('save-round-status').textContent = '✅ 已保存';
    if (document.getElementById('fixture-card').style.display === 'block') {
      document.getElementById('fixture-title').innerHTML = `${MS.tname} - 第${MS.edition}届 <button onclick="editRoundInfo()" style="font-size:11px;padding:1px 10px;margin-left:8px;vertical-align:middle">✏️ 编辑</button>`;
    }
  } catch (e) {
    document.getElementById('save-round-status').textContent = '❌ 保存失败';
  }
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
    document.getElementById('round-edition').value = round.edition;
    document.getElementById('round-date').value = round.date;
    document.getElementById('save-edition-btn').style.display = 'inline-block';
    document.getElementById('save-round-status').textContent = '';

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
      MS.fixtures.push({ i1: i, i2: j, tid1: null, tid2: null, s1: '', s2: '', mid: null });

    const saved = data.matches;
    for (let i = 0; i < n; i++) {
      for (const f of MS.fixtures) {
        if (f.i1 === i) f.tid1 = teams[i].team_id;
        if (f.i2 === i) f.tid2 = teams[i].team_id;
      }
    }
    for (const s of saved) {
      const f = MS.fixtures.find(x => (x.tid1 === s.team1_id && x.tid2 === s.team2_id) || (x.tid1 === s.team2_id && x.tid2 === s.team1_id));
      if (f) { if (s.team1_id === f.tid1) { f.s1 = s.team1_score; f.s2 = s.team2_score; } else { f.s1 = s.team2_score; f.s2 = s.team1_score; } f.mid = s.id; }
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
  wrapper.style.cssText = 'flex:1;min-width:150px';
  const s = document.createElement('select');
  s.id = 'p2-select';
  s.style.cssText = 'width:100%;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px;outline:none';
  let opts = '<option value="">选择第二位选手</option>';
  for (const p of cachedPlayers) {
    if (p.id === parseInt(p1v)) continue;
    if (isMixed && p.gender === p1g) continue;
    opts += `<option value="${p.id}">${displayName(p)}${p.real_name ? ' (' + p.name + ')' : ''} (${p.gender === 'male' ? '男' : '女'})</option>`;
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
    MS.fixtures.push({ i1: i, i2: j, tid1: null, tid2: null, s1: '', s2: '', mid: null });

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
      if (f) { if (s.team1_id === f.tid1) { f.s1 = s.team1_score; f.s2 = s.team2_score; } else { f.s1 = s.team2_score; f.s2 = s.team1_score; } f.mid = s.id; }
    }
  } catch (e) {}

  showFixtureTable();
}

function showFixtureTable() {
  document.getElementById('fixture-title').innerHTML = `${MS.tname} - 第${MS.edition}届 <button onclick="editRoundInfo()" style="font-size:11px;padding:1px 10px;margin-left:8px;vertical-align:middle">✏️ 编辑</button>`;
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
  html += `<div style="margin-top:8px;text-align:right">
    <button class="danger" onclick="deleteRound(MS.roundId)" style="font-size:12px;padding:4px 14px">🗑️ 删除该轮</button>
  </div>`;
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
    try {
      const result = await api('/api/matches', { method: 'POST', body: JSON.stringify({ round_id: MS.roundId, team1_id: f.tid1, team2_id: f.tid2, team1_score: parseInt(f.s1), team2_score: parseInt(f.s2) }) });
      f.mid = result.id;
    } catch (e) {}
  }
  const st = document.getElementById('save-all-status');
  st.textContent = '✅ 已保存'; st.style.color = '#38a169';
  updateLive();
}

async function editRoundInfo() {
  if (!MS.roundId) return;
  const newEdition = prompt('输入新届数:', MS.edition);
  if (!newEdition || parseInt(newEdition) === MS.edition) return;
  const newDate = prompt('输入新日期 (YYYY-MM-DD):', MS.date);
  if (!newDate) return;
  try {
    await api(`/api/rounds/${MS.roundId}`, {
      method: 'PUT',
      body: JSON.stringify({ edition: parseInt(newEdition), date: newDate })
    });
    MS.edition = parseInt(newEdition);
    MS.date = newDate;
    document.getElementById('fixture-title').innerHTML = `${MS.tname} - 第${MS.edition}届 <button onclick="editRoundInfo()" style="font-size:11px;padding:1px 10px;margin-left:8px;vertical-align:middle">✏️ 编辑</button>`;
    document.getElementById('round-edition').value = newEdition;
    document.getElementById('round-date').value = newDate;
    document.getElementById('save-round-status').textContent = '';
  } catch (e) { alert('修改失败: ' + e.message); }
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
        h += `<tr><td><span class="badge ${rc}">${i + 1}</span></td><td><strong>${displayName(p)}</strong></td>`;
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
    const tourData = await Promise.all(tournaments.map(async (t) => {
      const rounds = await api(`/api/tournaments/${t.id}/rounds`);
      return { ...t, rounds };
    }));
    const sortedTours = tourData.filter(t => t.rounds.length).sort((a, b) =>
      b.rounds[0].date.localeCompare(a.rounds[0].date)
    );
    for (const tour of sortedTours) {
      const latest = tour.rounds[0];
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
          <h3>📋 ${round.tournament_name} - 第${round.edition}届 (${round.date})</h3>`;

      html += `<h4>排名</h4><table><thead><tr><th>#</th><th>队伍</th><th>胜</th><th>负</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
      for (const r of round.ranking.rankings) {
        const name = r.player2_id ? `${pn(r.player1_id)} + ${pn(r.player2_id)}` : pn(r.player1_id);
        html += `<tr><td>${r.rank}</td><td>${name}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.net_points}</td><td>${r.points_earned}</td></tr>`;
      }
      html += `</tbody></table>`;

      if (round.matches.length) {
        html += `<button onclick="toggleMatchDetails(${round.id})" style="margin-top:16px;width:100%;padding:8px;background:#e2e8f0;border:none;border-radius:6px;cursor:pointer;font-size:14px">📊 查看比赛详情</button>
        <div id="match-details-${round.id}" style="display:none;margin-top:12px">
          <table><thead><tr><th>队伍1</th><th>比分</th><th>队伍2</th></tr></thead><tbody>`;
        for (const m of round.matches) {
          const dn = (n, r) => r || n;
          const t1n = m.t1p2name ? `${dn(m.t1p1name, m.t1p1real)} + ${dn(m.t1p2name, m.t1p2real)}` : dn(m.t1p1name, m.t1p1real);
          const t2n = m.t2p2name ? `${dn(m.t2p1name, m.t2p1real)} + ${dn(m.t2p2name, m.t2p2real)}` : dn(m.t2p1name, m.t2p1real);
          html += `<tr>
            <td>${t1n}</td>
            <td><strong>${m.team1_score} : ${m.team2_score}</strong></td>
            <td>${t2n}</td>
          </tr>`;
        }
        html += `</tbody></table>
        </div>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">查询失败: ${e.message}</div></div>`; }
}

function toggleMatchDetails(roundId) {
  const el = document.getElementById(`match-details-${roundId}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function deleteMatch(mid) {
  if (!confirm('确定删除该场比赛？')) return;
  try {
    await api(`/api/matches/${mid}`, { method: 'DELETE' });
    updateLive();
  } catch (e) { alert('删除失败: ' + e.message); }
}

async function deleteRound(rid) {
  if (!confirm('确定删除该轮次（含所有比赛数据）？此操作不可撤销！')) return;
  try {
    await api(`/api/rounds/${rid}`, { method: 'DELETE' });
    if (MS.roundId === rid) {
      MS.roundId = null;
      document.getElementById('fixture-card').style.display = 'none';
      document.getElementById('live-rank-card').style.display = 'none';
      document.getElementById('participant-list').innerHTML = '<div class="loading">暂无参赛者，请添加</div>';
      MS.participants = [];
    }
    alert('已删除');
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
    let html = `<div class="player-stat-card">
      <div style="display:flex;align-items:center;gap:16px">
        <div class="player-avatar" onclick="document.getElementById('avatar-input-${p.id}').click()" style="cursor:pointer">
          ${p.avatar ? `<img src="${p.avatar}" style="width:120px;height:120px;border-radius:50%;object-fit:cover">` : `<div style="width:120px;height:120px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:40px;color:#a0aec0">${p.name[0]}</div>`}
          <input id="avatar-input-${p.id}" type="file" accept="image/*" style="display:none" onchange="uploadAvatar(${p.id}, this)">
        </div>
        <div>
          <h3 style="margin:0;font-size:28px">${displayName(p)} ${p.real_name ? `<small style="color:#718096;font-weight:400;font-size:16px">(${p.name})</small>` : ''} <small style="color:#718096;font-weight:400;font-size:16px">${p.gender === 'male' ? '男' : '女'}</small></h3>
          <div style="margin-top:8px;font-size:13px;color:#718096">点击头像更换</div>
        </div>
      </div>
      <div class="stat-grid" style="margin-top:16px">
        <div class="stat-item"><div class="stat-value">${s.total_matches}</div><div class="stat-label">总场次</div></div>
        <div class="stat-item"><div class="stat-value">${s.total_wins}</div><div class="stat-label">总胜场</div></div>
        <div class="stat-item"><div class="stat-value">${s.win_rate || 0}%</div><div class="stat-label">胜率</div></div>
        <div class="stat-item"><div class="stat-value">${s.best_rank ? '第' + s.best_rank + '名' : '无'}</div><div class="stat-label">最高排名</div></div>
      </div>
    </div>`;

    html += `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3>📝 个人介绍</h3>
        <button onclick="editBio(${p.id})" style="font-size:12px;padding:4px 12px">✏️ 编辑</button>
      </div>
      <div id="bio-display-${p.id}" style="font-size:15px;line-height:1.7;color:#4a5568;margin-top:8px;white-space:pre-wrap">${p.bio || '暂无介绍'}</div>
      <div id="bio-edit-${p.id}" style="display:none;margin-top:8px">
        <textarea id="bio-textarea-${p.id}" style="width:100%;min-height:80px;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px;resize:vertical">${p.bio || ''}</textarea>
        <div style="margin-top:8px;display:flex;gap:8px">
          <button onclick="saveBio(${p.id})">💾 保存</button>
          <button class="secondary" onclick="cancelEditBio(${p.id})">取消</button>
        </div>
      </div>
    </div>`;

    if (data.points_history.length) {
      html += `<div class="card"><h3>比赛记录</h3><table><thead><tr><th>赛事</th><th>届</th><th>日期</th><th>排名</th><th>胜/负</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
      for (const h of data.points_history) html += `<tr><td>${h.tournament}</td><td>第${h.edition}届</td><td>${h.date}</td><td>第${h.rank}名</td><td>${h.wins}胜 ${h.losses}负</td><td>${h.net_points}</td><td>${h.points_earned}</td></tr>`;
      html += `</tbody></table></div>`;
    } else html += `<div class="card"><div class="loading">暂无比赛记录</div></div>`;
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">${e.message}</div></div>`; }
}

async function editBio(id) {
  document.getElementById(`bio-display-${id}`).style.display = 'none';
  document.getElementById(`bio-edit-${id}`).style.display = 'block';
}

async function cancelEditBio(id) {
  document.getElementById(`bio-display-${id}`).style.display = 'block';
  document.getElementById(`bio-edit-${id}`).style.display = 'none';
}

async function saveBio(id) {
  const bio = document.getElementById(`bio-textarea-${id}`).value;
  try {
    await api(`/api/players/${id}`, { method: 'PUT', body: JSON.stringify({ bio }) });
    document.getElementById(`bio-display-${id}`).textContent = bio || '暂无介绍';
    document.getElementById(`bio-display-${id}`).style.display = 'block';
    document.getElementById(`bio-edit-${id}`).style.display = 'none';
  } catch (e) { alert('保存失败: ' + e.message); }
}

let cropper = null;
let cropPlayerId = null;

function openCropModal(imgSrc, playerId) {
  cropPlayerId = playerId;
  const modal = document.getElementById('crop-modal');
  const img = document.getElementById('crop-image');
  modal.style.display = 'flex';
  img.src = imgSrc;
  if (cropper) cropper.destroy();
  img.onload = function() {
    cropper = new Cropper(img, {
      aspectRatio: 1, viewMode: 1, dragMode: 'move',
      autoCropArea: 0.8, cropBoxMovable: true, cropBoxResizable: true
    });
  };
}

function closeCropModal() {
  document.getElementById('crop-modal').style.display = 'none';
  if (cropper) { cropper.destroy(); cropper = null; }
}

async function confirmCrop() {
  if (!cropper || !cropPlayerId) return;
  const canvas = cropper.getCroppedCanvas({ width: 300, height: 300 });
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  try {
    await api(`/api/players/${cropPlayerId}/avatar`, { method: 'POST', body: JSON.stringify({ avatar: dataUrl }) });
    closeCropModal();
    queryPlayer();
  } catch (err) { alert('上传失败: ' + err.message); }
}

async function uploadAvatar(id, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('图片不能超过5MB'); return; }
  const reader = new FileReader();
  reader.onload = function(e) {
    openCropModal(e.target.result, id);
  };
  reader.readAsDataURL(file);
  input.value = '';
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
    function avatarHtml(p, size) {
      return p.avatar ? `<img src="${p.avatar}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block;margin:0 auto 6px">` : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.35)}px;color:#a0aec0;margin:0 auto 6px">${p.name[0]}</div>`;
    }
    let html = `<div class="card h2h-summary"><div style="display:flex;justify-content:center;align-items:center;gap:24px">
      <div style="text-align:center">${avatarHtml(data.player1, 64)}<strong style="font-size:20px">${displayName(data.player1)}</strong><br><span class="badge badge-win">${h2h.p1_wins} 胜</span></div>
      <div class="big-score">${h2h.p1_wins} : ${h2h.p2_wins}</div>
      <div style="text-align:center">${avatarHtml(data.player2, 64)}<strong style="font-size:20px">${displayName(data.player2)}</strong><br><span class="badge badge-loss">${h2h.p2_wins} 胜</span></div>
    </div><div class="h2h-vs" style="margin-top:8px">共交手 ${h2h.total} 次</div></div>`;
    if (data.matches.length) {
      html += `<div class="card"><h3>交手记录</h3>`;
      for (const m of data.matches) {
        const t1 = m.team1.players.map(p => displayName(p)).join(' + ');
        const t2 = m.team2.players.map(p => displayName(p)).join(' + ');
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

// ==================== Auth ====================

let isAuthenticated = false;
let currentAuthTab = null;

function showAuthInTab(tab) {
  currentAuthTab = tab;
  isAuthenticated = false;
  const tabEl = document.getElementById('tab-' + tab);
  const cards = tabEl.querySelectorAll('.card');
  cards.forEach(c => c.style.display = 'none');

  let authCard = document.getElementById('auth-card-' + tab);
  if (authCard) { authCard.style.display = 'block'; showAuthDefaultView(tab); return; }

  authCard = document.createElement('div');
  authCard.className = 'card';
  authCard.id = 'auth-card-' + tab;
  authCard.innerHTML = `
    <h3 style="margin-bottom:16px;font-size:20px">🔒 验证身份</h3>
    <div id="auth-body-${tab}">
      <p style="margin-bottom:12px;color:#4a5568;font-size:14px">请输入6位数字密码以进入管理页面</p>
      <input type="password" id="auth-pw-${tab}" maxlength="6" inputmode="numeric" pattern="\\d*"
        style="width:100%;padding:10px 14px;border:2px solid #d2d6dc;border-radius:8px;font-size:18px;text-align:center;letter-spacing:8px;outline:none"
        oninput="this.value=this.value.replace(/\D/g,'');document.getElementById('auth-err-${tab}').textContent=''"
        onkeydown="if(event.key==='Enter')authVerifyInline()">
      <div id="auth-err-${tab}" style="color:#e53e3e;font-size:13px;margin-top:8px;min-height:20px"></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button onclick="authVerifyInline()" style="flex:1;padding:10px;font-size:15px">确认</button>
        <button class="secondary" onclick="showForgotInline()" style="font-size:13px">忘记密码？</button>
      </div>
      <div style="margin-top:12px;text-align:center">
        <a href="#" onclick="showChangePwInline();return false" style="font-size:13px;color:#718096;text-decoration:underline">修改密码</a>
        <span style="color:#d2d6dc;margin:0 8px">|</span>
        <a href="#" onclick="showChangeSecInline();return false" style="font-size:13px;color:#718096;text-decoration:underline">修改密保</a>
      </div>
    </div>
    <div id="auth-forgot-${tab}" style="display:none">
      <p id="auth-q-${tab}" style="margin-bottom:12px;color:#4a5568;font-size:14px">加载中...</p>
      <input type="text" id="auth-sa-${tab}" placeholder="答案"
        style="width:100%;padding:10px 14px;border:2px solid #d2d6dc;border-radius:8px;font-size:16px;outline:none;margin-bottom:8px"
        oninput="document.getElementById('auth-fe-${tab}').textContent=''">
      <input type="password" id="auth-np-${tab}" maxlength="6" inputmode="numeric" pattern="\\d*" placeholder="新密码（6位数字）"
        style="width:100%;padding:10px 14px;border:2px solid #d2d6dc;border-radius:8px;font-size:18px;text-align:center;letter-spacing:8px;outline:none"
        oninput="this.value=this.value.replace(/\D/g,'');document.getElementById('auth-fe-${tab}').textContent=''"
        onkeydown="if(event.key==='Enter')authForgotInline()">
      <div id="auth-fe-${tab}" style="color:#e53e3e;font-size:13px;margin-top:8px;min-height:20px"></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button onclick="authForgotInline()" style="flex:1;padding:10px;font-size:15px">重置密码</button>
        <button class="secondary" onclick="showAuthDefaultView()" style="font-size:13px">返回</button>
      </div>
    </div>
    <div id="auth-cp-${tab}" style="display:none">
      <p style="margin-bottom:12px;color:#4a5568;font-size:14px">修改密码</p>
      <input type="password" id="auth-cur-${tab}" maxlength="6" inputmode="numeric" pattern="\\d*" placeholder="当前密码"
        style="width:100%;padding:10px 14px;border:2px solid #d2d6dc;border-radius:8px;font-size:18px;text-align:center;letter-spacing:8px;outline:none;margin-bottom:8px"
        oninput="this.value=this.value.replace(/\D/g,'');document.getElementById('auth-ce-${tab}').textContent=''">
      <input type="password" id="auth-np2-${tab}" maxlength="6" inputmode="numeric" pattern="\\d*" placeholder="新密码（6位数字）"
        style="width:100%;padding:10px 14px;border:2px solid #d2d6dc;border-radius:8px;font-size:18px;text-align:center;letter-spacing:8px;outline:none"
        oninput="this.value=this.value.replace(/\D/g,'');document.getElementById('auth-ce-${tab}').textContent=''"
        onkeydown="if(event.key==='Enter')authChangePwInline()">
      <div id="auth-ce-${tab}" style="color:#e53e3e;font-size:13px;margin-top:8px;min-height:20px"></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button onclick="authChangePwInline()" style="flex:1;padding:10px;font-size:15px">确认修改</button>
        <button class="secondary" onclick="showAuthDefaultView()" style="font-size:13px">返回</button>
      </div>
    </div>
    <div id="auth-cs-${tab}" style="display:none">
      <p style="margin-bottom:12px;color:#4a5568;font-size:14px">修改密保问题</p>
      <input type="password" id="auth-cspw-${tab}" maxlength="6" inputmode="numeric" pattern="\\d*" placeholder="当前密码"
        style="width:100%;padding:10px 14px;border:2px solid #d2d6dc;border-radius:8px;font-size:18px;text-align:center;letter-spacing:8px;outline:none;margin-bottom:8px"
        oninput="this.value=this.value.replace(/\D/g,'');document.getElementById('auth-cse-${tab}').textContent=''">
      <input type="text" id="auth-csq-${tab}" placeholder="新密保问题"
        style="width:100%;padding:10px 14px;border:2px solid #d2d6dc;border-radius:8px;font-size:16px;outline:none;margin-bottom:8px">
      <input type="text" id="auth-csa-${tab}" placeholder="新密保答案"
        style="width:100%;padding:10px 14px;border:2px solid #d2d6dc;border-radius:8px;font-size:16px;outline:none"
        onkeydown="if(event.key==='Enter')authChangeSecInline()">
      <div id="auth-cse-${tab}" style="color:#e53e3e;font-size:13px;margin-top:8px;min-height:20px"></div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button onclick="authChangeSecInline()" style="flex:1;padding:10px;font-size:15px">确认修改</button>
        <button class="secondary" onclick="showAuthDefaultView()" style="font-size:13px">返回</button>
      </div>
    </div>
  `;
  tabEl.insertBefore(authCard, tabEl.firstChild);
  setTimeout(() => document.getElementById('auth-pw-' + tab).focus(), 100);
}

function showAuthDefaultView() {
  const t = currentAuthTab;
  if (!t) return;
  document.getElementById('auth-body-' + t).style.display = 'block';
  document.getElementById('auth-forgot-' + t).style.display = 'none';
  document.getElementById('auth-cp-' + t).style.display = 'none';
  document.getElementById('auth-cs-' + t).style.display = 'none';
  document.getElementById('auth-pw-' + t).value = '';
  document.getElementById('auth-err-' + t).textContent = '';
}

async function authVerifyInline() {
  const t = currentAuthTab;
  if (!t) return;
  const password = document.getElementById('auth-pw-' + t).value;
  if (!password) return document.getElementById('auth-err-' + t).textContent = '请输入密码';
  if (!/^\d{6}$/.test(password)) return document.getElementById('auth-err-' + t).textContent = '密码必须为6位数字';
  try {
    await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ password }) });
    isAuthenticated = true;
    const authCard = document.getElementById('auth-card-' + t);
    if (authCard) authCard.remove();
    if (t === 'admin') {
      showAdminContent();
    } else {
      const tabEl = document.getElementById('tab-' + t);
      tabEl.querySelectorAll('.card').forEach(c => c.style.display = '');
      if (t === 'matches') initMatchPage();
      if (t === 'players') loadPlayerList();
    }
  } catch (e) {
    document.getElementById('auth-err-' + t).textContent = '密码错误';
  }
}

async function showForgotInline() {
  const t = currentAuthTab;
  if (!t) return;
  document.getElementById('auth-body-' + t).style.display = 'none';
  document.getElementById('auth-forgot-' + t).style.display = 'block';
  document.getElementById('auth-sa-' + t).value = '';
  document.getElementById('auth-np-' + t).value = '';
  document.getElementById('auth-fe-' + t).textContent = '';
  document.getElementById('auth-q-' + t).textContent = '加载中...';
  try {
    const data = await api('/api/auth/security-question');
    document.getElementById('auth-q-' + t).textContent = data.question;
  } catch (e) {
    document.getElementById('auth-q-' + t).textContent = '无法加载密保问题';
  }
}

async function authForgotInline() {
  const t = currentAuthTab;
  if (!t) return;
  const answer = document.getElementById('auth-sa-' + t).value.trim();
  const newPassword = document.getElementById('auth-np-' + t).value;
  if (!answer) return document.getElementById('auth-fe-' + t).textContent = '请回答密保问题';
  if (!newPassword) return document.getElementById('auth-fe-' + t).textContent = '请输入新密码';
  if (!/^\d{6}$/.test(newPassword)) return document.getElementById('auth-fe-' + t).textContent = '密码必须为6位数字';
  try {
    await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ answer, newPassword }) });
    alert('✅ 密码重置成功！请使用新密码登录');
    showAuthDefaultView();
  } catch (e) {
    document.getElementById('auth-fe-' + t).textContent = e.message;
  }
}

async function showChangePwInline() {
  const t = currentAuthTab;
  if (!t) return;
  document.getElementById('auth-body-' + t).style.display = 'none';
  document.getElementById('auth-cp-' + t).style.display = 'block';
  document.getElementById('auth-cur-' + t).value = '';
  document.getElementById('auth-np2-' + t).value = '';
  document.getElementById('auth-ce-' + t).textContent = '';
}

async function authChangePwInline() {
  const t = currentAuthTab;
  if (!t) return;
  const currentPassword = document.getElementById('auth-cur-' + t).value;
  const newPassword = document.getElementById('auth-np2-' + t).value;
  if (!currentPassword) return document.getElementById('auth-ce-' + t).textContent = '请输入当前密码';
  if (!newPassword) return document.getElementById('auth-ce-' + t).textContent = '请输入新密码';
  if (!/^\d{6}$/.test(newPassword)) return document.getElementById('auth-ce-' + t).textContent = '新密码必须为6位数字';
  try {
    await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    alert('✅ 密码修改成功！');
    showAuthDefaultView();
  } catch (e) {
    document.getElementById('auth-ce-' + t).textContent = e.message;
  }
}

async function showChangeSecInline() {
  const t = currentAuthTab;
  if (!t) return;
  document.getElementById('auth-body-' + t).style.display = 'none';
  document.getElementById('auth-cs-' + t).style.display = 'block';
  document.getElementById('auth-cspw-' + t).value = '';
  document.getElementById('auth-csq-' + t).value = '';
  document.getElementById('auth-csa-' + t).value = '';
  document.getElementById('auth-cse-' + t).textContent = '';
}

async function authChangeSecInline() {
  const t = currentAuthTab;
  if (!t) return;
  const password = document.getElementById('auth-cspw-' + t).value;
  const question = document.getElementById('auth-csq-' + t).value.trim();
  const answer = document.getElementById('auth-csa-' + t).value.trim();
  if (!password) return document.getElementById('auth-cse-' + t).textContent = '请输入当前密码';
  if (!question) return document.getElementById('auth-cse-' + t).textContent = '请输入新密保问题';
  if (!answer) return document.getElementById('auth-cse-' + t).textContent = '请输入新密保答案';
  try {
    await api('/api/auth/change-security', { method: 'POST', body: JSON.stringify({ password, question, answer }) });
    alert('✅ 密保问题修改成功！');
    showAuthDefaultView();
  } catch (e) {
    document.getElementById('auth-cse-' + t).textContent = e.message;
  }
}

// ==================== Init ====================
loadHome();
