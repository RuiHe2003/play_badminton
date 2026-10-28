// 历史排名曲线页：拉 /api/player/:name/rank-history，画 SVG 折线。
// 设计口径：
//   · y 轴 = 同性内名次，第 1 名在顶部（数值越小越靠上，反向刻度）
//   · x 轴 = 事件时点等距排列（赛事不定期，等距比按日期比例更可读）
//   · 事件分两种：蓝点＝打出成绩的轮次；亮黄▼＝停办赛事按时间衰减
//     （和积分榜里亮黄▼同款语言）。衰减发生在两届之间的「空白段 + k×182 天」
//     步进点上，当天没有轮次也会掉分/掉名次——不录成点就会被直线悄悄吸收，
//     所以专门标出来（和哥 v84 要求「标注某某赛事衰减」）。
//   · 每个点 hover/触摸出 tooltip：日期、赛事/衰减详情、总积分、名次、当时上榜人数
//   · 最后一点加粗标「现在」
(function () {
  const params = new URLSearchParams(location.search);
  const name = params.get('name') || '';
  const wrap = document.getElementById('chart-wrap');
  const metaEl = document.getElementById('chart-meta');
  const tip = document.getElementById('chart-tip');
  const COLORS = {
    line: '#2b6cb0', grid: '#edf2f7', axis: '#a0aec0', text: '#4a5568', now: '#c53030',
    decay: '#ffbf00', decayStroke: '#975a16', decayText: '#b7791f'   // 亮黄▼＝停办衰减（与榜单一致）
  };

  if (!name) {
    wrap.innerHTML = '<div class="chart-state">缺少选手参数，<a href="/">返回首页</a>重试</div>';
    return;
  }

  // 返回按钮：从选手查询页跳过来（&from=player）的，回到「该选手的查询详情页」
  // （/?player=<姓名> 深链，app.js initPlayerFromUrl 负责还原），
  // 直接打开（无来源）的才回首页。
  if (params.get('from') === 'player') {
    document.getElementById('chart-back').href = '/?player=' + encodeURIComponent(name);
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 亮黄小倒三角（衰减标记）
  const triPath = (cx, cy, s) => `M ${cx.toFixed(1)} ${(cy + s).toFixed(1)} L ${(cx - s * 0.92).toFixed(1)} ${(cy - s * 0.72).toFixed(1)} L ${(cx + s * 0.92).toFixed(1)} ${(cy - s * 0.72).toFixed(1)} Z`;

  fetch('/api/player/' + encodeURIComponent(name) + '/rank-history')
    .then(r => { if (!r.ok) throw new Error(r.status === 404 ? '选手不存在' : 'HTTP ' + r.status); return r.json(); })
    .then(data => render(data))
    .catch(err => {
      wrap.innerHTML = '<div class="chart-state">加载失败：' + esc(err.message) + '，<a href="/">返回首页</a></div>';
    });

  function render(data) {
    const series = data.series || [];
    const p = data.player || {};
    document.title = (p.real_name || p.name || name) + ' · 历史排名曲线';
    const gName = p.gender === 'male' ? '男子' : p.gender === 'female' ? '女子' : '';

    if (!series.length) {
      metaEl.innerHTML = `<span class="chart-name">${esc(p.real_name || p.name || name)}</span>` +
        (gName ? `<span class="chart-gender ${esc(p.gender)}">${gName}</span>` : '');
      wrap.innerHTML = '<div class="chart-state">该选手暂无上榜记录，曲线从第一次获得积分开始。</div>';
      return;
    }

    // ---- meta 区：姓名 + 性别 + 最好/当前名次 + 时点数（含衰减次数）+ 图例 ----
    const best = series.reduce((a, b) => (b.rank < a.rank ? b : a));
    const cur = series[series.length - 1];
    const decayCount = series.filter(s => s.type === 'decay').length;
    metaEl.innerHTML =
      `<span class="chart-name">${esc(p.real_name || p.name || name)}</span>` +
      (gName ? `<span class="chart-gender ${esc(p.gender)}">${gName}</span>` : '') +
      `<span class="chart-chip">最好 <b>第 ${best.rank} 名</b>（${esc(best.date)}）</span>` +
      `<span class="chart-chip">当前 <b>第 ${cur.rank} 名</b></span>` +
      `<span class="chart-chip">${series.length} 个时点</span>` +
      (decayCount ? `<span class="chart-chip" style="color:${COLORS.decayText};border-color:#faf089">停办衰减 <b style="color:${COLORS.decayText}">× ${decayCount}</b></span>` : '') +
      (decayCount ? `<span class="chart-chip">图例 <b style="color:#2b6cb0">●</b> 轮次 · <b style="color:${COLORS.decayText}">▼</b> 停办衰减</span>` : '');

    // ---- 画布尺寸（viewBox 固定，CSS 缩放到容器宽，双端自适应）----
    const W = 720, H = 400, L = 44, R = 22, T = 26, B = 46;
    const n = series.length;
    const maxRank = Math.max(...series.map(s => s.rank));
    const yMax = Math.max(5, maxRank);   // 名次轴上限 = 实际最差名次（至少 5 档），不取整到 5 的倍数

    const x = i => (n === 1 ? (L + (W - L - R) / 2) : L + i * (W - L - R) / (n - 1));
    const y = r => T + (r - 1) * (H - T - B) / (yMax - 1);

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="历史排名曲线">`;

    // y 轴：每个整数名次一条浅网格线，标签也跟着逐名次标（≤15 名时 1,2,3…全标），
    // 数据点全部落在整数名次线上，名次「对准」看得见（和哥 v83 反馈）。
    const step = yMax <= 15 ? 1 : yMax <= 30 ? 2 : 5;
    for (let r = 1; r <= yMax; r++) {
      const yy = Math.round(y(r) * 10) / 10;
      svg += `<line x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}" stroke="${r === 1 ? '#cbd5e0' : COLORS.grid}" stroke-width="1"/>`;
      if (r === 1 || r % step === 0) {
        svg += `<text x="${L - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${COLORS.text}">${r}</text>`;
      }
    }
    svg += `<text x="${L - 8}" y="${T - 10}" text-anchor="end" font-size="10" fill="${COLORS.axis}">名次</text>`;

    // x 轴标签：至多 8 个刻度，跨年的第一个刻度带年份
    const tickIdx = n <= 8 ? series.map((_, i) => i) : [...new Set([0, n - 1, ...Array.from({ length: 6 }, (_, i) => Math.round(i * (n - 1) / 6))])].sort((a, b) => a - b);
    let lastYear = '';
    for (const i of tickIdx) {
      const d = series[i].date;
      const yr = d.slice(0, 4);
      const label = yr !== lastYear ? yr.slice(2) + '年' + d.slice(5, 7) + '月' : d.slice(5);
      lastYear = yr;
      svg += `<text x="${x(i)}" y="${H - B + 18}" text-anchor="middle" font-size="11" fill="${COLORS.text}">${esc(label)}</text>`;
    }

    // 折线
    const path = series.map((s, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(s.rank).toFixed(1)).join(' ');
    svg += `<path d="${path}" fill="none" stroke="${COLORS.line}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

    // 数据点：轮次＝蓝点；停办衰减＝亮黄▼；最后一点加红晕标「现在」
    series.forEach((s, i) => {
      const isNow = i === n - 1;
      const cx = x(i), cy = y(s.rank);
      if (isNow) {
        svg += `<circle cx="${cx}" cy="${cy}" r="9" fill="${COLORS.now}" opacity="0.15"/>`;
        svg += `<text x="${cx}" y="${cy - 13}" text-anchor="middle" font-size="10" fill="${COLORS.now}" font-weight="700">现在</text>`;
      }
      if (s.type === 'decay') {
        svg += `<path class="pt" data-i="${i}" d="${triPath(cx, cy, 4.8)}" fill="${COLORS.decay}" ` +
          `stroke="${COLORS.decayStroke}" stroke-width="1.2" style="cursor:pointer"/>`;
      } else {
        svg += `<circle class="pt" data-i="${i}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${isNow ? 5.5 : 4}" ` +
          `fill="${isNow ? COLORS.now : '#fff'}" stroke="${isNow ? COLORS.now : COLORS.line}" stroke-width="2.5" style="cursor:pointer"/>`;
      }
    });

    svg += '</svg>';
    wrap.innerHTML = svg;

    // ---- tooltip：hover / 触摸都行，边界自动翻转 ----
    const pts = [...wrap.querySelectorAll('circle.pt, path.pt')];
    function decayLine(s) {
      if (!s.decayed || !s.decayed.length) return '';
      const names = s.decayed.map(d => esc(d.name) + (d.lost != null ? ' -' + esc(d.lost) : '')).join('、');
      return `<div class="tt-sub" style="color:#faf089">${s.type === 'decay' ? '停办站点：' : '＋停办衰减：'}${names}</div>`;
    }
    function showTip(i, cx, cy) {
      const s = series[i];
      const p0 = i > 0 ? series[i - 1] : null;
      let html;
      if (s.type === 'decay') {
        const own = s.kind === 'own';
        html =
          `<div class="tt-date">${esc(s.date)}</div>` +
          `<div class="tt-main" style="color:#faf089">停办衰减${own ? '' : '（其他选手）'}</div>` +
          decayLine(s) +
          `<div class="tt-sub">` +
          (own
            ? `总积分 ${p0 ? esc(p0.points) + ' → ' : ''}${esc(s.points)} · `
            : `总积分 ${esc(s.points)}（未变）· `) +
          `名次 ${p0 ? esc(p0.rank) + ' → ' : ''}${esc(s.rank)} · 上榜 ${esc(s.ranked_count)} 人</div>`;
      } else {
        html =
          `<div class="tt-date">${esc(s.date)}</div>` +
          `<div class="tt-main">${esc(s.tournament)} ${esc(s.level)}级 · 第${esc(s.edition)}届</div>` +
          `<div class="tt-sub">总积分 ${esc(s.points)} · 第 ${esc(s.rank)} 名 / 上榜 ${esc(s.ranked_count)} 人</div>` +
          decayLine(s);
      }
      tip.innerHTML = html;
      tip.hidden = false;
      const tr = tip.getBoundingClientRect();
      let left = cx + 14, top = cy - tr.height / 2;
      if (left + tr.width > window.innerWidth - 8) left = cx - tr.width - 14;
      top = Math.max(8, Math.min(top, window.innerHeight - tr.height - 8));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
    function ptCenter(el) {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }
    pts.forEach(el => {
      const i = +el.dataset.i;
      el.addEventListener('mouseenter', () => { const c = ptCenter(el); showTip(i, c.cx, c.cy); });
      el.addEventListener('touchstart', e => { const c = ptCenter(el); showTip(i, c.cx, c.cy); }, { passive: true });
    });
    wrap.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
})();
