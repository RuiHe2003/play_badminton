// ==================== Navigation ====================
// 静态资源版本号：CDN（Cloudflare）会缓存无版本号的静态文件，改版后必须换号才能生效。
// 注意版本号是两套、各自独立：
//   - ASSET_V（本常量）：管 app.js 与 app.js 里引用的图片
//   - style.css：在 index.html 里单独写 ?v=N
// 改 app.js 或图片 → 本常量 +1，并同步 index.html 的 /app.js?v=N
// 改 style.css   → 只改 index.html 的 /style.css?v=N
const ASSET_V = '50';
function assetUrl(p) { return p + '?v=' + ASSET_V; }
let currentAdminSub = 'players';
// 赛事没有自定义图标时，荣誉/详情处用的占位字符。
// 声明在文件顶部，避免被下面各渲染函数在 TDZ 里引用。
const HONOR_FALLBACK_ICON = '🏸';
function displayName(p) { return p.real_name || p.name; }
function htmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 赛事类型的显示名。老赛事只有 singles / mens_doubles / mixed_doubles，
// 「创建赛事」新增了 womens_* / mixed_singles / team。集中在这里，避免各处写死三元表达式。
function tourTypeLabel(type) {
  return ({
    singles: '男单', womens_singles: '女单', mixed_singles: '单打',
    mens_doubles: '男双', womens_doubles: '女双', mixed_doubles: '混双',
    team: '团体'
  })[type] || '赛事';
}

// 赛事详情深链参数：?tid=<赛事id>。用 replaceState 维护，不写浏览器历史，
// 「返回」行为完全由页面里的返回键控制，不跟浏览器历史纠缠。
function clearTidParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has('tid')) return;
  url.searchParams.delete('tid');
  history.replaceState(null, '', url);
}

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
    document.getElementById('tab-events').style.display = '';

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
    // 从赛事详情页点导航去别处时，清掉 URL 上的 ?tid=，否则刷新会又跳回详情页
    if (tab !== 'query') clearTidParam();
    if (tab === 'home') loadHome();
    if (tab === 'rankings') loadRankings();
    if (tab === 'query') initQueryPage();
    if (tab === 'player-query') reloadPlayerQueryList();
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
    setAdminSub(sub);
  });
});

// 管理端子页切换集中在这里。三块平级：选手管理 / 比赛管理 / 创建赛事。
function setAdminSub(sub) {
  document.getElementById('tab-players').style.display = sub === 'players' ? 'block' : 'none';
  document.getElementById('tab-matches').style.display = sub === 'matches' ? 'block' : 'none';
  document.getElementById('tab-events').style.display = sub === 'events' ? 'block' : 'none';
  if (sub === 'players') loadPlayerList();
  if (sub === 'matches') initMatchPage();
  if (sub === 'events') initEventPage();
}

