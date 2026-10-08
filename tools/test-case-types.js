import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import express from 'express';
import {CASE_TYPES,caseType,typeOrder,procedureLabel} from '../public/js/case-types.js';
process.env.DB_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'anqi-types-')),'test.db');process.env.ANJIAN_FILES_ROOT='';
const {db}=await import('../src/db.js');const {default:router}=await import('../src/routes/cases.js');
const app=express();app.use(express.json());app.use((req,res,next)=>{req.actor='test';next();});app.use(router());const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
async function call(url,method,body){const r=await fetch(`http://127.0.0.1:${server.address().port}${url}`,{signal:AbortSignal.timeout(10000),method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return [r.status,await r.json()];}
try{
 assert.equal(procedureLabel('一审'),'民事一审');assert.equal(procedureLabel('二审'),'民事二审');assert.equal(procedureLabel('刑事一审'),'刑事一审');assert.equal(caseType({}),'未分类');
 const [status,c]=await call('/cases','POST',{name:'虚构类型验收',procedure:'一审',stage:'立案准备',case_type:'民事'});assert.equal(status,200,JSON.stringify(c));assert.equal(c.case_type,'民事');
 assert.equal((await call('/cases/'+c.id,'PATCH',{case_type:'行政'}))[0],200);assert.equal(db.prepare('SELECT procedure FROM cases WHERE id=?').get(c.id).procedure,'一审');assert.equal((await call('/cases/'+c.id,'PATCH',{case_type:'invalid'}))[0],400);
 assert.ok(db.prepare("SELECT id FROM change_log WHERE field='case_type' AND case_id=?").get(c.id));
 assert.deepEqual([...CASE_TYPES].reverse().map(case_type=>({case_type})).sort(typeOrder).map(caseType),CASE_TYPES);
 console.log('PASS: case type API validation, local audit, stable procedure mapping and grouping order');
}finally{server.close();db.close();}
