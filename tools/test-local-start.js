import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import passwordHash from '../src/lib/password-hash.cjs';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'anqi-start-test-'));
process.env.DB_PATH=path.join(scratch,'test.db');
const {db}=await import('../src/db.js');
db.close();
const blocker=net.createServer();await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));
const port=blocker.address().port;
const env={...process.env,DB_PATH:process.env.DB_PATH,HOST:'127.0.0.1',PORT:String(port),ANJIAN_UNSAFE_NO_AUTH:'',ANJIAN_USER:'synthetic-user',ANJIAN_PASS_HASH:passwordHash.hashPassword(randomUUID()),ANJIAN_STATIC_TOKEN:randomUUID(),ANJIAN_FILES_ROOT:'',ANJIAN_AGENT_SESSION_ROOT:path.join(scratch,'sessions')};
const before=fs.readFileSync(env.DB_PATH);
const busy=spawnSync(process.execPath,['tools/local-start.cjs'],{env,encoding:'utf8'});
assert.equal(busy.status,1);assert.ok(busy.stderr.includes('EADDRINUSE'));
assert.deepEqual(fs.readFileSync(env.DB_PATH),before,'端口冲突时不迁移业务库');
await new Promise(resolve=>blocker.close(resolve));
const child=spawn(process.execPath,['tools/local-start.cjs'],{env,stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
try {
  for (let i=0;i<100 && !output.includes('anjian listening on');i++) {
    if (child.exitCode!==null) throw new Error('启动失败：'+output);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(output.includes('启动前备份已完成'));
  assert.ok(output.includes('anjian listening on'));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sync/status`)).status,401,'日常入口须保持鉴权');
  const backupDirs=fs.readdirSync(path.join(scratch,'backups'));assert.equal(backupDirs.length,1);
  assert.ok(fs.existsSync(path.join(scratch,'backups',backupDirs[0],'manifest.json')));
} finally {
  if (child.exitCode===null) {child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
}
console.log('daily start: port conflict / preflight / backup / authenticated service / graceful stop passed; retained '+scratch);
