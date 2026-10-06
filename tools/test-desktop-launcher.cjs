const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto');
const {start}=require('./desktop-start.cjs');
const Database=require('better-sqlite3');
const source=path.resolve('data/desktop/anjian.db'),hash=()=>crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const keepAlive=setInterval(()=>{},1000);
(async()=>{
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'anqi-desktop-'));const digest=hash(),port=await freePort();let pid;
 try{
  const result=await start({directory:scratch,source,port});const runtime=JSON.parse(fs.readFileSync(result.runtime_file)),config=JSON.parse(fs.readFileSync(path.join(scratch,'launcher-config.json')));pid=Number(fs.readFileSync(path.join(scratch,'server.pid')));
  assert.equal(config.host,'127.0.0.1');for(const file of ['launcher-config.json','runtime.json','anjian.db'])assert.equal(fs.statSync(path.join(scratch,file)).mode&0o077,0);
  assert.equal((await fetch(runtime.url+'api/counts')).status,401);
  const headers={Cookie:'anjian_token='+runtime.token,'Content-Type':'application/json'};
  const counts=await(await fetch(runtime.url+'api/counts',{headers})).json();assert.equal(counts.active_cases,2);
  const task=await fetch(runtime.url+'api/tasks',{method:'POST',headers,body:JSON.stringify({case_id:1,title:'虚构原生启动持久化验收',priority:'normal'})});assert.equal(task.status,200);const created=await task.json();
  const before=fs.readdirSync(path.join(scratch,'backups')).length;
  await Promise.all([start({directory:scratch}),start({directory:scratch}),start({directory:scratch})]);assert.equal(Number(fs.readFileSync(path.join(scratch,'server.pid'))),pid);assert.equal(fs.readdirSync(path.join(scratch,'backups')).length,before);
  process.kill(pid,'SIGTERM');await delay(500);await start({directory:scratch});pid=Number(fs.readFileSync(path.join(scratch,'server.pid')));
  const d=new Database(config.db_path,{readonly:true});assert.equal(d.prepare('select title from tasks where id=?').get(created.id).title,'虚构原生启动持久化验收');assert.equal(d.pragma('quick_check',{simple:true}),'ok');d.close();assert.equal(hash(),digest);
  assert.equal(fs.readdirSync(path.join(scratch,'backups')).length,before+1);
  const blocked=net.createServer(socket=>socket.destroy());await new Promise(r=>blocked.listen(0,'127.0.0.1',r));const occupied=blocked.address().port;
  try{await assert.rejects(start({directory:path.join(scratch,'occupied'),source,port:occupied}),/其他服务占用/);assert(blocked.listening);}finally{await new Promise(r=>blocked.close(r));}
  console.log(JSON.stringify({passed:true,cold_start:true,anonymous_401:true,persistent_restart:true,repeated_start_same_pid:true,backup_before_restart:true,occupied_port_preserved:true,source_unchanged:true,retained:scratch}));
 }finally{if(pid)try{process.kill(pid,'SIGTERM');}catch{}}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearInterval(keepAlive));
