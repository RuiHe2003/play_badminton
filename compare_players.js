const https = require('https');
const http = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject).on('timeout', reject);
  });
}

(async () => {
  const onlinePlayers = await fetch('https://badminton.bonto.run/api/players');
  const localPlayers = await fetch('http://localhost:3000/api/players');

  // Build local lookup
  const localMap = {};
  for (const p of localPlayers) {
    localMap[p.id] = p.name;
  }

  // For each online player that also exists locally, fetch their detail
  const results = [];
  for (const p of onlinePlayers) {
    if (!localMap[p.id]) continue; // skip players not in local
    try {
      const detail = await fetch(`https://badminton.bonto.run/api/player/${encodeURIComponent(p.name)}`);
      results.push({
        id: p.id,
        name: p.name,
        bio: detail.player?.bio || '',
        avatar: detail.player?.avatar ? 'YES' : '',
        partner1: detail.player?.partner1_id || null,
        partner2: detail.player?.partner2_id || null,
        partner3: detail.player?.partner3_id || null,
      });
    } catch(e) {
      results.push({ id: p.id, name: p.name, error: e.message });
    }
  }

  console.log('id\tname\tbio\tavatar\tp1\tp2\tp3');
  for (const r of results) {
    if (r.error) { console.log(`${r.id}\t${r.name}\tERROR: ${r.error}`); continue; }
    const bio = r.bio ? r.bio.substring(0, 20) : '';
    console.log(`${r.id}\t${r.name}\t${bio}\t${r.avatar}\t${r.partner1||'-'}\t${r.partner2||'-'}\t${r.partner3||'-'}`);
  }
})();
