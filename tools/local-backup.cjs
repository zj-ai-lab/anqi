// 备份/恢复只新建目标；拒绝覆盖，保留 WAL 中已提交数据与可选 secret.key。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function backupTo(source, directory) {
  if (!fs.existsSync(source)) throw new Error('源数据库不存在');
  fs.mkdirSync(directory,{ recursive:false,mode:0o700 });
  const target=path.join(directory,'anjian.db');
  const db=new Database(source,{ readonly:true,fileMustExist:true });
  try {
    if (db.pragma('quick_check',{ simple:true }) !== 'ok') throw new Error('源数据库完整性检查失败');
    await db.backup(target);
    fs.chmodSync(target,0o600);
    const secret=path.join(path.dirname(source),'secret.key');
    if (fs.existsSync(secret)) { fs.copyFileSync(secret,path.join(directory,'secret.key'),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(directory,'secret.key'),0o600); }
    const tables=['cases','events','deadlines','tasks','worklog'];
    // 清单核对备份本身；源库在在线备份结束后仍可能接收新的提交。
    const snapshot=new Database(target,{ readonly:true,fileMustExist:true });
    let manifest;
    try {
      manifest={ created_at:new Date().toISOString(),schema_version:snapshot.pragma('user_version',{ simple:true }),database_sha256:digest(target),counts:Object.fromEntries(tables.map(table=>[table,snapshot.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n])),has_secret_key:fs.existsSync(secret),secret_sha256:fs.existsSync(secret)?digest(secret):null };
    } finally { snapshot.close(); }
    fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{ flag:'wx',mode:0o600 });
    return manifest;
  } finally { db.close(); }
}
async function restoreTo(directory,target) {
  if (fs.existsSync(target) || fs.existsSync(target+'-wal') || fs.existsSync(target+'-shm')) throw new Error('目标已有数据库或WAL，拒绝覆盖；请选择新路径');
  const source=path.join(directory,'anjian.db');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const tables=['cases','events','deadlines','tasks','worklog'];
  if (!manifest.counts || Object.keys(manifest.counts).length!==tables.length || Object.keys(manifest.counts).some(t=>!tables.includes(t))) throw new Error('备份清单表名非法');
  if (digest(source)!==manifest.database_sha256) throw new Error('备份哈希不一致');
  const secret=path.join(directory,'secret.key');
  const targetSecret=path.join(path.dirname(target),'secret.key');
  if (manifest.has_secret_key && (!fs.existsSync(secret) || fs.existsSync(targetSecret))) throw new Error('密钥缺失或恢复目录已有密钥；请选择空恢复目录');
  if (manifest.has_secret_key && digest(secret)!==manifest.secret_sha256) throw new Error('密钥备份哈希不一致');
  fs.mkdirSync(path.dirname(target),{ recursive:true,mode:0o700 });
  const db=new Database(source,{ readonly:true,fileMustExist:true });
  try { await db.backup(target); } finally { db.close(); }
  fs.chmodSync(target,0o600);
  const restored=new Database(target,{ readonly:true,fileMustExist:true });
  try {
    if (restored.pragma('quick_check',{ simple:true })!=='ok') throw new Error('恢复库检查失败');
    if (restored.pragma('user_version',{simple:true})!==manifest.schema_version) throw new Error('恢复库版本不一致');
    for (const [table,count] of Object.entries(manifest.counts)) if (restored.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n!==count) throw new Error('恢复行数不一致');
  } finally { restored.close(); }
  if (manifest.has_secret_key) { fs.copyFileSync(secret,targetSecret,fs.constants.COPYFILE_EXCL);fs.chmodSync(targetSecret,0o600); }
  return { target,verified:true };
}
module.exports={ backupTo,restoreTo };
if (require.main === module) {
  const [mode,source,target]=process.argv.slice(2);
  const action=mode==='backup'?backupTo:mode==='restore'?restoreTo:null;
  if (!action || !source || !target) { console.error('用法：local-backup.cjs backup 源库 新备份目录 | restore 备份目录 新库路径');process.exitCode=2; }
  else action(source,target).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