function showAdminContent() {
  document.getElementById('admin-subnav').style.display = 'flex';
  document.getElementById('tab-admin').classList.add('active');
  document.querySelectorAll('[data-subtab]').forEach(a => a.classList.remove('active'));
  document.querySelector('[data-subtab="players"]').classList.add('active');
  currentAdminSub = 'players';
  setAdminSub('players');
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
// 给 cachedPlayers 赋值的唯一入口：同时重建「id → 姓名 / 性别」索引。
// 不这么做 pn() 就会退回「未知」—— 曾经踩过：管理端进「选手管理」时
// loadPlayerList() 直接赋值，随后 ensurePlayers() 因缓存非空提前返回，索引永远填不上，
// 赛事工作台的成员列 / 阵容下拉全变成「未知」。
function indexPlayers(list) {
  cachedPlayers = list || [];
  for (const k of Object.keys(nameCache)) delete nameCache[k];
  for (const k of Object.keys(evPidGender)) delete evPidGender[k];
  cachedPlayers.forEach(p => { nameCache[p.id] = p.real_name || p.name; evPidGender[p.id] = p.gender; });
  return cachedPlayers;
}
async function ensurePlayers() {
  if (cachedPlayers.length) return cachedPlayers;
  return indexPlayers(await api('/api/players'));
}
function pn(id) { return nameCache[id] || '未知'; }

// 总积分排名表格里姓名前的小头像：有录入头像则显示圆形缩略图，否则用名字首字符占位
function rankAvatarHtml(p, avatarMap) {
  const src = avatarMap && avatarMap[p.player_id];
  if (src) return `<img src="${src}" class="rank-avatar" alt="">`;
  const initial = htmlEsc((p.name || '?')[0]);
  return `<span class="rank-avatar rank-avatar-ph">${initial}</span>`;
}

// ==================== Home ====================
async function loadHome() {
  const el = document.getElementById('home-content');
  el.innerHTML = `
    <div class="home-top-row">
      <div class="home-card intro-card">
        <div class="home-card-icon">🏸</div>
        <h2 class="home-card-title">赛事介绍</h2>
        <p class="home-card-body">
          本系列羽毛球赛事自2024年正式开启，设<strong>集帅杯</strong>（男单）、<strong>国王杯</strong>（混双）、<strong>龙王杯</strong>（男双）三大竞赛项目，采用单循环赛制，赛事依据总胜局数、净胜分数核算名次。后增设<strong>希王杯</strong>（混双）和<strong>狗王杯</strong>（男双非固搭）赛事。
        </p>
      </div>
      <div class="home-image-wrapper">
        <img src="${assetUrl('/鸽子集帅.jpg')}" alt="鸽子集帅" class="home-image">
      </div>
    </div>
    <div class="home-card rules-card">
      <div class="home-card-icon">🏆</div>
      <h2 class="home-card-title">积分规则</h2>
      <div class="home-card-body">
        <div class="rule-item">
          <div class="rule-label">单轮排名</div>
          <div class="rule-desc">每轮比赛按胜场数排名，胜场相同则净胜分高者排名靠前。各赛事分为 1000 级、750 级、500 级、300 级四个级别，第1名得该赛事级别分数，之后每名递减 d 分（d = 赛事级别 ÷ 参赛队伍/人数，四舍五入）。</div>
        </div>
        <div class="rule-item">
          <div class="rule-label">跨届积分</div>
          <div class="rule-desc">选手参加某届比赛即获得该届排名对应积分；若缺席最新一届，则在上一届积分基础上扣除 d/2 分（最低为0，向下取整）。同一赛事只保留最新一届积分。</div>
        </div>
        <div class="rule-item">
          <div class="rule-label">总积分榜</div>
          <div class="rule-desc">每个选手取本人积分最高的四（男）/三（女）个赛事（如国王杯750级、国王杯500级视为不同赛事）的当前积分相加，按总积分降序排列。</div>
        </div>
      </div>
    </div>
  `;
}

// ==================== Player Management ====================
async function loadPlayerList() {
  try {
    const players = indexPlayers(await api('/api/players'));
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
    invalidatePlayerQueryCache();
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
    invalidatePlayerQueryCache();
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
    invalidatePlayerQueryCache();
    loadPlayerList();
  } catch (e) { alert(e.message); }
}

// ==================== Match Page ====================
const MS = { tid: null, type: '', tname: '', level: 1000, edition: 1, date: '', participants: [], roundId: null, roundNum: null, fixtures: [] };

async function initMatchPage() {
  Object.assign(MS, { tid: null, type: '', tname: '', level: 1000, edition: 1, date: '', participants: [], roundId: null, roundNum: null, fixtures: [] });
  document.getElementById('fixture-card').style.display = 'none';
  document.getElementById('live-rank-card').style.display = 'none';
  document.getElementById('round-actions').style.display = 'none';
  document.getElementById('save-edition-btn').style.display = 'none';
  document.getElementById('participant-list').innerHTML = '<div class="loading">暂无参赛者，请添加</div>';

  const tournaments = await api('/api/tournaments');
  cachedTournaments = tournaments;
  const sel = document.getElementById('round-tournament');
  // 新赛事（「创建赛事」建的）也在这里选，但走另一套 UI：
  // 它们的每一届由 event_editions 管（日期 / 级别 / 参赛名单 / 对阵），
  // 跟老赛事的 teams+matches 是两套数据，混进「创建新轮次」会录出两套结果。
  sel.innerHTML = tournaments.map(t =>
    `<option value="${t.id}" data-type="${t.type}" data-level="${t.level}" data-is-event="${t.is_event ? 1 : 0}" data-event-id="${t.event_id || ''}">${t.name} (${tourTypeLabel(t.type)}${t.is_event ? ' · 新赛制' : ''})</option>`
  ).join('');
  const levelSel = document.getElementById('round-level');
  if (levelSel) levelSel.onchange = () => { MS.level = parseInt(levelSel.value); };
  sel.onchange = () => { updateEditionSelect(); refreshParticipantSelect(); setDefaultLevel(); toggleFreeMatchUI(); renderTournamentIcon(); };
  function setDefaultLevel() {
    const opt = sel.options[sel.selectedIndex];
    if (levelSel && opt) { levelSel.value = opt.dataset.level || '1000'; MS.level = parseInt(levelSel.value); }
  }
  function toggleFreeMatchUI() {
    const sel = document.getElementById('round-tournament');
    const opt = sel.options[sel.selectedIndex];
    const isEv = opt && opt.dataset.isEvent === '1';
    const isFree = !isEv && opt && opt.text.startsWith('狗王杯');
    document.getElementById('free-match-card').style.display = isFree ? 'block' : 'none';
    // 新赛事：隐藏老流程的参赛区 / 对阵表 / 实时排名，改由「本届设置」卡接管
    document.getElementById('participant-area').style.display = (isFree || isEv) ? 'none' : '';
    document.getElementById('round-actions').style.display = 'none';
    document.getElementById('fixture-card').style.display = 'none';
    document.getElementById('live-rank-card').style.display = 'none';
    document.getElementById('existing-round-info').style.display = 'none';
    document.getElementById('ev-workspace-match').style.display = 'none';
    document.getElementById('ev-workspace-match').innerHTML = '';
    // 新赛事不用老流程那套「届数 / 日期 / 级别」输入（本届设置卡里有），藏起来免得两处打架
    for (const id of ['round-edition', 'round-date', 'round-level']) {
      const el = document.getElementById(id);
      if (el) el.style.display = isEv ? 'none' : '';
    }
    const h3 = document.querySelector('#create-round-card > h3');
    if (h3) h3.textContent = isEv ? '📋 选择赛事' : '📋 创建新轮次';
    document.getElementById('save-edition-btn').style.display = 'none';
    if (isEv) mEvInit();
    else {
      document.getElementById('ev-edition-card').style.display = 'none';
      if (isFree) initFreeMatch();
    }
  }
  document.getElementById('round-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('round-edition').oninput = async () => { await checkExistingRoundForEdit(); toggleFreeMatchOnEditionChange(); };
  await updateEditionSelect();
  await refreshParticipantSelect();
  toggleFreeMatchUI();
  renderTournamentIcon();
}

// ==================== Tournament Icon ====================
let cachedTournaments = [];

// 赛事图标统一压缩成正方形 JPEG（居中裁剪 + 白底）。
//
// 尺寸演变：
//   128 → 256（2026-10-16 首次修复）→ 512（2026-10-16 二次修复）
//
// 为什么最终定 512：图标最大展示处是查询页赛事格子 .tour-tile img，
// 2026-10-16 去掉格子里冗余的赛事名后上限提到 209px。在 125% 系统缩放下要 261 个物理像素，
// 512 对 261 有 1.96x 余量；256 只剩 0.98x（不够 1x，必糊）。
// 单张 JPEG(q0.92) 实测 40~80KB，7 个赛事全量也就几百 KB，完全可接受。
const ICON_SIZE = 512;

// 存量图标只有 128x128（早年旧代码压的），必须重新上传高清原图才能恢复细节。
// 这里只负责把新上传的图统一转成 ICON_SIZE 的 JPEG。
function compressIcon(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = function () {
      const SIZE = ICON_SIZE;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      // 先铺白底，透明 PNG 转 JPEG 才不会变黑
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, SIZE, SIZE);
      // 保持宽高比居中裁剪成正方形
      const side = Math.min(img.width, img.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function uploadTournamentIcon(input) {
  const status = document.getElementById('t-icon-status');
  const tid = document.getElementById('round-tournament').value;
  if (!tid) { input.value = ''; alert('请先选择赛事'); return; }
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { input.value = ''; alert('图片不能超过5MB'); return; }
  status.style.color = '#718096';
  status.textContent = '上传中...';
  try {
    const dataUrl = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = e => res(e.target.result);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
    // 源图太小的直接拦下来：放大只会更糊，不如让用户换原图。
    // 这正是 128×128 存量图标的病根——被浏览器放大到 110px+ 后边缘全糊。
    const srcSize = await getImageSize(dataUrl);
    if (srcSize && Math.min(srcSize.w, srcSize.h) < ICON_SIZE) {
      const go = confirm(
        `这张图只有 ${srcSize.w}×${srcSize.h}，小于图标标准尺寸 ${ICON_SIZE}×${ICON_SIZE}，\n` +
        `放大后边缘会偏糊。\n\n仍要使用吗？（建议换更大的原图）`
      );
      if (!go) { input.value = ''; status.textContent = ''; return; }
    }
    const icon = await compressIcon(dataUrl);
    await api(`/api/tournaments/${tid}/icon`, { method: 'POST', body: JSON.stringify({ icon }) });
    const t = cachedTournaments.find(x => String(x.id) === String(tid));
    if (t) t.icon = icon;
    status.style.color = '#38a169';
    status.textContent = `✓ 已保存 ${ICON_SIZE}×${ICON_SIZE} (${Math.round(icon.length / 1024)}KB)`;
    renderTournamentIcon();
    setTimeout(() => { status.textContent = ''; }, 3000);
  } catch (e) {
    status.style.color = '#e53e3e';
    status.textContent = '上传失败: ' + e.message;
  }
  input.value = '';
}

// 读取图片原始像素尺寸，用于上传前的清晰度校验（读不到尺寸不阻断流程）
function getImageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function removeTournamentIcon() {
  const tid = document.getElementById('round-tournament').value;
  if (!tid) return;
  if (!confirm('确定移除该赛事的图标吗？')) return;
  try {
    await api(`/api/tournaments/${tid}/icon`, { method: 'POST', body: JSON.stringify({ icon: '' }) });
    const t = cachedTournaments.find(x => String(x.id) === String(tid));
    if (t) t.icon = '';
    renderTournamentIcon();
  } catch (e) { alert('移除失败: ' + e.message); }
}

function renderTournamentIcon() {
  const sel = document.getElementById('round-tournament');
  const preview = document.getElementById('t-icon-preview');
  const hint = document.getElementById('t-icon-hint');
  const delBtn = document.getElementById('t-icon-del-btn');
  if (!sel || !preview) return;
  const t = cachedTournaments.find(x => String(x.id) === String(sel.value));
  if (!t) {
    preview.innerHTML = '🏸';
    hint.textContent = '请先选择赛事';
    delBtn.style.display = 'none';
    return;
  }
  if (t.icon) {
    preview.innerHTML = `<img src="${t.icon}" style="width:100%;height:100%;object-fit:cover;display:block">`;
    hint.textContent = `${t.name} · 点击图标可更换`;
    delBtn.style.display = '';
  } else {
    preview.innerHTML = htmlEsc((t.name || '?')[0]);
    hint.textContent = `${t.name} · 暂无图标，点击上传`;
    delBtn.style.display = 'none';
  }
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
  MS.level = parseInt(document.getElementById('round-level').value) || 1000;
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
  // 新赛制赛事：届次由「本届设置」卡管，这里的老轮次编辑一律不参与
  const selEl = document.getElementById('round-tournament');
  const curOpt = selEl.options[selEl.selectedIndex];
  if (curOpt && curOpt.dataset.isEvent === '1') {
    info.style.display = 'none'; editBtn.style.display = 'none';
    fixtureCard.style.display = 'none'; liveRankCard.style.display = 'none';
    if (roundActions) roundActions.style.display = 'none';
    return;
  }
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
    const lvl = parseInt(document.getElementById('round-level').value) || 1000;
    await api(`/api/rounds/${MS.roundId}`, {
      method: 'PUT',
      body: JSON.stringify({ edition, date, level: lvl })
    });
    MS.edition = edition;
    MS.date = date;
    MS.level = lvl;
    document.getElementById('save-round-status').textContent = '✅ 已保存';
    if (document.getElementById('fixture-card').style.display === 'block') {
      document.getElementById('fixture-title').innerHTML = `${MS.tname} - 第${MS.edition}届 (${MS.level}级) <button onclick="editRoundInfo()" style="font-size:11px;padding:1px 10px;margin-left:8px;vertical-align:middle">✏️ 编辑</button>`;
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
    MS.level = round.round_level || round.level || 1000;
    MS.edition = round.edition;
    MS.date = round.date;
    const levelSel = document.getElementById('round-level');
    if (levelSel) levelSel.value = MS.level;
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
      tournament_id: MS.tid, edition: MS.edition, date, level: MS.level,
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

// ==================== Free-Doubles (狗王杯) ====================
function toggleFreeMatchOnEditionChange() {
  const sel = document.getElementById('round-tournament');
  const opt = sel.options[sel.selectedIndex];
  if (opt && opt.text.startsWith('狗王杯')) initFreeMatch();
}

async function initFreeMatch() {
  const sel = document.getElementById('round-tournament');
  const tid = parseInt(sel.value);
  if (!tid) return;
  MS.tid = tid;
  MS.tname = sel.options[sel.selectedIndex].text.split('(')[0].trim();

  const players = await api('/api/players');
  const opts = players.map(p => `<option value="${p.id}">${p.real_name || p.name}</option>`).join('');
  ['fm-p1', 'fm-p2', 'fm-p3', 'fm-p4'].forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = '<option value="">选择选手</option>' + opts;
  });

  // Check if round exists for this edition
  const edition = document.getElementById('round-edition').value;
  if (edition) {
    try {
      const data = await api(`/api/rounds/lookup?tournamentId=${tid}&edition=${edition}`);
      if (data.exists) {
        MS.roundId = data.round.id;
        MS.edition = data.round.edition;
        MS.date = data.round.date;
        MS.level = data.round.round_level || data.round.level || 1000;
        document.getElementById('fm-create-btn').style.display = 'none';
        document.getElementById('fm-round-status').textContent = `✅ 已加载第${MS.edition}届`;
        document.getElementById('fm-entry-area').style.display = 'block';
        loadFreeMatchList();
        return;
      }
    } catch (e) {}
  }
  document.getElementById('fm-create-btn').style.display = 'inline-block';
  document.getElementById('fm-round-status').textContent = '';
  document.getElementById('fm-entry-area').style.display = 'none';
}

async function createFreeRound() {
  const edition = parseInt(document.getElementById('round-edition').value);
  const date = document.getElementById('round-date').value;
  const level = parseInt(document.getElementById('round-level').value) || 1000;
  if (!edition || !date) return alert('请填写届数和日期');
  try {
    document.getElementById('fm-round-status').textContent = '⏳ 创建中...';
    const r = await api('/api/rounds', { method: 'POST', body: JSON.stringify({
      tournament_id: MS.tid, edition, date, level
    })});
    MS.roundId = r.id;
    MS.edition = edition;
    MS.date = date;
    MS.level = level;
    document.getElementById('fm-create-btn').style.display = 'none';
    document.getElementById('fm-round-status').textContent = `✅ 已创建第${edition}届`;
    document.getElementById('fm-entry-area').style.display = 'block';
    document.getElementById('save-edition-btn').style.display = 'inline-block';
    document.getElementById('save-round-status').textContent = '';
    loadFreeMatchList();
  } catch (e) {
    document.getElementById('fm-round-status').textContent = '❌ 创建失败: ' + e.message;
  }
}

async function saveFreeMatch() {
  if (!MS.roundId) return alert('请先创建轮次');
  const p1 = parseInt(document.getElementById('fm-p1').value);
  const p2 = parseInt(document.getElementById('fm-p2').value);
  const p3 = parseInt(document.getElementById('fm-p3').value);
  const p4 = parseInt(document.getElementById('fm-p4').value);
  const s1 = parseInt(document.getElementById('fm-s1').value);
  const s2 = parseInt(document.getElementById('fm-s2').value);
  if (!p1 || !p2 || !p3 || !p4) return alert('请选择4名选手');
  if (new Set([p1, p2, p3, p4]).size !== 4) return alert('选手不能重复');
  if (isNaN(s1) || isNaN(s2)) return alert('请填写比分');
  if (s1 > 31 || s2 > 31 || s1 < 0 || s2 < 0) return alert('比分范围0-31');
  try {
    document.getElementById('fm-status').textContent = '⏳...';
    await api('/api/matches/direct', { method: 'POST', body: JSON.stringify({
      round_id: MS.roundId, player1_id: p1, player2_id: p2, player3_id: p3, player4_id: p4, team1_score: s1, team2_score: s2
    })});
    document.getElementById('fm-status').textContent = '✅ 已录入';
    document.getElementById('fm-p1').value = '';
    document.getElementById('fm-p2').value = '';
    document.getElementById('fm-p3').value = '';
    document.getElementById('fm-p4').value = '';
    document.getElementById('fm-s1').value = '';
    document.getElementById('fm-s2').value = '';
    loadFreeMatchList();
  } catch (e) {
    document.getElementById('fm-status').textContent = '❌ ' + e.message;
  }
}

async function loadFreeMatchList() {
  if (!MS.roundId) return;
  const matches = await api(`/api/matches/${MS.roundId}`);
  const teams = await api(`/api/rounds/${MS.roundId}/teams`);
  const teamMap = {};
  for (const t of teams) {
    teamMap[t.team_id] = { label: `${t.player1_name}${t.player2_name ? ' + ' + t.player2_name : ''}`, p1: t.player1_id, p2: t.player2_id, p1n: t.player1_name, p2n: t.player2_name };
  }

  let h = '<h4>📋 比赛列表</h4><table><thead><tr><th>#</th><th>队1</th><th>比分</th><th>队2</th><th>操作</th></tr></thead><tbody>';
  matches.forEach((m, i) => {
    const t1 = teamMap[m.team1_id];
    const t2 = teamMap[m.team2_id];
    h += `<tr>
      <td>${i + 1}</td>
      <td>${t1 ? t1.label : '?'}</td>
      <td><strong>${m.team1_score}:${m.team2_score}</strong></td>
      <td>${t2 ? t2.label : '?'}</td>
      <td><button class="danger" onclick="deleteFreeMatch(${m.id})" style="font-size:11px;padding:2px 8px">删除</button></td>
    </tr>`;
  });
  h += '</tbody></table>';

  // Per-player rankings (men's doubles only)
  const maleIds = new Set(cachedPlayers.filter(p => p.gender === 'male').map(p => p.id));
  const playerStats = {};
  for (const m of matches) {
    const t1 = teamMap[m.team1_id];
    const t2 = teamMap[m.team2_id];
    if (!t1 || !t2) continue;
    const t1w = m.team1_score > m.team2_score;
    const t1players = [[t1.p1, t1.p1n], t1.p2 ? [t1.p2, t1.p2n] : null].filter(Boolean);
    const t2players = [[t2.p1, t2.p1n], t2.p2 ? [t2.p2, t2.p2n] : null].filter(Boolean);
    for (const [pid, name] of t1players) {
      if (!maleIds.has(pid)) continue;
      if (!playerStats[pid]) playerStats[pid] = { name, wins: 0, losses: 0, pf: 0, pa: 0 };
      playerStats[pid].wins += t1w ? 1 : 0;
      playerStats[pid].losses += t1w ? 0 : 1;
      playerStats[pid].pf += m.team1_score;
      playerStats[pid].pa += m.team2_score;
    }
    for (const [pid, name] of t2players) {
      if (!maleIds.has(pid)) continue;
      if (!playerStats[pid]) playerStats[pid] = { name, wins: 0, losses: 0, pf: 0, pa: 0 };
      playerStats[pid].wins += t1w ? 0 : 1;
      playerStats[pid].losses += t1w ? 1 : 0;
      playerStats[pid].pf += m.team2_score;
      playerStats[pid].pa += m.team1_score;
    }
  }

  const sorted = Object.entries(playerStats).sort((a, b) => b[1].wins - a[1].wins || (b[1].pf - b[1].pa) - (a[1].pf - a[1].pa));
  const n = sorted.length;
  const d = n ? Math.round(MS.level / n) : 0;
  h += '<h4 style="margin-top:16px">📊 选手排名</h4><table><thead><tr><th>#</th><th>选手</th><th>胜</th><th>负</th><th>得分</th><th>失分</th><th>净胜分</th><th>积分</th></tr></thead><tbody>';
  sorted.forEach(([pid, s], i) => {
    const pts = MS.level - d * i;
    h += `<tr>
      <td>${i + 1}</td>
      <td><strong>${s.name}</strong></td>
      <td style="color:#38a169">${s.wins}</td>
      <td style="color:#e53e3e">${s.losses}</td>
      <td>${s.pf}</td>
      <td>${s.pa}</td>
      <td>${s.pf - s.pa}</td>
      <td><strong>${pts}</strong></td>
    </tr>`;
  });
  h += '</tbody></table>';

  document.getElementById('free-match-list').innerHTML = matches.length ? h : '<div class="loading">暂无比赛记录</div>';
}

async function deleteFreeMatch(matchId) {
  if (!confirm('确认删除该比赛？')) return;
  try {
    await api(`/api/matches/${matchId}`, { method: 'DELETE' });
    loadFreeMatchList();
  } catch (e) { alert('删除失败: ' + e.message); }
}

async function deleteFreeRound() {
  if (!MS.roundId) return;
  if (!confirm('确认删除该轮次及所有比赛？')) return;
  try {
    document.getElementById('fm-delete-status').textContent = '⏳ 删除中...';
    await api(`/api/rounds/${MS.roundId}`, { method: 'DELETE' });
    MS.roundId = null;
    document.getElementById('fm-entry-area').style.display = 'none';
    document.getElementById('fm-create-btn').style.display = 'inline-block';
    document.getElementById('fm-round-status').textContent = '🗑️ 已删除';
    document.getElementById('free-match-list').innerHTML = '';
    document.getElementById('save-edition-btn').style.display = 'none';
    document.getElementById('fm-delete-status').textContent = '';
  } catch (e) { document.getElementById('fm-delete-status').textContent = '❌ ' + e.message; }
}

async function editRoundInfo() {
  if (!MS.roundId) return;
  const newEdition = prompt('输入新届数:', MS.edition);
  if (!newEdition || parseInt(newEdition) === MS.edition) return;
  const newLevel = prompt('输入新级别 (300/500/750/1000):', MS.level);
  if (!newLevel) return;
  const newDate = prompt('输入新日期 (YYYY-MM-DD):', MS.date);
  if (!newDate) return;
  try {
    await api(`/api/rounds/${MS.roundId}`, {
      method: 'PUT',
      body: JSON.stringify({ edition: parseInt(newEdition), date: newDate, level: parseInt(newLevel) })
    });
    MS.edition = parseInt(newEdition);
    MS.date = newDate;
    MS.level = parseInt(newLevel);
    document.getElementById('fixture-title').innerHTML = `${MS.tname} - 第${MS.edition}届 (${MS.level}级) <button onclick="editRoundInfo()" style="font-size:11px;padding:1px 10px;margin-left:8px;vertical-align:middle">✏️ 编辑</button>`;
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
  const level = MS.level || 1000;
  const d = Math.round(level / n);
  let h = `<table><thead><tr><th>#</th><th>队伍</th><th>胜</th><th>负</th><th>得分</th><th>失分</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
  st.forEach((s, i) => {
    h += `<tr><td>${i+1 <= 3 ? ['🥇','🥈','🥉'][i] : i+1}</td><td>${s.label}</td><td>${s.wins}</td><td>${s.losses}</td><td>${s.pf}</td><td>${s.pa}</td><td>${s.pf-s.pa}</td><td><strong>${level-d*i}</strong></td></tr>`;
  });
  h += `</tbody></table><p style="margin-top:8px;color:#718096;font-size:13px">参赛: ${n} | 级别: ${level} | d=${d}</p>`;
  document.getElementById('live-rankings').innerHTML = h;
}

// ==================== Rankings ====================
let currentLowKey = null;
// 750 级合并列：所有 750 级赛事共用一个下拉列，默认显示"日期最新"举办的一届
// 例外：女生榜中国王杯(750级)单独成列，不并入合并列
const MERGED750_EXCLUDE_FEMALE = ['国王杯'];
// 男女榜的合并列选项不同，故选中项与"是否手动选过"都按性别分别记录
let currentHigh750Key = { male: null, female: null };
// 用户是否手动切换过下拉：没手动选过就永远默认显示"日期最新"的一届
let high750UserPicked = { male: false, female: false };
let lowUserPicked = false;
// 总积分榜默认只显示前 10 名，点下方提示条展开完整榜单；男女榜各自记住展开状态
const RANK_LIMIT = 10;
let rankExpanded = { male: false, female: false };
function isMerged750Key(key, gender) {
  const m = key.match(/^(.+)\((\d+)级\)$/);
  // 只要等级是 750 就归入合并列，新增 750 级赛事无需再改代码
  if (!m || parseInt(m[2]) !== 750) return false;
  if (gender === 'female' && MERGED750_EXCLUDE_FEMALE.includes(m[1])) return false;
  return true;
}
function sortKeysByLevelDesc(a, b) {
  const la = parseInt(a.match(/\((\d+)级\)$/)?.[1] || 1000);
  const lb = parseInt(b.match(/\((\d+)级\)$/)?.[1] || 1000);
  return la !== lb ? lb - la : a.localeCompare(b);
}

async function loadRankings() {
  const el = document.getElementById('rankings-content');
  try {
    await ensurePlayers();
    // 头像映射（来自选手库已录入的头像）
    const avatarMap = {};
    for (const p of cachedPlayers) if (p.avatar) avatarMap[p.id] = p.avatar;
    const trendData = await api('/api/points/trend');
    const points = trendData.current;
    const deltas = trendData.deltas || {};
    // Collect all unique tournament keys (e.g. "国王杯(1000级)") from player data
    const allKeys = {};
    for (const p of points) {
      for (const key in p.tournaments) allKeys[key] = true;
    }
    const sortedAll = Object.keys(allKeys).sort();
    // Compute all low keys (level < 750) for currentLowKey init
    const allLowKeys = [];
    for (const key of sortedAll) {
      const m = key.match(/\((\d+)级\)$/);
      const level = m ? parseInt(m[1]) : 1000;
      if (level < 750) allLowKeys.push(key);
    }
    // 计算每个 key 最近一届的日期（合并列默认选中"日期最新"的一届）；顺带建立 赛事名→图标 映射
    const allMerged750Keys = {
      male: sortedAll.filter(k => isMerged750Key(k, 'male')),
      female: sortedAll.filter(k => isMerged750Key(k, 'female')),
    };
    const keyLatestDate = {};
    const iconMap = {};
    {
      const tournaments = await api('/api/tournaments');
      const tourData = await Promise.all(tournaments.map(async (t) => {
        const rounds = await api(`/api/tournaments/${t.id}/rounds`);
        return { ...t, rounds };
      }));
      for (const tour of tourData) {
        if (tour.icon) iconMap[tour.name] = tour.icon;
        for (const round of tour.rounds) {
          const key = `${tour.name}(${round.round_level}级)`;
          if (!keyLatestDate[key] || round.date > keyLatestDate[key]) keyLatestDate[key] = round.date;
        }
      }
    }
    // 取 keys 中"最近一届日期"最新者；拿不到日期则退回级别高、再按名称排序
    function latestOf(keys) {
      let best = null;
      for (const key of keys) {
        const d = keyLatestDate[key];
        if (d && (!best || d > best.date)) best = { key, date: d };
      }
      if (best) return best.key;
      return [...keys].sort(sortKeysByLevelDesc)[0] || null;
    }
    // 下拉选项按"最近一届日期"倒序，最新排最前
    function byDateDesc(keys) {
      return [...keys].sort((a, b) => {
        const da = keyLatestDate[a] || '', db = keyLatestDate[b] || '';
        if (da !== db) return db.localeCompare(da);
        return sortKeysByLevelDesc(a, b);
      });
    }
    if (!lowUserPicked || !currentLowKey || !allLowKeys.includes(currentLowKey)) {
      currentLowKey = allLowKeys.length ? latestOf(allLowKeys) : null;
    }
    for (const g of ['male', 'female']) {
      const keys = allMerged750Keys[g];
      if (!high750UserPicked[g] || !currentHigh750Key[g] || !keys.includes(currentHigh750Key[g])) {
        currentHigh750Key[g] = keys.length ? latestOf(keys) : null;
      }
    }
    function isTournamentForGender(type, gender) {
      if (type === 'singles') return gender === 'male';
      return true;
    }
    function getGenderKeys(gender) {
      const has = {};
      for (const p of points) {
        if (p.gender !== gender) continue;
        for (const k in p.tournaments) {
          if (isTournamentForGender(p.tournaments[k].type, gender)) has[k] = true;
        }
      }
      const high = [];
      const merged = [];
      const low = [];
      for (const key of sortedAll) {
        const m = key.match(/\((\d+)级\)$/);
        const level = m ? parseInt(m[1]) : 1000;
        if (level >= 750) {
          if (has[key]) (isMerged750Key(key, gender) ? merged : high).push(key);
        } else {
          if (has[key]) low.push(key);
        }
      }
      high.sort(sortKeysByLevelDesc);
      merged.sort(sortKeysByLevelDesc);
      return { high, merged, low };
    }
    function renderRankTable(players, label, deltas) {
      if (!players.length) return '';
      const gender = players[0].gender;
      const gk = getGenderKeys(gender);
      const highKeys = gk.high;
      const mergedKeys = gk.merged;
      const lowKeys = gk.low;
      let lowKey = currentLowKey;
      if (lowKeys.length && (!lowKey || !lowKeys.includes(lowKey))) {
        lowKey = latestOf(lowKeys);
      }
      let mKey = currentHigh750Key[gender];
      if (mergedKeys.length && (!mKey || !mergedKeys.includes(mKey))) {
        mKey = latestOf(mergedKeys);
      }
      // 表头：赛事图标（24px 圆角）显示在赛事名称上方，未设置图标的赛事保持原样
      // 图标单独占一行（block），与名称/级别行分离，避免把下拉箭头挤成孤行
      function tourIconHtml(name) {
        return `<img class="tour-icon" src="${iconMap[name]}" alt="" title="${htmlEsc(name)}">`;
      }
      // 三行（图标 / 名称 / 🕊级别）拆成独立块级元素，行距由 CSS margin 统一控制，
      // 避免依赖 <br> 的行盒堆叠（那样各断点间距会不一致）。arrowHtml 拼在级别行开头。
      function tourLabel(k, arrowHtml = '') {
        const m = k.match(/^(.+)\((\d+)级\)$/);
        return m
          ? `<span class="tour-name">${m[1]}</span><span class="tour-lvl">${arrowHtml}🕊${m[2]}</span>`
          : `<span class="tour-name">${arrowHtml}${k}</span>`;
      }
      function tourNameOf(k) {
        const m = k.match(/^(.+)\((\d+)级\)$/);
        return m ? m[1] : k;
      }
      function fmtKey(k) {
        const name = tourNameOf(k);
        return iconMap[name] ? tourIconHtml(name) + tourLabel(k) : tourLabel(k);
      }
      // 列布局：先按级别降序输出独立高列（女生榜的国王杯750在此列队），再输出 750 合并列
      const columns = highKeys.map(key => ({ merged: false, key }));
      if (mergedKeys.length) columns.push({ merged: true, keys: mergedKeys });
      // 下拉选项：日期最新的排最前
      const mergedOpts = byDateDesc(mergedKeys);
      const lowOpts = byDateDesc(lowKeys);
      function dropdownTh(keys, selected, kind) {
        const icon = kind === 'low' ? 'low-icon' : 'high-icon';
        const toggle = kind === 'low' ? 'toggleLowDropdown' : 'toggleHighDropdown';
        const change = kind === 'low' ? 'changeLowTournament' : 'changeHighTournament';
        const tip = keyLatestDate[selected] ? `最近一届 ${keyLatestDate[selected]}` : '';
        const nm = tourNameOf(selected);
        const iconPart = iconMap[nm] ? tourIconHtml(nm) : '';
        return `<th class="tour-th" onclick="${toggle}(this)" title="${tip}" style="cursor:pointer;user-select:none;position:relative">
        ${iconPart}${tourLabel(selected, `<span class="${icon}">▶</span> `)}
        <div class="low-dd" onclick="event.stopPropagation()" style="display:none;position:absolute;top:100%;left:0;background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:4px;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,0.15);white-space:nowrap">
          <select class="low-sel" onchange="${change}(this)" style="padding:4px;border-radius:4px">
            ${keys.map(k => `<option value="${k}" ${k === selected ? 'selected' : ''}>${k}${keyLatestDate[k] ? ' · ' + keyLatestDate[k] : ''}</option>`).join('')}
          </select>
        </div>
      </th>`;
      }
      let h = `<div class="card"><h3>${label}总积分排名</h3>`;
      h += `<div class="rank-table-wrap"><table class="rank-table" data-gender="${gender}"><thead><tr><th class="th-hero-cell"><span class="th-hero" style="background-image:url('${assetUrl(gender === 'male' ? '/syq.png' : '/ztqy.png')}')"></span></th><th class="th-key">姓<span class="th-gap"></span>名</th>`;
      for (const col of columns) {
        h += col.merged ? dropdownTh(mergedOpts, mKey, 'high') : `<th class="tour-th">${fmtKey(col.key)}</th>`;
      }
      if (lowKeys.length) h += dropdownTh(lowOpts, lowKey, 'low');
      h += `<th class="th-key total-th" style="white-space:nowrap"><img class="tour-icon tour-icon-wide" src="${assetUrl('/total_points.png')}" alt="">总积分</th></tr></thead><tbody>`;
      players.forEach((p, i) => {
        const extra = i >= RANK_LIMIT;
        const hiddenAttr = extra && !rankExpanded[gender] ? ' style="display:none"' : '';
        const rc = i === 0 ? 'badge-gold' : i === 1 ? 'badge-silver' : i === 2 ? 'badge-bronze' : '';
        const d = deltas ? deltas[p.player_id] : 0;
        let trendColor = '', trendSymbol = '', trendNum = '';
        if (d > 0) { trendColor = '#38a169'; trendSymbol = '\u25b2'; trendNum = d; }
        else if (d < 0) { trendColor = '#e53e3e'; trendSymbol = '\u25bc'; trendNum = -d; }
        const trendVis = trendColor ? '' : 'visibility:hidden';
        h += `<tr class="${extra ? 'rank-extra' : ''}"${hiddenAttr}><td class="hero-col"><span class="badge ${rc}">${i + 1}</span></td><td style="white-space:nowrap">${rankAvatarHtml(p, avatarMap)}<strong>${displayName(p)}</strong></td>`;
        for (const col of columns) {
          const ck = col.merged ? mKey : col.key;
          const t = ck ? p.tournaments[ck] : null;
          h += `<td class="tour-td">${t ? t.points : 0}${t?.deducted ? ' <span style="color:#d69e00">▼</span>' : ''}</td>`;
        }
        if (lowKeys.length) {
          const lt = lowKey ? p.tournaments[lowKey] : null;
          h += `<td class="tour-td">${lt ? lt.points : 0}${lt?.deducted ? ' <span style="color:#d69e00">▼</span>' : ''}</td>`;
        }
        h += `<td class="total-td" style="vertical-align:middle;white-space:nowrap"><strong>${p.total_points}</strong> <span style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;color:${trendColor || '#ccc'};${trendVis};vertical-align:middle">
          <span style="font-size:10px;font-weight:bold;line-height:1.2">${trendNum || '0'}</span>
          <span style="font-size:14px;line-height:1.2">${trendSymbol || '\u25b2'}</span>
        </span></td></tr>`;
      });
      h += `</tbody></table></div>`;
      // 超过 10 人时，表格下方给出折叠提示条：点击展开/收起完整榜单
      if (players.length > RANK_LIMIT) {
        const open = rankExpanded[gender];
        const rest = players.length - RANK_LIMIT;
        h += `<div class="rank-more" data-gender="${gender}" onclick="toggleRankExpand('${gender}')">${open
          ? `▲ 收起，仅显示前 ${RANK_LIMIT} 名`
          : `▼ 仅显示前 ${RANK_LIMIT} 名，还有 ${rest} 位选手 · 点击查看完整排名`}</div>`;
      }
      h += `</div>`;
      return h;
    }

    const malePoints = points.filter(p => p.gender === 'male').sort((a, b) => b.total_points - a.total_points);
    const femalePoints = points.filter(p => p.gender === 'female').sort((a, b) => b.total_points - a.total_points);

    let html = renderRankTable(malePoints, '男子', deltas);
    html += renderRankTable(femalePoints, '女子', deltas);
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="loading" style="color:#e53e3e">加载失败: ${e.message}</div>`; }
}

function toggleRankExpand(gender) {
  rankExpanded[gender] = !rankExpanded[gender];
  const open = rankExpanded[gender];
  const btn = document.querySelector(`.rank-more[data-gender="${gender}"]`);
  const card = btn && btn.closest('.card');
  if (!card) return;
  card.querySelectorAll('tr.rank-extra').forEach(tr => { tr.style.display = open ? '' : 'none'; });
  const rest = card.querySelectorAll('tr.rank-extra').length;
  btn.textContent = open
    ? `▲ 收起，仅显示前 ${RANK_LIMIT} 名`
    : `▼ 仅显示前 ${RANK_LIMIT} 名，还有 ${rest} 位选手 · 点击查看完整排名`;
}

function toggleLowDropdown(th) {
  const dd = th.querySelector('.low-dd');
  const icon = th.querySelector('.low-icon');
  if (!dd) return;
  if (dd.style.display === 'none' || !dd.style.display) {
    dd.style.display = 'block';
    icon.textContent = '▼';
  } else {
    dd.style.display = 'none';
    icon.textContent = '▶';
  }
}

function changeLowTournament(sel) {
  currentLowKey = sel.value;
  lowUserPicked = true;
  document.querySelectorAll('.low-dd').forEach(d => d.style.display = 'none');
  document.querySelectorAll('.low-icon').forEach(i => i.textContent = '▶');
  loadRankings();
}

function toggleHighDropdown(th) {
  const dd = th.querySelector('.low-dd');
  const icon = th.querySelector('.high-icon');
  if (!dd) return;
  if (dd.style.display === 'none' || !dd.style.display) {
    dd.style.display = 'block';
    if (icon) icon.textContent = '▼';
  } else {
    dd.style.display = 'none';
    if (icon) icon.textContent = '▶';
  }
}

function changeHighTournament(sel) {
  // 男女榜的 750 合并列互不相干，按所属表格的性别分别记录
  const g = (sel.closest('table') || {}).dataset?.gender || 'male';
  currentHigh750Key[g] = sel.value;
  high750UserPicked[g] = true;
  document.querySelectorAll('.low-dd').forEach(d => d.style.display = 'none');
  document.querySelectorAll('.high-icon').forEach(i => i.textContent = '▶');
  document.querySelectorAll('.low-icon').forEach(i => i.textContent = '▶');
  loadRankings();
}

// ==================== Query by Tournament + Edition ====================
// 赛事查询页左上角图标：赛事 id → 图标（base64），随下拉选中项更新
let tourIconById = {};
let tourIconByName = {};
let queryTournaments = [];

// 赛事图标按钮网格：点击某个赛事跳转到独立详情页（不再在原网格下方就地展开）
function renderTourGrid() {
  const g = document.getElementById('query-tour-grid');
  if (!g) return;
  // 格子内不再显示赛事名：每个图标本身就是带赛事名的 logo，文字纯属冗余，
  // 省下的高度全部让给图标（见 style.css 的 .tour-tile img）。
  // 但按钮不能因此变成"无标签按钮"，所以 title 保留（悬停可见）+ aria-label 补语义。
  g.innerHTML = queryTournaments.map(t => `
    <div class="tour-tile" data-tid="${t.id}" onclick="showTournamentLatest('${t.id}')"
         title="${htmlEsc(t.name)}" aria-label="${htmlEsc(t.name)}">
      ${t.icon ? `<img src="${t.icon}" alt="">` : `<div class="tile-icon-ph">${htmlEsc((t.name || '?')[0])}</div>`}
    </div>`).join('');
}

// 切入「赛事详情」独立视图：切 tab + 设标题。
// 头部只留「返回键 + 标题」（赛事图标槽已移除，保持简洁）。
// 返回键是 HTML 里写死的 .back-btn → closeTourDetail()，两条入口（点图标 / 点查询）共用。
function openTourDetailPage(title) {
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-tour-detail').classList.add('active');
  document.getElementById('detail-tour-title').textContent = title;
}

// 跳到某个赛事的详情页（独立 tab），并同步 URL 的 ?tid= 便于刷新/分享
async function showTournamentLatest(tid) {
  const t = queryTournaments.find(x => String(x.id) === String(tid));
  if (!t) return;

  // 同步 URL：replaceState 不产生历史记录，返回键行为完全由我们的按钮控制
  const url = new URL(location.href);
  url.searchParams.set('tid', tid);
  history.replaceState(null, '', url);

  // 详情页头部只设标题（顶部导航保持"赛事查询"高亮）
  openTourDetailPage(t.name);

  // 「创建赛事」建的赛事走赛事工作台（小组积分榜 + 淘汰签表），
  // 老赛事走原来的轮次详情。两者共用同一个详情 tab。
  if (t.is_event && t.event_id) { showEventDetail(t.event_id); return; }

  const el = document.getElementById('tour-detail-body');
  el.innerHTML = '<div class="loading">加载中...</div>';
  try {
    await ensurePlayers();
    const data = await api(`/api/query/rounds?tournamentId=${tid}`);
    if (!data.length) { el.innerHTML = '<div class="card"><div class="loading">该赛事暂无赛况</div></div>'; return; }
    const sorted = data.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
    el.innerHTML = renderRoundCard(sorted[0]);
  } catch (e) {
    el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">加载失败: ${e.message}</div></div>`;
  }
}

// 从详情页返回赛事列表页：清掉 URL 上的 ?tid=，并重新初始化网格
function closeTourDetail() {
  clearTidParam();

  // 返回时把用户刚才选的赛事 / 届数原样恢复：initQueryPage() 会重建下拉框 options，
  // 不恢复的话会被重置成「全部赛事」，用户想改个条件重查就得重新选一遍。
  const keepTid = document.getElementById('query-tournament').value;
  const keepEdition = document.getElementById('query-edition').value;

  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-query').classList.add('active');
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.toggle('active', a.dataset.tab === 'query'));
  Promise.resolve(initQueryPage()).then(() => {
    const sel = document.getElementById('query-tournament');
    if (sel && keepTid && [...sel.options].some(o => o.value === keepTid)) sel.value = keepTid;
    document.getElementById('query-edition').value = keepEdition;
    updateQueryTourIcon();
  });
}

// 兼容浏览器/手机自带的返回手势：popstate 时按 URL 上的 ?tid= 决定停在哪个视图。
// 我们只用 replaceState 改 URL，所以用户按浏览器返回通常会退回进入本站前的页面；
// 但若他手动改了地址或从深链进来，这里能兜住。
window.addEventListener('popstate', () => {
  const tid = new URLSearchParams(location.search).get('tid');
  if (tid) { showTournamentLatest(tid); }
  else if (document.getElementById('tab-tour-detail').classList.contains('active')) { closeTourDetail(); }
});

function updateQueryTourIcon() {
  const sel = document.getElementById('query-tournament');
  const box = document.getElementById('query-tour-icon');
  if (!sel || !box) return;
  const tid = sel.value;
  const label = tid ? (sel.options[sel.selectedIndex]?.text || '') : '';
  const src = tid ? tourIconById[tid] : '';
  if (src) {
    box.innerHTML = `<img class="query-tour-icon" src="${src}" alt="" title="${htmlEsc(label)}">`;
  } else if (tid) {
    box.innerHTML = `<span class="query-tour-icon query-tour-icon-ph" title="${htmlEsc(label)}">${htmlEsc(label[0] || '?')}</span>`;
  } else {
    // 全部赛事（未指定赛事 = 还没开始查）：显示放大镜，语义上就是「搜索」。
    // 保留 58x58 占位，避免标题左右跳动。
    box.innerHTML = `<span class="query-tour-icon query-tour-icon-ph" title="全部赛事">🔍</span>`;
  }
}

async function initQueryPage() {
  const tournaments = await api('/api/tournaments');
  queryTournaments = tournaments;
  tourIconById = Object.fromEntries(tournaments.filter(t => t.icon).map(t => [String(t.id), t.icon]));
  tourIconByName = Object.fromEntries(tournaments.filter(t => t.icon).map(t => [t.name, t.icon]));
  const sel = document.getElementById('query-tournament');
  // 新赛事也列在前台查询里，点进去走只读工作台；带 data-is-event 让各处能一眼区分新老赛事
  sel.innerHTML = '<option value="">全部赛事</option>' +
    tournaments.map(t => `<option value="${t.id}" data-type="${t.type}" data-level="${t.level}" data-is-event="${t.is_event ? 1 : 0}" data-event-id="${t.event_id || ''}">${t.name}${t.is_event ? ' · 新赛制' : ''}</option>`).join('');
  sel.onchange = updateQueryTourIcon;
  updateQueryTourIcon();
  renderTourGrid();
  document.getElementById('query-results').innerHTML =
    '<div class="card"><div class="loading">👆 点击赛事图标查看最新赛况，或选好条件后点「查询」</div></div>';
}

async function queryRecentHighLevelRounds() {
  const el = document.getElementById('query-results');
  el.innerHTML = '<div class="loading">加载中...</div>';
  try {
    await ensurePlayers();
    const data = await api('/api/query/rounds');
    const highLevel = data.filter(r => (r.round_level || 1000) >= 750)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const seen = new Set();
    const latest = [];
    for (const round of highLevel) {
      const key = round.tournament_name + '(' + (round.round_level || 1000) + '级)';
      if (!seen.has(key)) { seen.add(key); latest.push(round); }
    }
    if (!latest.length) { el.innerHTML = '<div class="card"><div class="loading">暂无750级以上赛事</div></div>'; return; }
    let html = '';
    for (const round of latest) {
      html += renderRoundCard(round);
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">加载失败: ${e.message}</div></div>`; }
}

// 赛事图标（按赛事名）：用于赛事查询页的轮次卡片标题，无图标则显示赛事名首字占位
function tourIconByNameHtml(name) {
  const src = tourIconByName[name];
  if (src) return `<img class="round-tour-icon" src="${src}" alt="" title="${htmlEsc(name)}">`;
  return `<span class="round-tour-icon round-tour-icon-ph" title="${htmlEsc(name)}">${htmlEsc((name || '?')[0])}</span>`;
}

function renderRoundCard(round) {
  const isFree = round.tournament_name === '狗王杯';
  // 「创建赛事」建的赛事：这不是一届一轮的循环赛，用轮次卡片渲染会看不懂，
  // 改成一张引导卡，点进赛事工作台看小组积分榜与淘汰签表。
  const evT = queryTournaments.find(x => x.id === round.tournament_id && x.is_event);
  if (evT) {
    return `<div class="card">
      <h3 class="round-card-title">${tourIconByNameHtml(round.tournament_name)}<span>${round.tournament_name} - 第${round.edition}届 (${round.date})</span></h3>
      <div class="ev-brief" style="margin-bottom:12px">这是通过「创建赛事」建立的赛事（${round.round_level || 1000}级），采用小组循环 / 淘汰签表赛制，名次由赛事引擎计算。</div>
      <button onclick="showEventDetail(${evT.event_id},${round.edition})">查看本届详情</button>
    </div>`;
  }
  let h = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap">
      <h3 class="round-card-title">${tourIconByNameHtml(round.tournament_name)}<span>${round.tournament_name} - 第${round.edition}届 (${round.date}) | ${round.round_level || 1000}级</span></h3></div>`;
  h += `<table><thead><tr><th>排名</th><th>${isFree ? '选手' : '队伍'}</th><th>胜</th><th>负</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
  for (const r of round.ranking.rankings) {
    const name = isFree ? pn(r.player_id) : (r.player2_id ? `${pn(r.player1_id)} + ${pn(r.player2_id)}` : pn(r.player1_id));
    h += `<tr><td>${r.rank}</td><td>${name}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.net_points}</td><td>${r.points_earned}</td></tr>`;
  }
  h += `</tbody></table>`;
  if (round.matches && round.matches.length) {
    h += `<button onclick="toggleMatchDetails(${round.id})" style="margin-top:16px;width:100%;padding:8px;background:#e2e8f0;border:none;border-radius:6px;cursor:pointer;font-size:14px">📊 查看比赛详情</button>
      <div id="match-details-${round.id}" style="display:none;margin-top:12px">
      <table><thead><tr><th>队伍1</th><th>比分</th><th>队伍2</th></tr></thead><tbody>`;
    for (const m of round.matches) {
      const dn = (n, r) => r || n;
      const t1n = m.t1p2name ? `${dn(m.t1p1name, m.t1p1real)} + ${dn(m.t1p2name, m.t1p2real)}` : dn(m.t1p1name, m.t1p1real);
      const t2n = m.t2p2name ? `${dn(m.t2p1name, m.t2p1real)} + ${dn(m.t2p2name, m.t2p2real)}` : dn(m.t2p1name, m.t2p1real);
      h += `<tr><td>${t1n}</td><td><strong>${m.team1_score} : ${m.team2_score}</strong></td><td>${t2n}</td></tr>`;
    }
    h += `</tbody></table></div>`;
  }
  h += `</div>`;
  return h;
}

async function queryRounds() {
  const tid = document.getElementById('query-tournament').value;
  updateQueryTourIcon();
  const edition = document.getElementById('query-edition').value.trim();
  const el = document.getElementById('tour-detail-body');

  // 查询结果不再堆在列表下方，而是直接跳到独立的详情页（左上角有返回键）。
  // 标题按查询条件拼，让用户在新页面也知道自己在看什么。
  const t = queryTournaments.find(x => String(x.id) === String(tid));
  const title = t
    ? (edition ? `${t.name} - 第${edition}届` : `${t.name} - 全部届数`)
    : '全部赛事';
  // 选中的是「创建赛事」建的赛事：直接进它的工作台，别走轮次查询
  if (t && t.is_event && t.event_id) {
    openTourDetailPage(t.name);
    clearTidParam();
    showEventDetail(t.event_id);
    return;
  }
  openTourDetailPage(title);
  // 查询条件与 ?tid= 不同源（可能带届数），刷新不重放，故清掉 URL 上的旧赛事参数
  clearTidParam();

  el.innerHTML = '<div class="loading">查询中...</div>';

  try {
    await ensurePlayers();
    const params = new URLSearchParams();
    if (tid) params.set('tournamentId', tid);
    if (edition) params.set('edition', edition);
    const data = await api(`/api/query/rounds?${params.toString()}`);
    if (!data.length) { el.innerHTML = '<div class="card"><div class="loading">未找到匹配的赛事</div></div>'; return; }

    el.innerHTML = data.map(round => renderRoundCard(round)).join('');
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
// 选手查询页默认只显示「参加过 >= PLAYER_MIN_EDITIONS 届」的选手，
// 其余选手折叠在底部，点提示条才展开。阈值调这里。
const PLAYER_MIN_EDITIONS = 5;
let playerListExpanded = false;
let playerQueryCache = null;

// 选手输入联想的数据缓存（对阵查询/选手查询共用）。
// 声明放在这里而不是"选手输入联想"那一段，是为了让上面的 invalidate 函数
// 在任何调用时机都不会踩到 let 的暂时性死区。
let suggestPlayers = null;
let suggestLoading = null;

// 选手增删改或录了比赛之后调用，保证下次进列表时重新拉取届数
function invalidatePlayerQueryCache() {
  playerQueryCache = null;
  suggestPlayers = null;   // 联想数据同源，一并失效
}

async function loadPlayerQueryList() {
  const el = document.getElementById('player-result');
  document.getElementById('query-player-name').value = '';
  el.innerHTML = '<div class="loading">加载中...</div>';
  try {
    // 缓存一次，展开/收起时不必重复请求。
    // 缓存由 invalidatePlayerQueryCache() 失效，且每次进入本标签页都会强制刷新，
    // 所以「录完比赛再来看」拿到的一定是新的届数。
    if (!playerQueryCache) playerQueryCache = await api('/api/players/with-editions');
    renderPlayerQueryList();
  } catch (e) { el.innerHTML = `<div class="card"><div class="loading">加载失败</div></div>`; }
}

// 进入选手查询页时调用：强制重拉（录比赛/改选手后届数会变）
function reloadPlayerQueryList() {
  invalidatePlayerQueryCache();
  playerListExpanded = false;
  return loadPlayerQueryList();
}

function playerCardHtml(p) {
  const dn = displayName(p);
  const extra = dn !== p.name ? ` <small style="color:#718096;font-size:12px">(${p.name})</small>` : '';
  const meta = [p.gender === 'male' ? '男' : '女'];
  if (typeof p.editions === 'number') meta.push(`${p.editions} 届`);
  return `<div class="player-card" data-editions="${p.editions || 0}" onclick="showPlayerDetail('${p.name.replace(/'/g, "\\'")}')">
    <div class="player-avatar-wrap">${p.avatar ? `<img src="${p.avatar}" class="player-avatar-img">` : `<div class="player-avatar-placeholder">${p.name[0]}</div>`}</div>
    <div class="player-name"><strong>${dn}</strong>${extra}</div>
    <div class="player-gender">${meta.join(' · ')}</div>
  </div>`;
}

function renderPlayerQueryList() {
  const el = document.getElementById('player-result');
  const all = playerQueryCache || [];
  // 届数多的排前面，同届数按姓名 —— 让首页列表本身就是「核心选手榜」
  const sorted = all.slice().sort((a, b) => (b.editions || 0) - (a.editions || 0) || a.name.localeCompare(b.name, 'zh'));
  const main = sorted.filter(p => (p.editions || 0) >= PLAYER_MIN_EDITIONS);
  const rest = sorted.filter(p => (p.editions || 0) < PLAYER_MIN_EDITIONS);

  let html = '<div class="player-grid">';
  html += main.map(playerCardHtml).join('');
  if (playerListExpanded) html += rest.map(playerCardHtml).join('');
  html += '</div>';

  // 底部提示条：还有多少人被折叠。已展开则变成「收起」
  if (rest.length) {
    html += playerListExpanded
      ? `<div class="rank-more" onclick="togglePlayerListExpand()">▲ 收起，仅显示参加过 ${PLAYER_MIN_EDITIONS} 届及以上的选手</div>`
      : `<div class="rank-more" onclick="togglePlayerListExpand()">▼ 仅显示参加过 ${PLAYER_MIN_EDITIONS} 届及以上的选手（${main.length} 位），还有 ${rest.length} 位 · 点击查看所有选手</div>`;
  }
  el.innerHTML = html;
}

function togglePlayerListExpand() {
  playerListExpanded = !playerListExpanded;
  renderPlayerQueryList();
}

async function queryPlayer() {
  const name = document.getElementById('query-player-name').value.trim();
  if (!name) return alert('请输入选手姓名');
  await showPlayerDetail(name);
}

let currentViewedPlayer = '';

// ==================== 选手详情：四项数据模块 ====================
// 布局（从左到右）：[总场次 + 胜场] [胜率] [荣誉] [年度最高]
// 荣誉模块只放「门面」一条：最高级别的冠军；没冠军退亚军，再没退季军，
// 三项都空则显示"暂无"。点击整块跳转到该选手的荣誉清单页。

// 与后端 pickTopHonor 同规则的前端兜底实现（后端已排好序，这里只做挑拣）
function pickTopHonorClient(honors) {
  if (!honors || !honors.length) return null;
  for (const tier of [1, 2, 3]) {
    const hit = honors.find(h => h.tier === tier);
    if (hit) return hit;
  }
  return null;
}

function summarizeHonorsClient(honors) {
  const s = { gold: 0, silver: 0, bronze: 0, total: 0 };
  for (const h of honors || []) {
    if (h.tier === 1) s.gold++;
    else if (h.tier === 2) s.silver++;
    else if (h.tier === 3) s.bronze++;
  }
  s.total = s.gold + s.silver + s.bronze;
  return s;
}

// 荣誉模块内容：左边放大版赛事图标，右边上「赛事名」下「冠/亚/季」。
// 刻意不显示「第N届」——空间让给图标和赛事名，届数在荣誉清单页里有。
function honorModuleInner(topHonor) {
  if (!topHonor) {
    return `<div class="stat-honor-empty">暂无</div><div class="stat-label">荣誉</div>`;
  }
  const icon = topHonor.tournament_icon
    ? `<img class="stat-honor-icon" src="${topHonor.tournament_icon}" alt="">`
    : `<span class="stat-honor-icon stat-honor-icon-ph">${HONOR_FALLBACK_ICON}</span>`;
  const tierCls = 'stat-honor-tier tier-' + topHonor.tier;
  return `<div class="stat-honor-line">
      ${icon}
      <div class="stat-honor-text">
        <div class="stat-honor-title">${htmlEsc(topHonor.tournament_name)}</div>
        <div class="stat-honor-sub"><span class="${tierCls}">${topHonor.tier_icon}${htmlEsc(topHonor.tier_label)}</span></div>
      </div>
    </div>
    <div class="stat-label">荣誉</div>`;
}

// 胜率圆环：用 conic-gradient 画红/绿两段。
// 绿=胜、红=负（注意这是「胜负比例」不是股价涨跌，不受 A 股红涨绿跌惯例约束；
// 这里沿用胜利=绿的通用体育配色，与页面其它「胜/负」用色一致）。
function winRateRingHtml(winRate, totalMatches, totalWins) {
  const pct = Math.max(0, Math.min(100, Number(winRate) || 0));
  const losses = Math.max(0, (totalMatches || 0) - (totalWins || 0));
  const title = `胜 ${totalWins || 0} · 负 ${losses} 场`;
  return `<div class="wr-ring" style="--wr:${pct}%" title="${title}">
      <div class="wr-ring-hole">
        <div class="wr-ring-value">${pct}<small class="stat-unit">%</small></div>
      </div>
    </div>
    <div class="stat-label">胜率</div>`;
}

function statModulesHtml(s, summary, topHonor, playerName) {
  // 年度最高名次：总积分榜按年切片，取「最近一个自己有有效排名的年度」的最好名次。
  // 悬停给出年度与达成时间，避免被误读成「当前名次」。
  const rankYear = s.year_best_year || '';
  const r = s.year_best_rank;
  const rankTip = r
    ? `${rankYear} 年度 · ${s.year_best_date} ${s.year_best_tournament}第${s.year_best_edition}届 时达成`
    : '尚未在总积分榜上榜';
  const rankTxt = r ? '第' + r + '名' : '无';
  const safeName = String(playerName).replace(/'/g, "\\'");
  return `<div class="stat-modules">
    <div class="stat-mod stat-mod-cnt">
      <div class="stat-sub"><div class="stat-sub-value">${s.total_matches}</div><div class="stat-sub-label">总场次</div></div>
      <div class="stat-sub"><div class="stat-sub-value">${s.total_wins}</div><div class="stat-sub-label">胜场</div></div>
    </div>
    <div class="stat-mod">
      ${winRateRingHtml(s.win_rate, s.total_matches, s.total_wins)}
    </div>
    <div class="stat-mod stat-mod-honor" onclick="showPlayerHonors('${safeName}')" title="查看全部荣誉">
      ${honorModuleInner(topHonor)}
      <span class="stat-honor-arrow" aria-hidden="true"></span>
    </div>
    <div class="stat-mod" title="${htmlEsc(rankTip)}">
      <div class="stat-value">${rankTxt}</div>
      <div class="stat-label">${rankYear ? rankYear + '年最高' : '年度最高'}</div>
    </div>
  </div>`;
}

// ==================== 个人荣誉清单页 ====================
async function showPlayerHonors(name) {
  const el = document.getElementById('player-result');
  el.innerHTML = '<div class="loading">查询中...</div>';
  try {
    const data = await api(`/api/player/${encodeURIComponent(name)}/honors`);
    const p = data.player, sum = data.summary, honors = data.honors || [];

    // 按「冠军组 → 亚军组 → 季军组」分开渲染，组内已是「级别降序 + 同级近的在前」
    const groups = [
      { tier: 1, title: '🏆 冠军', cls: 'gold' },
      { tier: 2, title: '🥈 亚军', cls: 'silver' },
      { tier: 3, title: '🥉 季军', cls: 'bronze' }
    ];

    let body = '';
    for (const g of groups) {
      const list = honors.filter(h => h.tier === g.tier);
      if (!list.length) continue;
      body += `<div class="honor-group">
        <div class="honor-group-head ${g.cls}">
          <span>${g.title}</span><span class="honor-group-count">${list.length}</span>
        </div>
        ${list.map(honorRowHtml).join('')}
      </div>`;
    }

    el.innerHTML = `
      <button onclick="showPlayerDetail('${String(p.name).replace(/'/g, "\\'")}')" style="margin-bottom:12px;font-size:13px;padding:4px 12px;background:#e2e8f0;border:none;border-radius:4px;cursor:pointer">← 返回选手资料</button>
      <div class="player-stat-card">
        <h3 style="margin:0 0 4px">🏅 ${htmlEsc(p.real_name || p.name)} 的荣誉</h3>
        <div class="honor-summary">
          <span class="honor-chip gold">🏆 冠军 ${sum.gold}</span>
          <span class="honor-chip silver">🥈 亚军 ${sum.silver}</span>
          <span class="honor-chip bronze">🥉 季军 ${sum.bronze}</span>
          <span class="honor-chip total">合计 ${sum.total}</span>
        </div>
        ${body || '<div class="loading" style="padding:24px 0">这位选手还没有获得过前三名</div>'}
      </div>`;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    el.innerHTML = `<div class="card"><div class="loading">加载失败：${htmlEsc(e.message)}</div></div>`;
  }
}

function honorRowHtml(h) {
  const icon = h.tournament_icon
    ? `<img class="honor-row-icon" src="${h.tournament_icon}" alt="">`
    : `<span class="honor-row-icon honor-row-icon-ph">${HONOR_FALLBACK_ICON}</span>`;
  const partner = h.partner_name ? `<span class="honor-partner">搭档 ${htmlEsc(h.partner_name)}</span>` : '';
  return `<div class="honor-row">
    ${icon}
    <div class="honor-row-main">
      <div class="honor-row-title">${htmlEsc(h.tournament_name)} <small>第${h.edition}届</small></div>
      <div class="honor-row-meta">${h.date || ''}${partner ? ' · ' : ''}${partner}</div>
    </div>
    <div class="honor-row-right">
      <span class="honor-tier-badge tier-${h.tier}">${h.tier_icon}${htmlEsc(h.tier_label)}</span>
      <span class="honor-level">L${h.level}</span>
    </div>
  </div>`;
}

async function showPlayerDetail(name) {
  currentViewedPlayer = name;
  const el = document.getElementById('player-result');
  el.innerHTML = '<div class="loading">查询中...</div>';
  try {
    const data = await api(`/api/player/${encodeURIComponent(name)}`);
    const p = data.player, s = data.stats;
    // 荣誉：优先用详情接口随行返回的；老接口没带就补拉一次，保证布局不塌
    let honors = data.honors || null;
    let honorSummary = data.honor_summary || null;
    let topHonor = data.top_honor || null;
    if (!honors) {
      try {
        const hd = await api(`/api/player/${encodeURIComponent(p.name)}/honors`);
        honors = hd.honors; honorSummary = hd.summary; topHonor = pickTopHonorClient(honors);
      } catch (e) { honors = []; honorSummary = { gold: 0, silver: 0, bronze: 0, total: 0 }; }
    }
    if (!honorSummary) honorSummary = summarizeHonorsClient(honors);
    if (!topHonor) topHonor = pickTopHonorClient(honors);
    let html = `<button onclick="loadPlayerQueryList()" style="margin-bottom:12px;font-size:13px;padding:4px 12px;background:#e2e8f0;border:none;border-radius:4px;cursor:pointer">← 返回列表</button>
    <div class="player-stat-card">
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
      ${statModulesHtml(s, honorSummary, topHonor, p.name)}
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

    html += `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3>🤝 主要搭档</h3>
        <button onclick="editPartners(${p.id})" style="font-size:12px;padding:4px 12px">✏️ 设置</button>
      </div>
      <div id="partners-display-${p.id}" style="display:flex;gap:16px;margin-top:8px">
        ${p.partners && p.partners.length ? p.partners.map(partner => `
          <div onclick="showPlayerDetail('${partner.name.replace(/'/g, "\\'")}')" style="cursor:pointer;display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid #e2e8f0;border-radius:8px;transition:box-shadow .2s;flex:1" onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)'" onmouseout="this.style.boxShadow='none'">
            <div>${partner.avatar ? `<img src="${partner.avatar}" style="width:48px;height:48px;border-radius:50%;object-fit:cover">` : `<div style="width:48px;height:48px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:18px;color:#a0aec0">${partner.name[0]}</div>`}</div>
            <div><strong>${displayName(partner)}</strong>${partner.real_name ? `<br><small style="color:#718096;font-size:12px">${partner.name}</small>` : ''}</div>
          </div>
        `).join('') : '<div style="color:#718096;font-size:14px;padding:8px 0">暂无设置主要搭档</div>'}
      </div>
      <div id="partners-edit-${p.id}" style="display:none;margin-top:8px">
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select id="partner1-select-${p.id}" style="flex:1;min-width:150px;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px">
            <option value="">清空</option>
          </select>
          <select id="partner2-select-${p.id}" style="flex:1;min-width:150px;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px">
            <option value="">清空</option>
          </select>
          <select id="partner3-select-${p.id}" style="flex:1;min-width:150px;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px">
            <option value="">清空</option>
          </select>
        </div>
        <div style="margin-top:8px;display:flex;gap:8px">
          <button onclick="savePartners(${p.id})">💾 保存</button>
          <button class="secondary" onclick="cancelEditPartners(${p.id})">取消</button>
        </div>
      </div>
    </div>`;

    // Rivals section
    html += `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3>⚔️ 主要对手</h3>
        <button onclick="editRivals(${p.id})" style="font-size:12px;padding:4px 12px">✏️ 设置</button>
      </div>
      <div id="rivals-display-${p.id}" style="display:flex;gap:16px;margin-top:8px">
        ${p.rivals && p.rivals.length ? p.rivals.map(rival => `
          <div onclick="goToHeadToHead('${p.name.replace(/'/g, "\\'")}','${rival.name.replace(/'/g, "\\'")}')" style="cursor:pointer;display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid #e2e8f0;border-radius:8px;transition:box-shadow .2s;flex:1" onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.12)'" onmouseout="this.style.boxShadow='none'">
            <div>${rival.avatar ? `<img src="${rival.avatar}" style="width:48px;height:48px;border-radius:50%;object-fit:cover">` : `<div style="width:48px;height:48px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:18px;color:#a0aec0">${rival.name[0]}</div>`}</div>
            <div><strong>${displayName(rival)}</strong>${rival.real_name ? `<br><small style="color:#718096;font-size:12px">${rival.name}</small>` : ''}</div>
          </div>
        `).join('') : '<div style="color:#718096;font-size:14px;padding:8px 0">暂无设置主要对手</div>'}
      </div>
      <div id="rivals-edit-${p.id}" style="display:none;margin-top:8px">
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select id="rival1-select-${p.id}" style="flex:1;min-width:150px;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px">
            <option value="">清空</option>
          </select>
          <select id="rival2-select-${p.id}" style="flex:1;min-width:150px;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px">
            <option value="">清空</option>
          </select>
          <select id="rival3-select-${p.id}" style="flex:1;min-width:150px;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px">
            <option value="">清空</option>
          </select>
          <select id="rival4-select-${p.id}" style="flex:1;min-width:150px;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px">
            <option value="">清空</option>
          </select>
          <select id="rival5-select-${p.id}" style="flex:1;min-width:150px;padding:8px 12px;border:1px solid #d2d6dc;border-radius:6px;font-size:14px">
            <option value="">清空</option>
          </select>
        </div>
        <div style="margin-top:8px;display:flex;gap:8px">
          <button onclick="saveRivals(${p.id})">💾 保存</button>
          <button class="secondary" onclick="cancelEditRivals(${p.id})">取消</button>
        </div>
      </div>
    </div>`;

    if (data.points_history.length) {
      html += `<div class="card"><h3>比赛记录</h3><table><thead><tr><th>赛事</th><th>届</th><th>级别</th><th>日期</th><th>排名</th><th>胜/负</th><th>净胜分</th><th>积分</th></tr></thead><tbody>`;
      for (const h of data.points_history) html += `<tr><td>${h.tournament}</td><td>第${h.edition}届</td><td>${h.level || 1000}级</td><td>${h.date}</td><td>第${h.rank}名</td><td>${h.wins}胜 ${h.losses}负</td><td>${h.net_points}</td><td>${h.points_earned}</td></tr>`;
      html += `</tbody></table></div>`;
    } else html += `<div class="card"><div class="loading">暂无比赛记录</div></div>`;
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">${e.message}</div></div>`; }
}

async function editPartners(id) {
  document.getElementById(`partners-display-${id}`).style.display = 'none';
  document.getElementById(`partners-edit-${id}`).style.display = 'block';
  const players = await api('/api/players');
  const s1 = document.getElementById(`partner1-select-${id}`);
  const s2 = document.getElementById(`partner2-select-${id}`);
  const s3 = document.getElementById(`partner3-select-${id}`);
  const opts = players.filter(p => p.id !== id).map(p => `<option value="${p.id}">${displayName(p)}${p.real_name ? ' (' + p.name + ')' : ''}</option>`).join('');
  s1.innerHTML = '<option value="">清空</option>' + opts;
  s2.innerHTML = '<option value="">清空</option>' + opts;
  s3.innerHTML = '<option value="">清空</option>' + opts;
}

async function savePartners(id) {
  const partner1 = document.getElementById(`partner1-select-${id}`).value;
  const partner2 = document.getElementById(`partner2-select-${id}`).value;
  const partner3 = document.getElementById(`partner3-select-${id}`).value;
  try {
    await api(`/api/players/${id}/partners`, {
      method: 'PUT',
      body: JSON.stringify({
        partner1_id: partner1 ? parseInt(partner1) : null,
        partner2_id: partner2 ? parseInt(partner2) : null,
        partner3_id: partner3 ? parseInt(partner3) : null
      })
    });
    await showPlayerDetail(currentViewedPlayer);
  } catch (e) { alert('保存失败: ' + e.message); }
}

async function cancelEditPartners(id) {
  document.getElementById(`partners-display-${id}`).style.display = 'flex';
  document.getElementById(`partners-edit-${id}`).style.display = 'none';
}

async function editRivals(id) {
  document.getElementById(`rivals-display-${id}`).style.display = 'none';
  document.getElementById(`rivals-edit-${id}`).style.display = 'block';
  const players = await api('/api/players');
  const opts = players.filter(p => p.id !== id).map(p => `<option value="${p.id}">${displayName(p)}${p.real_name ? ' (' + p.name + ')' : ''}</option>`).join('');
  document.getElementById(`rival1-select-${id}`).innerHTML = '<option value="">清空</option>' + opts;
  document.getElementById(`rival2-select-${id}`).innerHTML = '<option value="">清空</option>' + opts;
  document.getElementById(`rival3-select-${id}`).innerHTML = '<option value="">清空</option>' + opts;
  document.getElementById(`rival4-select-${id}`).innerHTML = '<option value="">清空</option>' + opts;
  document.getElementById(`rival5-select-${id}`).innerHTML = '<option value="">清空</option>' + opts;
}

async function saveRivals(id) {
  const rival1 = document.getElementById(`rival1-select-${id}`).value;
  const rival2 = document.getElementById(`rival2-select-${id}`).value;
  const rival3 = document.getElementById(`rival3-select-${id}`).value;
  const rival4 = document.getElementById(`rival4-select-${id}`).value;
  const rival5 = document.getElementById(`rival5-select-${id}`).value;
  try {
    await api(`/api/players/${id}/rivals`, {
      method: 'PUT',
      body: JSON.stringify({
        rival1_id: rival1 ? parseInt(rival1) : null,
        rival2_id: rival2 ? parseInt(rival2) : null,
        rival3_id: rival3 ? parseInt(rival3) : null,
        rival4_id: rival4 ? parseInt(rival4) : null,
        rival5_id: rival5 ? parseInt(rival5) : null
      })
    });
    await showPlayerDetail(currentViewedPlayer);
  } catch (e) { alert('保存失败: ' + e.message); }
}

async function cancelEditRivals(id) {
  document.getElementById(`rivals-display-${id}`).style.display = 'flex';
  document.getElementById(`rivals-edit-${id}`).style.display = 'none';
}

function goToHeadToHead(name1, name2) {
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  document.querySelector('[data-tab="headtohead"]').classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-headtohead').classList.add('active');
  document.getElementById('h2h-name1').value = name1;
  document.getElementById('h2h-name2').value = name2;
  queryHeadToHead();
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
    showPlayerDetail(currentViewedPlayer);
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

function goToPlayer(name) {
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  document.querySelector('[data-tab="player-query"]').classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-player-query').classList.add('active');
  showPlayerDetail(name);
}

// ==================== 选手输入联想（对阵查询 / 选手查询共用） ====================
// 数据源用 /api/players（62 人的量级，一次全量拉到内存足够；将来上千再改服务端搜索）。
// 匹配规则：姓名(real_name)、比赛ID(name) 任一命中即可，前缀命中优先。
// 缓存变量 suggestPlayers / suggestLoading 声明在"选手查询"段，见那里的注释。
const suggestState = {};   // inputId -> { items, active }

async function ensureSuggestPlayers() {
  if (suggestPlayers) return suggestPlayers;
  if (!suggestLoading) {
    suggestLoading = api('/api/players')
      .then(list => { suggestPlayers = list; return list; })
      .catch(() => { suggestPlayers = []; return []; })
      .finally(() => { suggestLoading = null; });
  }
  return suggestLoading;
}

// 把命中片段包一层高亮；输入先转义再拼接，避免 XSS
function hl(text, q) {
  const t = String(text == null ? '' : text);
  if (!q) return htmlEsc(t);
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return htmlEsc(t);
  return htmlEsc(t.slice(0, i)) +
    `<span class="ac-hl">${htmlEsc(t.slice(i, i + q.length))}</span>` +
    htmlEsc(t.slice(i + q.length));
}

function matchPlayers(q) {
  const all = suggestPlayers || [];
  const k = q.trim().toLowerCase();
  if (!k) {
    // 空输入：按姓名排序给前 20 个，方便直接挑
    return all.slice(0, 20);
  }
  const starts = [], contains = [];
  for (const p of all) {
    const real = String(p.real_name || '').toLowerCase();
    const name = String(p.name || '').toLowerCase();
    const s = real.startsWith(k) || name.startsWith(k);
    if (s) starts.push(p);
    else if (real.includes(k) || name.includes(k)) contains.push(p);
  }
  // 前缀命中排在包含命中之前
  return starts.concat(contains).slice(0, 20);
}

async function onPlayerSuggest(inputId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById('ac-' + inputId);
  if (!input || !list) return;
  await ensureSuggestPlayers();

  const q = input.value;
  const items = matchPlayers(q);
  suggestState[inputId] = { items, active: -1 };

  if (!items.length) {
    list.innerHTML = `<div class="ac-empty">没找到匹配的选手</div>`;
    list.classList.add('open');
    return;
  }
  list.innerHTML = items.map((p, i) => {
    const real = p.real_name || '';
    const dn = displayName(p);
    // 姓名 + 比赛ID：有备注名时两者都显示，没有时只显示ID（此时二者相同，不重复展示）
    const namePart = hl(dn, q);
    const idPart = real && real !== p.name ? `<span class="ac-id">${hl(p.name, q)}</span>` : '';
    return `<div class="ac-item" data-i="${i}" onmousedown="pickPlayerSuggest(event, '${inputId}', ${i})">
      <span class="ac-name">${namePart}</span>${idPart}</div>`;
  }).join('');
  list.classList.add('open');
}

function pickPlayerSuggest(ev, inputId, idx) {
  ev.preventDefault();   // 防止 blur 先触发导致列表提前关闭
  const st = suggestState[inputId];
  if (!st || !st.items[idx]) return;
  const p = st.items[idx];
  const input = document.getElementById(inputId);
  // 回填比赛ID：服务端按 name 或 real_name 都能查到，但 name 唯一、最稳妥
  input.value = p.name;
  closePlayerSuggest(inputId);
}

function closePlayerSuggest(inputId) {
  const list = document.getElementById('ac-' + inputId);
  if (list) list.classList.remove('open');
  if (suggestState[inputId]) suggestState[inputId].active = -1;
}

function isSuggestOpen(inputId) {
  const list = document.getElementById('ac-' + inputId);
  return !!(list && list.classList.contains('open'));
}

// 键盘上下键选择、Enter 确认、Esc 关闭。
// 返回 true 表示这次按键已被联想逻辑消费，外层不应再执行默认动作（如提交查询）。
function onPlayerSuggestKey(ev, inputId) {
  const st = suggestState[inputId];
  const list = document.getElementById('ac-' + inputId);
  if (!list || !list.classList.contains('open') || !st || !st.items.length) return false;
  const n = st.items.length;
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    st.active = (st.active + 1) % n;
    paintActive(inputId);
    return true;
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    st.active = (st.active - 1 + n) % n;
    paintActive(inputId);
    return true;
  } else if (ev.key === 'Enter') {
    // 没手动选中任何一个时，默认取第一条 —— 避免"列表开着但 Enter 没反应"
    const idx = st.active >= 0 ? st.active : 0;
    ev.preventDefault();
    pickPlayerSuggest(ev, inputId, idx);
    return true;
  } else if (ev.key === 'Escape') {
    closePlayerSuggest(inputId);
    return true;
  }
  return false;
}

function paintActive(inputId) {
  const st = suggestState[inputId];
  const list = document.getElementById('ac-' + inputId);
  if (!list || !st) return;
  list.querySelectorAll('.ac-item').forEach((el, i) => el.classList.toggle('active', i === st.active));
  const cur = list.querySelector('.ac-item.active');
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

// 点击页面空白处收起下拉
document.addEventListener('click', e => {
  for (const id of Object.keys(suggestState)) {
    const wrap = document.getElementById('ac-' + id);
    if (wrap && !wrap.contains(e.target) && e.target.id !== id) closePlayerSuggest(id);
  }
});

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
    const esc = n => n.replace(/'/g, "\\'");
    function avatarHtml(p, size) {
      const inner = p.avatar ? `<img src="${p.avatar}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block;margin:0 auto 6px">` : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.35)}px;color:#a0aec0;margin:0 auto 6px;cursor:pointer" onclick="goToPlayer('${esc(p.name)}')">${p.name[0]}</div>`;
      if (p.avatar) return `<a href="#" onclick="goToPlayer('${esc(p.name)}');return false" style="text-decoration:none;display:block">${inner}</a>`;
      return inner;
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

// ==================== 创建赛事（新版赛事引擎 UI） ====================
//
// 两层结构，和后端一一对应：
//   · 管理端「➕ 创建赛事」只定义「赛制」：类型、赛制、局制、团体项目与出场顺序、
//     小组配置、季军赛。赛事本身可以办很多届，不带日期 / 级别 / 参赛名单。
//   · 某一届的日期、级别、参赛名单在「比赛管理」里录入，录完就在那儿生成对阵、录比分。
//
// 工作台（小组积分榜 / 淘汰签表 / 逐局录分）三个入口共用同一套渲染，差别只有两点：
//   EVS.host    决定渲染进哪个容器（创建赛事页 / 比赛管理页 / 前台赛事查询弹层）
//   EVS.readonly 决定有没有操作按钮 —— 前台只读，管理端可生成对阵 / 排阵 / 录分 / 调签表。
// 这样「赛事结果给普通用户看」不需要再写一套页面，也不会出现两处数字不一致。

const TEAM_ITEM_DEFS = [
  { code: 'ms', name: '男单', size: 1, gender: 'male' },
  { code: 'ws', name: '女单', size: 1, gender: 'female' },
  { code: 'md', name: '男双', size: 2, gender: 'male' },
  { code: 'wd', name: '女双', size: 2, gender: 'female' },
  { code: 'xd', name: '混双', size: 2, gender: 'mixed' }
];
const TEAM_ITEM_MAP = Object.fromEntries(TEAM_ITEM_DEFS.map(d => [d.code, d]));

// 赛制三选一
const EVENT_FORMAT_DEFS = [
  { code: 'rr', name: '单循环赛', hasGroup: true },
  { code: 'ko', name: '淘汰赛', hasGroup: false },
  { code: 'group_ko', name: '小组赛+淘汰赛', hasGroup: true }
];
const EVENT_FORMAT_MAP = Object.fromEntries(EVENT_FORMAT_DEFS.map(f => [f.code, f]));
const EVENT_BEST_OF_DEFS = [{ n: 1, name: '一局定胜负' }, { n: 3, name: '三局两胜' }];

// 种子排序依据：只影响「蛇形分组的先后」和「纯淘汰赛的落位」，不影响任何比分计算。
const SEED_BY_DEFS = [
  { code: 'entry', name: '按录入顺序', hint: '你录名单的先后就是种子顺序' },
  { code: 'points', name: '按总积分（种子）', hint: '按参赛选手 / 队伍成员的总积分之和降序，强队/高分选手分散到各组' }
];
const SEED_BY_MAP = Object.fromEntries(SEED_BY_DEFS.map(d => [d.code, d]));
const seedByLabel = s => (SEED_BY_MAP[s] || SEED_BY_DEFS[0]).name;

// 分组方式
const GROUP_MODE_DEFS = [
  { code: 'snake', name: '自动蛇形分组', hint: '按种子顺序蛇形分配，各组实力尽量均匀' },
  { code: 'manual', name: '手动指定分组', hint: '录完名单后你自己把每个单元放进指定小组（可安排种子）' }
];
const GROUP_MODE_MAP = Object.fromEntries(GROUP_MODE_DEFS.map(d => [d.code, d]));
const groupModeLabel = s => (GROUP_MODE_MAP[s] || GROUP_MODE_DEFS[0]).name;

// 淘汰赛对阵方式
const KO_MODE_DEFS = [
  { code: 'seed', name: '固定交叉（种子位）', hint: 'A1 打 B2、B1 打 A2 —— 小组第一不会在首轮相遇' },
  { code: 'random', name: '随机抽签', hint: '出线者随机落位，可能同组相遇' },
  { code: 'random_avoid', name: '随机 + 首轮回避同组', hint: '随机落位，但强制同组出线的两人不在首轮碰面' }
];
const KO_MODE_MAP = Object.fromEntries(KO_MODE_DEFS.map(d => [d.code, d]));
const koModeLabel = s => (KO_MODE_MAP[s] || KO_MODE_DEFS[0]).name;

const EVS = {
  list: [],
  detail: null,          // 某一届的完整数据（工作台用）
  expanded: null,        // 展开录入的 tieId
  pick: null,            // 签表待交换的位置 {ko_round, slot, side}
  canSwap: false,        // 淘汰赛是否还没开打（只有没开打才允许调签表）
  readonly: false,
  host: 'events',        // events | match | query —— 工作台渲染进哪个容器
  editingId: null,       // 正在改赛制的赛事 id（null = 新建）
  showTies: false,       // 前台只读：对阵默认折叠，点「查看比赛详情」才展开
  draft: {
    name: '', kind: 'individual', format: 'rr', bestOf: 3,
    thirdPlace: false, groupCount: 2, advancePerGroup: 1,
    seedBy: 'entry', groupMode: 'snake', koMode: 'seed',
    items: ['ms', 'ws', 'md']
  }
};

let evPidGender = {};   // player_id -> gender，排阵时按项目筛人用

const evKindLabel = k => k === 'team' ? '团体赛' : '单项赛';
// 「参赛单元」是内部概念，界面上按赛事类型说人话：单项赛就是选手本人，只有团体赛才多一层队伍 / 队员
const evEntryNoun = k => k === 'team' ? '参赛队伍' : '参赛选手';
const evEntryUnit = k => k === 'team' ? '支' : '位';
// 团体赛的队员名单折在最终排名里，不单独占一列
function evMemberCellHtml(memberIds) {
  const ids = memberIds || [];
  if (!ids.length) return '<td style="color:#a0aec0">—</td>';
  return `<td><details class="ev-roster"><summary>👥 ${ids.length} 人</summary>
    <div class="ev-roster-body">${ids.map(id => htmlEsc(pn(id))).join('、')}</div></details></td>`;
}
const evFormatLabel = f => (EVENT_FORMAT_MAP[f] || { name: f }).name;
const evBestOfLabel = n => (parseInt(n) === 1 ? '一局定胜负' : '三局两胜');
const evFormatHasGroup = f => !!(EVENT_FORMAT_MAP[f] || EVENT_FORMAT_MAP.rr).hasGroup;
const evStatusLabel = s => s === 'done' ? '已结束' : s === 'draft' ? '未生成对阵' : '进行中';
const evGenderOf = pid => evPidGender[pid] || '';
// 一个单项要赢几局：一局制 1 局，三局制 2 局
const evGameNeed = bestOf => Math.floor((parseInt(bestOf) || 3) / 2) + 1;

async function initEventPage() {
  document.getElementById('event-page').innerHTML = '<div class="loading">加载中...</div>';
  await ensurePlayers();
  await evRenderList();
}

async function evRenderList() {
  await ensurePlayers();
  try { EVS.list = await api('/api/events'); } catch (e) { EVS.list = []; }
  document.getElementById('event-page').innerHTML = evFormHtml() + evEventListHtml();
}

// ---------------- 赛制表单（只有赛制，没有日期 / 级别 / 名单） ----------------

function evPlayerOpts(selected) {
  return '<option value="">选择选手</option>' + cachedPlayers
    .slice().sort((a, b) => displayName(a).localeCompare(displayName(b), 'zh'))
    .map(p => `<option value="${p.id}" ${String(selected) === String(p.id) ? 'selected' : ''}>${htmlEsc(displayName(p))}（${p.gender === 'male' ? '男' : '女'}）</option>`)
    .join('');
}

function evItemPoolInner() {
  const d = EVS.draft;
  const chosen = d.items.map((c, i) => `<span class="ev-order-chip"><span class="ev-idx">${i + 1}</span>${TEAM_ITEM_MAP[c].name}
    <button class="ev-mini" onclick="evMoveItem('${c}',-1)" title="上移">↑</button>
    <button class="ev-mini" onclick="evMoveItem('${c}',1)" title="下移">↓</button>
    <button class="ev-mini danger" onclick="evToggleItem('${c}')" title="移除">✕</button></span>`).join('');
  const avail = TEAM_ITEM_DEFS.filter(x => !d.items.includes(x.code))
    .map(x => `<button class="ev-mini ev-add-item" onclick="evToggleItem('${x.code}')">＋ ${x.name}</button>`).join('');
  return (chosen || '<span class="ev-empty">还没勾选项目</span>') + avail;
}

function evFormHtml() {
  const d = EVS.draft;
  const isTeam = d.kind === 'team';
  const editing = !!EVS.editingId;
  return `<div class="card">
    <h3>${editing ? '✏️ 修改赛制' : '➕ 新建赛事'}</h3>
    <div class="ev-hint" style="margin-bottom:10px">
      这里只定义「怎么打」；每一届的日期、级别和参赛名单在「比赛管理」里录入。
    </div>
    <div class="form-row">
      <input type="text" id="ev-name" placeholder="赛事名称，例如：秋季团体赛" value="${htmlEsc(d.name)}"
             oninput="EVS.draft.name=this.value">
    </div>

    <div class="ev-sec">
      <div class="ev-sec-title">赛事类型</div>
      <div class="ev-radios">
        <label class="ev-radio ${!isTeam ? 'on' : ''}"><input type="radio" name="ev-kind" ${!isTeam ? 'checked' : ''} onchange="evSetKind('individual')">单项赛（按选手报名）</label>
        <label class="ev-radio ${isTeam ? 'on' : ''}"><input type="radio" name="ev-kind" ${isTeam ? 'checked' : ''} onchange="evSetKind('team')">团体赛（按队伍报名）</label>
      </div>
    </div>

    <div class="ev-sec">
      <div class="ev-sec-title">赛制</div>
      <div class="ev-radios">
        ${EVENT_FORMAT_DEFS.map(f => `<label class="ev-radio ${d.format === f.code ? 'on' : ''}">
          <input type="radio" name="ev-format" ${d.format === f.code ? 'checked' : ''} onchange="evSetFormat('${f.code}')">${f.name}</label>`).join('')}
      </div>
    </div>

    <div class="ev-sec">
      <div class="ev-sec-title">局制 <span class="ev-hint">每个单项打几局定胜负</span></div>
      <div class="ev-radios">
        ${EVENT_BEST_OF_DEFS.map(b => `<label class="ev-radio ${d.bestOf === b.n ? 'on' : ''}">
          <input type="radio" name="ev-bo" ${d.bestOf === b.n ? 'checked' : ''} onchange="evSetBestOf(${b.n})">${b.name}</label>`).join('')}
      </div>
    </div>

    ${isTeam ? `<div class="ev-sec">
      <div class="ev-sec-title">团体项目与出场顺序
        <span class="ev-hint">按顺序对位开打；一方先赢下「多数项」即结束本场，剩余项自动标记「未进行」</span></div>
      <div class="ev-order-list" id="ev-item-pool">${evItemPoolInner()}</div>
    </div>` : ''}

    ${evFormatHasGroup(d.format) ? `<div class="ev-sec">
      <div class="ev-sec-title">小组配置
        <span class="ev-hint">${d.format === 'rr' ? '分成几组各自单循环，最后按各组名次排总名次；1 组 = 全员大循环' : '小组循环后按名次出线打淘汰赛'}</span></div>
      <div class="form-row">
        <label style="font-size:14px;color:#4a5568">小组数</label>
        <input type="number" id="ev-gc" min="1" value="${d.groupCount}" oninput="EVS.draft.groupCount=parseInt(this.value)||1" style="max-width:100px">
        ${d.format === 'group_ko' ? `<label style="font-size:14px;color:#4a5568">每组出线</label>
        <input type="number" id="ev-apg" min="1" value="${d.advancePerGroup}" oninput="EVS.draft.advancePerGroup=parseInt(this.value)||1" style="max-width:100px">` : ''}
      </div>
    </div>` : ''}

    <div class="ev-sec">
      <div class="ev-sec-title">种子依据 <span class="ev-hint">${SEED_BY_MAP[d.seedBy].hint}</span></div>
      <div class="ev-radios">
        ${SEED_BY_DEFS.map(s => `<label class="ev-radio ${d.seedBy === s.code ? 'on' : ''}">
          <input type="radio" name="ev-seedby" ${d.seedBy === s.code ? 'checked' : ''} onchange="EVS.draft.seedBy='${s.code}';evRenderList()">${s.name}</label>`).join('')}
      </div>
    </div>

    ${evFormatHasGroup(d.format) ? `<div class="ev-sec">
      <div class="ev-sec-title">分组方式 <span class="ev-hint">${GROUP_MODE_MAP[d.groupMode].hint}</span></div>
      <div class="ev-radios">
        ${GROUP_MODE_DEFS.map(g => `<label class="ev-radio ${d.groupMode === g.code ? 'on' : ''}">
          <input type="radio" name="ev-gmode" ${d.groupMode === g.code ? 'checked' : ''} onchange="EVS.draft.groupMode='${g.code}';evRenderList()">${g.name}</label>`).join('')}
      </div>
    </div>` : ''}

    ${d.format !== 'rr' ? `<div class="ev-sec">
      <div class="ev-sec-title">淘汰赛对阵方式 <span class="ev-hint">${KO_MODE_MAP[d.koMode].hint}</span></div>
      <div class="ev-radios">
        ${KO_MODE_DEFS.map(k => `<label class="ev-radio ${d.koMode === k.code ? 'on' : ''}">
          <input type="radio" name="ev-komode" ${d.koMode === k.code ? 'checked' : ''} onchange="EVS.draft.koMode='${k.code}';evRenderList()">${k.name}</label>`).join('')}
      </div>
    </div>

    <div class="ev-sec">
      <label class="ev-radio ${d.thirdPlace ? 'on' : ''}"><input type="checkbox" ${d.thirdPlace ? 'checked' : ''}
        onchange="EVS.draft.thirdPlace=this.checked;evRenderList()">设置季军赛</label>
    </div>` : ''}

    <div class="form-row" style="margin-top:18px">
      <button onclick="${editing ? 'evSaveConfig()' : 'evCreate()'}">✅ ${editing ? '保存赛制' : '创建赛事'}</button>
      ${editing ? `<button class="secondary" onclick="evCancelEdit()">取消</button>`
      : `<button class="secondary" onclick="evResetDraft()">重置</button>`}
      <span id="ev-create-msg" style="font-size:13px"></span>
    </div>
  </div>`;
}

function evSetKind(k) { EVS.draft.kind = k; evRenderList(); }
function evSetBestOf(n) { EVS.draft.bestOf = parseInt(n) || 3; evRenderList(); }
function evSetFormat(f) {
  EVS.draft.format = f;
  if (f === 'rr') EVS.draft.thirdPlace = false;
  evRenderList();
}
function evToggleItem(code) {
  const d = EVS.draft;
  const i = d.items.indexOf(code);
  if (i >= 0) d.items.splice(i, 1); else d.items.push(code);
  const el = document.getElementById('ev-item-pool');
  if (el) el.innerHTML = evItemPoolInner(); else evRenderList();
}
function evMoveItem(code, dir) {
  const d = EVS.draft;
  const i = d.items.indexOf(code), j = i + dir;
  if (i < 0 || j < 0 || j >= d.items.length) return;
  [d.items[i], d.items[j]] = [d.items[j], d.items[i]];
  const el = document.getElementById('ev-item-pool');
  if (el) el.innerHTML = evItemPoolInner(); else evRenderList();
}

function evDraftDefaults() {
  return {
    name: '', kind: 'individual', format: 'rr', bestOf: 3,
    thirdPlace: false, groupCount: 2, advancePerGroup: 1,
    seedBy: 'entry', groupMode: 'snake', koMode: 'seed',
    items: ['ms', 'ws', 'md']
  };
}
function evResetDraft() {
  EVS.draft = evDraftDefaults();
  evRenderList();
}
function evResetDraftSilent() {
  EVS.draft = evDraftDefaults();
}

function evCollectForm() {
  const d = EVS.draft;
  const gcEl = document.getElementById('ev-gc'), apgEl = document.getElementById('ev-apg');
  return {
    name: (document.getElementById('ev-name').value || '').trim(),
    kind: d.kind, format: d.format, best_of: d.bestOf,
    third_place: !!d.thirdPlace,
    group_count: gcEl ? (parseInt(gcEl.value) || 1) : 0,
    advance_per_group: apgEl ? (parseInt(apgEl.value) || 1) : 0,
    seed_by: d.seedBy, group_mode: d.groupMode, ko_mode: d.koMode,
    items: d.items.slice()
  };
}

async function evCreate() {
  const msg = document.getElementById('ev-create-msg');
  const fail = t => { msg.style.color = '#e53e3e'; msg.textContent = t; };
  const body = evCollectForm();
  if (!body.name) return fail('请填写赛事名称');
  if (body.kind === 'team' && body.items.length === 0) return fail('请至少勾选一个团体项目');
  if (body.kind === 'team' && body.items.length % 2 === 0) return fail('团体项目数需为奇数，否则会出现无法分胜负的平局');
  try {
    msg.style.color = '#718096'; msg.textContent = '创建中...';
    await api('/api/events', { method: 'POST', body: JSON.stringify(body) });
    evResetDraftSilent();
    EVS.editingId = null;
    await evRenderList();
    msg.style.color = '#38a169';
    msg.textContent = '✅ 已创建。去「比赛管理」选这个赛事，录第 1 届的日期与参赛名单。';
  } catch (e) { fail(e.message); }
}

async function evSaveConfig() {
  const msg = document.getElementById('ev-create-msg');
  const fail = t => { msg.style.color = '#e53e3e'; msg.textContent = t; };
  const body = evCollectForm();
  if (!body.name) return fail('请填写赛事名称');
  if (body.kind === 'team' && body.items.length === 0) return fail('请至少勾选一个团体项目');
  if (body.kind === 'team' && body.items.length % 2 === 0) return fail('团体项目数需为奇数，否则会出现无法分胜负的平局');
  try {
    msg.style.color = '#718096'; msg.textContent = '保存中...';
    await api('/api/events/' + EVS.editingId + '/config', { method: 'PUT', body: JSON.stringify(body) });
    EVS.editingId = null;
    await evRenderList();
    const m2 = document.getElementById('ev-create-msg');
    if (m2) { m2.style.color = '#38a169'; m2.textContent = '✅ 赛制已保存，对所有届次生效'; }
  } catch (e) { fail(e.message); }
}

async function evEditEvent(id) {
  const e = EVS.list.find(x => x.id === id);
  if (!e) return;
  let items = ['ms', 'ws', 'md'];
  try {
    const d = await api('/api/events/' + id);
    items = d.items.map(i => i.code);
  } catch (err) { /* 取不到就沿用默认 */ }
  EVS.editingId = id;
  EVS.draft = {
    name: e.name, kind: e.kind, format: e.format, bestOf: e.best_of || 3,
    thirdPlace: !!e.third_place, groupCount: e.group_count || 1,
    advancePerGroup: e.advance_per_group || 1, items,
    seedBy: e.seed_by || 'entry', groupMode: e.group_mode || 'snake', koMode: e.ko_mode || 'seed'
  };
  await evRenderList();
  document.getElementById('event-page').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function evCancelEdit() {
  EVS.editingId = null;
  evResetDraftSilent();
  await evRenderList();
}

// ---------------- 赛事定义列表 ----------------

function evEventSummary(e) {
  const bits = [evKindLabel(e.kind), evFormatLabel(e.format), evBestOfLabel(e.best_of)];
  if (e.kind === 'team' && e.item_count) bits.push(`${e.item_count} 项`);
  if (evFormatHasGroup(e.format)) bits.push(`${e.group_count || 1} 组 · ${groupModeLabel(e.group_mode)}`);
  if (e.format === 'group_ko') bits.push(`每组出线 ${e.advance_per_group || 1}`);
  if (e.format !== 'rr') bits.push(koModeLabel(e.ko_mode));
  bits.push(`种子：${seedByLabel(e.seed_by)}`);
  if (e.third_place) bits.push('季军赛');
  return bits.join(' · ');
}

function evEventListHtml() {
  if (!EVS.list.length) return `<div class="card"><h3>已有赛事</h3><div class="ev-empty">还没有创建过赛事</div></div>`;
  const rows = EVS.list.map(e => `<div class="ev-card-row">
    <div class="ev-card-main" onclick="evToggleEvent(${e.id})">
      <div class="ev-card-name">${htmlEsc(e.name)}
        <span class="ev-tag ${e.kind}">${evKindLabel(e.kind)}</span>
        <span class="ev-tag">${evFormatLabel(e.format)}</span>
        <span class="ev-hint" style="margin-left:6px">${evBestOfLabel(e.best_of)}</span>
      </div>
      <div class="ev-card-meta">
        <span>${htmlEsc(evEventSummary(e))}</span>
        <span>已办 ${e.edition_count} 届</span>
      </div>
    </div>
    <div class="ev-card-actions">
      <button onclick="evEditEvent(${e.id})">✏️ 改赛制</button>
      <button class="danger" onclick="evDelete(${e.id})">删除</button>
    </div>
    <div class="ev-editions" id="ev-editions-${e.id}" style="display:none"></div>
  </div>`).join('');
  return `<div class="card"><h3>已有赛事（${EVS.list.length}）<span class="ev-hint">点名称展开历届</span></h3>${rows}</div>`;
}

async function evToggleEvent(id) {
  const box = document.getElementById('ev-editions-' + id);
  if (!box) return;
  if (box.style.display === 'block') { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.innerHTML = '<div class="loading">加载中...</div>';
  box.style.display = 'block';
  try {
    const d = await api('/api/events/' + id);
    if (!d.editions.length) {
      box.innerHTML = `<div class="ev-empty">还没有办过。到「比赛管理」选这个赛事，录第 1 届。</div>`;
      return;
    }
    box.innerHTML = d.editions.map(e => `<div class="ev-edition-row" onclick="evOpenEdition(${e.id},'events')">
      <span>第 ${e.edition} 届</span>
      <span>${e.date || '—'}</span>
      <span>${e.level}级</span>
      <span>${e.entry_count} ${evEntryUnit(d.event.kind)}${evEntryNoun(d.event.kind)}</span>
      <span class="ev-tag ${e.status === 'done' ? 'done' : 'draft'}">${evStatusLabel(e.status)}</span>
      ${e.tie_count ? `<span style="color:#718096">${e.done_count}/${e.tie_count} 场已打</span>` : ''}
    </div>`).join('');
  } catch (err) { box.innerHTML = `<div class="ev-empty" style="color:#e53e3e">加载失败：${err.message}</div>`; }
}

async function evDelete(id) {
  const e = EVS.list.find(x => x.id === id);
  if (!confirm(`确定删除赛事「${e ? e.name : id}」？\n它的所有届次、对阵、比分会被一并清除，并从积分榜与赛事查询里消失。`)) return;
  try {
    await api('/api/events/' + id, { method: 'DELETE' });
    cachedPlayers = [];          // 届数/积分都变了，让缓存失效
    invalidatePlayerQueryCache();
    EVS.detail = null;
    if (EVS.editingId === id) { EVS.editingId = null; evResetDraftSilent(); }
    await evRenderList();
  } catch (e2) { alert('删除失败: ' + e2.message); }
}

// ---------------- 工作台（某一届） ----------------

async function evOpenEdition(edId, host) {
  EVS.host = host || 'events';
  EVS.readonly = (EVS.host === 'query');
  EVS.expanded = null; EVS.pick = null; EVS.showTies = false;
  evSetWorkspaceHost('loading');
  await ensurePlayers();
  try {
    EVS.detail = await api('/api/editions/' + edId);
    evRenderWorkspace();
  } catch (e) {
    const el = evWorkspaceEl();
    if (el) el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">加载失败: ${e.message}</div></div>`;
  }
}

function evWorkspaceEl() {
  if (EVS.host === 'match') return document.getElementById('ev-workspace-match');
  if (EVS.host === 'query') return document.getElementById('tour-detail-body');
  return document.getElementById('event-page');
}
function evSetWorkspaceHost(kind) {
  const el = evWorkspaceEl();
  if (kind === 'loading' && el) el.innerHTML = '<div class="loading">加载中...</div>';
  if (EVS.host === 'match') {
    // 比赛管理：工作台与「本届设置」卡互斥显示
    document.getElementById('ev-edition-card').style.display = 'none';
    document.getElementById('ev-workspace-match').style.display = 'block';
  }
}

async function evReload() {
  const id = EVS.detail.edition.id;
  EVS.detail = await api('/api/editions/' + id);
  evRenderWorkspace();
}

function evRenderWorkspace() {
  const html = evWorkspaceHtml(!EVS.readonly);
  const el = evWorkspaceEl();
  if (el) el.innerHTML = html;
}

function evBack() {
  if (EVS.host === 'match') { mEvBack(); return; }
  if (EVS.host === 'query') { closeTourDetail(); return; }
  evRenderList();
}

// 前台「赛事查询」点赛事图标时走这里（只读）。
// editionNo 不传就看最近一届。
async function showEventDetail(eventId, editionNo) {
  EVS.host = 'query'; EVS.readonly = true; EVS.expanded = null; EVS.pick = null; EVS.showTies = false;
  const el = document.getElementById('tour-detail-body');
  if (el) el.innerHTML = '<div class="loading">加载中...</div>';
  try {
    await ensurePlayers();
    const d = await api('/api/events/' + eventId);
    if (!d.editions.length) {
      if (el) el.innerHTML = '<div class="card"><div class="loading">该赛事还没有任何一届的赛况</div></div>';
      return;
    }
    const want = d.editions.find(e => String(e.edition) === String(editionNo));
    const target = want || d.editions[0];
    EVS.detail = await api('/api/editions/' + target.id);
    evRenderWorkspace();
  } catch (e) {
    if (el) el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">加载失败: ${e.message}</div></div>`;
  }
}

async function evGenGroups(edId) {
  const has = EVS.detail && EVS.detail.ties.some(t => t.stage === 'group');
  if (has && !confirm('重新生成小组对阵？\n所有小组赛比分会被清空（淘汰赛也一并重置）。')) return;
  try {
    await api(`/api/editions/${edId}/generate-groups`, { method: 'POST', body: '{}' });
    EVS.expanded = null;
    await evReload();
  } catch (e) { alert('生成失败: ' + e.message); }
}

async function evGenKO(edId) {
  const has = EVS.detail && EVS.detail.ties.some(t => t.stage === 'ko');
  if (has && !confirm('重新生成淘汰签表？\n现有淘汰赛比分会被清空。')) return;
  try {
    await api(`/api/editions/${edId}/generate-ko`, { method: 'POST', body: '{}' });
    EVS.expanded = null;
    await evReload();
  } catch (e) { alert('生成失败: ' + e.message); }
}

function evEntryLabel(d, id) {
  if (!id) return '';
  const e = d.entries.find(x => x.id === id);
  return e ? e.label : ('#' + id);
}

function evWorkspaceHtml(withHead) {
  const d = EVS.detail;
  if (!d) return '';
  const ev = d.event, ed = d.edition, ro = EVS.readonly;
  const koTies = d.ties.filter(t => t.stage === 'ko');
  EVS.canSwap = koTies.length > 0 && !d.ties.some(t => (t.stage === 'ko' || t.stage === 'third') && t.winner_entry_id);

  let h = '';
  if (withHead) {
    h += `<div class="ev-head">
      <button class="back-btn" onclick="evBack()"><span class="back-arrow"></span>返回</button>
      <h2>${htmlEsc(ev.name)} <span style="font-size:16px;color:#718096">第 ${ed.edition} 届</span></h2>
      <span class="ev-tag ${ev.kind}">${evKindLabel(ev.kind)}</span>
      <span class="ev-tag">${evFormatLabel(ev.format)}</span>
      <span class="ev-tag">${evBestOfLabel(ev.best_of)}</span>
      <span class="ev-tag ${ed.status === 'done' ? 'done' : 'draft'}">${evStatusLabel(ed.status)}</span>
      <div class="ev-head-actions">
        ${evFormatHasGroup(ev.format) ? `<button onclick="evGenGroups(${ed.id})">🎲 ${d.ties.some(t => t.stage === 'group') ? '重新生成' : '生成'}循环对阵</button>` : ''}
        ${ev.format !== 'rr' ? `<button onclick="evGenKO(${ed.id})">🏆 ${koTies.length ? '重新生成' : '生成'}淘汰签表</button>` : ''}
      </div>
    </div>`;
  }

  h += evBriefHtml(d, ro);
  if (ro) {
    // 前台只读：和老赛事卡片一个样式 —— 默认只给「最终排名（含积分）」，
    // 小组积分榜 + 逐场对阵全部折进「查看比赛详情」，别一进来就把所有比分摊开。
    // 唯一例外：还没打出名次（小组赛进行中）时，积分榜是唯一有信息量的东西，先给出来。
    const hasFinal = d.final_ranks.length > 0;
    h += hasFinal ? evFinalHtml(d) : evGroupSectionHtml(d, ro, 'standings');
    if (!hasFinal && !Object.keys(d.standings).length) {
      h += `<div class="card"><div class="ev-empty">该赛事还没有赛况</div></div>`;
      return h;
    }
    h += `<button class="ev-detail-toggle" onclick="evToggleTies()">📊 ${EVS.showTies ? '收起比赛详情' : '查看比赛详情'}</button>`;
    if (EVS.showTies) {
      // 有总排名时积分榜也被折起来了，展开要一起给回来
      if (hasFinal) h += evGroupSectionHtml(d, ro, 'standings');
      h += evGroupSectionHtml(d, ro, 'ties') + evKOSectionHtml(d, ro, 'ties');
    }
    return h;
  }
  const groupHtml = evGroupSectionHtml(d, ro);
  const koHtml = evKOSectionHtml(d, ro);
  if (!groupHtml && !koHtml) {
    h += `<div class="card"><div class="ev-empty">还没有对阵。先点右上角「生成循环对阵」或「生成淘汰签表」。</div></div>`;
  }
  h += groupHtml + koHtml;
  h += evFinalHtml(d);
  return h;
}

function evToggleTies() { EVS.showTies = !EVS.showTies; evRenderWorkspace(); }

function evBriefHtml(d, ro) {
  const ev = d.event, ed = d.edition;
  const items = d.items.map(i => i.name).join(' / ');
  return `<div class="card"><h3>本届概览</h3>
    <div class="ev-brief">
      <div>赛事名称：<b>${htmlEsc(ev.name)}</b>　届次：<b>第 ${ed.edition} 届</b>　日期：<b>${ed.date || '—'}</b>　级别：<b>${ed.level}级</b></div>
      <div>类型：<b>${evKindLabel(ev.kind)}</b>　赛制：<b>${evFormatLabel(ev.format)}</b>　局制：<b>${evBestOfLabel(ev.best_of)}</b>
        ${evFormatHasGroup(ev.format) ? `　小组数：<b>${ev.group_count}</b>（${groupModeLabel(ev.group_mode)}）` : ''}
        ${ev.format === 'group_ko' ? `　每组出线：<b>${ev.advance_per_group}</b>` : ''}
        ${ev.third_place ? '　<b>设季军赛</b>' : ''}</div>
      <div>种子依据：<b>${seedByLabel(ev.seed_by)}</b>${ev.format !== 'rr' ? `　淘汰对阵：<b>${koModeLabel(ev.ko_mode)}</b>` : ''}</div>
      ${ev.kind === 'team' ? `<div>团体项目（按出场顺序）：<b>${htmlEsc(items)}</b></div>` : ''}
      <div>${evEntryNoun(ev.kind)}：<b>${d.entries.length}</b> ${evEntryUnit(ev.kind)}　
        <span style="color:#a0aec0;font-size:13px">${d.entries.map(e => htmlEsc(e.label)).join('、')}</span></div>
    </div></div>`;
}

// part：undefined/'both' 全渲染 | 'standings' 只积分榜（前台只读默认）| 'ties' 只对阵
function evGroupSectionHtml(d, ro, part) {
  const gn = Object.keys(d.standings).map(Number).sort((a, b) => a - b);
  if (!gn.length) return '';
  const adv = d.event.format === 'group_ko' ? (d.event.advance_per_group || 0) : 0;
  let h = '<div class="card"><h3>小组积分榜</h3>';
  for (const g of gn) {
    const list = d.standings[g];
    if (part !== 'ties') {
      h += `<div class="ev-group"><div class="ev-group-title">第 ${g} 组</div>
        <div class="ev-standings"><table><thead><tr>
          <th class="ev-rank-cell">名次</th><th>${evEntryNoun(d.event.kind)}</th><th>大场胜</th><th>大场负</th>
          <th>净胜大场</th><th>净胜局</th><th>净胜分</th></tr></thead><tbody>`;
      for (const r of list) {
        const q = adv && r.rank <= adv;
        h += `<tr class="${q ? 'qualify' : ''}"><td class="ev-rank-cell">${r.rank}${q ? ' <span style="color:#38a169">▲</span>' : ''}</td>
          <td>${htmlEsc(r.label)}</td><td>${r.tie_wins}</td><td>${r.tie_losses}</td>
          <td>${r.net_ties > 0 ? '+' : ''}${r.net_ties}</td>
          <td>${r.net_games > 0 ? '+' : ''}${r.net_games}</td>
          <td>${r.net_points > 0 ? '+' : ''}${r.net_points}</td></tr>`;
      }
      h += `</tbody></table></div></div>`;
    }
    if (part !== 'standings') {
      h += `<div class="ev-group"><div class="ev-group-title">第 ${g} 组 对阵</div>`;
      h += d.ties.filter(t => t.stage === 'group' && t.group_no === g).map(t => evTieHtml(t, d, ro, false)).join('');
      h += `</div>`;
    }
  }
  h += `<div style="font-size:12px;color:#a0aec0;margin-top:6px">排名规则：大场胜场 → 净胜大场 → 净胜局 → 净胜分 → 交手记录</div></div>`;
  return h;
}

function evKOSectionHtml(d, ro, part) {
  if (ro && part !== 'ties') return '';   // 前台只读：签表折在「查看比赛详情」里
  const ko = d.ties.filter(t => t.stage === 'ko');
  const tp = d.ties.filter(t => t.stage === 'third');
  if (!ko.length && !tp.length) return '';
  const R = d.ko_rounds;
  let h = '<div class="card"><h3>淘汰签表</h3>';
  if (!ro && EVS.canSwap) {
    h += `<div style="font-size:12px;color:#718096;margin-bottom:10px">✋ 还没开打，点任意两个队伍位置即可交换（同一轮内）。开打后签表锁定。</div>`;
  }
  for (let r = 1; r <= R; r++) {
    const label = r === R ? '决赛' : (r === R - 1 ? '半决赛' : `第 ${r} 轮`);
    h += `<div class="ev-bracket-round"><div class="ev-bracket-round-title">${label}</div>`;
    h += ko.filter(t => t.ko_round === r).sort((a, b) => a.slot - b.slot).map(t => evTieHtml(t, d, ro, true)).join('');
    h += `</div>`;
  }
  if (tp.length) {
    h += `<div class="ev-bracket-round"><div class="ev-bracket-round-title">季军赛</div>`;
    h += tp.map(t => evTieHtml(t, d, ro, true)).join('');
    h += `</div>`;
  }
  h += '</div>';
  return h;
}

function evTieHtml(t, d, ro, bracket) {
  const win = t.winner_entry_id;
  const both = t.side1_entry_id && t.side2_entry_id;
  const o = t.outcome;
  const expanded = EVS.expanded === t.id;
  const l1 = t.side1_entry_id ? evEntryLabel(d, t.side1_entry_id) : '待定';
  const l2 = t.side2_entry_id ? evEntryLabel(d, t.side2_entry_id) : '待定';

  function sideHtml(side) {
    const id = side === 1 ? t.side1_entry_id : t.side2_entry_id;
    const label = side === 1 ? l1 : l2;
    const cls = !id ? 'empty' : (win ? (win === id ? 'win' : 'lose') : '');
    const canPick = !ro && bracket && EVS.canSwap && !!id;
    const picked = EVS.pick && EVS.pick.ko_round === t.ko_round && EVS.pick.slot === t.slot && EVS.pick.side === side;
    return `<span class="ev-slot ${cls} ${canPick ? 'pickable' : ''} ${picked ? 'picked' : ''}"
      ${canPick ? `onclick="event.stopPropagation();evPickSwap(${t.ko_round},${t.slot},${side})" title="点击后点另一个位置即可交换"` : ''}>${htmlEsc(label)}</span>`;
  }

  // 三种状态必须分开：一方都没打 → 未录入（不能显示 0 : 0，否则像是真打出 0 比 0）；
  // 打了一半 → 进行中（此时的 i1:i2 是有意义的中途大场分）；赢了 → 已结束。
  const played = !!(o && o.perItem && o.perItem.some(p => p.side !== 0 || p.w1 || p.w2));
  const score = (both && played) ? `${o.i1} : ${o.i2}` : '';
  const flag = win ? '<span class="ev-tie-flag done">已结束</span>'
    : (!both ? '<span class="ev-tie-flag pending">待定</span>'
      : (played ? '<span class="ev-tie-flag pending">进行中</span>' : '<span class="ev-tie-flag pending">未录入</span>'));

  let h = `<div class="ev-tie ${win ? 'done' : ''}">
    <div class="ev-tie-head" onclick="evToggleTie(${t.id})">
      <div class="ev-tie-sides">${sideHtml(1)}<span class="ev-vs">VS</span>${sideHtml(2)}</div>
      ${score ? `<span class="ev-tie-score">${score}</span>` : ''}
      ${flag}
    </div>`;
  if (expanded) h += evTieBodyHtml(t, d, ro, both);
  h += `</div>`;
  return h;
}

function evToggleTie(tieId) {
  EVS.expanded = EVS.expanded === tieId ? null : tieId;
  evRenderWorkspace();
}

function evTieBodyHtml(t, d, ro, both) {
  if (!both) return '<div class="ev-tie-body"><div class="ev-empty">对阵双方待定（等上一轮结果）</div></div>';
  const isTeam = d.event.kind === 'team';
  const bo = parseInt(d.best_of) || 3;
  const gameSlots = bo === 1 ? [0] : [0, 1, 2];
  let h = '<div class="ev-tie-body">';
  for (const it of t.items) {
    const def = TEAM_ITEM_MAP[it.code];
    const res = it.winner_side;
    const resHtml = res === -1 ? '<span class="ev-item-res skip">未进行</span>'
      : res === 1 ? '<span class="ev-item-res w1">左方胜</span>'
        : res === 2 ? '<span class="ev-item-res w2">右方胜</span>'
          : '<span class="ev-item-res skip">未录入</span>';
    h += `<div class="ev-item-block" data-item="${it.id}">
      <div class="ev-item-head"><span class="ev-item-name">${htmlEsc(it.name || '比赛')}</span>${resHtml}</div>`;
    if (isTeam && def) {
      h += `<div class="ev-lineup">
        ${evLineupSide(d, t, it, def, 1, ro)}
        <span class="ev-vs">VS</span>
        ${evLineupSide(d, t, it, def, 2, ro)}
      </div>`;
    }
    if (!ro) {
      if (res === -1) {
        h += `<div class="ev-skip-note">该项因大场已分出胜负而未进行</div>`;
      } else {
        h += `<div class="ev-games">${gameSlots.map(gi => `<span class="ev-game-set">
          <input class="ev-game" data-item="${it.id}" data-g="${gi}" data-col="1" type="number" min="0" max="99" value="${it.games[gi] ? it.games[gi].s1 : ''}">
          <span>:</span>
          <input class="ev-game" data-item="${it.id}" data-g="${gi}" data-col="2" type="number" min="0" max="99" value="${it.games[gi] ? it.games[gi].s2 : ''}">
        </span>`).join('')}</div>`;
      }
    } else if (it.games.length) {
      h += `<div class="ev-games">${it.games.map(g => `<span class="ev-game-set"><b>${g.s1}</b> : <b>${g.s2}</b></span>`).join('')}</div>`;
    } else if (res === -1) {
      h += `<div class="ev-skip-note">未进行</div>`;
    }
    h += `</div>`;
  }
  if (!ro) {
    h += `<div class="ev-tie-foot">
      <button onclick="evSaveTie(${d.edition.id},${t.id})">💾 保存本场</button>
      <button class="secondary" onclick="evClearTie(${d.edition.id},${t.id})">清空本场</button>
      <span class="ev-msg" id="ev-tie-msg-${t.id}"></span>
    </div>`;
  }
  h += '</div>';
  return h;
}

// 排阵下拉：按项目要求的性别，从该队名单里筛人。
// 混双固定「第一位男、第二位女」，避免排错。
function evLineupSide(d, t, it, def, side, ro) {
  const entryId = side === 1 ? t.side1_entry_id : t.side2_entry_id;
  const entry = d.entries.find(e => e.id === entryId);
  const members = entry ? entry.members : [];
  const chosen = (side === 1 ? it.side1_players : it.side2_players) || [];
  let h = '';
  for (let k = 0; k < def.size; k++) {
    const need = def.gender === 'mixed' ? (k === 0 ? 'male' : 'female') : def.gender;
    const opts = members.filter(pid => !need || evGenderOf(pid) === need);
    if (ro) {
      h += `<span style="font-size:13px;color:#4a5568">${chosen[k] ? htmlEsc(pn(chosen[k])) : '—'}</span>`;
      continue;
    }
    h += `<select class="ev-lineup" data-item="${it.id}" data-side="${side}" data-pos="${k}">
      <option value="">选人${need === 'male' ? '(男)' : need === 'female' ? '(女)' : ''}</option>
      ${opts.map(pid => `<option value="${pid}" ${chosen[k] === pid ? 'selected' : ''}>${htmlEsc(pn(pid))}</option>`).join('')}
    </select>`;
  }
  return h;
}

function evFinalHtml(d) {
  if (!d.final_ranks.length) return '';
  const isTeam = d.event.kind === 'team';
  const noun = evEntryNoun(d.event.kind);
  // 积分列：与总积分榜同一个数（后端算好带过来），前台只读页靠它跟老赛事卡片对齐
  const hasPts = d.final_ranks.some(r => r.points != null);
  const rows = d.final_ranks.map(r => {
    const cls = r.rank === 1 ? 'top1' : r.rank === 2 ? 'top2' : r.rank === 3 ? 'top3' : '';
    const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank;
    // 单项赛：参赛单元就是选手本人，再列一遍「成员」纯属重复，不显示
    return `<tr class="${cls}"><td>${medal}</td><td>${htmlEsc(r.label)}</td>
      ${isTeam ? evMemberCellHtml(r.member_ids) : ''}
      ${hasPts ? `<td class="ev-final-pts">${r.points == null ? '—' : r.points}</td>` : ''}</tr>`;
  }).join('');
  return `<div class="card"><h3>最终排名 <span class="ev-hint">${hasPts ? '积分按本届级别折算，与总积分榜同一个数' : '该名次会按本届级别折算成积分并计入总积分榜'}</span></h3>
    <table class="ev-final"><thead><tr><th style="width:70px">名次</th><th>${noun}</th>
    ${isTeam ? '<th class="ev-member-col">成员</th>' : ''}
    ${hasPts ? '<th class="ev-final-pts">积分</th>' : ''}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------------- 录入 ----------------

async function evSaveTie(editionId, tieId) {
  const d = EVS.detail;
  const t = d.ties.find(x => x.id === tieId);
  if (!t) return;
  const bo = parseInt(d.best_of) || 3;
  const msg = document.getElementById('ev-tie-msg-' + tieId);
  const items = t.items.map(it => {
    const block = document.querySelector(`.ev-item-block[data-item="${it.id}"]`);
    let s1 = [], s2 = [], games = [];
    if (block) {
      s1 = [...block.querySelectorAll(`select[data-side="1"]`)].map(s => parseInt(s.value)).filter(Boolean);
      s2 = [...block.querySelectorAll(`select[data-side="2"]`)].map(s => parseInt(s.value)).filter(Boolean);
      for (let gi = 0; gi < bo; gi++) {
        const a = block.querySelector(`input.ev-game[data-g="${gi}"][data-col="1"]`);
        const b = block.querySelector(`input.ev-game[data-g="${gi}"][data-col="2"]`);
        const v1 = a && a.value !== '' ? parseInt(a.value) : NaN;
        const v2 = b && b.value !== '' ? parseInt(b.value) : NaN;
        if (!isNaN(v1) && !isNaN(v2)) games.push({ s1: v1, s2: v2 });
      }
    }
    return { item_id: it.id, side1_players: s1, side2_players: s2, games };
  });
  try {
    if (msg) { msg.style.color = '#718096'; msg.textContent = '保存中...'; }
    await api(`/api/editions/${editionId}/tie/${tieId}`, { method: 'POST', body: JSON.stringify({ items }) });
    cachedPlayers = [];
    invalidatePlayerQueryCache();
    EVS.expanded = tieId;
    await evReload();
    const m2 = document.getElementById('ev-tie-msg-' + tieId);
    if (m2) { m2.style.color = '#38a169'; m2.textContent = '✅ 已保存'; }
  } catch (e) {
    if (msg) { msg.style.color = '#e53e3e'; msg.textContent = e.message; }
    else alert('保存失败: ' + e.message);
  }
}

async function evClearTie(editionId, tieId) {
  if (!confirm('清空这一场的全部比分？')) return;
  try {
    await api(`/api/editions/${editionId}/tie/${tieId}/clear`, { method: 'POST', body: '{}' });
    cachedPlayers = [];
    invalidatePlayerQueryCache();
    EVS.expanded = tieId;
    await evReload();
  } catch (e) { alert('清空失败: ' + e.message); }
}

async function evPickSwap(round, slot, side) {
  const p = EVS.pick;
  if (!p || p.ko_round !== round) { EVS.pick = { ko_round: round, slot, side }; evRenderWorkspace(); return; }
  if (p.slot === slot && p.side === side) { EVS.pick = null; evRenderWorkspace(); return; }
  try {
    await api(`/api/editions/${EVS.detail.edition.id}/ko-swap`, {
      method: 'POST', body: JSON.stringify({ a: p, b: { ko_round: round, slot, side } })
    });
    EVS.pick = null;
    await evReload();
  } catch (e) { alert('调整失败: ' + e.message); EVS.pick = null; evRenderWorkspace(); }
}

// ---------------- 比赛管理：本届设置（日期 / 级别 / 参赛名单） ----------------
//
// 「创建赛事」只定赛制，具体某一届谁参加、什么时候打，都在这里录。
const MES = {
  eventId: null, event: null, editionId: null, editionNo: 1,
  date: '', level: 1000, entries: [], teamMembers: [], teamName: '', singlesSize: 1,
  editions: [],
  groupAssign: {},   // entryId -> 组号（手动分组面板的本地草稿，点「保存分组」才写库）
  tieCount: 0        // 本届已有多少场对阵 —— 重排会清空比分，用它来决定要不要二次确认
};

async function mEvInit() {
  const sel = document.getElementById('round-tournament');
  const opt = sel.options[sel.selectedIndex];
  if (!opt || opt.dataset.isEvent !== '1') {
    document.getElementById('ev-edition-card').style.display = 'none';
    return;
  }
  await ensurePlayers();
  const eventId = parseInt(opt.dataset.eventId);
  Object.assign(MES, {
    eventId, editionId: null, editionNo: 1,
    date: new Date().toISOString().slice(0, 10), level: 1000,
    entries: [], teamMembers: [], teamName: '', singlesSize: 1
  });
  try {
    const d = await api('/api/events/' + eventId);
    MES.event = d.event;
    MES.editions = d.editions;
    if (d.editions.length) MES.editionNo = Math.max(...d.editions.map(e => e.edition));
  } catch (e) {
    document.getElementById('ev-edition-card').innerHTML = `<h3>⚙️ 本届设置</h3><div class="loading" style="color:#e53e3e">加载赛事失败：${e.message}</div>`;
    return;
  }
  await mEvSelectEdition(MES.editions.length ? MES.editions[0].id : null);
  mEvRender();
}

async function mEvSelectEdition(edId) {
  Object.assign(MES, { editionId: null, entries: [], teamMembers: [], teamName: '', groupAssign: {}, tieCount: 0 });
  if (!edId) {
    MES.editionNo = Math.max(...MES.editions.map(e => e.edition).concat([0])) + 1;
    MES.date = new Date().toISOString().slice(0, 10);
    MES.level = 1000;
    return;
  }
  const d = await api('/api/editions/' + edId);
  MES.editionId = d.edition.id;
  MES.editionNo = d.edition.edition;
  MES.date = d.edition.date || new Date().toISOString().slice(0, 10);
  MES.level = d.edition.level || 1000;
  MES.tieCount = (d.ties || []).length;
  // 带 id / seed / group_no 下来：手动分组面板要靠它们显示种子积分与当前分组
  MES.entries = d.entries.map(e => ({
    id: e.id, label: e.label, players: (e.members || []).slice(),
    seed: e.seed || 0, seedRank: e.seed_rank || 0, groupNo: e.group_no || 0
  }));
  MES.groupAssign = {};
  for (const e of d.entries) if (e.group_no) MES.groupAssign[e.id] = e.group_no;
}

function mEvRender() {
  const box = document.getElementById('ev-edition-card');
  if (!box || !MES.event) return;
  const ev = MES.event;
  const isTeam = ev.kind === 'team';
  const gc = ev.group_count || 1, apg = ev.advance_per_group || 1;
  const need = ev.format === 'group_ko' ? Math.max(gc * 2, apg * gc + 1) : 2;
  const editing = !!MES.editionId;

  const editionOpts = MES.editions.map(e =>
    `<option value="${e.id}" ${MES.editionId === e.id ? 'selected' : ''}>第 ${e.edition} 届（${e.date || '—'}，${e.entry_count} ${evEntryUnit(ev.kind)}）</option>`
  ).join('') + `<option value="" ${!MES.editionId ? 'selected' : ''}>＋ 新建第 ${MES.editions.reduce((m, e) => Math.max(m, e.edition), 0) + 1} 届</option>`;

  const entryNoun = evEntryNoun(ev.kind);
  // 团体赛：chip 只显示队名，队员名单折进「👥 N 人」，不占一整列
  const entryRows = MES.entries.map((e, i) => `<span class="ev-chip"><span class="ev-chip-num">${i + 1}</span>${htmlEsc(e.label)}
    <button onclick="mEvRemoveEntry(${i})" title="移除">✕</button></span>
    ${isTeam && (e.players || []).length ? `<details class="ev-roster ev-roster-inline"><summary>👥 ${e.players.length} 人</summary>
      <div class="ev-roster-body">${e.players.map(pn).map(htmlEsc).join('、')}</div></details>` : ''}`).join('')
    || `<span class="ev-empty">还没有${entryNoun}</span>`;

  const memberRows = MES.teamMembers.map((pid, i) => `<span class="ev-chip">${htmlEsc(pn(pid))}（${evGenderOf(pid) === 'male' ? '男' : '女'}）
    <button onclick="mEvRemoveMember(${i})" title="移出">✕</button></span>`).join('') || '<span class="ev-empty">队员名单为空</span>';

  const entryArea = isTeam
    ? `<div class="ev-sec">
        <div class="ev-sec-title">参赛队伍 <span class="ev-hint">先把队员加进名单，再填队名保存</span></div>
        <div class="form-row">
          <input type="text" id="mev-tname" placeholder="队伍名，例如：闪电队" value="${htmlEsc(MES.teamName)}" oninput="MES.teamName=this.value">
          <select id="mev-tmember">${evPlayerOpts()}</select>
          <button onclick="mEvAddMember()">＋ 加入队员</button>
        </div>
        <div class="ev-chip-list">${memberRows}</div>
        <div class="form-row" style="margin-top:10px">
          <button onclick="mEvAddTeam()">✅ 保存这支队伍</button>
        </div>
      </div>`
    : `<div class="ev-sec">
        <div class="ev-sec-title">${entryNoun} <span class="ev-hint">每${evEntryUnit(ev.kind)}点一次添加</span></div>
        <div class="form-row" style="margin-bottom:8px">
          <div class="ev-radios">
            <label class="ev-radio ${MES.singlesSize === 1 ? 'on' : ''}"><input type="radio" name="mev-size" ${MES.singlesSize === 1 ? 'checked' : ''} onchange="mEvSetSize(1)">单打（1 人）</label>
            <label class="ev-radio ${MES.singlesSize === 2 ? 'on' : ''}"><input type="radio" name="mev-size" ${MES.singlesSize === 2 ? 'checked' : ''} onchange="mEvSetSize(2)">双打（2 人）</label>
          </div>
        </div>
        <div class="form-row">
          <select id="mev-p1">${evPlayerOpts()}</select>
          ${MES.singlesSize === 2 ? `<select id="mev-p2">${evPlayerOpts()}</select>` : ''}
          <button onclick="mEvAddIndividual()">＋ 添加${entryNoun}</button>
        </div>
      </div>`;

  // 分组面板：只有「本届已保存」才有 entry id，才谈得上手动分组。
  // 生成对阵后也还能改 —— 但会清空比分，函数里会二次确认。
  const groupPick = (evFormatHasGroup(ev.format) && editing && MES.entries.every(e => e.id))
    ? `<div class="ev-sec">
        <div class="ev-sec-title">分组安排
          <span class="ev-hint">当前分组方式：<b>${groupModeLabel(ev.group_mode)}</b>　种子依据：<b>${seedByLabel(ev.seed_by)}</b>
          ${ev.group_mode === 'snake' ? '（自动模式下你也可以先手动分好，生成对阵时会自动沿用）' : ''}</span></div>
        <div class="ev-group-pick">
          ${MES.entries.slice().sort((a, b) => (a.seedRank || 999) - (b.seedRank || 999)).map(e => `
            <div class="ev-gp-row">
              <span class="ev-gp-seed">种子 ${e.seedRank || '-'}</span>
              <span class="ev-gp-name">${htmlEsc(e.label)}</span>
              <span class="ev-gp-pts">积分 ${e.seed || 0}</span>
              <select onchange="mEvSetGroup(${e.id}, this.value)">
                ${Array.from({ length: gc }, (_, i) => i + 1).map(g =>
                  `<option value="${g}" ${(MES.groupAssign[e.id] || 0) === g ? 'selected' : ''}>第 ${g} 组</option>`).join('')}
                <option value="0" ${!MES.groupAssign[e.id] ? 'selected' : ''}>未分组</option>
              </select>
            </div>`).join('')}
        </div>
        <div class="form-row" style="margin-top:10px">
          <button onclick="mEvAutoSeedGroups()">🎯 按积分自动蛇形分组</button>
          <button onclick="mEvSaveGroups()">💾 保存分组</button>
        </div>
      </div>`
    : '';

  box.innerHTML = `<h3>⚙️ 本届设置 <span class="ev-hint">${htmlEsc(ev.name)}　${evKindLabel(ev.kind)}　${evFormatLabel(ev.format)}　${evBestOfLabel(ev.best_of)}</span></h3>
    <div class="form-row">
      <label style="font-size:14px;color:#4a5568">届次</label>
      <select id="mev-edition" onchange="mEvOnEditionChange(this.value)">${editionOpts}</select>
      <input type="date" id="mev-date" value="${MES.date}" onchange="MES.date=this.value">
      <select id="mev-level" onchange="MES.level=parseInt(this.value)||1000">
        ${[1000, 750, 500, 300].map(l => `<option value="${l}" ${MES.level === l ? 'selected' : ''}>${l}级</option>`).join('')}
      </select>
    </div>
    ${ev.format === 'group_ko' ? `<div class="ev-hint" style="margin:6px 0">小组 ${gc} 组、每组出线 ${apg} 个 —— 本届至少 ${need} ${evEntryUnit(ev.kind)}${entryNoun}</div>` : ''}
    ${entryArea}
    <div class="ev-chip-list" id="mev-entry-chips">${entryRows}</div>
    ${groupPick}
    <div class="form-row" style="margin-top:14px">
      <button onclick="mEvSave()">💾 ${editing ? '保存本届' : '创建本届'}</button>
      <button onclick="mEvGenFixtures()" ${!MES.editionId ? 'disabled' : ''}>⚡ 一键生成对阵</button>
      <button onclick="mEvOpenWorkspace()" ${!MES.editionId ? 'disabled' : ''}>📋 打开工作台</button>
      ${editing ? `<button class="danger" onclick="mEvDelete()">🗑️ 删除本届</button>` : ''}
      <span id="mev-msg" style="font-size:13px"></span>
    </div>`;
  box.style.display = 'block';
}

function mEvSetSize(n) { MES.singlesSize = n; mEvRender(); }

// 手动分组面板：改的是本地草稿，点「保存分组」才写库
function mEvSetGroup(entryId, g) {
  const n = parseInt(g);
  if (!n) delete MES.groupAssign[entryId];
  else MES.groupAssign[entryId] = n;
}

// 「按积分自动蛇形分组」：按种子值降序蛇形填一遍，填完用户还能再微调。
// 只填草稿，不写库 —— 跟「保存分组」分开，避免一键下去就清掉比分。
function mEvAutoSeedGroups() {
  const gc = MES.event.group_count || 1;
  const sorted = MES.entries.slice().sort((a, b) => {
    const d = (b.seed || 0) - (a.seed || 0);
    if (d) return d;
    return (a.seedRank || 999) - (b.seedRank || 999);
  });
  MES.groupAssign = {};
  sorted.forEach((e, i) => {
    const round = Math.floor(i / gc), pos = i % gc;
    MES.groupAssign[e.id] = ((round % 2 === 0) ? pos : (gc - 1 - pos)) + 1;
  });
  mEvRender();
}

async function mEvSaveGroups() {
  const ev = MES.event;
  const gc = ev.group_count || 1;
  const assign = MES.entries.map(e => [e.id, MES.groupAssign[e.id] || 0]);
  if (assign.some(a => !a[1])) return mEvMsg(`还有${evEntryNoun(ev.kind)}没指定小组`);
  // 重排会清空已有对阵与比分，必须让用户确认
  if (MES.tieCount > 0 && !confirm(`本届已有 ${MES.tieCount} 场对阵。\n重新分组会清空所有小组赛与淘汰赛的比分，确定继续？`)) return;
  try {
    mEvMsg('保存中...', true);
    await api('/api/editions/' + MES.editionId + '/set-groups', {
      method: 'POST', body: JSON.stringify({ assign })
    });
    await mEvSelectEdition(MES.editionId);
    mEvRender();
    mEvMsg(`✅ 分组已保存（${gc} 组）。点「一键生成对阵」按这个分组排出小组赛。`, true);
  } catch (e) { mEvMsg(e.message); }
}
async function mEvOnEditionChange(v) {
  try {
    await mEvSelectEdition(v ? parseInt(v) : null);
    mEvRender();
  } catch (e) { alert('加载该届失败: ' + e.message); }
}

function mEvAddMember() {
  const sel = document.getElementById('mev-tmember');
  const pid = parseInt(sel.value);
  if (!pid) return alert('请选择选手');
  if (MES.teamMembers.includes(pid)) return alert('该队员已在名单里');
  MES.teamMembers.push(pid);
  sel.value = '';
  mEvRender();
}
function mEvRemoveMember(i) { MES.teamMembers.splice(i, 1); mEvRender(); }
function mEvAddTeam() {
  const name = (document.getElementById('mev-tname').value || '').trim();
  if (!name) return alert('请填写队伍名');
  if (MES.teamMembers.length < 2) return alert('每支队伍至少 2 名队员');
  if (MES.entries.some(e => e.label === name)) return alert('已有同名队伍');
  MES.entries.push({ label: name, players: MES.teamMembers.slice() });
  MES.teamMembers = [];
  MES.teamName = '';
  mEvRender();
}
function mEvAddIndividual() {
  const p1 = parseInt(document.getElementById('mev-p1').value);
  if (!p1) return alert('请选择选手');
  const players = [p1];
  if (MES.singlesSize === 2) {
    const p2 = parseInt(document.getElementById('mev-p2').value);
    if (!p2) return alert('双打请选择第二位选手');
    if (p2 === p1) return alert('两位选手不能相同');
    players.push(p2);
  }
  const label = players.map(pn).join(' + ');
  if (MES.entries.some(e => e.players.slice().sort().join(',') === players.slice().sort().join(','))) return alert('该组合已在名单里');
  MES.entries.push({ label, players });
  mEvRender();
}
function mEvRemoveEntry(i) { MES.entries.splice(i, 1); mEvRender(); }

function mEvMsg(t, ok) {
  const el = document.getElementById('mev-msg');
  if (!el) return;
  el.style.color = ok ? '#38a169' : '#e53e3e';
  el.textContent = t;
}

async function mEvSave() {
  if (MES.entries.length < 2) return mEvMsg(`至少需要 2 ${evEntryUnit(MES.event.kind)}${evEntryNoun(MES.event.kind)}`);
  const body = {
    edition: parseInt(document.getElementById('mev-edition').value ? MES.editionNo : MES.editionNo) || 1,
    date: document.getElementById('mev-date').value,
    level: parseInt(document.getElementById('mev-level').value) || 1000,
    entries: MES.entries.map(e => ({ label: e.label, players: e.players }))
  };
  try {
    mEvMsg('保存中...', true);
    if (MES.editionId) {
      await api('/api/editions/' + MES.editionId, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      const r = await api('/api/events/' + MES.eventId + '/editions', { method: 'POST', body: JSON.stringify(body) });
      MES.editionId = r.id;
    }
    cachedPlayers = [];
    invalidatePlayerQueryCache();
    const d = await api('/api/events/' + MES.eventId);
    MES.editions = d.editions;
    MES.editionNo = MES.editions.find(e => e.id === MES.editionId) ? MES.editions.find(e => e.id === MES.editionId).edition : MES.editionNo;
    // 重新拉一次本届：名单存进库后才有 entry id 与种子积分，分组面板要用
    await mEvSelectEdition(MES.editionId);
    mEvRender();
    mEvMsg(evFormatHasGroup(MES.event.format)
      ? '✅ 已保存。可在「分组安排」里自己分小组，再点「一键生成对阵」。'
      : '✅ 已保存。点「一键生成对阵」按赛制排出赛程。', true);
  } catch (e) { mEvMsg(e.message); }
}

async function mEvGenFixtures() {
  if (!MES.editionId) return;
  const ev = MES.event;
  // 生成会清空小组赛/淘汰赛全部比分，已经有对阵时必须先确认 —— 否则一点就把成绩抹了
  if (MES.tieCount > 0 && !confirm(`本届已有 ${MES.tieCount} 场对阵。\n重新生成会清空所有已录的比分，确定继续？`)) return;
  try {
    mEvMsg('生成中...', true);
    if (evFormatHasGroup(ev.format)) {
      // 已经分好组（手动分过 / 上次生成留下）就沿用；用户确认过重排才 force 重新抽
      await api('/api/editions/' + MES.editionId + '/generate-groups',
        { method: 'POST', body: JSON.stringify({ force: MES.tieCount > 0 ? 1 : 0 }) });
    }
    // 淘汰赛：只有纯淘汰赛制能现在就排（出线名单 = 全部参赛单元）。
    // 小组+淘汰赛制必须等小组赛打完才知道谁出线，所以留到工作台里再点。
    if (ev.format === 'ko') {
      await api('/api/editions/' + MES.editionId + '/generate-ko', { method: 'POST', body: '{}' });
    }
    mEvMsg(ev.format === 'group_ko'
      ? '✅ 小组对阵已生成。打完小组赛后，到工作台点「🏆 生成淘汰签表」排出淘汰赛。'
      : '✅ 对阵已生成，点「打开工作台」录入比分。', true);
  } catch (e) { mEvMsg(e.message); }
}

async function mEvOpenWorkspace() {
  if (!MES.editionId) return;
  document.getElementById('ev-workspace-match').style.display = 'block';
  await evOpenEdition(MES.editionId, 'match');
  document.getElementById('ev-workspace-match').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function mEvBack() {
  document.getElementById('ev-workspace-match').style.display = 'none';
  document.getElementById('ev-workspace-match').innerHTML = '';
  document.getElementById('ev-edition-card').style.display = 'block';
  mEvRender();
}

async function mEvDelete() {
  if (!MES.editionId) return;
  const ed = MES.editions.find(e => e.id === MES.editionId);
  if (!confirm(`确定删除第 ${ed ? ed.edition : MES.editionNo} 届？\n该届的对阵与比分会被清除，积分榜与荣誉会同步回落。`)) return;
  try {
    await api('/api/editions/' + MES.editionId, { method: 'DELETE' });
    cachedPlayers = [];
    invalidatePlayerQueryCache();
    const d = await api('/api/events/' + MES.eventId);
    MES.editions = d.editions;
    await mEvSelectEdition(MES.editions.length ? MES.editions[0].id : null);
    mEvRender();
    mEvMsg('✅ 该届已删除', true);
  } catch (e) { mEvMsg(e.message); }
}

// 赛事图标：复用比赛管理里的压缩逻辑（正方形 JPEG，居中裁剪 + 白底）
async function evUploadIcon(eventId, tournamentId, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { input.value = ''; alert('图片不能超过5MB'); return; }
  try {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const icon = await compressIcon(dataUrl);
    await api(`/api/tournaments/${tournamentId}/icon`, { method: 'POST', body: JSON.stringify({ icon }) });
    const t = cachedTournaments.find(x => String(x.id) === String(tournamentId));
    if (t) t.icon = icon;
    alert('✅ 图标已更新');
  } catch (e) { alert('上传失败: ' + e.message); }
  input.value = '';
}

// ==================== Init ====================
loadHome();

// 支持直接带 ?tid= 打开赛事详情（刷新/分享链接不丢当前赛事）。
// 放在 loadHome 之后异步跑，不阻塞首页渲染。
(async function initFromUrl() {
  const tid = new URLSearchParams(location.search).get('tid');
  if (!tid) return;
  try {
    const tournaments = await api('/api/tournaments');
    queryTournaments = tournaments;
    tourIconById = Object.fromEntries(tournaments.filter(t => t.icon).map(t => [String(t.id), t.icon]));
    tourIconByName = Object.fromEntries(tournaments.filter(t => t.icon).map(t => [t.name, t.icon]));
    await ensurePlayers();
    if (tournaments.some(t => String(t.id) === String(tid))) {
      document.querySelectorAll('.nav-links a').forEach(a => a.classList.toggle('active', a.dataset.tab === 'query'));
      await showTournamentLatest(tid);
    }
  } catch (e) { /* 深链失败就静默留在首页，不打扰用户 */ }
})();
