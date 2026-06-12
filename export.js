const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function main() {
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(path.join(__dirname, 'data.db'));
  const db = new SQL.Database(buffer);

  const tables = ['players', 'tournaments', 'rounds', 'teams', 'matches', 'settings'];
  for (const t of tables) {
    const rows = db.exec('SELECT * FROM ' + t);
    if (rows.length > 0 && rows[0].values.length > 0) {
      console.log('-- ' + t + ' (' + rows[0].values.length + ' rows)');
      for (const row of rows[0].values) {
        const vals = row.map(v => {
          if (v === null) return 'NULL';
          const s = String(v).replace(/'/g, "''");
          return "'" + s + "'";
        });
        console.log('INSERT INTO ' + t + ' VALUES (' + vals.join(', ') + ');');
      }
      console.log('');
    }
  }
}
main();
