// 一次性：把「总决赛」拆成两个赛事 —— 总决赛（混双）保留第1届，总决赛（男单）接管第2届。
// 跑完即删也可、留着当记录也行。跑前确保服务在 3000 端口跑着（走 API，不碰 data.db 文件）。
const BASE = 'http://localhost:3000';

async function api(path, method, body) {
  const r = await fetch(BASE + path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${d.error || JSON.stringify(d)}`);
  return d;
}

(async () => {
  // 1. 读老总决赛（event 37）当前赛制
  const old = await api('/api/events/37');
  const ev = old.event;
  console.log('老总决赛:', JSON.stringify({ id: ev.id, name: ev.name, kind: ev.kind, format: ev.format,
    best_of: ev.best_of, third_place: ev.third_place, lower_bracket: ev.lower_bracket,
    group_count: ev.group_count, advance_per_group: ev.advance_per_group, seed_by: ev.seed_by,
    group_mode: ev.group_mode, ko_mode: ev.ko_mode, free_kind: ev.free_kind, tournament_id: ev.tournament_id }));

  // 2. 存一份赛制模板（以后建同款赛事一键填充）
  const tpl = await api('/api/event-templates', 'POST', {
    name: '总决赛赛制',
    kind: ev.kind, format: ev.format, best_of: ev.best_of, free_kind: ev.free_kind || 'md',
    third_place: !!ev.third_place, lower_bracket: !!ev.lower_bracket,
    group_count: ev.group_count, advance_per_group: ev.advance_per_group,
    seed_by: ev.seed_by, group_mode: ev.group_mode, ko_mode: ev.ko_mode
  });
  console.log('模板已建 id=', tpl.id);

  // 3. 建「总决赛（男单）」（赛制与老总决赛一致）
  const created = await api('/api/events', 'POST', {
    name: '总决赛（男单）',
    kind: ev.kind, format: ev.format, best_of: ev.best_of, free_kind: ev.free_kind || 'md',
    third_place: !!ev.third_place, lower_bracket: !!ev.lower_bracket,
    group_count: ev.group_count, advance_per_group: ev.advance_per_group,
    seed_by: ev.seed_by, group_mode: ev.group_mode, ko_mode: ev.ko_mode
  });
  console.log('新赛事已建 event_id=', created.id, 'tournament_id=', created.tournament_id);

  // 4. 图标复用老总决赛的
  const tours = await api('/api/tournaments');
  const oldTour = tours.find(t => t.id === ev.tournament_id);
  if (oldTour && oldTour.icon) {
    await api(`/api/tournaments/${created.tournament_id}/icon`, 'POST', { icon: oldTour.icon });
    console.log('图标已复制');
  } else {
    console.log('老赛事没有图标，跳过');
  }

  // 5. 第2届（edition 127）搬到新赛事
  await api('/api/editions/127/move', 'POST', { event_id: created.id });
  console.log('第2届已迁移');

  // 6. 老赛事改名「总决赛（混双）」（config 接口会同步镜像 tournaments 的名字）
  await api('/api/events/37/config', 'PUT', { name: '总决赛（混双）' });
  console.log('老赛事已改名 总决赛（混双）');

  // 7. 验证
  const evs = await api('/api/events');
  for (const e of evs) {
    if (e.name.includes('总决赛')) {
      console.log('验证:', e.name, '| 届数', e.edition_count, '| id', e.id);
    }
  }
  const pts = await api('/api/points');
  for (const p of pts) {
    if (p.gender === 'female' && p.tournaments['总决赛(混双)(1000级)']) {
      console.log('女生榜验证:', p.real_name || p.name, '总决赛(混双) =', p.tournaments['总决赛(混双)(1000级)'].points,
        '| 届扣标志:', p.tournaments['总决赛(混双)(1000级)'].deducted ? '有(不该有!)' : '无');
    }
  }
  const hrs = await api('/api/player/R./honors');
  for (const h of hrs.honors || []) console.log('荣誉验证:', h.tournament_name, '第' + h.edition + '届', h.tier_label);
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
