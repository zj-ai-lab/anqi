const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {backupTo}=require('./local-backup.cjs');
const root=path.resolve(__dirname,'..');
async function main() {
  if (Number(process.versions.node.split('.')[0])!==22) throw new Error('该入口按已验收的Node22启动，请使用案齐启动.command');
  const envFile=path.join(root,'.env.local');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.env.ANJIAN_UNSAFE_NO_AUTH==='1') throw new Error('日常启动入口禁止关闭鉴权；请配置登录账号和密码哈希');
  process.env.HOST=process.env.HOST || '127.0.0.1';
  process.env.PORT=process.env.PORT || '3017';
  process.env.NODE_ENV='production';
  process.env.DB_PATH=path.resolve(process.env.DB_PATH || path.join(root,'data','anjian.db'));
  const {resolveStartupConfig,isLoopbackHost}=await import('../src/lib/startup-config.js');
  if (!isLoopbackHost(process.env.HOST)) throw new Error('日常本地入口只允许回环监听');
  resolveStartupConfig(process.env);
  // 先排除端口冲突，再备份、迁移，避免重复点击启动台产生误导。
  const net=require('node:net');
  const probe=net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(Number(process.env.PORT),process.env.HOST,resolve);});
  await new Promise(resolve=>probe.close(resolve));
  if (fs.existsSync(process.env.DB_PATH)) {
    const backups=path.join(path.dirname(process.env.DB_PATH),'backups');
    fs.mkdirSync(backups,{ recursive:true,mode:0o700 });
    const directory=path.join(backups,new Date().toISOString().replaceAll(':','-')+'-'+process.pid);
    await backupTo(process.env.DB_PATH,directory);
    console.log('启动前备份已完成：'+directory);
  }
  const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:process.env,stdio:'inherit'});
  child.once('error',error=>{console.error(error.message);process.exitCode=1;});
  child.once('exit',code=>{process.exitCode=code || 0;});
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>child.kill(signal));
  console.log(`本地地址：http://${process.env.HOST}:${process.env.PORT}/；关闭此终端将停止服务。`);
}
main().catch(error=>{console.error(error.message+'\n请阅读 README.md；未配置登录时不会开启业务库。');process.exitCode=1;});
