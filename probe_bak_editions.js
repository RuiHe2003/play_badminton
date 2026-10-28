// 查备份库里总决赛（event 37）有几届
const { initDatabase, getDb } = require('./database');
(async () => {
  await initDatabase();
  const db = getDb();
  const r = db.exec("SELECT id, edition, date, status, round_id FROM event_editions WHERE event_id=37 ORDER BY id");
  console.log('备份库总决赛届次:', JSON.stringify(r));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
