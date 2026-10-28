// ==================== Navigation ====================
// 静态资源版本号：CDN（Cloudflare）会缓存无版本号的静态文件，改版后必须换号才能生效。
// 注意版本号是两套、各自独立：
//   - ASSET_V（本常量）：管 app.js 与 app.js 里引用的图片
//   - style.css：在 index.html 里单独写 ?v=N
// 改 app.js 或图片 → 本常量 +1，并同步 index.html 的 /app.js?v=N
// 改 style.css   → 只改 index.html 的 /style.css?v=N
const ASSET_V = '115';
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

// 单项赛（非固搭）的「项目类型」：决定每个参赛单元是 1 人还是 2 人，以及性别口径。
// 男单/女单 = 1 人；男双/女双/混双 = 2 人（混双额外要求一男一女）。
// '' = 未指定（legacy 行为，录名单时仍可临时选单打/双打）。
const EV_TYPE_DEFS = [
  { code: 'singles',        name: '男单', size: 1, genders: ['male'] },
  { code: 'womens_singles', name: '女单', size: 1, genders: ['female'] },
  { code: 'mens_doubles',   name: '男双', size: 2, genders: ['male', 'male'] },
  { code: 'womens_doubles', name: '女双', size: 2, genders: ['female', 'female'] },
  { code: 'mixed_doubles',  name: '混双', size: 2, genders: ['male', 'female'] },
];
const evTypeLabel = t => (EV_TYPE_DEFS.find(x => x.code === t) || {}).name || '';
const evTypeSize  = t => (EV_TYPE_DEFS.find(x => x.code === t) || {}).size || 0;   // 0 = 不锁定
const evTypeGenders = t => (EV_TYPE_DEFS.find(x => x.code === t) || {}).genders || null;

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
    document.getElementById('tab-logs').style.display = '';

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

// 管理端子页切换集中在这里。四块平级：选手管理 / 比赛管理 / 创建赛事 / 日志。
function setAdminSub(sub) {
  document.getElementById('tab-players').style.display = sub === 'players' ? 'block' : 'none';
  document.getElementById('tab-matches').style.display = sub === 'matches' ? 'block' : 'none';
  document.getElementById('tab-events').style.display = sub === 'events' ? 'block' : 'none';
  document.getElementById('tab-logs').style.display = sub === 'logs' ? 'block' : 'none';
  if (sub === 'players') loadPlayerList();
  if (sub === 'matches') initMatchPage();
  if (sub === 'events') initEventPage();
  if (sub === 'logs') initLogPage();
}

// 日志子页：拉操作日志第一页
function initLogPage() {
  fetchLogPage(false);
  loadLogCalendar();
}

// ==================== 赛历查询 ====================
// 日志页最上面的卡片：按年份列出每一届赛事（一届一行），期间发生的积分衰减
// （扣分）事件也列出来——与赛事同日的衰减并入该行标注，纯衰减日单列一行。
async function loadLogCalendar() {
  const sel = document.getElementById('log-cal-year');
  const listEl = document.getElementById('log-cal-list');
  const year = sel.value || String(new Date().getFullYear());
  listEl.innerHTML = '<div class="log-empty">加载中…</div>';
  try {
    const d = await api('/api/logs/calendar?year=' + encodeURIComponent(year));
    // 年份下拉只建一次（接口给的年份范围）
    if (sel.options.length !== d.years.length) {
      sel.innerHTML = d.years.map(y => `<option value="${y}">${y} 年</option>`).join('');
    }
    if (d.years.includes(year)) sel.value = year;
    if (!d.items.length) {
      listEl.innerHTML = '<div class="log-empty">这一年没有赛事记录</div>';
      return;
    }
    listEl.innerHTML = '';
    for (const it of d.items) listEl.appendChild(calItemEl(it));
    // 重新查询 = 重新折叠成前 N 条
    logCollapse['log-cal-list'] = { expanded: false };
    applyLogCollapse('log-cal-list', 'log-cal-more', d.items.length);
  } catch (e) {
    listEl.innerHTML = `<div class="log-empty" style="color:#e53e3e">加载失败：${e.message}</div>`;
  }
}

function calItemHtml(it) {
  if (it.kind === 'decay') {
    return `<div class="log-item cal-item cal-decay">
      <div class="cal-date">${it.date}</div>
      <div class="log-item-body">
        <div class="log-item-head">
          <span class="log-badge log-badge-decay">积分衰减</span>
        </div>
        <div class="log-summary">${it.sites.map(htmlEsc).join('、')} 积分衰减</div>
      </div>
    </div>`;
  }
  const decayTip = it.decay_sites && it.decay_sites.length
    ? `<div class="cal-decay-tip">📉 当日积分衰减：${it.decay_sites.map(htmlEsc).join('、')}</div>` : '';
  return `<div class="log-item cal-item">
    <div class="cal-date">${it.date}</div>
    <div class="log-item-body">
      <div class="log-item-head">
        <span class="log-badge log-badge-round_add">赛事</span>
        <span class="log-time">${it.level} 级</span>
      </div>
      <div class="log-summary">${htmlEsc(it.name)} 第 ${it.edition} 届 · ${it.participants} 人参赛</div>
      ${decayTip}
    </div>
  </div>`;
}

function calItemEl(it) {
  const div = document.createElement('div');
  div.innerHTML = calItemHtml(it);
  return div.firstElementChild;
}

document.getElementById('log-cal-year').addEventListener('change', loadLogCalendar);

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

// 首页「积分规则」：正文就是和哥定稿的一段式大白话简介，
// 两份细则（积分怎么来 / 扣分怎么扣）做成按钮，点开才有详细解释。
// 新增细则只往这里加一条，正文用 ruleDetailBtn('key') 引用即可。
const RULE_DETAILS = {
  earn: {
    t: '积分细则',
    b: '<b>赛事级别</b>：按参赛人数分 1000 / 750 / 500 / 300 四档；同一赛事的不同级别算两个独立站点（如国王杯 750 级与 500 级互不相干）。<br><br>' +
       '<b>名次分</b>：<code>名次分 = 赛事级别 − (名次 − 1) × d</code><br>' +
       '其中 <code>d = 赛事级别 ÷ 参赛人数</code>（四舍五入）。例：1000 级 8 人，d = 125 —— 冠军 1000、亚军 875、季军 750……<br>' +
       '名次按胜场排，胜场相同比净胜分；两者全同则并列，取所跨名次的平均分。<br><br>' +
       '<b>残值</b>：某站最后一次成绩换算出的分，一直挂在账上；去打就刷新成当届分。<br><br>' +
       '<b>总积分</b>：<code>总积分 = 前 4 站（男）/ 前 3 站（女）积分之和</code>，多打几个站比死守一个老站划算。'
  },
  decay: {
    t: '削减细则',
    b: '<b>按届扣</b>（赛事还在办）：缺席一届且本站有残值，扣 <code>d/2</code>（d 为本人当届分差），扣完为止；去打了就刷新成当届分，一笔勾销。<br><br>' +
       '<b>停办赛事按时间扣</b>：超过半年没办新一届，之后每满半年扣 1 个当次 d，扣完为止；半年内重新办起来则不额外扣。<br><br>' +
       '<b>停摆后复活不回升</b>：停摆期间扣掉的分不会涨回去，只从已扣后的值继续往下。<br><br>' +
       '标志：站点格 <span style="color:#ffbf00;font-weight:bold">▼</span>＝按时间扣，' +
       '<span style="color:#b8860b;font-weight:bold">▼</span>＝按届扣，同站只亮最新的一个；' +
       '总积分旁 <span style="color:#38a169;font-weight:bold">▲</span> / ' +
       '<span style="color:#e53e3e;font-weight:bold">▼</span>＝排名变化。'
  }
};

function ruleDetailBtn(key) {
  const t = RULE_DETAILS[key];
  if (!t) return '';
  return `<button class="detail-btn" onclick="showRuleDetail('${key}')">${htmlEsc(t.t)}</button>`;
}

function showRuleDetail(key) {
  const t = RULE_DETAILS[key];
  if (!t) return;
  const old = document.getElementById('rule-term-pop');
  if (old) old.remove();
  const pop = document.createElement('div');
  pop.id = 'rule-term-pop';
  pop.className = 'term-mask';
  pop.innerHTML = `<div class="term-card">
      <div class="term-card-title">${htmlEsc(t.t)}</div>
      <div class="term-card-body">${t.b}</div>
      <button class="term-close" onclick="document.getElementById('rule-term-pop').remove()">知道了</button>
    </div>`;
  pop.addEventListener('click', e => { if (e.target === pop) pop.remove(); });
  document.body.appendChild(pop);
}

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
        <p class="rule-prose">本系列赛事分为若干级别，每位参赛选手会根据赛事级别和排名获得相应的积分${ruleDetailBtn('earn')}。若未参加最新一届赛事但具有该项赛事积分的选手，其在该项赛事的积分会削减。某项赛事停办的时间每超过半年，所有具有该项赛事积分的选手的积分都会削减${ruleDetailBtn('decay')}。每位选手的总积分为其所获得的最高四项（男）/三项（女）赛事积分的总和。</p>
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

// 一键补默认对手/搭档：给没设置过的人填交手/搭档最多的前 3 个（服务端幂等，已设置的不碰）
async function backfillDefaultMates() {
  if (!confirm('将给没有设置主要对手/搭档的选手自动填充（取交手/搭档次数最多的前 3 个）。\n已自行设置过的选手不会被修改。确定继续？')) return;
  const btn = document.getElementById('btn-backfill-mates');
  btn.disabled = true; btn.textContent = '⏳ 计算中…';
  try {
    const r = await api('/api/players/backfill-default-mates', { method: 'POST', body: '{}' });
    cachedPlayers = [];
    invalidatePlayerQueryCache();
    loadPlayerList();
    const lines = (r.details || []).map(d =>
      `${d.name}：对手[${d.rivals.join('、') || '无'}] 搭档[${d.partners.join('、') || '无'}]`);
    alert(`已补充 ${r.updated} 人。\n\n` + (lines.join('\n') || '（没有需要补充的选手）'));
  } catch (e) { alert('补充失败: ' + e.message); }
  btn.disabled = false; btn.textContent = '🧮 补默认对手/搭档';
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
    `<option value="${t.id}" data-type="${t.type}" data-level="${t.level}" data-is-event="${t.is_event ? 1 : 0}" data-event-id="${t.event_id || ''}">${t.name}${t.is_event ? '' : ` (${tourTypeLabel(t.type)})`}</option>`
  ).join('');
  const levelSel = document.getElementById('round-level');
  if (levelSel) levelSel.onchange = () => { MS.level = parseInt(levelSel.value); };
  sel.onchange = () => { updateEditionSelect(); refreshParticipantSelect(); setDefaultLevel(); toggleFreeMatchUI(); renderTournamentIcon(); renderTournamentDesc(); };
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
  renderTournamentDesc();
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

// ==================== Tournament Description ====================
// 赛事介绍：管理端编辑，展示在赛事查询详情页赛事名后面。
// 与图标同一模式：跟着「创建新轮次」的赛事下拉联动，存 tournaments.description。

// 下拉选中项变化时，把该赛事已有的介绍灌进输入框（没有则清空）。
function renderTournamentDesc() {
  const sel = document.getElementById('round-tournament');
  const input = document.getElementById('tournament-desc-input');
  const status = document.getElementById('t-desc-status');
  if (!sel || !input) return;
  if (status) status.textContent = '';
  const t = cachedTournaments.find(x => String(x.id) === String(sel.value));
  if (!t) {
    input.value = '';
    input.placeholder = '请先选择赛事';
    input.disabled = true;
    return;
  }
  input.disabled = false;
  input.placeholder = `一句话介绍${t.name}，将显示在赛事查询页`;
  input.value = t.description || '';
}

