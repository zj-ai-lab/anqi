// 原生启动器后端：显式持久数据库、鉴权、健康核对、重复启动复用与启动前备份。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {backupTo}=require('./local-backup.cjs');
const {hashPassword}=require('../src/lib/password-hash.cjs');
const root=path.resolve(__dirname,'..');
const defaultDirectory=process.env.ANQI_DESKTOP_DIR || path.join(require('node:os').homedir(),'Library','Application Support','cn.csslaw.anqi.local-only');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function check(base,token){try{const response=await fetch(base+'/api/counts',{headers:{Cookie:'anjian_token='+token},signal:AbortSignal.timeout(1000)});if(!response.ok)return false;const d=await response.json();return typeof d.active_cases==='number'&&typeof d.version==='string';}catch{return false;}}
async function start({directory=defaultDirectory,source,port=3017,open=false}={}){
 if(Number(process.versions.node.split('.')[0])!==22)throw Error('需要已验证的 Node22');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,'launcher-config.json');let config;
 if(fs.existsSync(file)){if(fs.statSync(file).mode&0o077)throw Error('启动器配置权限异常，必须仅本人读写');config=JSON.parse(fs.readFileSync(file,'utf8'));}
 else{
  config={format:1,db_path:path.join(directory,'anjian.db'),host:'127.0.0.1',port,user:'desktop-'+crypto.randomBytes(8).toString('hex'),pass_hash:hashPassword(crypto.randomBytes(32).toString('base64url')),static_token:crypto.randomBytes(32).toString('hex')};
  try{fs.writeFileSync(file,JSON.stringify(config),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;config=JSON.parse(fs.readFileSync(file,'utf8'));}
 }
 if(config.format!==1||config.host!=='127.0.0.1'||!Number.isInteger(config.port)||config.port<1024||config.port>65535||!path.isAbsolute(config.db_path)||!/^[a-f0-9]{64}$/.test(config.static_token||''))throw Error('启动器配置不合法');
 const base='http://127.0.0.1:'+config.port;
 if(!await check(base,config.static_token)){
  const net=require('node:net');const probe=net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',()=>reject(Error('端口已被其他服务占用，未关闭其他程序')));probe.listen(config.port,config.host,resolve);});await new Promise(r=>probe.close(r));
  if(!fs.existsSync(config.db_path)){
   let selected=source;
   if(!selected)selected=path.join(require('node:os').homedir(),'Library','Application Support','cn.csslaw.anqi','anjian.db');
   if(fs.existsSync(selected)){const copy=path.join(directory,'initial-copy-'+Date.now());await backupTo(selected,copy);fs.copyFileSync(path.join(copy,'anjian.db'),config.db_path,fs.constants.COPYFILE_EXCL);fs.chmodSync(config.db_path,0o600);const key=path.join(copy,'secret.key');if(fs.existsSync(key))fs.copyFileSync(key,path.join(directory,'secret.key'),fs.constants.COPYFILE_EXCL);}
  }
  if(fs.existsSync(config.db_path)){const backups=path.join(directory,'backups');fs.mkdirSync(backups,{recursive:true,mode:0o700});await backupTo(config.db_path,path.join(backups,new Date().toISOString().replaceAll(':','-')+'-'+process.pid));}
  const log=fs.openSync(path.join(directory,'server.log'),'a',0o600);
  const env={...process.env,HOST:config.host,PORT:String(config.port),NODE_ENV:'production',DB_PATH:config.db_path,ANJIAN_USER:config.user,ANJIAN_PASS_HASH:config.pass_hash,ANJIAN_STATIC_TOKEN:config.static_token,ANJIAN_AGENT_SESSION_ROOT:path.join(directory,'agent-sessions')};delete env.ANJIAN_UNSAFE_NO_AUTH; for(const name of Object.keys(env))if(name.startsWith("ANQI_WORKBUDDY")||name.startsWith("ANQI_REMINDER"))delete env[name];
  const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env,detached:true,stdio:['ignore',log,log]});child.unref();fs.closeSync(log);
  fs.writeFileSync(path.join(directory,'server.pid'),String(child.pid),{mode:0o600});
  let healthy=false;for(let i=0;i<60;i++){if(await check(base,config.static_token)){healthy=true;break;}await delay(250);}if(!healthy)throw Error('服务启动失败；请查看 data/desktop/server.log');
 }
 const runtime=path.join(directory,'runtime.json');fs.writeFileSync(runtime,JSON.stringify({url:base+'/',token:config.static_token,db_path:config.db_path}),{mode:0o600});
 return {ok:true,runtime_file:runtime};
}
module.exports={start,check};
if(require.main===module)start().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
