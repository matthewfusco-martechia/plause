import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,writeFile,readFile,chmod,symlink,link,readdir,rm,mkdir,stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EVALUATION_POLICY,LiveEvaluationHarness,readEvaluationKey,evaluateTurns,main,runEvaluation } from './evaluate-model.mjs';

const fakeKey='sk-fictional-evaluation-fixture-not-real';
const script=fileURLToPath(new URL('./evaluate-model.mjs',import.meta.url));
async function fixture(t){
  const directory=await mkdtemp(path.join(await import('node:fs/promises').then((fs)=>fs.realpath(os.tmpdir())),'plause-model-eval-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const config=path.join(directory,'selected.dev.vars');
  await writeFile(config,`# Private fixture, never a real credential\nOPENAI_API_KEY=${fakeKey}\nCONTENT_ENCRYPTION_KEY=must-not-copy-this\nAUTH_GOOGLE_CLIENT_SECRET=must-not-copy-this-either\n`,{mode:0o600});
  return {directory,config,reports:path.join(directory,'reports')};
}
test('evaluation requires explicit live opt-in and rejects credential arguments without reading a config',async()=>{
  await assert.rejects(main([]),{code:'EVAL_EXPLICIT_LIVE_OPT_IN_REQUIRED'});
  await assert.rejects(main(['--api-key',fakeKey]),{code:'EVAL_ARGUMENT_INVALID'});
  await assert.rejects(main(['--live','--live']),{code:'EVAL_ARGUMENT_INVALID'});
  const result=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8'});
  assert.equal(result.status,0);assert.match(result.stdout,/--live is required/);assert.match(result.stdout,/at most three/);assert.ok(!result.stdout.includes(fakeKey));
});
test('credential selection reads only one valid key from a private single-link regular file',async(t)=>{
  const f=await fixture(t);assert.equal(await readEvaluationKey(f.config),fakeKey);
  await chmod(f.config,0o644);await assert.rejects(readEvaluationKey(f.config),{code:'EVAL_KEY_FILE_UNSAFE'});await chmod(f.config,0o600);
  const hard=path.join(f.directory,'hard');await link(f.config,hard);await assert.rejects(readEvaluationKey(f.config),{code:'EVAL_KEY_FILE_UNSAFE'});await rm(hard);
  const sym=path.join(f.directory,'sym');await symlink(f.config,sym);await assert.rejects(readEvaluationKey(sym),{code:'EVAL_KEY_FILE_UNREADABLE'});
  await writeFile(f.config,`OPENAI_API_KEY=${fakeKey}\nOPENAI_API_KEY=${fakeKey}\n`);await assert.rejects(readEvaluationKey(f.config),{code:'EVAL_KEY_MISSING_OR_DUPLICATE'});
  await writeFile(f.config,'OPENAI_API_KEY=not-a-valid-key\n');await assert.rejects(readEvaluationKey(f.config),{code:'EVAL_KEY_INVALID'});
});

function fakeHarness(directory,{failureTurn=0,unknown=false,exportFails=false}={}){
  const h={fixtures:{runId:'fictional-run'},account:{id:'fictional-user'},sourceHash:'fixture-source-fingerprint',children:new Set(),messages:[],posted:[],order:[],
    async initializeForEvaluation(key){assert.equal(key,fakeKey);this.directory=path.join(directory,'isolated-state');await mkdir(this.directory,{mode:0o700});this.order.push('initialize');},
    async migrate(){this.order.push('migrate');},async seedFixtures(){this.order.push('seed');},async assertFresh(){this.order.push('fresh');},async startEvaluation(){this.order.push('start');},
    async login(account){assert.equal(account,this.account);return {};},
    async request(route){if(route==='/api/memories')return {data:{memories:[]}};if(route==='/api/calendar/google')return {data:{connected:false,configured:false}};throw new Error('Unexpected route.');},
    async conversation(){return {messages:this.messages};},
    async post(_session,text,clientMessageId){
      const beforeIds=new Set(this.messages.map((message)=>message.id));this.posted.push({text,clientMessageId});
      const number=this.posted.length;const input={id:`input_${number}`,role:'user',text,status:number===failureTurn?'failed':'completed'};
      this.messages.push(input);
      if(number!==failureTurn)this.messages.push({id:`reply_${number}`,inReplyTo:input.id,role:'assistant',status:'delivered',model:EVALUATION_POLICY.model,
        text:number===2?'cedar-fictional-run':number===3?'NOT_CREATED':'Acknowledged.'});
      return {beforeIds};
    },
    async stop(){this.order.push('stop');},async scrubCredential(){this.order.push('scrub');},
    async collectLedger(){
      this.order.push('export');if(exportFails)throw new Error('Simulated evidence export failure.');
      return {attempts:this.posted.map((_,index)=>({message_id:`input_${index+1}`,state:unknown&&index===this.posted.length-1?'unknown':'completed',
        reservation_micro_usd:1324,budget_debit_micro_usd:unknown?1324:200,provider_response_id:unknown?null:`resp_fixture_${index}`,error_code:unknown?'model_timeout':null})),
        counts:{user_turns:this.posted.length,memories:0,google_connections:0,search_attempts:0,calendar_requests:0},
        possibleChargeHoldMicroUsd:unknown?1324:0,estimatedDebitMicroUsd:this.posted.length*(unknown?1324:200)};
    },
    async cleanup(){
      this.order.push('cleanup');const names=await readdir(path.join(directory,'reports'));
      const before=JSON.parse(await readFile(path.join(directory,'reports',names[0]),'utf8'));
      assert.ok(before.ledger,'Accounting evidence must exist before deleting the state.');
      await rm(this.directory,{recursive:true});return {ownedProcessesStopped:true,temporaryDataRemoved:true};
    },
  };return h;
}
test('successful fixture evaluation submits exactly three serial turns and persists private content-free accounting first',async(t)=>{
  const f=await fixture(t),h=fakeHarness(f.directory);const source=await readFile(f.config,'utf8');
  const report=await runEvaluation({configPath:f.config,reportDirectory:f.reports,createHarness:()=>h});
  assert.equal(h.posted.length,3);assert.equal(new Set(h.posted.map((item)=>item.clientMessageId)).size,3);
  assert.deepEqual(h.order.slice(0,5),['initialize','migrate','seed','fresh','start']);assert.ok(h.order.indexOf('export')<h.order.indexOf('cleanup'));
  assert.equal(report.status,'passed');assert.equal(report.turns.length,3);assert.equal(report.policy.ledgerCapMicroUsd,30_000);
  const files=await readdir(f.reports);assert.equal(files.length,1);const filename=path.join(f.reports,files[0]);const raw=await readFile(filename,'utf8');
  assert.equal((await stat(filename)).mode&0o777,0o600);assert.equal((await stat(f.reports)).mode&0o777,0o700);
  for(const secret of [fakeKey,'must-not-copy-this','must-not-copy-this-either','Fictional model evaluation','NOT_CREATED','cedar-fictional-run'])assert.ok(!raw.includes(secret));
  assert.equal(await readFile(f.config,'utf8'),source);
});
test('uncertain first-turn failure stops without another input and preserves the hold before cleanup',async(t)=>{
  const f=await fixture(t),h=fakeHarness(f.directory,{failureTurn:1,unknown:true});
  await assert.rejects(runEvaluation({configPath:f.config,reportDirectory:f.reports,createHarness:()=>h}),{code:'EVAL_INPUT_TERMINAL'});
  assert.equal(h.posted.length,1);assert.ok(h.order.includes('cleanup'));
  const report=JSON.parse(await readFile(path.join(f.reports,(await readdir(f.reports))[0]),'utf8'));
  assert.equal(report.status,'failed');assert.equal(report.ledger.attempts[0].state,'unknown');assert.equal(report.ledger.possibleChargeHoldMicroUsd,1324);
});
test('failed accounting export preserves isolated state and scrubs the temporary credential',async(t)=>{
  const f=await fixture(t),h=fakeHarness(f.directory,{failureTurn:1,unknown:true,exportFails:true});
  await assert.rejects(runEvaluation({configPath:f.config,reportDirectory:f.reports,createHarness:()=>h}),{code:'EVAL_EVIDENCE_PRESERVATION_FAILED'});
  assert.ok(!h.order.includes('cleanup'));assert.ok(h.order.includes('scrub'));assert.equal((await stat(h.directory)).isDirectory(),true);
  const report=JSON.parse(await readFile(path.join(f.reports,(await readdir(f.reports))[0]),'utf8'));assert.equal(report.cleanup.isolatedStateRetained,true);
});
test('existing memory or history stops the fixture evaluation before any submitted input',async()=>{
  for(const existing of ['memory','history']){
    const h=fakeHarness('/unused');if(existing==='history')h.messages.push({id:'old',role:'user',text:'Must never transmit.'});
    else h.request=async()=>({data:{memories:[{id:'private',text:'Must never transmit.'}]}});
    await assert.rejects(evaluateTurns(h,{turns:[]}));assert.equal(h.posted.length,0);
  }
});
test('real initialization copies source only and creates a distinct identity, keyring, configuration and state using a fictional key',async(t)=>{
  const h=new LiveEvaluationHarness();t.after(()=>h.cleanup());
  await h.initializeForEvaluation(fakeKey);
  assert.equal(h.workerVars.APP_ENV,'local');assert.equal(h.workerVars.MODEL_PROVIDER,'openai');assert.equal(h.workerVars.MESSAGING_PROVIDER,'mock');
  assert.equal(h.workerVars.MODEL_USER_MONTHLY_BUDGET_MICRO_USD,'30000');assert.equal(h.workerVars.MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD,'30000');
  assert.equal(h.workerVars.OPENAI_API_KEY,undefined);assert.equal(h.workerVars.CONTENT_ENCRYPTION_KEY,h.fixtures.contentKey);
  assert.notEqual(h.port,8787);assert.match(h.base,/^http:\/\/127\.0\.0\.1:/);
  assert.ok(!h.environment.OPENAI_API_KEY);assert.ok(!h.environment.CLOUDFLARE_API_TOKEN);
  const config=await readFile(h.config,'utf8');assert.ok(!config.includes(fakeKey));assert.ok(!config.includes('must-not-copy-this'));
  assert.equal(await readFile(h.evaluationKeyFile,'utf8'),`OPENAI_API_KEY=${fakeKey}\n`);
  const seed=await readFile(h.seed,'utf8');assert.equal((seed.match(/INSERT INTO users/g)||[]).length,1);assert.ok(seed.includes('daily_message_limit'));
  assert.ok(!seed.includes('u_sam'));assert.ok(!seed.includes(h.account.inviteToken));assert.ok(!seed.includes('INSERT INTO memories'));
  assert.equal((await stat(h.evaluationKeyFile)).mode&0o777,0o600);await h.scrubCredential();
  await assert.rejects(readFile(h.evaluationKeyFile),{code:'ENOENT'});
  assert.throws(()=>h.assertOfflineConfiguration(),'Shared E2E must continue rejecting the live configuration.');
});
