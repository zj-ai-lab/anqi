const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Database=require('better-sqlite3');
const {backupTo,restoreTo}=require('./local-backup.cjs');
async function main() {
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'anqi-backup-test-'));
  const source=path.join(scratch,'live.db');
  const db=new Database(source);db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');
  for (const table of ['cases','events','deadlines','tasks','worklog']) {db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,name TEXT)`);db.prepare(`INSERT INTO ${table}(name) VALUES (?)`).run('虚构WAL数据');}
  const backup=path.join(scratch,'backup');
  const manifest=await backupTo(source,backup);
  assert.equal(manifest.counts.events,1);
  assert.ok(fs.statSync(source+'-wal').size>0,'源库仍有WAL');
  await assert.rejects(backupTo(source,backup),/EEXIST/);
  const target=path.join(scratch,'restore','restored.db');
  await restoreTo(backup,target);
  await assert.rejects(restoreTo(backup,target),/拒绝覆盖/);
  const restored=new Database(target,{readonly:true});
  assert.equal(restored.prepare('SELECT name FROM events').get().name,'虚构WAL数据');restored.close();db.close();
  console.log('backup: live WAL / integrity / counts / exclusive targets / restore passed; retained '+scratch);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