async function saveTournamentDesc() {
  const sel = document.getElementById('round-tournament');
  const input = document.getElementById('tournament-desc-input');
  const status = document.getElementById('t-desc-status');
  if (!sel || !input) return;
  const tid = sel.value;
  if (!tid) { alert('请先选择赛事'); return; }
  const desc = input.value.trim();
  try {
    await api(`/api/tournaments/${tid}/description`, { method: 'POST', body: JSON.stringify({ description: desc }) });
    const t = cachedTournaments.find(x => String(x.id) === String(tid));
    if (t) t.description = desc;
    // 赛事查询页的下拉数据是另外一份缓存，顺手同步，避免刚保存完跳过去还是旧文案
    const qt = queryTournaments.find(x => String(x.id) === String(tid));
    if (qt) qt.description = desc;
    status.style.color = '#38a169';
    status.textContent = '✓ 已保存';
    setTimeout(() => { status.textContent = ''; }, 3000);
  } catch (e) {
    status.style.color = '#e53e3e';
    status.textContent = '保存失败: ' + e.message;
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
  const box = document.getElementById('participant-pick');
  if (!opt || !opt.value) {
    box.innerHTML = '<span style="color:#a0aec0;font-size:14px;padding:8px 0">请先选择赛事</span>';
    return;
  }
  MS.tid = parseInt(opt.value);
  MS.type = opt.dataset.type;
  MS.level = parseInt(document.getElementById('round-level').value) || 1000;
  MS.tname = opt.text.split('(')[0].trim();
  MS.edition = parseInt(document.getElementById('round-edition').value) || 1;
  MS.date = document.getElementById('round-date').value;

  // 和新赛事同一套联想输入框：姓名 / 比赛ID 都能搜。男双只出男、女双只出女；
  // 混双第一位不限性别，第二位在 evPickAfterChoose 里按第一位切性别。
  await ensurePlayers();
  const isDoubles = MS.type !== 'singles';
  const g1 = MS.type === 'mens_doubles' ? 'male' : MS.type === 'womens_doubles' ? 'female' : '';
  box.innerHTML =
    evPickHtml('ms-p1', isDoubles ? '输入姓名或ID选第一位' : '输入姓名或ID选选手', g1) +
    (isDoubles ? evPickHtml('ms-p2', '输入姓名或ID选搭档', MS.type === 'mixed_doubles' ? '' : g1) : '');
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
    renderFixtureTitle();
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

// 旧赛事混双：第一位选手选定后，第二位搭档的联想框切成只出异性
// （和老下拉「选完第一位才出现第二位、且过滤性别」的行为一致）。
function evPickAfterChoose(pickId, p) {
  if (pickId !== 'ms-p1' || MS.type !== 'mixed_doubles') return;
  const p2 = document.getElementById('pp-ms-p2');
  if (p2) p2.dataset.gender = p.gender === 'male' ? 'female' : 'male';
  evPickClear('ms-p2');   // 第一位换了，原来的搭档选择作废
}

async function addParticipant() {
  const isDoubles = MS.type !== 'singles';
  const p1 = evPickValue('ms-p1');
  if (!p1) return alert(isDoubles ? '请从提示里选择第一位选手' : '请从提示里选择选手');
  const p1l = pn(p1);

  if (isDoubles) {
    const p2 = evPickValue('ms-p2');
    if (!p2) return alert('请从提示里选择第二位选手');
    if (p2 === p1) return alert('两位选手不能相同');
    if (MS.type === 'mixed_doubles') {
      const g1 = evGenderOf(p1), g2 = evGenderOf(p2);
      if (g1 && g2 && g1 === g2) return alert('混双搭档需要一男一女');
    }
    if (MS.participants.some(p => (p.p1 === p1 && p.p2 === p2) || (p.p1 === p2 && p.p2 === p1))) return alert('该组合已存在');
    MS.participants.push({ p1, p2, label: `${p1l} + ${pn(p2)}` });
    evPickClear('ms-p1');
    evPickClear('ms-p2');
  } else {
    if (MS.participants.some(p => p.p1 === p1)) return alert('该选手已添加');
    MS.participants.push({ p1, p2: null, label: p1l });
    evPickClear('ms-p1');
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

  // 同样换成联想输入框（姓名 / 比赛ID 都能搜），和新赛事非固搭录入一致
  await ensurePlayers();
  ['fm-pick1', 'fm-pick2', 'fm-pick3', 'fm-pick4'].forEach((cid, i) => {
    document.getElementById(cid).innerHTML = evPickHtml(`fm-p${i + 1}`, '输入姓名或ID选人');
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
  const [p1, p2, p3, p4] = ['fm-p1', 'fm-p2', 'fm-p3', 'fm-p4'].map(evPickValue);
  const s1 = parseInt(document.getElementById('fm-s1').value);
  const s2 = parseInt(document.getElementById('fm-s2').value);
  if (!p1 || !p2 || !p3 || !p4) return alert('请从提示里选择4名选手');
  if (new Set([p1, p2, p3, p4]).size !== 4) return alert('选手不能重复');
  if (isNaN(s1) || isNaN(s2)) return alert('请填写比分');
  if (s1 > 31 || s2 > 31 || s1 < 0 || s2 < 0) return alert('比分范围0-31');
  try {
    document.getElementById('fm-status').textContent = '⏳...';
    await api('/api/matches/direct', { method: 'POST', body: JSON.stringify({
      round_id: MS.roundId, player1_id: p1, player2_id: p2, player3_id: p3, player4_id: p4, team1_score: s1, team2_score: s2
    })});
    document.getElementById('fm-status').textContent = '✅ 已录入';
    ['fm-p1', 'fm-p2', 'fm-p3', 'fm-p4'].forEach(evPickClear);
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
  const lvl = parseInt(MS.level, 10) || 0;
  const d = n ? Math.round(lvl / n) : 0;
  // 与后端 calculatePlayerRankings 同口径，否则这里显示的积分会和总积分榜对不上
  // （真正写进积分榜的是后端那一份）：胜场与净胜分都相同才算并列 → 同名次 +
  // 积分取所跨名次的平均值，且单场积分不低于 0。
  const rows = [];
  let i = 0;
  while (i < n) {
    let j = i;
    const netI = sorted[i][1].pf - sorted[i][1].pa;
    while (j + 1 < n
      && sorted[j + 1][1].wins === sorted[i][1].wins
      && (sorted[j + 1][1].pf - sorted[j + 1][1].pa) === netI) j++;
    let sum = 0;
    for (let k = i; k <= j; k++) sum += Math.max(0, lvl - d * k);
    const avg = Math.round(sum / (j - i + 1));
    for (let k = i; k <= j; k++) rows.push({ s: sorted[k][1], rank: i + 1, pts: avg });
    i = j + 1;
  }
  h += '<h4 style="margin-top:16px">📊 选手排名</h4><table><thead><tr><th>#</th><th>选手</th><th>胜</th><th>负</th><th>得分</th><th>失分</th><th>净胜分</th><th>积分</th></tr></thead><tbody>';
  rows.forEach(r => {
    const s = r.s;
    h += `<tr>
      <td>${r.rank}</td>
      <td><strong>${s.name}</strong></td>
      <td style="color:#38a169">${s.wins}</td>
      <td style="color:#e53e3e">${s.losses}</td>
      <td>${s.pf}</td>
      <td>${s.pa}</td>
      <td>${s.pf - s.pa}</td>
      <td><strong>${r.pts}</strong></td>
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

// 标题行：三处（原标题 / 编辑后 / 取消编辑）都用这一个渲染，省得各写一份字符串
function renderFixtureTitle() {
  const box = document.getElementById('fixture-title');
  if (!box) return;
  box.innerHTML = `${MS.tname} - 第${MS.edition}届 (${MS.level}级)
    <button onclick="editRoundInfo()" style="font-size:11px;padding:1px 10px;margin-left:8px;vertical-align:middle">✏️ 编辑</button>`;
}

// 改届数 / 级别 / 日期。
// 坑史：以前是连弹三个 prompt，把 edition+date+level 一把提交 —— 只想改级别也得把
// 届数和日期重填一遍，填错就顺带改掉别的字段（客户端还会把旧值写回去覆盖）。
// 现在改成行内编辑：只把你真正改过的那几个字段发给服务端。
function editRoundInfo() {
  const box = document.getElementById('fixture-title');
  if (!box || !MS.roundId) return;
  box.innerHTML = `<span>${MS.tname} - 第${MS.edition}届</span>
    <input type="date" id="re-date" value="${MS.date}" style="font-size:12px;padding:2px 6px;margin-left:8px">
    <select id="re-level" style="font-size:12px;padding:2px 6px">
      ${[1000, 750, 500, 300].map(l => `<option value="${l}" ${MS.level === l ? 'selected' : ''}>${l}级</option>`).join('')}
    </select>
    <input type="number" id="re-edition" value="${MS.edition}" title="届数" style="font-size:12px;padding:2px 6px;width:64px">
    <button onclick="saveRoundInfo()" style="font-size:11px;padding:2px 10px">保存</button>
    <button class="secondary" onclick="renderFixtureTitle()" style="font-size:11px;padding:2px 10px">取消</button>`;
}

async function saveRoundInfo() {
  if (!MS.roundId) return;
  const cfg = 'round-edition', sdf = 'round-date';
  const ed = parseInt(document.getElementById('re-edition').value) || MS.edition;
  const dt = document.getElementById('re-date').value || MS.date;
  const lv = parseInt(document.getElementById('re-level').value) || MS.level;
  // 只把变了的字段放进请求体：服务端对 undefined 的字段一律不动，
  // 这样「只改级别」就不会顺带把日期也重写一遍。
  const body = {};
  if (ed !== MS.edition) body.edition = ed;
  if (dt !== MS.date) body.date = dt;
  if (lv !== MS.level) body.level = lv;
  if (!Object.keys(body).length) { renderFixtureTitle(); return; }
  const bits = [];
  if (body.edition !== undefined) bits.push(`届数 ${MS.edition} → ${ed}`);
  if (body.date !== undefined) bits.push(`日期 ${MS.date} → ${dt}`);
  if (body.level !== undefined) bits.push(`级别 ${MS.level} → ${lv}`);
  if (!confirm(`确认把「${MS.tname}」改成：\n${bits.join('\n')}？\n\n其余字段保持不变。`)) return;
  try {
    await api(`/api/rounds/${MS.roundId}`, { method: 'PUT', body: JSON.stringify(body) });
    MS.edition = ed; MS.date = dt; MS.level = lv;
    const e2 = document.getElementById(cfg), d2 = document.getElementById(sdf);
    if (e2) e2.value = ed;
    if (d2) d2.value = dt;
    cachedPlayers = [];
    invalidatePlayerQueryCache();
    renderFixtureTitle();
    const st = document.getElementById('save-round-status');
    if (st) st.textContent = '✅ 已保存：' + bits.join('、');
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
// 总积分之外，赛事按级别分成三个"带"，每个带只占一列，列内用下拉切换具体赛事
//   b1000：1000 级赛事
//   b750 ：750 级赛事（女生榜的国王杯750 例外，归到 b1000）
//   b500 ：500 级与 300 级赛事
const RANK_BANDS = [
  { id: 'b1000', label: '1000级' },
  { id: 'b750', label: '750级' },
  { id: 'b500', label: '500/300级' },
];
// 女生榜特有：这几个 750 级赛事不进 750 列，跟 1000 级排在一起
const FEMALE_750_IN_1000 = ['国王杯'];
// 每个带默认选中"最近一届日期"最新的赛事；用户手动选过之后就尊重选择
// 男女榜各带分别记录选中项与"是否手动选过"
const currentBandKey = { male: {}, female: {} };
const bandUserPicked = { male: {}, female: {} };
for (const g of ['male', 'female']) {
  for (const b of RANK_BANDS) { currentBandKey[g][b.id] = null; bandUserPicked[g][b.id] = false; }
}
// 总积分榜默认只显示前 10 名，点下方提示条展开完整榜单；男女榜各自记住展开状态
const RANK_LIMIT = 10;
let rankExpanded = { male: false, female: false };
function bandOf(key, gender) {
  const m = key.match(/^(.+)\((\d+)级\)$/);
  const level = m ? parseInt(m[2]) : 1000;
  const name = m ? m[1] : key;
  if (gender === 'female' && level === 750 && FEMALE_750_IN_1000.includes(name)) return 'b1000';
  if (level >= 1000) return 'b1000';
  if (level === 750) return 'b750';
  // 500、300 以及将来更低的级别统一归到最后一列
  return 'b500';
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
    // 计算每个 key 最近一届的日期（各级别带默认选中"日期最新"的一届）；顺带建立 赛事名→图标 映射
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
    // 赛事列只按「该性别选手实际拿过分的赛事」收集，绝不看赛事静态 type。
    // 血泪坑（2026-10-26 和哥报「女生没有显示第一届总决赛积分」）：总决赛第 1 届
    // 混双、第 2 届男单，tournaments.type 是赛事级静态字段、跟不上届级变化。
    // 原来按 type==='singles' 过滤会把 6 个女生的第一届混双积分
    // （917/750/583/416/249/82）整列藏掉——分计进了总分却看不到列，总分和列永远对不上。
    // 女生没打过的男单赛事（集帅杯/不紧张杯）在她 tournaments 里根本没有这个 key，
    // 天然不会出现，不需要 type 兜底；反而不如把列露出来，数据录错了也看得见。
    function getGenderKeys(gender) {
      const has = {};
      for (const p of points) {
        if (p.gender !== gender) continue;
        for (const k in p.tournaments) has[k] = true;
      }
      const out = {};
      for (const b of RANK_BANDS) out[b.id] = [];
      for (const key of sortedAll) {
        if (!has[key]) continue;
        out[bandOf(key, gender)].push(key);
      }
      // 带内先按级别降序（1000 列里女生榜的国王杯750 会排在 1000 级之后）
      for (const b of RANK_BANDS) out[b.id].sort(sortKeysByLevelDesc);
      return out;
    }
    function renderRankTable(players, label, deltas) {
      if (!players.length) return '';
      const gender = players[0].gender;
      const gk = getGenderKeys(gender);
      // 每个带各占一列：没手动选过就默认选中该带里"日期最新"的一届
      const bandSel = {};
      for (const b of RANK_BANDS) {
        const keys = gk[b.id];
        let k = currentBandKey[gender][b.id];
        if (keys.length && (!k || !keys.includes(k))) k = latestOf(keys);
        bandSel[b.id] = k;
      }
      // 表头：赛事图标（24px 圆角）显示在赛事名称上方，未设置图标的赛事保持原样
      // 图标单独占一行（block），与名称/级别行分离，避免把下拉箭头挤成孤行
      function tourIconHtml(name) {
        return `<img class="tour-icon" src="${iconMap[name]}" alt="" title="${htmlEsc(name)}">`;
      }
      // 三行（图标 / 名称 / 🕊级别）拆成独立块级元素，行距由 CSS margin 统一控制，
      // 避免依赖 <br> 的行盒堆叠（那样各断点间距会不一致）。arrowHtml 拼在级别行开头。
      // 赛事名超过 3 个字只显示前 3 个（如「总决赛（男单）」→「总决赛」），全称保留在 title 上悬停可见。
      function shortTourName(name) {
        return name.length > 3 ? name.slice(0, 3) : name;
      }
      function tourLabel(k, arrowHtml = '') {
        const m = k.match(/^(.+)\((\d+)级\)$/);
        if (m) {
          const full = m[1];
          return `<span class="tour-name" title="${htmlEsc(full)}">${shortTourName(full)}</span><span class="tour-lvl">${arrowHtml}🕊${m[2]}</span>`;
        }
        return `<span class="tour-name" title="${htmlEsc(k)}">${arrowHtml}${shortTourName(k)}</span>`;
      }
      function tourNameOf(k) {
        const m = k.match(/^(.+)\((\d+)级\)$/);
        return m ? m[1] : k;
      }
      function fmtKey(k) {
        const name = tourNameOf(k);
        return iconMap[name] ? tourIconHtml(name) + tourLabel(k) : tourLabel(k);
      }
      // 列布局：总积分之外固定三列 —— 1000 级 / 750 级 / 500+300 级，
      // 女生榜的国王杯750 已由 bandOf 归到 1000 列；空带不输出列
      // 下拉选项：日期最新的排最前
      const columns = RANK_BANDS
        .filter(b => gk[b.id].length)
        .map(b => ({ band: b.id, label: b.label, keys: byDateDesc(gk[b.id]), selected: bandSel[b.id] }));
      function dropdownTh(keys, selected, bandId) {
        const tip = keyLatestDate[selected] ? `最近一届 ${keyLatestDate[selected]}` : '';
        const nm = tourNameOf(selected);
        const iconPart = iconMap[nm] ? tourIconHtml(nm) : '';
        return `<th class="tour-th" onclick="toggleBandDropdown(this)" title="${tip}" style="cursor:pointer;user-select:none;position:relative">
        ${iconPart}${tourLabel(selected, `<span class="band-icon">▶</span> `)}
        <div class="low-dd" onclick="event.stopPropagation()" style="display:none;position:absolute;top:100%;left:0;background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:4px;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,0.15);white-space:nowrap">
          <select class="low-sel" data-band="${bandId}" onchange="changeBandTournament(this)" style="padding:4px;border-radius:4px">
            ${keys.map(k => `<option value="${k}" ${k === selected ? 'selected' : ''}>${k}${keyLatestDate[k] ? ' · ' + keyLatestDate[k] : ''}</option>`).join('')}
          </select>
        </div>
      </th>`;
      }
      let h = `<div class="card"><h3>${label}总积分排名</h3>`;
      h += `<div class="rank-table-wrap"><table class="rank-table" data-gender="${gender}"><thead><tr><th class="th-hero-cell"><span class="th-hero" style="background-image:url('${assetUrl(gender === 'male' ? '/syq.png' : '/ztqy.png')}')"></span></th><th class="th-key">姓<span class="th-gap"></span>名</th>`;
      for (const col of columns) h += dropdownTh(col.keys, col.selected, col.band);
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
          const t = col.selected ? p.tournaments[col.selected] : null;
          // 扣分标志只显示「最新一次事件」的符号，都是黄色系、深浅区分：
          // ▼ 亮黄＝时间扣（停办超半年）；▼ 深黄＝届扣（缺席当届）。
          // 同一站既被届扣又被时间扣时不叠加，只认最近发生的那个（时间扣更新）。
          let marks = '';
          if (t) {
            if (t.timeDeducted) marks += ' <span style="color:#ffbf00;font-weight:bold" title="时间扣：该站停办超过半年，每满 182 天扣 1 个 d">▼</span>';
            else if (t.deducted) marks += ' <span style="color:#b8860b" title="届扣：缺席当届，每缺一届扣 d/2">▼</span>';
          }
          h += `<td class="tour-td">${t ? t.points : 0}${marks}</td>`;
        }
        h += `<td class="total-td" style="vertical-align:middle;white-space:nowrap"><strong>${p.total_points}</strong> <span title="总积分排名变化（新赛事或时间扣引起）" style="display:inline-flex;flex-direction:column;align-items:center;line-height:1;color:${trendColor || '#ccc'};${trendVis};vertical-align:middle">
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

// 三个级别带共用一套下拉逻辑：band 由 select 上的 data-band 区分，
// 性别由所属表格的 data-gender 区分，男女榜各带互不干扰
function toggleBandDropdown(th) {
  const dd = th.querySelector('.low-dd');
  const icon = th.querySelector('.band-icon');
  if (!dd) return;
  const open = dd.style.display === 'none' || !dd.style.display;
  dd.style.display = open ? 'block' : 'none';
  if (icon) icon.textContent = open ? '▼' : '▶';
}

function changeBandTournament(sel) {
  const band = sel.dataset.band;
  if (!band) return;
  const g = (sel.closest('table') || {}).dataset?.gender || 'male';
  currentBandKey[g][band] = sel.value;
  bandUserPicked[g][band] = true;
  document.querySelectorAll('.low-dd').forEach(d => d.style.display = 'none');
  document.querySelectorAll('.band-icon').forEach(i => i.textContent = '▶');
  loadRankings();
}

// ==================== Query by Tournament + Edition ====================
// 赛事查询页左上角图标：赛事 id → 图标（base64），随下拉选中项更新
let tourIconById = {};
let tourIconByName = {};
let queryTournaments = [];
let queryTourGroups = [];

// 同品牌归组：共享同一图标 + 同名前缀（如「总决赛（男单）」「总决赛（混双）」）的赛事
// 在查询网格里合成一个图标。品牌 key 同时要求 icon 与去括号后的基名一致，
// 避免「图标碰巧相同但其实是不同赛事」被误并（图标是上传图，复制属于刻意行为）。
function buildTourGroups() {
  const byKey = {};
  queryTourGroups = [];
  for (const t of queryTournaments) {
    const base = (t.name || '').replace(/（[^）]*）\s*$/, '').trim() || (t.name || ('' + t.id));
    const key = t.icon ? ('ico:' + t.icon.length + ':' + base) : ('id:' + t.id);
    if (!byKey[key]) {
      byKey[key] = { base, icon: t.icon, members: [] };
      queryTourGroups.push(byKey[key]);
    }
    byKey[key].members.push(t);
  }
}

// 赛事图标按钮网格：点击某个赛事跳转到独立详情页（不再在原网格下方就地展开）
function renderTourGrid() {
  const g = document.getElementById('query-tour-grid');
  if (!g) return;
  // 格子内不再显示赛事名：每个图标本身就是带赛事名的 logo，文字纯属冗余，
  // 省下的高度全部让给图标（见 style.css 的 .tour-tile img）。
  // 但按钮不能因此变成"无标签按钮"，所以 title 保留（悬停可见）+ aria-label 补语义。
  // 同品牌多赛事（如总决赛的男单/混双）归为一个图标，点进去再选具体项目。
  g.innerHTML = queryTourGroups.map((grp, gi) => {
    const t0 = grp.members[0];
    const label = grp.members.length > 1 ? grp.base : (t0.name || '');
    const img = grp.icon
      ? `<img src="${grp.icon}" alt="">`
      : `<div class="tile-icon-ph">${htmlEsc((label || '?')[0])}</div>`;
    const badge = grp.members.length > 1 ? `<span class="tile-count">${grp.members.length}</span>` : '';
    return `
    <div class="tour-tile" data-gi="${gi}" onclick="onTourTileClick(${gi})"
         title="${htmlEsc(label)}" aria-label="${htmlEsc(label)}">
      ${img}${badge}
    </div>`;
  }).join('');
}

// 点网格图标：单赛事直接进详情；同品牌多赛事先弹「选具体项目」
function onTourTileClick(gi) {
  const grp = queryTourGroups[gi];
  if (!grp) return;
  if (grp.members.length === 1) { showTournamentLatest(grp.members[0].id); return; }
  openBrandPicker(grp);
}

// 同品牌多赛事的二级选择弹窗（纯 JS 动态遮罩，不依赖 index.html）
function openBrandPicker(grp) {
  let box = document.getElementById('brand-picker');
  if (box) box.remove();
  box = document.createElement('div');
  box.id = 'brand-picker';
  box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1200;display:flex;align-items:center;justify-content:center';
  const items = grp.members.map(m =>
    `<button class="bp-item" onclick="brandPickClose();showTournamentLatest(${m.id})">
       ${m.icon ? `<img src="${m.icon}" alt="">` : ''}
       <span>${htmlEsc(m.name)}</span>
     </button>`).join('');
  box.innerHTML = `
    <div class="bp-panel">
      <div class="bp-title">${htmlEsc(grp.base)} · 选择项目</div>
      <div class="bp-items">${items}</div>
      <button class="bp-cancel" onclick="brandPickClose()">取消</button>
    </div>`;
  box.onclick = (e) => { if (e.target === box) brandPickClose(); };
  document.body.appendChild(box);
}
function brandPickClose() {
  const box = document.getElementById('brand-picker');
  if (box) box.remove();
}

// 切入「赛事详情」独立视图：切 tab + 设标题。
// 头部只留「返回键 + 标题 + 赛事介绍」（赛事图标槽已移除，保持简洁）。
// 返回键是 HTML 里写死的 .back-btn → closeTourDetail()，两条入口（点图标 / 点查询）共用。
function openTourDetailPage(title, desc) {
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-tour-detail').classList.add('active');
  document.getElementById('detail-tour-title').textContent = title;
  // 赛事介绍（管理端编辑）：有则显示在赛事名下方，没有则整行隐藏
  const descEl = document.getElementById('detail-tour-desc');
  if (descEl) {
    if (desc && String(desc).trim()) {
      descEl.textContent = String(desc).trim();
      descEl.style.display = '';
    } else {
      descEl.textContent = '';
      descEl.style.display = 'none';
    }
  }
}

// 跳到某个赛事的详情页（独立 tab），并同步 URL 的 ?tid= 便于刷新/分享
async function showTournamentLatest(tid) {
  const t = queryTournaments.find(x => String(x.id) === String(tid));
  if (!t) return;

  // 同步 URL：replaceState 不产生历史记录，返回键行为完全由我们的按钮控制
  const url = new URL(location.href);
  url.searchParams.set('tid', tid);
  history.replaceState(null, '', url);

  // 详情页头部设标题 + 赛事介绍（顶部导航保持"赛事查询"高亮）
  openTourDetailPage(t.name, t.description);

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
  // 正停在某个人的本届对局页：先退回他的赛事卡片，别一下跳回网格
  if (rqPrevHtml !== null) { rqClosePlayerView(); return; }
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
  buildTourGroups();
  const sel = document.getElementById('query-tournament');
  // 新赛事也列在前台查询里，点进去走只读工作台；带 data-is-event 让各处能一眼区分新老赛事
  sel.innerHTML = '<option value="">全部赛事</option>' +
    tournaments.map(t => `<option value="${t.id}" data-type="${t.type}" data-level="${t.level}" data-is-event="${t.is_event ? 1 : 0}" data-event-id="${t.event_id || ''}">${t.name}</option>`).join('');
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

// 老赛事（一届一轮循环赛那套）的轮次卡片渲染下来只剩 HTML，
// 点人名要看对局得回查原始 round 数据，这里按 round.id 缓存一份。
const roundCardCache = {};

function renderRoundCard(round) {
  const isFree = round.tournament_name === '狗王杯';
  // 点最终排名里的人名要能看他的对局，数据在 round 对象里，卡片只留 HTML，故缓存一份
  roundCardCache[round.id] = round;
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
    h += `<tr><td>${r.rank}</td>${rqNameCellHtml(round, r)}<td>${r.wins}</td><td>${r.losses}</td><td>${r.net_points}</td><td>${r.points_earned}</td></tr>`;
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

// ---------------- 老赛事：最终排名点人名 → 此人本届对局 ----------------
// 与「创建赛事」那条链路（evNameBtnHtml / evAskPlayer）保持同样的两段式交互，
// 只是数据源从 event_ties 换成 round.teams + round.matches。

// 排名行是一个「参赛单位」：单打一个人，双打两个人是同一个整体 → 只做一个按钮
// 单位用 key 表示：「12」单人 / 「12_34」双打组合
function rqNameCellHtml(round, row) {
  const ids = [];
  for (const k of ['player_id', 'player1_id', 'player2_id']) {
    if (row[k] && !ids.includes(row[k])) ids.push(row[k]);
  }
  if (!ids.length) return '<td style="color:#a0aec0">—</td>';
  const key = ids.join('_');
  const label = ids.map(pn).join(' + ');
  return `<td><span class="ev-ask-wrap"><span class="ev-name-btn" role="button" tabindex="0"
    onclick="rqAskPlayer(${round.id},'${key}',this)">${htmlEsc(label)}</span></span></td>`;
}

function rqUnitLabel(key) {
  return String(key).split('_').map(id => pn(Number(id))).join(' + ');
}

// 这个参赛单位在本届用过的队伍 id（狗王杯这种自由组队，一个人可能出现多个队里）
function rqPlayerTeamIds(round, key) {
  const ids = String(key).split('_').map(Number);
  const all = (round.teams || []).filter(t => ids.every(id => t.player1_id === id || t.player2_id === id));
  if (all.length) return all.map(t => t.team_id);
  return (round.teams || [])
    .filter(t => ids.some(id => t.player1_id === id || t.player2_id === id))
    .map(t => t.team_id);
}

let rqAskBound = false;
let rqPrevHtml = null;
let rqPrevTitle = null;

function rqAskPlayer(roundId, unitKey, el) {
  const key = `${roundId}:${unitKey}`;
  const already = document.querySelector(`.ev-ask-bubble[data-key="${key}"]`);
  evCloseAsk();
  if (already) return;                       // 再点同一个名字 = 收起气泡
  if (!rqAskBound) {
    rqAskBound = true;
    // 同一次 click 事件还会冒泡到 document，故排除落在名字/气泡上的点击
    document.addEventListener('click', (e) => {
      if (e.target.closest('.ev-name-btn') || e.target.closest('.ev-ask-bubble')) return;
      evCloseAsk();
    });
  }
  const b = document.createElement('span');
  b.className = 'ev-ask-bubble';
  b.dataset.key = key;
  b.textContent = '查看此人对局';
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  b.onclick = (e) => { e.stopPropagation(); rqOpenPlayerMatches(roundId, unitKey); };
  b.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault(); rqOpenPlayerMatches(roundId, unitKey);
  };
  el.insertAdjacentElement('afterend', b);
  if (b.getBoundingClientRect().top < 4) b.classList.add('below');   // 顶到屏幕外就翻到名字下方
  b.focus();
}

function rqOpenPlayerMatches(roundId, unitKey) {
  evCloseAsk();
  const round = roundCardCache[roundId];
  const el = document.getElementById('tour-detail-body');
  if (!round || !el) return;
  rqPrevHtml = el.innerHTML;                 // 记下原卡片，返回时原样放回去
  const t = document.getElementById('detail-tour-title');
  rqPrevTitle = t ? t.textContent : null;
  el.innerHTML = rqPlayerViewHtml(round, unitKey);
  if (t) t.textContent = `${round.tournament_name} · ${rqUnitLabel(unitKey)}`;
  window.scrollTo(0, 0);
}

function rqClosePlayerView() {
  const el = document.getElementById('tour-detail-body');
  if (el && rqPrevHtml !== null) { el.innerHTML = rqPrevHtml; rqPrevHtml = null; }
  const t = document.getElementById('detail-tour-title');
  if (t && rqPrevTitle !== null) { t.textContent = rqPrevTitle; rqPrevTitle = null; }
}

function rqSideNames(m, which) {
  // which: 1 = 队伍1，2 = 队伍2；有真名用真名，没有就退回昵称
  const dn = (n, r) => r || n || '';
  const names = which === 1
    ? [dn(m.t1p1name, m.t1p1real), dn(m.t1p2name, m.t1p2real)]
    : [dn(m.t2p1name, m.t2p1real), dn(m.t2p2name, m.t2p2real)];
  return names.filter(Boolean).join(' + ') || '—';
}

function rqPlayerViewHtml(round, unitKey) {
  const ids = String(unitKey).split('_').map(Number);
  const myName = rqUnitLabel(unitKey);        // 双打是两个人的组合名，单打就是一个人的名字
  const teamIds = rqPlayerTeamIds(round, unitKey);
  const mine = (round.matches || []).filter(m => teamIds.includes(m.team1_id) || teamIds.includes(m.team2_id));
  const row = (round.ranking.rankings || []).find(r => {
    const rid = [r.player_id, r.player1_id, r.player2_id].filter(Boolean);
    return ids.every(id => rid.includes(id)) && rid.length === ids.length;
  });

  let wins = 0, losses = 0, draws = 0, rows = '';
  mine.forEach((m, i) => {
    const isT1 = teamIds.includes(m.team1_id);
    const my = isT1 ? m.team1_score : m.team2_score;
    const op = isT1 ? m.team2_score : m.team1_score;
    const played = my !== 0 || op !== 0;
    let resText = '未开打', resCls = 'pending';
    if (played) {
      if (my > op) { resText = '胜'; resCls = 'win'; wins++; }
      else if (my < op) { resText = '负'; resCls = 'lose'; losses++; }
      else { resText = '平'; draws++; }
    }
    // 对局列：两边选手都列出来，比分夹在中间 —— 「我方 21 : 15 对手」
    const sideOpp = htmlEsc(rqSideNames(m, isT1 ? 2 : 1));
    const matchCell = `<div class="ev-pv-match">
      <span class="ev-pv-side">${htmlEsc(myName)}</span>
      ${played ? `<b>${my} : ${op}</b>` : '<span class="ev-pv-none">未开打</span>'}
      <span class="ev-pv-side">${sideOpp}</span>
    </div>`;
    rows += `<tr>
      <td class="ev-pv-stage">第 ${i + 1} 场</td>
      <td>${matchCell}</td>
      <td class="ev-pv-res ${resCls}">${resText}</td>
    </tr>`;
  });

  const sum = `${mine.length} 场${mine.length ? `　胜 ${wins} / 负 ${losses}${draws ? ' / 平 ' + draws : ''}` : ''}`;
  // 返回键用详情页头部自带的那个（closeTourDetail 会先退回最终排名），这里不再重复画一个
  let h = '';
  if (row) {
    h += `<div class="card ev-brief" style="margin-bottom:12px">
      本届战绩：<strong>${row.wins} 胜 ${row.losses} 负</strong>，净胜分 ${row.net_points}，本届积分 ${row.points_earned}
    </div>`;
  }
  h += `<div class="card"><h3>本届对局 <span class="ev-hint">${sum}</span></h3>`;
  if (!mine.length) {
    h += `<div class="ev-empty">这个参赛单位本届还没有已录入的对局</div>`;
  } else {
    h += `<table class="ev-pv"><thead><tr><th>场次</th><th class="ev-pv-th-match">对局</th><th>结果</th></tr>
      <tbody>${rows}</tbody></table>`;
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
    openTourDetailPage(t.name, t.description);
    clearTidParam();
    showEventDetail(t.event_id);
    return;
  }
  openTourDetailPage(title, t ? t.description : '');
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
  h2hReturnView = null;
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
// 从「对阵查询」结果里点选手进详情时置为 'headtohead'，详情页返回键据此跳回对阵查询（查询框重新可见）。
let h2hReturnView = null;

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
    <div class="stat-mod stat-mod-link" title="${htmlEsc(rankTip)} · 点击查看历史排名曲线"
         onclick="location.href='/player-chart.html?name=' + encodeURIComponent('${safeName}') + '&from=player'">
      <div class="stat-value">${rankTxt}</div>
      <div class="stat-label">${rankYear ? rankYear + '年最高' : '年度最高'}</div>
      <div class="stat-link-hint">查看曲线</div>
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
      <button onclick="showPlayerDetail('${String(p.name).replace(/'/g, "\\'")}')" style="margin-bottom:12px;font-size:13px;padding:0;background:transparent;border:none;color:#3182ce;cursor:pointer">← 返回选手资料</button>
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
    let html = playerBackButtonHtml() + `
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
  h2hReturnView = null;
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  document.querySelector('[data-tab="headtohead"]').classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-headtohead').classList.add('active');
  document.getElementById('h2h-a1').value = name1;
  document.getElementById('h2h-b1').value = name2;
  document.getElementById('h2h-a2').value = '';
  document.getElementById('h2h-b2').value = '';
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

function goToPlayer(name, fromH2h) {
  h2hReturnView = fromH2h ? 'headtohead' : null;
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  document.querySelector('[data-tab="player-query"]').classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-player-query').classList.add('active');
  showPlayerDetail(name);
}

// 选手详情页左上角的返回键：来自对阵查询 → 切回对阵查询（表单+结果仍在 DOM，查询框重新可见）；
// 否则回到选手列表。直接切换 active 类、不触发 nav 的「清空对阵结果」逻辑，从而保留上次查询结果。
function goBackFromPlayerDetail() {
  if (h2hReturnView === 'headtohead') {
    document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
    document.querySelector('[data-tab="headtohead"]').classList.add('active');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-headtohead').classList.add('active');
    h2hExpandForm();   // 返回时把查询表单重新展开，方便改人再查
    h2hReturnView = null;
    return;
  }
  loadPlayerQueryList();
}

function playerBackButtonHtml() {
  const style = "margin-bottom:12px;font-size:13px;padding:0;background:transparent;border:none;color:#3182ce;cursor:pointer";
  if (h2hReturnView === 'headtohead') {
    return `<button onclick="goBackFromPlayerDetail()" style="${style}">← 返回对阵查询</button>`;
  }
  return `<button onclick="loadPlayerQueryList()" style="${style}">← 返回列表</button>`;
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

// ==================== 选手联想选择器（管理端录入用） ====================
// 下拉框换输入框：输入姓名 / 备注名 / 选手 ID 都能搜，选项带提示（和对阵查询同一套 ac-list）。
// gender 过滤（男双只出男、女双只出女）；pool 限定候选范围（团体排阵只出本队队员）。
// 选中后 pid 记在 EVP[pickId].pid，取旧用 evPickValue(pickId)。
const EVP = {};   // pickId -> { pid, label }

function evPickPoolById(pid) {
  const p = (suggestPlayers || []).find(x => x.id === pid);
  return p ? displayName(p) : '';
}

function evPickHtml(pickId, placeholder, gender, pool, val, attrs) {
  const label = val ? evPickPoolById(val) : '';
  EVP[pickId] = { pid: val || 0, label };
  return `<div class="ev-ppick"><input type="text" class="ev-ppick-in" id="pp-${pickId}"
      placeholder="${htmlEsc(placeholder || '输入姓名或ID搜索')}" autocomplete="off"
      value="${htmlEsc(label)}" data-gender="${gender || ''}"
      data-pool="${pool && pool.length ? pool.join(',') : ''}"${attrs ? ' ' + attrs : ''}
      oninput="evPickInput('${pickId}')" onfocus="evPickInput('${pickId}')"
      onkeydown="evPickKey(event, '${pickId}')">
    <div class="ac-list" id="ac-pp-${pickId}"></div></div>`;
}

// 姓名 / 备注名包含或前缀匹配；纯数字输入额外按选手 ID 匹配（排在最前）
function matchPlayersEx(q, gender, pool) {
  let all = suggestPlayers || [];
  if (pool && pool.length) { const set = new Set(pool); all = all.filter(p => set.has(p.id)); }
  if (gender) all = all.filter(p => p.gender === gender);
  const k = String(q || '').trim().toLowerCase();
  if (!k) return all.slice().sort((a, b) => displayName(a).localeCompare(displayName(b), 'zh')).slice(0, 30);
  const isNum = /^\d+$/.test(k);
  const byId = [], starts = [], contains = [];
  for (const p of all) {
    const real = String(p.real_name || '').toLowerCase();
    const name = String(p.name || '').toLowerCase();
    const idStr = String(p.id);
    if (isNum && (idStr.startsWith(k) || idStr.includes(k))) byId.push(p);
    if (real.startsWith(k) || name.startsWith(k)) starts.push(p);
    else if (real.includes(k) || name.includes(k)) contains.push(p);
  }
  return byId.concat(starts, contains).slice(0, 30);
}

async function evPickInput(pickId) {
  await ensureSuggestPlayers();
  const input = document.getElementById('pp-' + pickId);
  const list = document.getElementById('ac-pp-' + pickId);
  if (!input || !list) return;
  const q = input.value;
  // 一开始输入就视为「还没选定」，避免留着上一次的 pid 造成错选
  if (EVP[pickId]) { EVP[pickId].pid = 0; EVP[pickId].label = ''; }
  const items = matchPlayersEx(q, input.dataset.gender || '', (input.dataset.pool || '').split(',').map(Number).filter(Boolean));
  suggestState['pp-' + pickId] = { items, active: -1 };
  if (!items.length) {
    list.innerHTML = '<div class="ac-empty">没找到匹配的选手</div>';
    list.classList.add('open');
    return;
  }
  list.innerHTML = items.map((p, i) => {
    const real = p.real_name || '';
    const dn = displayName(p);
    const namePart = hl(dn, q);
    const idPart = real && real !== p.name ? `<span class="ac-id">${hl(p.name, q)}</span>` : '';
    return `<div class="ac-item" data-i="${i}" onmousedown="evPickChoose(event, '${pickId}', ${i})">
      <span class="ac-name">${namePart}</span>${idPart}<span class="ac-pid">ID ${p.id}</span></div>`;
  }).join('');
  list.classList.add('open');
}

function evPickChoose(ev, pickId, idx) {
  ev.preventDefault();   // 防止 blur 先触发导致列表提前关闭
  const st = suggestState['pp-' + pickId];
  if (!st || !st.items[idx]) return;
  const p = st.items[idx];
  const input = document.getElementById('pp-' + pickId);
  if (input) input.value = displayName(p);
  EVP[pickId] = { pid: p.id, label: displayName(p) };
  closePlayerSuggest('pp-' + pickId);
  // 选中后的全局钩子（函数声明会提升，这里始终可调）；
  // 旧赛事混双靠它把第二位搭档框切成只出异性，见 evPickAfterChoose。
  if (typeof evPickAfterChoose === 'function') evPickAfterChoose(pickId, p);
}

// 键盘上下 / Enter / Esc。逻辑与 onPlayerSuggestKey 相同，只是选中回调不同。
function evPickKey(ev, pickId) {
  const st = suggestState['pp-' + pickId];
  const list = document.getElementById('ac-pp-' + pickId);
  if (!list || !list.classList.contains('open') || !st || !st.items.length) return false;
  const n = st.items.length;
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    st.active = (st.active + 1) % n;
    paintActive('pp-' + pickId);
    return true;
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    st.active = (st.active - 1 + n) % n;
    paintActive('pp-' + pickId);
    return true;
  } else if (ev.key === 'Enter') {
    const idx = st.active >= 0 ? st.active : 0;   // 没手动选中时默认第一条
    ev.preventDefault();
    evPickChoose(ev, pickId, idx);
    return true;
  } else if (ev.key === 'Escape') {
    closePlayerSuggest('pp-' + pickId);
    return true;
  }
  return false;
}

function evPickValue(pickId) {
  return (EVP[pickId] && EVP[pickId].pid) || 0;
}

// 清空一个联想框（输入框文本 + 选中态 + 收起下拉）。录完一条后重置用。
function evPickClear(pickId) {
  const input = document.getElementById('pp-' + pickId);
  if (input) input.value = '';
  if (EVP[pickId]) { EVP[pickId].pid = 0; EVP[pickId].label = ''; }
  closePlayerSuggest('pp-' + pickId);
}

// 从渲染好的输入框元素反查 pid（evSaveTie 收集团体排阵用）
function evPickValueOf(el) {
  if (!el || !el.id) return 0;
  return (EVP[el.id.replace(/^pp-/, '')] && EVP[el.id.replace(/^pp-/, '')].pid) || 0;
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
// A 方 1~2 人 vs B 方 1~2 人：填 2 人=单打交手；填 3~4 人=双打（同侧两人作为搭档必须都在同一边）
async function queryHeadToHead() {
  const gv = id => (document.getElementById(id).value || '').trim();
  const A = [gv('h2h-a1'), gv('h2h-a2')].filter(Boolean);
  const B = [gv('h2h-b1'), gv('h2h-b2')].filter(Boolean);
  const el = document.getElementById('h2h-result');
  if (!A.length || !B.length) return alert('A 方、B 方都至少填一位选手');
  const all = A.concat(B);
  if (new Set(all).size !== all.length) return alert('同一位选手不要重复填写');
  el.innerHTML = '<div class="loading">查询中...</div>';
  try {
    const qs = new URLSearchParams({ a1: A[0], b1: B[0] });
    if (A[1]) qs.set('a2', A[1]);
    if (B[1]) qs.set('b2', B[1]);
    const data = await api('/api/headtohead?' + qs.toString());
    const h2h = data.head_to_head;
    const esc = n => n.replace(/'/g, "\\'");
    function avatarHtml(p, size) {
      const inner = p.avatar ? `<img src="${p.avatar}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block;margin:0 auto 6px">` : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.35)}px;color:#a0aec0;margin:0 auto 6px;cursor:pointer" onclick="goToPlayer('${esc(p.name)}', true)">${p.name[0]}</div>`;
      if (p.avatar) return `<a href="#" onclick="goToPlayer('${esc(p.name)}', true);return false" style="text-decoration:none;display:block">${inner}</a>`;
      return inner;
    }
    // 双人搭档：头像缩小、名字用 + 连接，避免窄屏挤成三行
    function sideHtml(team, wins, cls) {
      const size = team.length > 1 ? 46 : 64;
      return `<div class="h2h-summary-side" style="text-align:center">
        <div class="h2h-avatars">${team.map(p => avatarHtml(p, size)).join('')}</div>
        <strong style="font-size:${team.length > 1 ? 16 : 20}px">${team.map(p => displayName(p)).join(' + ')}</strong><br>
        <span class="badge ${cls}">${wins} 胜</span>
      </div>`;
    }
    let html = `<div class="card h2h-summary"><div class="h2h-summary-row">
      ${sideHtml(data.teamA, h2h.a_wins, 'badge-win')}
      <div class="big-score">${h2h.a_wins} : ${h2h.b_wins}</div>
      ${sideHtml(data.teamB, h2h.b_wins, 'badge-loss')}
    </div><div class="h2h-vs" style="margin-top:8px">共交手 ${h2h.total} 次</div></div>`;
    if (data.matches.length) {
      const aId = data.teamA[0].id;
      html += `<div class="card"><h3>交手记录</h3>`;
      for (const m of data.matches) {
        const t1 = m.team1.players.map(p => displayName(p)).join(' + ');
        const t2 = m.team2.players.map(p => displayName(p)).join(' + ');
        // A 方在哪边就按哪边的比分判胜负，A 方一侧加粗
        const aOnT1 = m.team1.players.some(p => p.id === aId);
        const win = aOnT1 ? m.team1.score > m.team2.score : m.team2.score > m.team1.score;
        html += `<div class="match-history-item ${win ? '' : 'loss'}">
          <strong>${m.tournament}</strong> 第${m.edition}届 | ${m.date}<br>
          ${aOnT1 ? `<b>${t1}</b>` : t1} <strong>${m.team1.score} : ${m.team2.score}</strong> ${aOnT1 ? t2 : `<b>${t2}</b>`}
          <span style="float:right">${win ? '✅' : '❌'}</span>
        </div>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
    h2hCollapseForm();   // 查完后收起查询表单，结果区更干净；想改人点「修改查询」再展开
  } catch (e) { el.innerHTML = `<div class="card"><div class="loading" style="color:#e53e3e">${e.message}</div></div>`; }
}

// 对阵查询：查完后把上方的 A/B 查询表单收起（只留「修改查询」按钮），避免结果区被表单挤占。
function h2hCollapseForm() {
  const f = document.querySelector('#tab-headtohead .h2h-form');
  const tip = document.querySelector('#tab-headtohead .h2h-tip');
  const btn = document.getElementById('h2h-edit-query');
  if (f) f.style.display = 'none';
  if (tip) tip.style.display = 'none';
  if (btn) btn.style.display = '';
}
function h2hExpandForm() {
  const f = document.querySelector('#tab-headtohead .h2h-form');
  const tip = document.querySelector('#tab-headtohead .h2h-tip');
  const btn = document.getElementById('h2h-edit-query');
  if (f) f.style.display = '';
  if (tip) tip.style.display = '';
  if (btn) btn.style.display = 'none';
  const a1 = document.getElementById('h2h-a1');
  if (a1) a1.focus();
}

// ==================== 日志 ====================

// 服务端新增 action 时要同步三处：这里（徽章文案）、index.html 的 #log-op-filters 筛选项、
// style.css 的 .log-badge-<action> 配色。缺任何一处都会变成「日志里有、页面上显示成原始 action 名」。
// ⚠️ 新引擎（events/editions/ties）的录改比分刻意复用 match_add/update/delete 三个 action：
//    语义一样（都是录/改/删一场比分），只是存在不同的表里，没必要再造三个同义 chip。
const LOG_ACTION_LABELS = {
  tournament_add: '赛事添加', tournament_delete: '赛事删除',
  edition_add: '届次创建', edition_update: '届次修改', edition_delete: '届次删除',
  round_add: '轮次创建', round_update: '轮次修改', round_delete: '轮次删除',
  match_add: '比分录入', match_update: '比分修改', match_delete: '比分删除',
  groups_set: '分组调整', fixture_generate: '对阵生成', ko_swap: '签表调整',
  edition_move: '届次迁移', template_manage: '赛制模板',
  player_add: '选手添加', player_update: '信息更新', player_delete: '选手删除'
};
const LOG_PAGE_SIZE = 30;
// 赛历/操作日志默认只显示前 N 条，其余折叠，点底部按钮展开（和哥 2026-10-24 要求）
const LOG_COLLAPSE_LIMIT = 2;
// 折叠状态按列表容器 id 记；重新查询/切换筛选时重置为收起
const logCollapse = {};
const logPages = { op: { action: '', offset: 0, loading: false, done: false } };
// 日志多选：id 集合（操作日志唯一一类）
const logSelected = new Set();

// 折叠/展开通用逻辑：前 LOG_COLLAPSE_LIMIT 条照常显示，其余加 .log-fold-hidden，
// 底部按钮在「展开全部（N 条）」/「收起」之间切换；总数 ≤ N 时按钮隐藏。
function applyLogCollapse(listId, btnId, totalOverride) {
  const list = document.getElementById(listId);
  const btn = document.getElementById(btnId);
  if (!list || !btn) return;
  const items = [...list.querySelectorAll('.log-item')];
  const state = logCollapse[listId] || (logCollapse[listId] = { expanded: false });
  const shown = state.expanded ? items.length : Math.min(LOG_COLLAPSE_LIMIT, items.length);
  items.forEach((el, i) => el.classList.toggle('log-fold-hidden', i >= shown));
  const total = typeof totalOverride === 'number' ? totalOverride : items.length;
  if (total > LOG_COLLAPSE_LIMIT) {
    btn.style.display = '';
    btn.textContent = state.expanded
      ? `收起，仅显示前 ${LOG_COLLAPSE_LIMIT} 条`
      : `展开全部（${total} 条）`;
  } else {
    btn.style.display = 'none';
  }
}

function logTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function logItemHtml(item) {
  const label = LOG_ACTION_LABELS[item.action] || item.action;
  const body = `<div class="log-summary">${htmlEsc(item.summary)}</div>`;
  return `<div class="log-item">
    <label class="log-check" title="勾选后可批量删除"><input type="checkbox" data-id="${item.id}" onchange="onLogCheck(this)"></label>
    <div class="log-item-body">
      <div class="log-item-head">
        <span class="log-badge log-badge-${item.action}">${label}</span>
        <span class="log-time">${logTime(item.created_at)}</span>
      </div>
      ${body}
    </div>
  </div>`;
}

async function fetchLogPage(append) {
  const st = logPages.op;
  if (st.loading || st.done) return;
  st.loading = true;
  const listEl = document.getElementById('log-op-list');
  if (!append) {
    st.offset = 0; st.done = false;
    // 重新加载（含切换筛选）= 重新折叠
    logCollapse['log-op-list'] = { expanded: false };
    listEl.innerHTML = '<div class="log-empty">加载中…</div>';
  }
  try {
    const params = new URLSearchParams({
      type: 'operation',
      limit: String(LOG_PAGE_SIZE),
      offset: String(st.offset)
    });
    if (st.action) params.set('action', st.action);
    const data = await api('/api/logs?' + params.toString());
    if (!append) { listEl.innerHTML = ''; logSelected.clear(); refreshLogDelButtons(); }
    if (!data.items.length && !append) {
      listEl.innerHTML = '<div class="log-empty">暂无记录</div>';
    } else {
      for (const item of data.items) {
        const div = document.createElement('div');
        div.innerHTML = logItemHtml(item);
        listEl.appendChild(div.firstElementChild);
      }
    }
    st.offset += data.items.length;
    st.total = data.total;
    st.done = st.offset >= data.total;
    applyLogCollapse('log-op-list', 'log-op-more', st.total);
    refreshLogDelButtons();   // 顺带同步全选框三态
  } catch (e) {
    listEl.innerHTML = `<div class="log-empty" style="color:#e53e3e">加载失败：${e.message}</div>`;
    applyLogCollapse('log-op-list', 'log-op-more', 0);
    refreshLogDelButtons();   // 列表空了，全选框/删除按钮复位
  }
  st.loading = false;
}

// ---- 日志多选删除 ----
// 勾选框挂在每条日志上，选中后点卡片右上角「🗑 删除选中」批量删。
function onLogCheck(cb) {
  const id = Number(cb.dataset.id);
  if (cb.checked) logSelected.add(id);
  else logSelected.delete(id);
  refreshLogDelButtons();
}

// 全选框：一键勾选当前筛选下的全部日志。
// 分页没加载完时先把剩余页拉完再全勾（操作日志一页 30 条，最多两三下就到底），
// 这样「全选」语义 = 当前筛选的全部，而不是只有眼前这几条。
async function onLogCheckAll(cb) {
  const st = logPages.op;
  if (cb.checked) {
    while (!st.done) {
      const before = st.offset;
      await fetchLogPage(true);
      if (st.offset === before) break;   // 防死循环：没加载到新数据就收手
    }
    // 全选 = 选全部，顺手展开列表，不然只看到前 2 条被勾、其余藏着
    logCollapse['log-op-list'] = { expanded: true };
    document.querySelectorAll('#log-op-list input[type="checkbox"]').forEach(c => {
      c.checked = true;
      logSelected.add(Number(c.dataset.id));
    });
  } else {
    logSelected.clear();
    document.querySelectorAll('#log-op-list input[type="checkbox"]').forEach(c => c.checked = false);
  }
  applyLogCollapse('log-op-list', 'log-op-more', st.total);
  refreshLogDelButtons();
}

// 全选框三态：全勾→选中；部分勾→半选(indeterminate)；没勾/列表空→未选
function updateCheckAllState() {
  const all = document.getElementById('log-op-check-all');
  if (!all) return;
  const boxes = [...document.querySelectorAll('#log-op-list input[type="checkbox"]')];
  if (!boxes.length) { all.checked = false; all.indeterminate = false; return; }
  const n = boxes.filter(b => b.checked).length;
  all.checked = n === boxes.length;
  all.indeterminate = n > 0 && n < boxes.length;
}

function refreshLogDelButtons() {
  const btn = document.getElementById('log-op-del');
  if (!btn) return;
  btn.disabled = !logSelected.size;
  btn.textContent = logSelected.size ? `🗑 删除选中（${logSelected.size}）` : '🗑 删除选中';
  updateCheckAllState();
}

async function deleteSelectedLogs() {
  if (!logSelected.size) return;
  const ids = [...logSelected];
  if (!confirm(`确定删除选中的 ${ids.length} 条日志？删除后不可恢复。`)) return;
  try {
    await api('/api/logs', { method: 'DELETE', body: JSON.stringify({ ids }) });
    logSelected.clear();
    refreshLogDelButtons();
    // 上一页可能已加载完（done=true），不重置会被 fetchLogPage 开头守卫挡掉、列表不刷新
    logPages.op.done = false;
    fetchLogPage(false);
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}

// 赛历展开/收起：无分页，直接切折叠态
function toggleCalExpand() {
  const state = logCollapse['log-cal-list'] || (logCollapse['log-cal-list'] = { expanded: false });
  state.expanded = !state.expanded;
  applyLogCollapse('log-cal-list', 'log-cal-more');
}

// 操作日志展开/收起：展开前若分页还没拉完，先把剩余页加载完，
// 保证「展开全部（N 条）」的 N 与真实全部一致
async function toggleOpExpand() {
  const st = logPages.op;
  const state = logCollapse['log-op-list'] || (logCollapse['log-op-list'] = { expanded: false });
  if (!state.expanded && !st.done) {
    while (!st.done) {
      const before = st.offset;
      await fetchLogPage(true);
      if (st.offset === before) break;
    }
  }
  state.expanded = !state.expanded;
  applyLogCollapse('log-op-list', 'log-op-more', st.total);
}

document.getElementById('log-op-filters').addEventListener('click', e => {
  const btn = e.target.closest('.log-chip');
  if (!btn) return;
  document.querySelectorAll('#log-op-filters .log-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  logPages.op.done = false;   // 上一筛选可能已加载完，不重置 done 会挡住新筛选的请求
  logPages.op.action = btn.dataset.action;
  fetchLogPage(false);
});

// 低频筛选项默认收起，点「更多筛选 ▾」展开。
// 注意：这个按钮刻意不带 .log-chip，否则会被上面的 chip 点击逻辑当成「筛选」处理。
function toggleLogFilters(btn) {
  const box = document.getElementById('log-op-filters');
  if (!box) return;
  const open = box.classList.toggle('rare-open');
  if (btn) btn.textContent = open ? '收起筛选 ▴' : '更多筛选 ▾';
  // 如果当前选中的正好是被收起来的那一项，收起时要把高亮退回「全部」，
  // 否则会看不出到底在筛什么
  const active = box.querySelector('.log-chip.active');
  if (!open && active && active.classList.contains('log-chip-rare')) {
    active.classList.remove('active');
    const all = box.querySelector('.log-chip[data-action=""]');
    if (all) all.classList.add('active');
    logPages.op.done = false;
    logPages.op.action = '';
    fetchLogPage(false);
  }
}

// 历史排名快照：不填日期＝当前
async function queryRankSnapshot() {
  const date = document.getElementById('log-rank-date').value;
  const el = document.getElementById('log-rank-result');
  el.innerHTML = '<div class="log-empty">回放计算中…</div>';
  try {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    const data = await api('/api/logs/rankings?' + params.toString());
    el.innerHTML = renderRankSnapshot(data);
  } catch (e) {
    el.innerHTML = `<div class="log-empty" style="color:#e53e3e">查询失败：${e.message}</div>`;
  }
}

function renderRankSnapshot(data) {
  const table = (title, rows) => `
    <div class="log-rank-block">
      <h4>${title}（${rows.length} 人）</h4>
      <div class="rank-table-wrap"><table class="rank-table"><thead><tr><th>名次</th><th>姓名</th><th>总积分</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><span class="badge ${r.rank === 1 ? 'badge-gold' : r.rank === 2 ? 'badge-silver' : r.rank === 3 ? 'badge-bronze' : ''}">${r.rank}</span></td><td style="white-space:nowrap">${htmlEsc(r.name)}${r.real_name ? `（${htmlEsc(r.real_name)}）` : ''}</td><td>${r.points}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
  return `<div class="log-rank-meta">📅 ${data.date} 的排名快照（积分衰减结算至该日）</div>`
       + table('男子', data.male) + table('女子', data.female);
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

// 赛制四选一。free = 非固搭双打（狗王杯那类）：没有固定组合，每场临时配对，名次记在个人头上
const EVENT_FORMAT_DEFS = [
  { code: 'rr', name: '单循环赛', hasGroup: true },
  { code: 'ko', name: '淘汰赛', hasGroup: false },
  { code: 'group_ko', name: '小组赛+淘汰赛', hasGroup: true },
  { code: 'free', name: '非固搭双打', hasGroup: false }
];
const EVENT_FORMAT_MAP = Object.fromEntries(EVENT_FORMAT_DEFS.map(f => [f.code, f]));
const EVENT_BEST_OF_DEFS = [{ n: 1, name: '一局定胜负' }, { n: 3, name: '三局两胜' }];

// 非固搭双打打哪个项目。它决定上场人的性别与按什么口径统计个人战绩。
const FREE_KIND_DEFS = [
  { code: 'md', name: '男双', hint: '只上男选手，只统计男选手的个人战绩' },
  { code: 'wd', name: '女双', hint: '只上女选手' },
  { code: 'xd', name: '混双', hint: '每场 2 男 2 女，每边固定 1 男 1 女' }
];
const FREE_KIND_MAP = Object.fromEntries(FREE_KIND_DEFS.map(k => [k.code, k]));
const freeKindLabel = k => (FREE_KIND_MAP[k] || FREE_KIND_DEFS[0]).name;

// 种子排序依据：只影响「蛇形分组的先后」和「纯淘汰赛的落位」，不影响任何比分计算。
const SEED_BY_DEFS = [
  { code: 'entry', name: '按录入顺序', hint: '你录名单的先后就是种子顺序' },
  { code: 'points', name: '按总积分（种子）', hint: '按参赛选手积分、双打两人平均分、队伍成员总分降序，强队/高分选手分散到各组' }
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
  templates: [],       // 赛制模板（「怎么打」的预设快照）
  detail: null,          // 某一届的完整数据（工作台用）
  editions: [],          // 当前赛事的全部届次（详情页的届次切换器用；只有一届就不显示切换）
  expanded: null,        // 展开录入的 tieId
  pick: null,            // 签表待交换的位置 {ko_round, slot, side}
  canSwap: false,        // 淘汰赛是否还没开打（只有没开打才允许调签表）
  readonly: false,
  host: 'events',        // events | match | query —— 工作台渲染进哪个容器
  editingId: null,       // 正在改赛制的赛事 id（null = 新建）
  showTies: false,       // 前台只读：对阵默认折叠，点「查看比赛详情」才展开
  playerView: null,      // 最终排名点某人后进入的个人对局页 {entryId, memberId}；null = 不在该页
  draft: {
    name: '', kind: 'individual', type: '', format: 'rr', bestOf: 3, freeKind: 'md',
    thirdPlace: false, lowerPlace: false, groupCount: 2, advancePerGroup: 1,
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
function evMemberCellHtml(memberIds, entryId) {
  const ids = memberIds || [];
  if (!ids.length) return '<td style="color:#a0aec0">—</td>';
  // 展开后每个队员名字也是按钮：点进去只看他本人出场的项目
  const names = ids.map(id => evNameBtnHtml(entryId, pn(id), id)).join('、');
  return `<td><details class="ev-roster"><summary>👥 ${ids.length} 人</summary>
    <div class="ev-roster-body">${names}</div></details></td>`;
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
  await evLoadTemplates();
  await evRenderList();
}

async function evRenderList() {
  await ensurePlayers();
  try { EVS.list = await api('/api/events'); } catch (e) { EVS.list = []; }
  document.getElementById('event-page').innerHTML = evFormHtml() + evTemplatePanelHtml() + evEventListHtml();
}

// ---------------- 赛制模板 ----------------

async function evLoadTemplates() {
  try { EVS.templates = await api('/api/event-templates'); } catch (e) { EVS.templates = []; }
}

function evTemplateSummary(t) {
  const bits = [evKindLabel(t.kind), evFormatLabel(t.format), evBestOfLabel(t.best_of)];
  if (t.kind === 'team' && t.items && t.items.length) bits.push(`${t.items.length} 项`);
  if (evFormatHasGroup(t.format) && t.format !== 'rr') bits.push(`${t.group_count || 1} 组`);
  if (t.format === 'group_ko') bits.push(`出线 ${t.advance_per_group || 1}`);
  if (t.third_place) bits.push('季军赛');
  if (t.lower_bracket) bits.push('败者组');
  return bits.join(' · ');
}

// 表单顶部的模板条：新建时「选模板一键填充」；任何时候都能把当前表单存成模板。
function evTemplateBarHtml() {
  const editing = !!EVS.editingId;
  const tpls = EVS.templates || [];
  const sel = tpls.length
    ? `<select id="ev-tpl-sel" style="max-width:230px">
         <option value="">选择模板…</option>
         ${tpls.map(t => `<option value="${t.id}">${htmlEsc(t.name)}（${htmlEsc(evTemplateSummary(t))}）</option>`).join('')}
       </select>
       <button class="secondary" onclick="evApplyTemplate()">填充</button>`
    : `<span class="ev-hint">还没有模板。填好下面的赛制，点「存为模板」即可保存预设。</span>`;
  return `<div class="ev-sec">
    <div class="ev-sec-title">赛制模板 <span class="ev-hint">「怎么打」的预设：一键填充 / 存下来复用</span></div>
    <div class="form-row" style="flex-wrap:wrap;gap:8px;align-items:center">
      ${editing ? '<span class="ev-hint">编辑已有赛事的赛制，不适用模板填充；可以直接存为新模板。</span>' : sel}
      <input type="text" id="ev-tpl-name" placeholder="模板名称，例如：总决赛赛制" style="max-width:200px">
      <button class="secondary" onclick="evSaveTemplate()">💾 存为模板</button>
    </div>
  </div>`;
}

// 模板只管「怎么打」，赛事名永远留给用户自己起（总决赛（男单）/ 总决赛（混双）这类）
async function evApplyTemplate() {
  const sel = document.getElementById('ev-tpl-sel');
  const id = sel && parseInt(sel.value);
  if (!id) return;
  const t = (EVS.templates || []).find(x => x.id === id);
  if (!t) return;
  EVS.draft = {
    name: EVS.draft.name,
    kind: t.kind, format: t.format, bestOf: t.best_of || 3,
    freeKind: t.free_kind || 'md',
    thirdPlace: !!t.third_place, lowerPlace: !!t.lower_bracket,
    groupCount: t.group_count || 1, advancePerGroup: t.advance_per_group || 1,
    seedBy: t.seed_by || 'entry', groupMode: t.group_mode || 'snake', koMode: t.ko_mode || 'seed',
    items: (t.items && t.items.length) ? t.items.slice() : ['ms', 'ws', 'md']
  };
  await evRenderList();
  const msg = document.getElementById('ev-create-msg');
  if (msg) { msg.style.color = '#38a169'; msg.textContent = `✅ 已按模板「${t.name}」填充，起个赛事名就能创建`; }
}

async function evSaveTemplate() {
  const nameEl = document.getElementById('ev-tpl-name');
  const name = (nameEl.value || '').trim();
  const msg = document.getElementById('ev-create-msg');
  if (!name) {
    if (msg) { msg.style.color = '#e53e3e'; msg.textContent = '先给模板起个名字'; }
    if (nameEl) nameEl.focus();
    return;
  }
  const body = evCollectForm();
  body.name = name;
  try {
    await api('/api/event-templates', { method: 'POST', body: JSON.stringify(body) });
    await evLoadTemplates();
    await evRenderList();
    if (msg) { msg.style.color = '#38a169'; msg.textContent = `✅ 模板「${name}」已保存`; }
  } catch (e) { if (msg) { msg.style.color = '#e53e3e'; msg.textContent = e.message; } }
}

async function evDeleteTemplate(id) {
  const t = (EVS.templates || []).find(x => x.id === id);
  if (!t) return;
  if (!confirm(`删除赛制模板「${t.name}」？\n已经用它创建的赛事不受影响。`)) return;
  try {
    await api('/api/event-templates/' + id, { method: 'DELETE' });
    await evLoadTemplates();
    await evRenderList();
  } catch (e) { alert(e.message); }
}

// 模板管理面板：模板是快照、不自动同步 —— 改完模板在这里勾选赛事点应用，才会刷过去。
// 只列同类型（单项/团体）的赛事：类型不一致应用会毁历史，那种需求走「修改赛制」。
function evTemplatePanelHtml() {
  const tpls = EVS.templates || [];
  if (!tpls.length) return '';
  const cards = tpls.map(t => {
    const same = EVS.list.filter(e => e.kind === t.kind);
    const checks = same.map(e => `<label style="display:inline-flex;align-items:center;gap:4px;margin:3px 12px 3px 0;font-size:13px">
      <input type="checkbox" class="ev-tpl-apply-${t.id}" value="${e.id}">${htmlEsc(e.name)}</label>`).join('');
    return `<div class="ev-card-row" style="display:block">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>${htmlEsc(t.name)}</strong> <span class="ev-hint">${htmlEsc(evTemplateSummary(t))}</span></div>
        <button class="secondary" style="font-size:12px" onclick="evDeleteTemplate(${t.id})">删除</button>
      </div>
      ${same.length ? `<div style="margin-top:6px">${checks}
        <button style="font-size:12px;padding:3px 10px" onclick="evApplyTemplateToEvents(${t.id})">应用到勾选赛事</button>
        <span class="ev-hint" style="margin-left:6px">只刷赛制参数，不碰任何届次和比分</span></div>`
      : '<div class="ev-hint" style="margin-top:4px">还没有同类型（单项/团体）的赛事</div>'}
    </div>`;
  }).join('');
  return `<div class="card"><h3>🧩 赛制模板</h3>
    <div class="ev-hint" style="margin-bottom:8px">同品牌多个项目（如总决赛混双 / 男单）建议用同一套模板建，各改各的也不冲突。</div>
    ${cards}</div>`;
}

async function evApplyTemplateToEvents(tplId) {
  const ids = [...document.querySelectorAll('.ev-tpl-apply-' + tplId + ':checked')].map(el => parseInt(el.value));
  if (!ids.length) { alert('先勾选要应用的赛事'); return; }
  const t = (EVS.templates || []).find(x => x.id === tplId);
  try {
    await api('/api/event-templates/' + tplId + '/apply', { method: 'POST', body: JSON.stringify({ event_ids: ids }) });
    alert(`✅ 已把「${t.name}」应用到 ${ids.length} 个赛事`);
    await evRenderList();
  } catch (e) { alert(e.message); }
}

// ---------------- 赛制表单（只有赛制，没有日期 / 级别 / 名单） ----------------

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
  const isFree = d.format === 'free';
  const editing = !!EVS.editingId;
  return `<div class="card">
    <h3>${editing ? '✏️ 修改赛制' : '➕ 新建赛事'}</h3>
    <div class="ev-hint" style="margin-bottom:10px">
      这里只定义「怎么打」；每一届的日期、级别和参赛名单在「比赛管理」里录入。
    </div>
    ${evTemplateBarHtml()}
    <div class="form-row">
      <input type="text" id="ev-name" placeholder="赛事名称，例如：秋季团体赛" value="${htmlEsc(d.name)}"
             oninput="EVS.draft.name=this.value">
    </div>

    <div class="ev-sec">
      <div class="ev-sec-title">赛事类型</div>
      <div class="ev-radios">
        <label class="ev-radio ${!isTeam ? 'on' : ''}"><input type="radio" name="ev-kind" ${!isTeam ? 'checked' : ''} onchange="evSetKind('individual')">单项赛（按选手报名）</label>
        <label class="ev-radio ${isTeam ? 'on' : ''}"><input type="radio" name="ev-kind" ${isTeam ? 'checked' : ''} ${isFree ? 'disabled' : ''} onchange="evSetKind('team')">团体赛（按队伍报名）${isFree ? '<span class="ev-hint">（非固搭双打按个人参赛）</span>' : ''}</label>
      </div>
      ${d.kind === 'individual' && d.format !== 'free' ? `<div class="form-row" style="margin-top:8px;align-items:center">
        <label style="font-size:14px;color:#4a5568">项目类型</label>
        <select id="ev-type" onchange="EVS.draft.type=this.value">
          <option value="">未指定（录名单时可临时选单打/双打）</option>
          ${EV_TYPE_DEFS.map(o => `<option value="${o.code}" ${d.type === o.code ? 'selected' : ''}>${o.name}</option>`).join('')}
        </select>
        <span class="ev-hint">选定后录名单只能按该项目类型添加（男单=1 人 / 混双=2 人且一男一女）</span>
      </div>` : ''}
    </div>

    <div class="ev-sec">
      <div class="ev-sec-title">赛制</div>
      <div class="ev-radios">
        ${EVENT_FORMAT_DEFS.map(f => `<label class="ev-radio ${d.format === f.code ? 'on' : ''}">
          <input type="radio" name="ev-format" ${d.format === f.code ? 'checked' : ''} onchange="evSetFormat('${f.code}')">${f.name}</label>`).join('')}
      </div>
      ${isFree ? `<div class="ev-hint" style="margin-top:6px">
        没有固定搭档：每场 4 个人临时配成两对，名次记在<b>个人</b>头上（胜场 → 净胜分）。
        一键排赛程会把所有人两两搭配的场次全部排出来（6 人 15 场、5 人 5 场、7 人 35 场）。
      </div>` : ''}
      ${d.format === 'rr' ? `<div class="ev-hint" style="margin-top:6px">
        <b>不分组</b>：所有人两两各打一场，按总战绩排总名次（<b>5 人打 10 场、6 人打 15 场</b>）。
        人越多场次涨得越快，超过 8 人建议改用「小组赛+淘汰赛」。
      </div>` : ''}
    </div>

    ${isFree ? `<div class="ev-sec">
      <div class="ev-sec-title">项目 <span class="ev-hint">${FREE_KIND_MAP[d.freeKind].hint}</span></div>
      <div class="ev-radios">
        ${FREE_KIND_DEFS.map(k => `<label class="ev-radio ${d.freeKind === k.code ? 'on' : ''}">
          <input type="radio" name="ev-freekind" ${d.freeKind === k.code ? 'checked' : ''} onchange="EVS.draft.freeKind='${k.code}';evRenderList()">${k.name}</label>`).join('')}
      </div>
    </div>` : ''}

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

    ${evFormatHasGroup(d.format) && d.format !== 'rr' ? `<div class="ev-sec">
      <div class="ev-sec-title">小组配置
        <span class="ev-hint">小组循环后按名次出线打淘汰赛</span></div>
      <div class="form-row">
        <label style="font-size:14px;color:#4a5568">小组数</label>
        <input type="number" id="ev-gc" min="1" value="${d.groupCount}" oninput="EVS.draft.groupCount=parseInt(this.value)||1" style="max-width:100px">
        <label style="font-size:14px;color:#4a5568">每组出线</label>
        <input type="number" id="ev-apg" min="1" value="${d.advancePerGroup}" oninput="EVS.draft.advancePerGroup=parseInt(this.value)||1" style="max-width:100px">
      </div>
    </div>` : ''}

    ${d.format !== 'rr' && d.format !== 'free' ? `<div class="ev-sec">
      <div class="ev-sec-title">种子依据 <span class="ev-hint">${SEED_BY_MAP[d.seedBy].hint}</span></div>
      <div class="ev-radios">
        ${SEED_BY_DEFS.map(s => `<label class="ev-radio ${d.seedBy === s.code ? 'on' : ''}">
          <input type="radio" name="ev-seedby" ${d.seedBy === s.code ? 'checked' : ''} onchange="EVS.draft.seedBy='${s.code}';evRenderList()">${s.name}</label>`).join('')}
      </div>
    </div>` : ''}

    ${evFormatHasGroup(d.format) && d.format !== 'rr' ? `<div class="ev-sec">
      <div class="ev-sec-title">分组方式 <span class="ev-hint">${GROUP_MODE_MAP[d.groupMode].hint}</span></div>
      <div class="ev-radios">
        ${GROUP_MODE_DEFS.map(g => `<label class="ev-radio ${d.groupMode === g.code ? 'on' : ''}">
          <input type="radio" name="ev-gmode" ${d.groupMode === g.code ? 'checked' : ''} onchange="EVS.draft.groupMode='${g.code}';evRenderList()">${g.name}</label>`).join('')}
      </div>
    </div>` : ''}

    ${d.format !== 'rr' && !isFree ? `<div class="ev-sec">
      <div class="ev-sec-title">淘汰赛对阵方式 <span class="ev-hint">${KO_MODE_MAP[d.koMode].hint}</span></div>
      <div class="ev-radios">
        ${KO_MODE_DEFS.map(k => `<label class="ev-radio ${d.koMode === k.code ? 'on' : ''}">
          <input type="radio" name="ev-komode" ${d.koMode === k.code ? 'checked' : ''} onchange="EVS.draft.koMode='${k.code}';evRenderList()">${k.name}</label>`).join('')}
      </div>
    </div>

    <div class="ev-sec">
      <label class="ev-radio ${d.thirdPlace ? 'on' : ''}"><input type="checkbox" ${d.thirdPlace ? 'checked' : ''}
        onchange="EVS.draft.thirdPlace=this.checked;evRenderList()">设置季军赛</label>
      <label class="ev-radio ${d.lowerPlace ? 'on' : ''}"><input type="checkbox" ${d.lowerPlace ? 'checked' : ''}
        onchange="EVS.draft.lowerPlace=this.checked;evRenderList()">设置败者组（决 5~8 名）</label>
      <div class="ev-hint" style="margin-top:6px">
        败者组：未出线的人再打一个半决赛 + 名次赛，把 5~8 名也打出来。
        <b>只有某一届正好 8 个参赛单元时才会生成</b>（2 组各出线 2 个），人数不对就当没勾。
      </div>
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
  if (f === 'rr') { EVS.draft.thirdPlace = false; EVS.draft.lowerPlace = false; }
  // 非固搭双打按个人报名（搭档每场临时配），不存在队伍，选它就自动切回单项赛
  if (f === 'free') EVS.draft.kind = 'individual';
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
    name: '', kind: 'individual', format: 'rr', bestOf: 3, freeKind: 'md',
    thirdPlace: false, lowerPlace: false, groupCount: 2, advancePerGroup: 1,
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
  // 单循环赛只有一个大组（表单里小组数已经藏起来了），group_count 固定写 1；
  // 没有小组概念的赛制（淘汰赛 / 非固搭双打）写 0。别指望输入框的值：它压根没渲染。
  const groupCount = d.format === 'rr' ? 1
    : d.format === 'group_ko' ? (gcEl ? (parseInt(gcEl.value) || 1) : d.groupCount)
    : 0;
  return {
    name: (document.getElementById('ev-name').value || '').trim(),
    kind: d.kind, type: (d.kind === 'individual' && d.format !== 'free') ? d.type : '', format: d.format, best_of: d.bestOf,
    free_kind: d.freeKind,
    third_place: !!d.thirdPlace,
    lower_bracket: !!d.lowerPlace,
    group_count: groupCount,
    advance_per_group: d.format === 'group_ko' ? (apgEl ? (parseInt(apgEl.value) || 1) : d.advancePerGroup) : 0,
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
    name: e.name, kind: e.kind, type: e.type || '', format: e.format, bestOf: e.best_of || 3,
    freeKind: e.free_kind || 'md',
    thirdPlace: !!e.third_place, lowerPlace: !!e.lower_bracket, groupCount: e.group_count || 1,
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
  if (e.format === 'free') bits.push(freeKindLabel(e.free_kind));
  if (e.kind === 'team' && e.item_count) bits.push(`${e.item_count} 项`);
  // 单循环赛不分组也不看种子：这两个选项只对「小组赛+淘汰赛 / 淘汰赛」有意义，
  // 写进摘要会让人以为自己当初选过（历史 rr 赛事可能还留着 group_count=2 的旧值）
  if (evFormatHasGroup(e.format) && e.format !== 'rr') bits.push(`${e.group_count || 1} 组 · ${groupModeLabel(e.group_mode)}`);
  if (e.format === 'group_ko') bits.push(`每组出线 ${e.advance_per_group || 1}`);
  if (e.format !== 'rr' && e.format !== 'free') bits.push(koModeLabel(e.ko_mode));
  if (e.format !== 'rr' && e.format !== 'free') bits.push(`种子：${seedByLabel(e.seed_by)}`);
  if (e.third_place) bits.push('季军赛');
  if (e.lower_bracket) bits.push('败者组');
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
    // 详情页要能翻往届：把当前赛事的届次列表带上。
    // 之前只有 showEventDetail（赛事查询入口）喂过 editions，从比赛管理进工作台时
    // EVS.editions 是空的，切换器根本不出现——和哥录了第二届后在查询页找不到第一届，
    // 根因就是查询入口 showTournamentLatest 不传届数、detail 里又没有切换器。
    if (!EVS.editions.some(e => e.id === EVS.detail.edition.id)) {
      try {
        const d = await api('/api/events/' + EVS.detail.event.id);
        EVS.editions = d.editions || [];
      } catch (e) { EVS.editions = []; }
    }
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

// 详情页切换届次：查询页 / 比赛管理 / 赛事列表三个宿主都能用
async function evSwitchEdition(edId) {
  const prevHost = EVS.host;
  await evOpenEdition(parseInt(edId), prevHost);
  // 查询页的标题也带着届数，切换后要同步，不然标题停在旧届
  if (prevHost === 'query' && EVS.detail) {
    openTourDetailPage(
      EVS.detail.event.name + ' 第' + EVS.detail.edition.edition + '届',
      EVS.detail.event.description || '');
  }
  // 从比赛管理进来时，返回后「本届设置」卡要跟着显示切到的那一届
  if (prevHost === 'match' && EVS.detail) {
    MES.eventId = EVS.detail.event.id;
    MES.editionNo = EVS.detail.edition.edition;
    // MES.editions 可能是进工作台之前拉的，跟当前届次对不上会让下拉框缺选项
    if (!MES.editions.some(e => e.id === EVS.detail.edition.id)) MES.editions = EVS.editions.slice();
    // 名单 / 分组 / 对阵数都要换成切过去那一届的，否则返回后卡片内容对不上
    await mEvSelectEdition(EVS.detail.edition.id);
  }
}

async function evReload() {
  const id = EVS.detail.edition.id;
  EVS.detail = await api('/api/editions/' + id);
  evRenderWorkspace();
}

function evRenderWorkspace() {
  const html = EVS.playerView ? evPlayerViewHtml() : evWorkspaceHtml(!EVS.readonly);
  const el = evWorkspaceEl();
  if (el) el.innerHTML = html;
}

function evBack() {
  // 在个人对局页按返回 → 退回赛事详情（而不是直接退回赛事列表）
  if (EVS.playerView) { evClosePlayerView(); return; }
  if (EVS.host === 'match') { mEvBack(); return; }
  if (EVS.host === 'query') { closeTourDetail(); return; }
  evRenderList();
}

// ---------------- 最终排名 → 某人本届对局 ----------------
//
// 交互是两段式：点名字先弹一个「查看此人对局」的小气泡，点气泡才真的跳，
// 避免手指在手机上误触名字就把页面跳走。

// 名字里可能有引号/尖括号，进 onclick 前必须先转义，否则一堆看似正常的名字会炸
function evNameBtnHtml(entryId, label, memberId) {
  // 三个参数必须齐全（id, memberId, 元素），漏了 memberId 会把 DOM 元素当成 memberId
  const arg = memberId ? `${entryId},${memberId}` : `${entryId},null`;
  return `<span class="ev-ask-wrap"><span class="ev-name-btn" role="button" tabindex="0"
    data-entry="${entryId}"${memberId ? ` data-member="${memberId}"` : ''}
    onclick="evAskPlayer(${arg},this)">${htmlEsc(label)}</span></span>`;
}

function evAskPlayer(entryId, memberId, el) {
  const key = `${entryId}:${memberId || 0}`;
  const already = document.querySelector(`.ev-ask-bubble[data-key="${key}"]`);
  evCloseAsk();
  if (already) return;               // 再点同一个名字 = 收起气泡
  if (!EVS.askBound) {
    EVS.askBound = true;
    // 点页面其他地方收起气泡。注意这个监听器是在本次 click 处理过程中挂上的，
    // 同一次事件仍会冒泡到 document，所以要排除落在名字/气泡上的点击。
    document.addEventListener('click', (e) => {
      if (e.target.closest('.ev-name-btn') || e.target.closest('.ev-ask-bubble')) return;
      evCloseAsk();
    });
  }
  const b = document.createElement('span');
  b.className = 'ev-ask-bubble';
  b.dataset.key = key;
  b.textContent = '查看此人对局';
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  b.onclick = (e) => { e.stopPropagation(); evOpenPlayerMatches(entryId, memberId || null); };
  b.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault(); evOpenPlayerMatches(entryId, memberId || null);
  };
  el.insertAdjacentElement('afterend', b);
  evCloseAskOutsideFrames(b);
  b.focus();
}

function evCloseAsk() { document.querySelectorAll('.ev-ask-bubble').forEach(n => n.remove()); }

// 气泡可能被表格格子裁掉：如果它超出了可视区域，就把它翻到名字下方显示
function evCloseAskOutsideFrames(b) {
  const r = b.getBoundingClientRect();
  if (r.top < 4) b.classList.add('below');
}

function evOpenPlayerMatches(entryId, memberId) {
  evCloseAsk();
  EVS.playerView = { entryId, memberId: memberId || null };
  evRenderWorkspace();
  // 详情页标题跟着变，用户一眼知道自己在看谁
  const el = document.getElementById('detail-tour-title');
  if (el && EVS.detail) el.textContent = `${EVS.detail.event.name} · ${evPlayerViewName()}`;
  if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function evClosePlayerView() {
  EVS.playerView = null;
  evRenderWorkspace();
  const el = document.getElementById('detail-tour-title');
  if (el && EVS.detail) el.textContent = EVS.detail.event.name;
}

function evPlayerViewName() {
  const d = EVS.detail;
  if (!d || !EVS.playerView) return '';
  const entry = d.entries.find(e => e.id === EVS.playerView.entryId);
  if (EVS.playerView.memberId) return pn(EVS.playerView.memberId);
  return entry ? entry.label : '';
}

// 败者组的场次叫法：半决赛 / 5-6 名决赛 / 7-8 名名次赛
function evLowerStageLabel(t, d) {
  const R = d.lower_rounds || 2;
  if (t.ko_round < R) return '败者组半决赛';
  return t.slot === 0 ? '5-6 名决赛' : '7-8 名名次赛';
}

// 某个 tie 属于哪个阶段：小组赛 / 淘汰轮次 / 季军赛 / 败者组
function evStageLabel(t, d) {
  if (t.stage === 'free') return `第 ${t.seq || 0} 场`;
  if (t.stage === 'group') return `小组赛 · 第 ${t.group_no} 组`;
  if (t.stage === 'third') return '季军赛';
  if (t.stage === 'lower') return evLowerStageLabel(t, d);
  const r = t.ko_round, R = d.ko_rounds;
  if (r === R) return '决赛';
  if (r === R - 1) return '半决赛';
  return `淘汰赛 · 第 ${r} 轮`;
}

// ---------- 树状签表（参考中羽在线：左起首轮，逐级向右两两合并，冠军挂在最右） ----------

// 轮次名走转播口径：8 进 4 是 1/4 决赛，16 进 8 是 1/8 决赛……
function evRoundName(r, R) {
  if (r >= R) return '决赛';
  if (r === R - 1) return '半决赛';
  return `1/${Math.pow(2, R - r)} 决赛`;
}

// 签表格子里的选手名：双打组合 "A + B" 紧凑成 "A+B"（加号淡色不带空格）。
// 170px 窄列里 " + " 的两个空格要占 ~13px，是名字被 ellipsis 截断的主因之一。
// 签表/冠军框里的名字：双打搭档竖排（A+ 换行 B，第二行缩进），单行高度只取决于最长单个名字，
// 列宽能从 196px 收到 ~168px；管理端 slot 保持横排（v=false），列表行高不变。
function bkNameHtml(label, v) {
  const parts = String(label == null ? '' : label).split(/\s*\+\s*/);
  if (v && parts.length === 2) {
    return `${htmlEsc(parts[0])}<br><span class="bk-n2">${htmlEsc(parts[1])}</span>`;
  }
  return htmlEsc(label).replace(/\s*\+\s*/g, '<span class="bk-plus">+</span>');
}

// 签表格子里一行的比分：单项给逐局分（21 19），团体只给大场分
function evBracketScoreHtml(t, d, side) {
  const o = t.outcome || {};
  if (d.event.kind === 'team') {
    if (!o.perItem || !o.perItem.length) return '<span class="bk-sc"></span>';
    return `<span class="bk-sc">${side === 1 ? (o.i1 || 0) : (o.i2 || 0)}</span>`;
  }
  const it = (t.items || [])[0];
  if (!it || !it.games || !it.games.length) return '<span class="bk-sc"></span>';
  return `<span class="bk-sc">${it.games.map(g => side === 1 ? g.s1 : g.s2).join(' ')}</span>`;
}

// 一个签表格子：上下两行（种子号 + 名字 + 比分），胜者绿底加粗
function evBracketMatchHtml(t, d, ro, r, R) {
  const win = t.winner_entry_id;
  const st = t.stage === 'lower' ? 'lower' : 'ko';
  const canSwap = !ro && EVS.canSwap && st === 'ko';
  const played = !!(t.outcome && t.outcome.perItem && t.outcome.perItem.some(p => p.side !== 0 || p.w1 || p.w2));

  function row(side) {
    const id = side === 1 ? t.side1_entry_id : t.side2_entry_id;
    const other = side === 1 ? t.side2_entry_id : t.side1_entry_id;
    if (!id) {
      return `<div class="bk-row empty"><span class="bk-seed"></span><span class="bk-name">${other ? '轮空' : '待定'}</span><span class="bk-sc"></span></div>`;
    }
    const ent = d.entries.find(e => e.id === id);
    // 序号：淘汰赛身份标签优先（group_ko=A1/B2 小组名次，纯 KO=种子位），没有才显示种子排名。
    // 这样半决赛「A1 VS B2」和对阵逻辑自洽，不会让人误以为种子错位。
    const tag = ent ? (ent.qual_label || (ent.seed_rank ? String(ent.seed_rank) : '')) : '';
    const seed = tag ? `<span class="bk-seed">${htmlEsc(tag)}</span>` : '<span class="bk-seed"></span>';
    const cls = win ? (win === id ? 'win' : 'lose') : '';
    const picked = canSwap && EVS.pick && EVS.pick.stage === st && EVS.pick.ko_round === t.ko_round
      && EVS.pick.slot === t.slot && EVS.pick.side === side;
    const onclick = canSwap
      ? ` onclick="event.stopPropagation();evPickSwap(${t.ko_round},${t.slot},${side},'${st}')" title="点选手名字选中，再点另一个名字即可交换签位"`
      : '';
    return `<div class="bk-row ${cls}${picked ? ' picked' : ''}"${onclick}>${seed}<span class="bk-name">${bkNameHtml(evEntryLabel(d, id), true)}</span>${played ? evBracketScoreHtml(t, d, side) : '<span class="bk-sc"></span>'}</div>`;
  }

  // 竖线：偶数号位（一对里的上半个）往下走，奇数号位往上走，正好在两场中点汇合
  const v = r < R ? `<i class="bk-v${t.slot % 2 ? ' up' : ''}"></i>` : '';
  return `<div class="bk-m${EVS.expanded === t.id ? ' active' : ''}" onclick="evToggleTie(${t.id})">${row(1)}${row(2)}${v}</div>`;
}

// 管理端（比赛管理）用按轮分栏的列表：点开就能录比分、名字选中换签位，不占横向空间。
// 树状签表只给前台查询页看。
function evKOSectionHtml(d) {
  const ko = d.ties.filter(t => t.stage === 'ko');
  const tp = d.ties.filter(t => t.stage === 'third');
  if (!ko.length && !tp.length) return '';
  const R = Math.max.apply(null, ko.map(t => t.ko_round));
  let h = '<div class="card"><h3>淘汰签表</h3>';
  if (EVS.canSwap) {
    h += `<div class="ev-hint">✋ 还没开打：点选手名字选中，再点另一个名字即可交换签位（同一轮内）。开打后签表锁定。</div>`;
  }
  for (let r = 1; r <= R; r++) {
    h += `<div class="ev-bracket-round"><div class="ev-bracket-round-title">${evRoundName(r, R)}</div>`;
    h += ko.filter(t => t.ko_round === r).sort((a, b) => a.slot - b.slot).map(t => evTieHtml(t, d, false, true)).join('');
    h += `</div>`;
  }
  if (tp.length) {
    h += `<div class="ev-bracket-round"><div class="ev-bracket-round-title">季军赛</div>`;
    h += tp.map(t => evTieHtml(t, d, false, true)).join('');
    h += `</div>`;
  }
  h += '</div>';
  return h;
}

// 前台「查看比赛详情」里的淘汰赛逐场列表（只读版 evKOSectionHtml）：按轮分栏 + 季军赛。
// 树状签表只给「谁打谁」的全局视角，这里补上可点开看逐局比分的逐场清单。
function evKOTiesSectionHtml(d, ro) {
  const ko = d.ties.filter(t => t.stage === 'ko');
  const tp = d.ties.filter(t => t.stage === 'third');
  if (!ko.length && !tp.length) return '';
  const R = Math.max.apply(null, ko.map(t => t.ko_round));
  let h = '<div class="card"><h3>淘汰赛对阵</h3>';
  for (let r = 1; r <= R; r++) {
    const round = ko.filter(t => t.ko_round === r).sort((a, b) => a.slot - b.slot);
    if (!round.length) continue;
    h += `<div class="ev-bracket-round"><div class="ev-bracket-round-title">${evRoundName(r, R)}</div>`;
    h += round.map(t => evTieHtml(t, d, ro, false)).join('');
    h += `</div>`;
  }
  if (tp.length) {
    h += `<div class="ev-bracket-round"><div class="ev-bracket-round-title">季军赛</div>`;
    h += tp.map(t => evTieHtml(t, d, ro, false)).join('');
    h += `</div>`;
  }
  h += '</div>';
  return h;
}

// 整棵签表：轮次列 + 冠军列。所有列等高、各列 space-around，
// 于是第 r 轮第 k 场的中心刚好落在第 r-1 轮第 2k/2k+1 两场的中点上，连线才对得齐。
function evBracketCardHtml(d, ro) {
  const ko = d.ties.filter(t => t.stage === 'ko');
  if (!ko.length) return '';
  const R = Math.max.apply(null, ko.map(t => t.ko_round));
  const rounds = [];
  for (let r = 1; r <= R; r++) rounds.push(ko.filter(t => t.ko_round === r).sort((a, b) => a.slot - b.slot));
  const n0 = rounds[0].length;
  if (!n0) return '';

  const canSwap = !ro && EVS.canSwap;
  const finalTie = rounds[R - 1][0];
  const champ = finalTie ? finalTie.winner_entry_id : null;

  let h = `<div class="card ev-bk-card"><h3>淘汰签表</h3>`;
  h += `<div class="ev-hint">${ro
    ? '点任意一场可看逐局比分。选手左边的序号：小组+淘汰赛 = 小组名次（A1/B2），纯淘汰赛 = 种子位。'
    : (canSwap
      ? '✋ 还没开打：点选手名字选中，再点另一个名字即可交换签位（同一轮内）；点卡片其它位置展开录比分。'
      : '点任意一场即可展开录入 / 修改比分。')}</div>`;
  h += `<div class="bk-scroll"><div class="bk" style="--n:${n0}">`;
  for (let r = 1; r <= R; r++) {
    h += `<div class="bk-col${r === 1 ? ' bk-col-first' : ''}">
      <div class="bk-col-title"><span>${evRoundName(r, R)}</span></div>
      ${rounds[r - 1].map(t => evBracketMatchHtml(t, d, ro, r, R)).join('')}
    </div>`;
  }
  h += `<div class="bk-col bk-col-champ"><div class="bk-col-title"><span>冠军</span></div>
    <div class="bk-champ">${champ ? `🏆 <b>${bkNameHtml(evEntryLabel(d, champ), true)}</b>` : '<span class="bk-empty">待定</span>'}</div>
  </div>`;
  h += `</div></div>`;

  // 季军赛不属于主树（负者汇合，不是两两合并），单独挂一小格在下面
  const third = d.ties.filter(t => t.stage === 'third');
  if (third.length) {
    h += `<div class="bk-third"><div class="bk-third-title"><span>季军赛</span></div>
      <div class="bk-third-match">${third.map(t => evBracketMatchHtml(t, d, ro, R, R)).join('')}</div></div>`;
  }
  // 败者组（5~8 名）同样不是标准合并树，单独挂一小棵在季军赛下面
  h += evLowerTreeHtml(d, ro);
  h += `</div>`;
  return h;
}

// 败者组小树：左列半决赛，右列两场名次赛（各带小标题），中间一条竖直母线。
// 服务端固定生成「2 场半决赛 → 5-6 名决赛（胜者）+ 7-8 名名次赛（负者）」：
// 两场名次赛都从两场半决赛各取一人，画不成标准合并树，用母线把四场两两连起来。
// 轮数不是 2（目前服务端只会生成 2 轮）时退化成无连线分栏，不会画错。
function evLowerTreeHtml(d, ro) {
  const lower = d.ties.filter(t => t.stage === 'lower');
  if (!lower.length) return '';
  const R = Math.max.apply(null, lower.map(t => t.ko_round));
  const rounds = [];
  for (let r = 1; r <= R; r++) rounds.push(lower.filter(t => t.ko_round === r).sort((a, b) => a.slot - b.slot));
  const n0 = rounds[0].length;
  if (!n0) return '';
  const last = rounds[R - 1];
  const bus = R === 2 && n0 === 2 && last.length === 2;
  let h = `<div class="bk-lower-wrap"><div class="bk-third-title"><span>败者组 · 决 5~8 名</span></div>`;
  h += `<div class="bk-scroll"><div class="bk bk-lower${bus ? '' : ' bk-lower-plain'}" style="--n:${n0}">`;
  if (R > 1) {
    h += `<div class="bk-col bk-col-first"><div class="bk-col-title"><span>败者组半决赛</span></div>
      ${rounds[0].map(t => evBracketMatchHtml(t, d, ro, R, R)).join('')}</div>`;
    if (bus) h += `<div class="bk-bus"></div>`;
  }
  h += `<div class="bk-col${R > 1 ? '' : ' bk-col-first'}"><div class="bk-col-title"><span>名次赛</span></div>
    ${last.map(t => `<div class="bk-mwrap"><div class="bk-mcap">${evLowerStageLabel(t, d)}</div>
      ${evBracketMatchHtml(t, d, ro, R, R)}</div>`).join('')}</div>`;
  h += `</div></div></div>`;
  return h;
}

// 签表里被点开的那一场：把录入/详情面板挂在签表下方，避免撑坏树状布局
function evBracketEditorHtml(d, ro) {
  if (!EVS.expanded) return '';
  const t = d.ties.find(x => x.id === EVS.expanded && (x.stage === 'ko' || x.stage === 'third' || x.stage === 'lower'));
  if (!t) return '';
  const l1 = t.side1_entry_id ? evEntryLabel(d, t.side1_entry_id) : '待定';
  const l2 = t.side2_entry_id ? evEntryLabel(d, t.side2_entry_id) : '待定';
  return `<div class="card ev-bk-editor"><h3>${evStageLabel(t, d)}：${htmlEsc(l1)} VS ${htmlEsc(l2)}
    <button class="ev-mini" style="float:right" onclick="evToggleTie(${t.id})">收起</button></h3>
    ${evTieBodyHtml(t, d, ro, !!(t.side1_entry_id && t.side2_entry_id))}</div>`;
}

function evPlayerViewHtml() {
  const d = EVS.detail;
  if (!d) return '';
  const pv = EVS.playerView;
  const entry = d.entries.find(e => e.id === pv.entryId);
  if (!entry) return '';
  const name = evPlayerViewName();
  const isMember = !!pv.memberId;
  const unitName = isMember ? `${name} <span class="ev-hint">（${htmlEsc(entry.label)}）</span>` : htmlEsc(name);
  const fr = d.final_ranks.find(r => r.entry_id === pv.entryId);
  const rankTip = fr ? `本届第 ${fr.rank} 名` : '';

  // 只取这个参赛单元打过的对局（双方都已确定）
  // 非固搭双打一侧是两个人临时搭档，所以第二个人（sideN_entry2_id）也要认
  const inTie = t => t.side1_entry_id === pv.entryId || t.side1_entry2_id === pv.entryId
    || t.side2_entry_id === pv.entryId || t.side2_entry2_id === pv.entryId;
  const ties = d.ties.filter(t => inTie(t) && t.side1_entry_id && t.side2_entry_id);
  // 按实际赛程先后排：小组赛 → 淘汰赛（轮次升序）→ 季军赛 → 败者组
  const ord = t => t.stage === 'group' ? [0, t.group_no, t.seq || 0, t.id]
    : t.stage === 'free' ? [0, 0, t.seq || 0, t.id]
      : t.stage === 'ko' ? [1, t.ko_round, t.slot, t.id]
        : t.stage === 'third' ? [2, 0, 0, t.id]
          : [3, t.ko_round, t.slot, t.id];
  ties.sort((a, b) => { const A = ord(a), B = ord(b); for (let i = 0; i < 4; i++) if (A[i] !== B[i]) return A[i] - B[i]; return 0; });

  let rows = '';
  let wins = 0, losses = 0;
  for (const t of ties) {
    const mySide = (t.side1_entry_id === pv.entryId || t.side1_entry2_id === pv.entryId) ? 1 : 2;
    // 非固搭双打一场是「两人 : 两人」，其余赛制一边就是一个单元
    const sideLabel = s => (s === 1 ? [t.side1_entry_id, t.side1_entry2_id] : [t.side2_entry_id, t.side2_entry2_id])
      .filter(Boolean).map(x => evEntryLabel(d, x)).join(' ＋ ');
    const oppLabel = sideLabel(3 - mySide);
    const myLabel = d.event.format === 'free' ? sideLabel(mySide) : name;
    // 团体赛且点的是具体队员：只保留他出场的项目；单项赛所有项目天然就是他的
    let items = t.items || [];
    if (isMember && d.event.kind === 'team') {
      items = items.filter(it => ((mySide === 1 ? it.side1_players : it.side2_players) || []).includes(pv.memberId));
    }
    // 比分一律按「本人 : 对手」的方向显示
    const scoreOf = it => (it.games || []).map(g => {
      const a = mySide === 1 ? g.s1 : g.s2, b = mySide === 1 ? g.s2 : g.s1;
      return `${a} : ${b}`;
    }).join('　');
    const playedBond = items.some(it => (it.games || []).length > 0) ||
      !!(t.outcome && t.outcome.perItem && t.outcome.perItem.some(p => p.side !== 0 || p.w1 || p.w2));

    // 真正打过的项目：没打的项目（例如三局两胜 2:0 后的第三项）不能算进个人战绩
    const playedItems = items.filter(it => (it.games || []).length > 0 || it.winner_side);
    const tieRes = t.winner_entry_id === pv.entryId ? '胜'
      : t.winner_entry_id ? '负' : (playedBond ? '进行中' : '未开打');
    const lineScore = it => scoreOf(it) || '—';
    const lineRes = it => it.winner_side ? (it.winner_side === mySide ? '胜' : '负') : (playedBond ? '进行中' : '未开打');

    let scoreCell, resCell, resCls = 'pending';
    if (!playedBond) {
      scoreCell = '<span class="ev-pv-none">未开打</span>';
      resCell = '<span class="ev-pv-none">—</span>';
    } else if (!playedItems.length) {
      scoreCell = '<span class="ev-pv-none">未出场</span>';
      resCell = '<span class="ev-pv-none">—</span>';
    } else if (playedItems.length === 1) {
      // 单项赛（以及只出场一个项目的队员）：一整行的比分 + 一个结果，最紧凑
      const it = playedItems[0];
      const nm = (it.name && it.name !== '比赛') ? `<span class="ev-pv-itemname">${htmlEsc(it.name)}</span>` : '';
      scoreCell = `<div class="ev-pv-item">${nm}<b>${lineScore(it)}</b></div>`;
      const r = lineRes(it) || tieRes;
      resCls = r === '胜' ? 'win' : r === '负' ? 'lose' : 'pending';
      resCell = r;
      if (r === '胜') wins++; else if (r === '负') losses++;
    } else {
      // 团体赛同一场里这个人打了多个项目：比分与结果按项目分行，左右两列一一对应
      scoreCell = playedItems.map(it => `<div class="ev-pv-item"><span class="ev-pv-itemname">${htmlEsc(it.name || '比赛')}</span><b>${lineScore(it)}</b></div>`).join('');
      const lines = playedItems.map(it => lineRes(it) || tieRes);
      resCls = lines.every(x => x === '胜') ? 'win' : lines.every(x => x === '负') ? 'lose' : 'pending';
      resCell = lines.map(x => `<div class="ev-pv-item ${x === '胜' ? 'r-win' : x === '负' ? 'r-lose' : 'r-pending'}">${x}</div>`).join('');
      wins += lines.filter(x => x === '胜').length;
      losses += lines.filter(x => x === '负').length;
    }

    rows += `<tr>
      <td class="ev-pv-stage">${evStageLabel(t, d)}</td>
      <td class="ev-pv-opp">${htmlEsc(myLabel)} <b class="ev-pv-vs">:</b> ${htmlEsc(oppLabel)}</td>
      <td class="ev-pv-score">${scoreCell}</td>
      <td class="ev-pv-res ${resCls}">${resCell}</td>
    </tr>`;
  }

  let h = `<div class="ev-head">
    <button class="back-btn" onclick="evClosePlayerView()" title="返回最终排名"><span class="back-arrow"></span>返回</button>
    <h2>${unitName} <span class="ev-hint">${htmlEsc(d.event.name)} 第 ${d.edition.edition} 届${rankTip ? ' · ' + rankTip : ''}</span></h2>
  </div>`;
  h += `<div class="card"><h3>本届对局 <span class="ev-hint">${ties.length} 场${ties.length ? `　胜 ${wins} / 负 ${losses}` : ''}</span></h3>`;
  if (!ties.length) {
    h += `<div class="ev-empty">这个人本届还没有已确定的对局</div>`;
  } else {
    h += `<table class="ev-pv"><thead><tr><th>阶段</th><th>对局</th><th>比分（本人 : 对手）</th><th>结果</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
  h += `</div>`;
  return h;
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
    EVS.editions = d.editions;   // 详情页届次切换器用（翻往届）
    // 从「查看本届详情」按钮进来时 tab 还停在赛事查询，这里自己切过去——
    // 不然按钮点了页面没反应（图标入口 showTournamentLatest 已切过一次，重复切幂等无害）
    openTourDetailPage(d.event.name + (target.edition ? ' 第' + target.edition + '届' : ''), d.event.description || '');
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
  const wantLower = !!(EVS.detail && EVS.detail.lower_bracket);
  try {
    const r = await api(`/api/editions/${edId}/generate-ko`, { method: 'POST', body: '{}' });
    EVS.expanded = null;
    await evReload();
    // 开了败者组却没生成出来（人数不对 / 小组赛没打完）时说清楚，别让用户以为勾了没用
    if (wantLower && r.lower_reason) alert('败者组没生成：' + r.lower_reason);
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
  // 主签表与败者组共用「还没开打就能调」的状态：任何一方出结果就锁死
  EVS.canSwap = (koTies.length > 0 || d.ties.some(t => t.stage === 'lower'))
    && !d.ties.some(t => (t.stage === 'ko' || t.stage === 'third' || t.stage === 'lower') && t.winner_entry_id);

  let h = '';
  // 届次切换器：两届以上才出现。必须独立于 head 渲染——查询页是只读的
  // （withHead=false，整块 head 都不渲染），而「往届看不见」恰恰是查询页的问题：
  // showTournamentLatest 不传届数 → target = editions[0] 永远只给最新一届。
  if (EVS.editions.length > 1) {
    const edOpts2 = EVS.editions.map(e =>
      `<option value="${e.id}" ${e.id === ed.id ? 'selected' : ''}>第 ${e.edition} 届${e.date ? '（' + e.date + '）' : ''}</option>`).join('');
    h += `<div class="ev-edition-bar"><span class="ev-edition-bar-label">届次</span>
      <select class="ev-edition-switch" onchange="evSwitchEdition(this.value)">${edOpts2}</select>
      <span class="ev-edition-bar-hint">共 ${EVS.editions.length} 届</span></div>`;
  }
  if (withHead) {
    h += `<div class="ev-head">
      <button class="back-btn" onclick="evBack()"><span class="back-arrow"></span>返回</button>
      <h2>${htmlEsc(ev.name)}</h2>
      <span class="ev-tag ${ev.kind}">${evKindLabel(ev.kind)}</span>
      <span class="ev-tag">${evFormatLabel(ev.format)}</span>
      <span class="ev-tag">${evBestOfLabel(ev.best_of)}</span>
      <span class="ev-tag ${ed.status === 'done' ? 'done' : 'draft'}">${evStatusLabel(ed.status)}</span>
      <div class="ev-head-actions">
        ${ev.format === 'free'
    ? `<button onclick="evGenFree(${ed.id})">🎲 ${d.ties.some(t => t.stage === 'free') ? '补齐' : '生成'}全部对局</button>`
    : `${evFormatHasGroup(ev.format) ? `<button onclick="evGenGroups(${ed.id})">🎲 ${d.ties.some(t => t.stage === 'group') ? '重新生成' : '生成'}循环对阵</button>` : ''}
        ${ev.format !== 'rr' ? `<button onclick="evGenKO(${ed.id})">🏆 ${koTies.length ? '重新生成' : '生成'}淘汰签表</button>` : ''}`}
      </div>
    </div>`;
  }

  h += evBriefHtml(d, ro);
  // 非固搭双打没有小组 / 淘汰，界面就是「一场场录 4 人临时配对」+ 一张个人成绩表
  if (ev.format === 'free') {
    if (!ro) h += evFreeEntryHtml(d);
    h += evFreeRankHtml(d);
    h += evFreeTiesHtml(d, ro);
    return h;
  }
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
    // 有淘汰赛就默认把树状签表摊开给用户看（中羽在线那种左→右合并的样式），
    // 逐场比分靠点格子展开，就不再塞进「查看比赛详情」里重复一遍。
    h += evBracketCardHtml(d, ro) + evBracketEditorHtml(d, ro);
    h += `<button class="ev-detail-toggle" onclick="evToggleTies()">📊 ${EVS.showTies ? '收起比赛详情' : '查看比赛详情'}</button>`;
    if (EVS.showTies) {
      // 有总排名时积分榜也被折起来了，展开要一起给回来
      if (hasFinal) h += evGroupSectionHtml(d, ro, 'standings');
      h += evGroupSectionHtml(d, ro, 'ties') + evKOTiesSectionHtml(d, ro) + evLowerSectionHtml(d, ro, 'ties');
    }
    return h;
  }
  const groupHtml = evGroupSectionHtml(d, ro);
  const koHtml = evKOSectionHtml(d);
  const lowerHtml = evLowerSectionHtml(d, ro);
  if (!groupHtml && !koHtml && !lowerHtml) {
    h += `<div class="card"><div class="ev-empty">还没有对阵。先点右上角「生成循环对阵」或「生成淘汰签表」。</div></div>`;
  }
  h += groupHtml + koHtml + lowerHtml + evLowerSwitchHtml(d);
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
        ${ev.format === 'free' ? `　项目：<b>${freeKindLabel(ev.free_kind)}</b>` : ''}
        ${evFormatHasGroup(ev.format) && ev.format !== 'rr' ? `　小组数：<b>${ev.group_count}</b>（${groupModeLabel(ev.group_mode)}）` : ''}
        ${ev.format === 'group_ko' ? `　每组出线：<b>${ev.advance_per_group}</b>` : ''}
        ${ev.third_place ? '　<b>设季军赛</b>' : ''}${d.lower_bracket ? '　<b>设败者组（决 5~8 名）</b>' : ''}</div>
      ${ev.format === 'rr' || ev.format === 'free' ? '' : `<div>种子依据：<b>${seedByLabel(ev.seed_by)}</b>${ev.format !== 'rr' ? `　淘汰对阵：<b>${koModeLabel(ev.ko_mode)}</b>` : ''}</div>`}
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

// 败者组（未出线者再打一个小淘汰，决出 5~8 名）。
// 结构与主签表同构：首轮半决赛 → 末轮 slot 0 是 5-6 名决赛、slot 1 是 7-8 名名次赛。
function evLowerSectionHtml(d, ro, part) {
  const lower = d.ties.filter(t => t.stage === 'lower');
  if (!lower.length) return '';
  const R = Math.max(...lower.map(t => t.ko_round));
  let h = '<div class="card"><h3>败者组 <span class="ev-hint">未出线者决 5~8 名</span></h3>';
  for (let r = 1; r <= R; r++) {
    const round = lower.filter(t => t.ko_round === r).sort((a, b) => a.slot - b.slot);
    if (r < R) {
      h += `<div class="ev-bracket-round"><div class="ev-bracket-round-title">败者组半决赛</div>`;
      h += round.map(t => evTieHtml(t, d, ro, true)).join('');
      h += `</div>`;
    } else {
      const f = round.filter(t => t.slot === 0), s = round.filter(t => t.slot === 1);
      if (f.length) {
        h += `<div class="ev-bracket-round"><div class="ev-bracket-round-title">5-6 名决赛</div>`;
        h += f.map(t => evTieHtml(t, d, ro, true)).join('') + `</div>`;
      }
      if (s.length) {
        h += `<div class="ev-bracket-round"><div class="ev-bracket-round-title">7-8 名名次赛</div>`;
        h += s.map(t => evTieHtml(t, d, ro, true)).join('') + `</div>`;
      }
    }
  }
  h += '</div>';
  return h;
}

// 本届败者组开关：只有正好 8 个参赛单元时才给这个选项 ——
// 8 人 = 2 组各出线 2 个，剩下的 4 个刚好也能凑一个半决赛 + 名次赛，把 5~8 名打出来。
function evLowerSwitchHtml(d) {
  const ev = d.event;
  if (EVS.readonly || ev.format !== 'group_ko' || d.entries.length !== 8) return '';
  const on = !!d.lower_bracket;
  return `<div class="card">
    <h3>后几名对阵 <span class="ev-hint">本届正好 8 ${evEntryUnit(ev.kind)}${evEntryNoun(ev.kind)}</span></h3>
    <label class="ev-radio ${on ? 'on' : ''}"><input type="checkbox" ${on ? 'checked' : ''}
      onchange="evToggleLower(this.checked)">设置败者组（决 5~8 名）</label>
    <div class="ev-hint" style="margin-top:6px">
      勾选后点右上角「重新生成淘汰签表」即生成：小组未出线的 4 个先打半决赛，
      胜者打 5-6 名决赛、负者打 7-8 名名次赛。开关只对这一届生效。
    </div>
  </div>`;
}

async function evToggleLower(on) {
  const edId = EVS.detail.edition.id;
  try {
    const r = await api(`/api/editions/${edId}/lower-bracket`, { method: 'PUT', body: JSON.stringify({ on: !!on }) });
    await evReload();
    if (r.reason) alert('败者组暂时没生成：' + r.reason + '\n把小组赛打完后再点「重新生成淘汰签表」即可。');
  } catch (e) { alert('设置失败: ' + e.message); await evReload(); }
}

// 折叠状态下那一行显示什么比分。
// 单项赛事只有 1 个比赛项目，大场分 i1:i2 恒为 1:0 / 0:1，横竖没信息，所以单项一律不看大场分：
//   一局定胜负 → 直接端出那一局的实际比分（21 : 15）
//   三局两胜   → 显示赢了几局（2 : 1）
// 团体赛是真「几项对几项」，保留大场分（3 : 2）。
function evTieHeadScore(t, d) {
  const o = t.outcome || {};
  if (d.event.kind !== 'team') {
    const bo = parseInt(d.best_of, 10) || 3;
    const it = (t.items || [])[0];
    const g = it && it.games && it.games[0];
    if (bo === 1) {
      if (g && g.s1 !== '' && g.s1 != null && g.s2 !== '' && g.s2 != null) return `${g.s1} : ${g.s2}`;
    } else if (o.g1 != null && o.g2 != null) {
      return `${o.g1} : ${o.g2}`;
    }
  }
  return `${o.i1} : ${o.i2}`;
}

function evTieHtml(t, d, ro, bracket) {
  const st = t.stage === 'lower' ? 'lower' : 'ko';
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
    const picked = EVS.pick && EVS.pick.stage === st && EVS.pick.ko_round === t.ko_round && EVS.pick.slot === t.slot && EVS.pick.side === side;
    return `<span class="ev-slot ${cls} ${canPick ? 'pickable' : ''} ${picked ? 'picked' : ''}"
      ${canPick ? `onclick="event.stopPropagation();evPickSwap(${t.ko_round},${t.slot},${side},'${st}')" title="点击后点另一个位置即可交换"` : ''}>${bkNameHtml(label)}</span>`;
  }

  // 三种状态必须分开：一方都没打 → 未录入（不能显示 0 : 0，否则像是真打出 0 比 0）；
  // 打了一半 → 进行中（此时的 i1:i2 是有意义的中途大场分）；赢了 → 已结束。
  const played = !!(o && o.perItem && o.perItem.some(p => p.side !== 0 || p.w1 || p.w2));
  const score = (both && played) ? evTieHeadScore(t, d) : '';
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

// 排阵选择器：按项目要求的性别提示，从该队名单里搜人（支持姓名 / ID 输入联想）。
// 混双固定「第一位男、第二位女」，避免排错。
function evLineupSide(d, t, it, def, side, ro) {
  const entryId = side === 1 ? t.side1_entry_id : t.side2_entry_id;
  const entry = d.entries.find(e => e.id === entryId);
  const members = entry ? entry.members : [];
  const chosen = (side === 1 ? it.side1_players : it.side2_players) || [];
  let h = '';
  for (let k = 0; k < def.size; k++) {
    const need = def.gender === 'mixed' ? (k === 0 ? 'male' : 'female') : def.gender;
    if (ro) {
      h += `<span style="font-size:13px;color:#4a5568">${chosen[k] ? htmlEsc(pn(chosen[k])) : '—'}</span>`;
      continue;
    }
    h += evPickHtml(`li${it.id}-${side}-${k}`, `选人${need === 'male' ? '(男)' : need === 'female' ? '(女)' : ''}`,
      need, members, chosen[k] || 0, `data-item="${it.id}" data-side="${side}" data-pos="${k}"`);
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
    // 名字做成按钮：两段式（点一下弹「查看此人对局」气泡，点气泡才跳），见 evAskPlayer
    return `<tr class="${cls}"><td>${medal}</td><td>${evNameBtnHtml(r.entry_id, r.label)}</td>
      ${isTeam ? evMemberCellHtml(r.member_ids, r.entry_id) : ''}
      ${hasPts ? `<td class="ev-final-pts">${r.points == null ? '—' : r.points}</td>` : ''}</tr>`;
  }).join('');
  return `<div class="card"><h3>最终排名 <span class="ev-hint">${hasPts ? '积分按本届级别折算，与总积分榜同一个数' : '该名次会按本届级别折算成积分并计入总积分榜'}</span></h3>
    <table class="ev-final"><thead><tr><th style="width:70px">名次</th><th>${noun}</th>
    ${isTeam ? '<th class="ev-member-col">成员</th>' : ''}
    ${hasPts ? '<th class="ev-final-pts">积分</th>' : ''}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------------- 非固搭双打：一场场录 4 人临时配对 + 个人成绩表 ----------------

function evFreeEntryHtml(d) {
  const kind = d.event.free_kind || 'md';
  const bo = parseInt(d.best_of, 10) || 3;
  // 男双只出男、女双只出女；混双男女都出（每边 1 男 1 女由后端卡）
  const g = kind === 'md' ? 'male' : kind === 'wd' ? 'female' : '';
  const gameRows = Array.from({ length: bo }, (_, i) => `<div class="ev-free-row">
      <span class="ev-free-side">${bo === 1 ? '比分' : `第 ${i + 1} 局`}</span>
      <input type="number" id="ef-g${i}-1" min="0" placeholder="0">
      <span class="ev-free-colon">:</span>
      <input type="number" id="ef-g${i}-2" min="0" placeholder="0">
    </div>`).join('');
  return `<div class="card">
    <h3>➕ 录入一场 <span class="ev-hint">${freeKindLabel(kind)}　4 人临时配成两对；同样 4 个人同样搭法再录 = 改这场比分，换一种搭法 = 新的一场</span></h3>
    <div class="ev-free-row">
      <span class="ev-free-side">左方</span>
      ${evPickHtml('ef-p1', '输入姓名或ID选人', g)}
      ${evPickHtml('ef-p2', '输入姓名或ID选人', g)}
    </div>
    <div class="ev-free-row">
      <span class="ev-free-side">右方</span>
      ${evPickHtml('ef-p3', '输入姓名或ID选人', g)}
      ${evPickHtml('ef-p4', '输入姓名或ID选人', g)}
    </div>
    ${gameRows}
    <div class="form-row">
      <button onclick="evSaveFreeMatch()">✅ 保存这一场</button>
      <span id="ev-free-msg" style="font-size:13px"></span>
    </div>
  </div>`;
}

function evFreeMsg(t, ok) {
  const el = document.getElementById('ev-free-msg');
  if (!el) { if (t) alert(t); return; }
  el.style.color = ok ? '#38a169' : '#e53e3e';
  el.textContent = t;
}

async function evSaveFreeMatch() {
  const d = EVS.detail;
  const ids = ['ef-p1', 'ef-p2', 'ef-p3', 'ef-p4'].map(x => evPickValue(x));
  if (ids.some(x => !x)) return evFreeMsg('请选择 4 名选手');
  if (new Set(ids).size !== 4) return evFreeMsg('同一场的 4 名选手不能重复');
  const bo = parseInt(d.best_of, 10) || 3;
  const games = [];
  for (let i = 0; i < bo; i++) {
    const a = document.getElementById(`ef-g${i}-1`), b = document.getElementById(`ef-g${i}-2`);
    const v1 = a && a.value !== '' ? parseInt(a.value) : NaN;
    const v2 = b && b.value !== '' ? parseInt(b.value) : NaN;
    if (!isNaN(v1) && !isNaN(v2)) games.push({ s1: v1, s2: v2 });
  }
  if (!games.length) return evFreeMsg('请填写比分');
  evFreeMsg('保存中...', true);
  try {
    await api(`/api/editions/${d.edition.id}/free-match`, {
      method: 'POST', body: JSON.stringify({ p1: ids[0], p2: ids[1], p3: ids[2], p4: ids[3], games })
    });
    cachedPlayers = [];
    invalidatePlayerQueryCache();
    await evReload();
    evFreeMsg('✅ 已保存');
  } catch (e) { evFreeMsg(e.message); }
}

async function evDeleteFreeMatch(edId, tieId) {
  if (!confirm('删除这一场及其比分？')) return;
  try {
    await api(`/api/editions/${edId}/free-match/${tieId}`, { method: 'DELETE' });
    cachedPlayers = [];
    invalidatePlayerQueryCache();
    await evReload();
  } catch (e) { alert('删除失败: ' + e.message); }
}

async function evGenFree(edId) {
  const d = EVS.detail;
  const n = d.entries.length;
  if (!confirm(`本届 ${n} 人，将把所有人两两搭配的对局一次排出来（搭档轮换尽量平均）。\n已录过比分的场次不会动，只补缺的。\n继续？`)) return;
  try {
    const r = await api(`/api/editions/${edId}/free-generate`, { method: 'POST', body: '{}' });
    await evReload();
    alert(`已补 ${r.added} 场，本届共 ${r.total} 场。${r.dropped ? `\n另有 ${r.dropped} 场因有人退出名单被作废。` : ''}`);
  } catch (e) { alert('生成失败: ' + e.message); }
}

// 成绩表：名次记在个人头上（胜场 → 净胜分，并列同名次、积分取平均）
function evFreeRankHtml(d) {
  const rows = d.final_ranks || [];
  let h = `<div class="card"><h3>选手排名 <span class="ev-hint">胜场 → 净胜分；并列同名次，积分取所跨名次的平均值</span></h3>`;
  if (!rows.length) return h + `<div class="ev-empty">还没有打出成绩，录完第一场就有了</div></div>`;
  h += `<table class="ev-final"><thead><tr><th style="width:70px">名次</th><th>选手</th>
    <th>胜</th><th>负</th><th>净胜分</th><th class="ev-final-pts">积分</th></tr></thead><tbody>`;
  for (const r of rows) {
    const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank;
    const cls = r.rank === 1 ? 'top1' : r.rank === 2 ? 'top2' : r.rank === 3 ? 'top3' : '';
    h += `<tr class="${cls}"><td>${medal}</td><td>${evNameBtnHtml(r.entry_id, r.label)}</td>
      <td>${r.wins}</td><td>${r.losses}</td>
      <td>${r.net_points > 0 ? '+' : ''}${r.net_points}</td>
      <td class="ev-final-pts">${r.points == null ? '—' : r.points}</td></tr>`;
  }
  return h + '</tbody></table></div>';
}

function evFreeTiesHtml(d, ro) {
  const ties = (d.ties || []).filter(t => t.stage === 'free').slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const nm = id => { const e = d.entries.find(x => x.id === id); return e ? e.label : '?'; };
  let h = `<div class="card"><h3>对局 <span class="ev-hint">共 ${ties.length} 场</span></h3>`;
  if (!ties.length) {
    return h + `<div class="ev-empty">还没有对局。点右上角「🎲 生成全部对局」一次排完，或用上面的表单一场场录。</div></div>`;
  }
  h += `<table class="ev-free"><thead><tr><th style="width:52px">#</th><th>左方</th><th>比分</th><th>右方</th>
    ${ro ? '' : '<th style="width:64px">操作</th>'}</tr></thead><tbody>`;
  ties.forEach((t, i) => {
    const games = ((t.items || [])[0] || {}).games || [];
    const score = games.length ? games.map(g => `${g.s1} : ${g.s2}`).join('　') : '<span class="ev-hint">未打</span>';
    const w = t.winner_entry_id ? (t.winner_entry_id === t.side1_entry_id ? 1 : 2) : 0;
    h += `<tr><td>${i + 1}</td>
      <td class="${w === 1 ? 'ev-free-win' : ''}">${htmlEsc(nm(t.side1_entry_id))} ＋ ${htmlEsc(nm(t.side1_entry2_id))}</td>
      <td><b>${score}</b></td>
      <td class="${w === 2 ? 'ev-free-win' : ''}">${htmlEsc(nm(t.side2_entry_id))} ＋ ${htmlEsc(nm(t.side2_entry2_id))}</td>
      ${ro ? '' : `<td><button class="danger" style="font-size:11px;padding:2px 8px"
        onclick="evDeleteFreeMatch(${d.edition.id},${t.id})">删除</button></td>`}</tr>`;
  });
  return h + '</tbody></table></div>';
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
      s1 = [...block.querySelectorAll(`.ev-ppick-in[data-side="1"]`)].map(el => evPickValueOf(el)).filter(Boolean);
      s2 = [...block.querySelectorAll(`.ev-ppick-in[data-side="2"]`)].map(el => evPickValueOf(el)).filter(Boolean);
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

// stage 只有 'ko' 与 'lower' 两种：败者组和主签表共用这套换位逻辑。
async function evPickSwap(round, slot, side, stage) {
  const st = stage === 'lower' ? 'lower' : 'ko';
  const p = EVS.pick;
  if (!p || p.stage !== st || p.ko_round !== round) { EVS.pick = { stage: st, ko_round: round, slot, side }; evRenderWorkspace(); return; }
  if (p.slot === slot && p.side === side) { EVS.pick = null; evRenderWorkspace(); return; }
  try {
    await api(`/api/editions/${EVS.detail.edition.id}/ko-swap`, {
      method: 'POST', body: JSON.stringify({ stage: st, a: p, b: { ko_round: round, slot, side } })
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
  tieCount: 0,       // 本届已有多少场对阵 —— 重排会清空比分，用它来决定要不要二次确认
  savedKey: '',      // 上次落库时的快照（日期|级别|届数|名单），用来判「有未保存的改动」
  savedEntries: null, // 上次落库的名单，用来判断这次要不要把 entries 发给服务端
  groupOpen: false   // 分组面板是否展开（本地状态，重绘时要保住用户的展开/收起）
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
    mEvMarkSaved();   // 新的一届：此刻「库里 == 空名单」，别沿用上一届的快照
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
  mEvMarkSaved();
}

// 记住「现在这份就是库里的」：未保存提示与「要不要发名单」都靠它判断
function mEvMarkSaved() {
  MES.savedEntries = MES.entries.map(e => ({ players: (e.players || []).slice() }));
  MES.savedKey = mEvCurrentKey();
}

function mEvRender() {
  const box = document.getElementById('ev-edition-card');
  if (!box || !MES.event) return;
  const ev = MES.event;
  const isTeam = ev.kind === 'team';
  const isFree = ev.format === 'free';
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

  // 项目类型锁定：男单/女单=1 人、男双/女双/混双=2 人。locked=0 表示未指定（legacy，仍可临时选）。
  const locked = evTypeSize(ev.type);
  const entryArea = isTeam
    ? `<div class="ev-sec">
        <div class="ev-sec-title">参赛队伍 <span class="ev-hint">先把队员加进名单，再填队名保存</span></div>
        <div class="form-row">
          <input type="text" id="mev-tname" placeholder="队伍名，例如：闪电队" value="${htmlEsc(MES.teamName)}" oninput="MES.teamName=this.value">
          ${evPickHtml('mev-tmember', '输入姓名或ID搜索队员')}
          <button onclick="mEvAddMember()">＋ 加入队员</button>
        </div>
        <div class="ev-chip-list">${memberRows}</div>
        <div class="form-row" style="margin-top:10px">
          <button onclick="mEvAddTeam()">✅ 保存这支队伍</button>
        </div>
      </div>`
    : `<div class="ev-sec">
        <div class="ev-sec-title">${entryNoun} <span class="ev-hint">每${evEntryUnit(ev.kind)}点一次添加${isFree ? '　非固搭双打：这里录的是一个个的人，搭档每场临时配' : (locked ? `　本项目为「${evTypeLabel(ev.type)}」，每单位 ${locked} 人` : '')}</span></div>
        ${isFree || locked ? '' : `<div class="form-row" style="margin-bottom:8px">
          <div class="ev-radios">
            <label class="ev-radio ${MES.singlesSize === 1 ? 'on' : ''}"><input type="radio" name="mev-size" ${MES.singlesSize === 1 ? 'checked' : ''} onchange="mEvSetSize(1)">单打（1 人）</label>
            <label class="ev-radio ${MES.singlesSize === 2 ? 'on' : ''}"><input type="radio" name="mev-size" ${MES.singlesSize === 2 ? 'checked' : ''} onchange="mEvSetSize(2)">双打（2 人）</label>
          </div>
        </div>`}
        <div class="form-row">
          ${evPickHtml('mev-p1', isFree ? '输入姓名或ID搜索选手' : '输入姓名或ID搜索' + evEntryUnit(ev.kind))}
          ${(locked === 2 || (!locked && MES.singlesSize === 2)) ? evPickHtml('mev-p2', '输入姓名或ID搜索搭档') : ''}
          <button onclick="mEvAddIndividual()">＋ 添加${entryNoun}</button>
        </div>
      </div>`;

  // 分组面板：只有「本届已保存」才有 entry id，才谈得上手动分组。
  // 生成对阵后也还能改 —— 但会清空比分，函数里会二次确认。
  // 单循环赛不分组（服务端也当 1 组），这里整个面板不出现。
  // 默认已经是「按种子蛇形」，绝大多数时候不用动 —— 所以折起来，
  // 真要调再点开。和哥 2026-10-25 要求：小卡片里不要一排按钮糊在一起。
  const needGroupUI = evFormatHasGroup(ev.format) && ev.format !== 'rr' && editing && MES.entries.every(e => e.id);
  const groupPick = needGroupUI
    ? `<details class="ev-fold-sec" ${MES.groupOpen ? 'open' : ''}>
        <summary>分组安排 <span class="ev-hint">默认「${groupModeLabel(ev.group_mode)}，种子按${seedByLabel(ev.seed_by)}」，点开可手动改</span></summary>
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
          <button class="secondary" onclick="mEvAutoSeedGroups()">🎯 按种子重排（蛇形）</button>
          <button onclick="mEvSaveGroups()">💾 保存分组</button>
        </div>
      </details>`
    : '';

  box.innerHTML = `<h3>⚙️ 本届设置 <span class="ev-hint">${htmlEsc(ev.name)}　${evKindLabel(ev.kind)}　${evFormatLabel(ev.format)}　${evBestOfLabel(ev.best_of)}</span></h3>
    <div class="form-row">
      <label style="font-size:14px;color:#4a5568">届次</label>
      <select id="mev-edition" onchange="mEvOnEditionChange(this.value)">${editionOpts}</select>
      <input type="date" id="mev-date" value="${MES.date}" onchange="MES.date=this.value;mEvTouch()">
      <select id="mev-level" onchange="MES.level=parseInt(this.value)||1000;mEvTouch()">
        ${[1000, 750, 500, 300].map(l => `<option value="${l}" ${MES.level === l ? 'selected' : ''}>${l}级</option>`).join('')}
      </select>
    </div>
    ${ev.format === 'group_ko' ? `<div class="ev-hint" style="margin:6px 0">小组 ${gc} 组、每组出线 ${apg} 个 —— 本届至少 ${need} ${evEntryUnit(ev.kind)}${entryNoun}</div>` : ''}
    ${isFree ? `<div class="ev-hint" style="margin:6px 0">${freeKindLabel(ev.free_kind)} · 每场 4 人上场 —— 本届名单至少 4 人，人越多场次越多（6 人 15 场）</div>` : ''}
    <div id="mev-dirty-bar">${mEvDirtyBar()}</div>
    ${entryArea}
    <div class="ev-chip-list" id="mev-entry-chips">${entryRows}</div>
    ${groupPick}
    <div class="form-row mev-foot">
      <button onclick="mEvGoWorkspace()">📋 打开工作台 →</button>
      ${editing ? `<button class="mev-link danger" onclick="mEvDelete()">删除本届</button>` : ''}
      <span id="mev-msg" style="font-size:13px"></span>
    </div>`;
  box.style.display = 'block';
}

// 未保存提示：日期 / 级别 / 名单改了但还没入库时给个显眼的提醒。
// 之前点了 Xin 也不落库，界面上却看不出还没保存，回头以为「改了没生效」。
function mEvDirty() {
  return MES.savedKey && MES.savedKey !== mEvCurrentKey();
}
function mEvCurrentKey() {
  const ents = MES.entries.map(e => (e.players || []).slice().sort((a, b) => a - b).join('+')).sort().join(';');
  return [MES.date, MES.level, MES.editionNo, ents].join('|');
}
function mEvDirtyBar() {
  if (!mEvDirty()) return '';
  return `<div class="mev-dirty">● 有未保存的改动（日期 / 级别 / 名单），点下面「打开工作台」会先自动保存</div>`;
}
// 只刷提示条，不整卡重绘 —— 重绘会清掉正在输入的选手搜索框
function mEvTouch() {
  const el = document.getElementById('mev-dirty-bar');
  if (el) el.innerHTML = mEvDirtyBar();
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
  const pid = evPickValue('mev-tmember');
  if (!pid) return alert('请从提示里选择一位选手');
  if (MES.teamMembers.includes(pid)) return alert('该队员已在名单里');
  MES.teamMembers.push(pid);
  const inp = document.getElementById('pp-mev-tmember');
  if (inp) inp.value = '';
  if (EVP['mev-tmember']) EVP['mev-tmember'].pid = 0;
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
  const p1 = evPickValue('mev-p1');
  if (!p1) return alert('请从提示里选择选手');
  const players = [p1];
  // 项目类型锁定人数与性别：男单/女单=1 人、男双/女双/混双=2 人；未指定（legacy）则沿用临时选的 singlesSize。
  const locked = evTypeSize(MES.event && MES.event.type);
  const size = locked || MES.singlesSize;
  const genders = evTypeGenders(MES.event && MES.event.type);
  // 非固搭双打按项目卡性别（男双只能男、女双只能女、混双不限单人）
  if (MES.event && MES.event.format === 'free') {
    const g = evGenderOf(p1), k = MES.event.free_kind || 'md';
    if (k === 'md' && g !== 'male') return alert('男双项目只能加男选手');
    if (k === 'wd' && g !== 'female') return alert('女双项目只能加女选手');
  }
  // 有项目类型时卡单人性别（男单只男、女单只女）
  if (genders && genders.length === 1) {
    const g1 = evGenderOf(p1);
    if (g1 !== genders[0]) return alert(`${evTypeLabel(MES.event.type)}只能加${genders[0] === 'male' ? '男' : '女'}选手`);
  }
  if (size === 2) {
    const p2 = evPickValue('mev-p2');
    if (!p2) return alert('双打请从提示里选择第二位选手');
    if (p2 === p1) return alert('两位选手不能相同');
    if (genders) {
      const g1 = evGenderOf(p1), g2 = evGenderOf(p2);
      if (genders.includes('male') && genders.includes('female')) {
        if (!((g1 === 'male' && g2 === 'female') || (g1 === 'female' && g2 === 'male'))) return alert('混双必须一男一女');
      } else if (genders.every(x => x === 'male') && (g1 !== 'male' || g2 !== 'male')) {
        return alert('男双只能加男选手');
      } else if (genders.every(x => x === 'female') && (g1 !== 'female' || g2 !== 'female')) {
        return alert('女双只能加女选手');
      }
    }
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

// 名单是否换过人。返回 true 表示「还是原来那批人」，此时请求里**不要带 entries**：
// 服务端一旦收到 entries 就会去比对、甚至可能重建参赛单元（id 全变），
// 日志里也会平白多出一条「参赛名单 N 个单元」，让人误以为名单被改了。
// 和哥 2026-10-25 的原话：「修改时间或者级别的时候，尽量不要一下子改变其它信息」。
function mEvSameLineup() {
  if (!MES.savedEntries) return false;
  const key = es => es.map(e => (e.players || []).slice().sort((a, b) => a - b).join('+')).sort().join(';');
  return key(MES.savedEntries) === key(MES.entries);
}

async function mEvSave() {
  const minN = MES.event.format === 'free' ? 4 : 2;
  if (MES.entries.length < minN) return mEvMsg(`至少需要 ${minN} ${evEntryUnit(MES.event.kind)}${evEntryNoun(MES.event.kind)}`);
  const dateEl = document.getElementById('mev-date'), lvEl = document.getElementById('mev-level');
  const body = {
    edition: MES.editionNo || 1,
    date: dateEl ? dateEl.value : MES.date,
    level: lvEl ? (parseInt(lvEl.value) || 1000) : MES.level
  };
  // 已经建过本届、且名单没换人 → 一个字节的名单都不往服务端发
  if (!(MES.editionId && mEvSameLineup())) {
    body.entries = MES.entries.map(e => ({ label: e.label, players: e.players }));
  }
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
    // 重新拉一次本届：名单存进库后才有 entry id 与种子积分，分组面板要用。
    // 它顺带会把 savedKey / savedEntries 刷成最新，未保存提示随之消失。
    await mEvSelectEdition(MES.editionId);
    mEvRender();
    mEvMsg('✅ 已保存', true);
  } catch (e) { mEvMsg(e.message); }
}

// 唯一的那个按钮：保存（如有未存改动）→ 生成对阵（还没排过的话）→ 直接进工作台。
// 之前三个按钮（保存本届 / 一键生成对阵 / 打开工作台）挤成一排，
// 还要自己记得先保存再生成再打开，漏一步就一头雾水。
async function mEvGoWorkspace() {
  const ev = MES.event;
  if (!ev) return;
  try {
    if (!MES.editionId || mEvDirty()) {
      await mEvSave();
      if (!MES.editionId) return;              // 保存失败时 mEvSave 已经把原因写出来了
    }
    // 一个对阵都还没排 → 按赛制先排出来，省得再点一次按钮
    if (MES.tieCount === 0) await mEvGenFixtures();
  } catch (e) { return mEvMsg(e.message); }
  await mEvOpenWorkspace();
}

async function mEvGenFixtures() {
  if (!MES.editionId) return;
  const ev = MES.event;
  // 非固搭双打：把所有人两两搭配的场次一次排出来，已录比分的那几场不动
  if (ev.format === 'free') {
    try {
      mEvMsg('生成中...', true);
      const r = await api('/api/editions/' + MES.editionId + '/free-generate', { method: 'POST', body: '{}' });
      mEvMsg(`✅ 已补 ${r.added} 场（本届共 ${r.total} 场），点「打开工作台」录比分。`, true);
    } catch (e) { mEvMsg(e.message); }
    return;
  }
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

// 从历史排名曲线页返回：?player=<姓名> 直接回到该选手的查询详情页
// （曲线页「返回」按钮链到这里，见 chart.js）。
// 为什么不用 history.back()：浏览器后退对 SPA 的 tab 激活状态没有保证
// （可能整页重载回默认 tab），参数深链则 100% 还原现场。
// 先用 replaceState 清掉参数，避免刷新重复触发、或把参数带向其它 tab。
(async function initPlayerFromUrl() {
  const player = new URLSearchParams(location.search).get('player');
  if (!player) return;
  try {
    const url = new URL(location.href);
    url.searchParams.delete('player');
    history.replaceState(null, '', url);
    document.querySelector('[data-tab="player-query"]').click();
    await showPlayerDetail(player);
  } catch (e) { /* 深链失败就静默留在首页，不打扰用户 */ }
})();
