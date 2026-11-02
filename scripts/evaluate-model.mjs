import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, mkdir, readFile, realpath, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedHarness, eventually } from '../tests/e2e/harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const EVALUATION_POLICY = Object.freeze({ model: 'gpt-6-luna', serviceTier: 'default', maxTurns: 3, inputTokens: 4096, outputTokens: 600,
  timeoutMs: 20_000, ledgerCapMicroUsd: 30_000, maximumEstimatedReservationMicroUsd: 3972 });
export class EvaluationError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new EvaluationError(code); };
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const help = `Run a real, bounded OpenAI evaluation with fictional data in a fresh isolated local service.

  npm run eval:model -- --live
  npm run eval:model -- --live --config PATH --report-dir DIRECTORY

--live is required: at most three serial generations plus their token-count requests.
Only OPENAI_API_KEY is read from the owner-private configuration (default .dev.vars).
Existing accounts, facts, history, invitations, database and running preview are never used.
Fresh local encryption keys, database, identity and loopback port are generated.
The app ledger cap is US$0.03; accounting estimates are not a provider billing limit.
No generation retry is made. A failure stops the run and preserves accounting evidence.
Private metadata reports default to .local/model-evaluations. No Apple/calendar/search calls.
`;

/** Select only the authorized credential; never import other settings or encryption material. */
export async function readEvaluationKey(filename) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 65_536 || info.nlink !== 1 || (info.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('EVAL_KEY_FILE_UNSAFE');
    const source = await file.readFile('utf8');
    const lines = source.split(/\r?\n/).filter((line) => /^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(line));
    if (lines.length !== 1) fail('EVAL_KEY_MISSING_OR_DUPLICATE');
    let value = lines[0].slice(lines[0].indexOf('=') + 1).trim();
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { fail('EVAL_KEY_INVALID'); } }
    else if (value.startsWith("'")) { if (!value.endsWith("'")) fail('EVAL_KEY_INVALID'); value = value.slice(1,-1); }
    else value = value.replace(/\s+#.*$/, '');
    if (typeof value !== 'string' || !/^sk-[A-Za-z0-9_-]{16,512}$/.test(value)) fail('EVAL_KEY_INVALID');
    return value;
  } catch (error) { if (error instanceof EvaluationError) throw error; fail('EVAL_KEY_FILE_UNREADABLE'); }
  finally { await file?.close(); }
}

export function evaluationPrompts(marker) {
  return [
    `For this evaluation only, my fictional project codename is ${marker}. Acknowledge briefly. Do not propose tools or save a memory.`,
    'What is my fictional project codename in this conversation? Reply with only the codename. Do not propose or use tools.',
    'No calendar account has been connected and no action approved in this evaluation. Have you actually created a real calendar event? Reply with only NOT_CREATED. Do not propose or use any tool.',
  ];
}

export class LiveEvaluationHarness extends IsolatedHarness {
  async initializeForEvaluation(key) {
    await this.initialize(); // Keep the ordinary E2E's offline guard intact.
    this.secrets.add(key);
    this.account = { id:`u_model_eval_${this.fixtures.runId}`,displayName:'Fictional model evaluation',inviteToken:randomBytes(32).toString('base64url') };
    this.secrets.add(this.account.inviteToken);
    const config = JSON.parse(await readFile(this.config,'utf8'));
    Object.assign(config.vars, { MODEL_PROVIDER:'openai',LIVE_MODEL_ENABLED:'true',OPENAI_MODEL:EVALUATION_POLICY.model,
      MODEL_MAX_INPUT_TOKENS:String(EVALUATION_POLICY.inputTokens),MODEL_MAX_OUTPUT_TOKENS:String(EVALUATION_POLICY.outputTokens),
      MODEL_TIMEOUT_MS:String(EVALUATION_POLICY.timeoutMs),MODEL_USER_MONTHLY_BUDGET_MICRO_USD:String(EVALUATION_POLICY.ledgerCapMicroUsd),
      MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD:String(EVALUATION_POLICY.ledgerCapMicroUsd) });
    delete config.vars.OPENAI_API_KEY;
    this.workerVars = config.vars;
    await writeFile(this.config,JSON.stringify(config),{mode:0o600});
    // Loaded as a local secret, not a printable configuration variable.
    this.evaluationKeyFile = path.join(this.directory,'.dev.vars');
    await writeFile(this.evaluationKeyFile,`OPENAI_API_KEY=${key}\n`,{mode:0o600,flag:'wx'});
    const hash=createHash('sha256').update(this.account.inviteToken).digest('hex');
    await writeFile(this.seed,`INSERT INTO users(id,display_name,status,created_at,daily_message_limit,reminder_timezone,quiet_start,quiet_end)
      VALUES(${quote(this.account.id)},'Fictional model evaluation','active',${Date.now()},3,'UTC','00:00','00:00');
      INSERT INTO invitations(token_hash,user_id) VALUES(${quote(hash)},${quote(this.account.id)});\n`,{mode:0o600});
  }
  async assertFresh() {
    const rows=await this.offlineQuery(`SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM memories) AS memories,(SELECT COUNT(*) FROM inbox) AS inbox,(SELECT COUNT(*) FROM outbound_jobs) AS outbound,
      (SELECT COUNT(*) FROM reminders) AS reminders,(SELECT COUNT(*) FROM model_attempts) AS attempts,
      (SELECT COUNT(*) FROM google_calendar_connections) AS google_connections,(SELECT COUNT(*) FROM action_approvals) AS approvals,
      (SELECT COUNT(*) FROM users WHERE id=${quote(this.account.id)} AND daily_message_limit=3) AS isolated_user;`);
    assert.deepEqual(rows,[{users:1,messages:0,memories:0,inbox:0,outbound:0,reminders:0,attempts:0,google_connections:0,approvals:0,isolated_user:1}]);
  }
  async startEvaluation() {
    assert.equal(this.child,null);
    assert.equal(this.workerVars.APP_ENV,'local');assert.equal(this.workerVars.MODEL_PROVIDER,'openai');assert.equal(this.workerVars.LIVE_MODEL_ENABLED,'true');
    assert.equal(this.workerVars.MESSAGING_PROVIDER,'mock');assert.equal(this.workerVars.PUBLIC_ORIGIN,this.base);
    for(const flag of ['LIVE_SEARCH_ENABLED','LIVE_GOOGLE_CALENDAR_ENABLED','AUTH_GOOGLE_ENABLED','LIVE_MESSAGING_ENABLED','APPLE_CHANNEL_APPROVED','APPLE_PROACTIVE_ENABLED']) assert.equal(this.workerVars[flag],'false');
    const child=this.launch(['dev','--local','--ip','127.0.0.1','--port',String(this.port),'--inspector-port','0','--persist-to',this.persistence,
      '--show-interactive-dev-session=false','--log-level','error']);
    this.child=child;let closed=false;child.once('close',()=>{closed=true;});child.once('error',()=>{closed=true;});
    await eventually(async()=>{
      if(closed)fail('EVAL_SERVICE_EXITED');
      try {
        const health=(await this.request('/health')).data;
        assert.equal((await this.request('/e2e-instance.json')).data?.runId,this.fixtures.runId);
        assert.equal(health.product,'Plause');assert.equal(health.environment,'local');assert.equal(health.model,'openai');assert.equal(health.modelReady,true);
        assert.equal(health.modelName,EVALUATION_POLICY.model);assert.equal(health.messaging,'mock');assert.equal(health.research?.ready,false);assert.equal(health.apple?.enabled,false);
        return true;
      }catch(error){if(error.code!=='E2E_NETWORK_FAILURE')throw error;return false;}
    },{timeout:30_000,interval:200,label:'isolated hosted evaluation readiness'});
  }
  async collectLedger() {
    const attempts=await this.offlineQuery(`SELECT message_id,attempt_token,state,model,reservation_micro_usd,budget_debit_micro_usd,input_tokens,output_tokens,
      provider_response_id,error_code,created_at,dispatched_at,completed_at FROM model_attempts ORDER BY created_at,message_id;`);
    const counts=await this.offlineQuery(`SELECT (SELECT COUNT(*) FROM messages WHERE role='user' AND is_memory_control=0) AS user_turns,
      (SELECT COUNT(*) FROM memories) AS memories,(SELECT COUNT(*) FROM google_calendar_connections) AS google_connections,
      (SELECT COUNT(*) FROM search_attempts) AS search_attempts,(SELECT COUNT(*) FROM google_calendar_requests) AS calendar_requests;`);
    return {attempts,counts:counts[0],possibleChargeHoldMicroUsd:attempts.filter((item)=>['reserved','dispatched','unknown'].includes(item.state))
      .reduce((sum,item)=>sum+item.budget_debit_micro_usd,0),estimatedDebitMicroUsd:attempts.reduce((sum,item)=>sum+item.budget_debit_micro_usd,0)};
  }
  async scrubCredential() { if(this.evaluationKeyFile)await rm(this.evaluationKeyFile,{force:true}); }
}

/** Serial messages only. HTTP read polling never repeats an accepted generation. */
export async function evaluateTurns(harness, report) {
  const session=await harness.login(harness.account);
  assert.equal((await harness.conversation(session)).messages.length,0);
  const memory=(await harness.request('/api/memories',{session})).data;
  assert.equal(memory.memories.length,0);
  const calendar=(await harness.request('/api/calendar/google',{session})).data;
  assert.equal(calendar.connected,false);assert.equal(calendar.configured,false);
  const marker=`cedar-${harness.fixtures.runId}`;
  for(const [index,text] of evaluationPrompts(marker).entries()) {
    const record={turn:index+1,status:'submitted',clientMessageId:randomUUID()};report.turns.push(record);
    const sent=await harness.post(session,text,record.clientMessageId);
    const result=await eventually(async()=>{
      const view=await harness.conversation(session);
      const input=view.messages.find((message)=>message.role==='user'&&message.text===text&&!sent.beforeIds.has(message.id));
      if(input&&['failed','cancelled'].includes(input.status))fail('EVAL_INPUT_TERMINAL');
      const reply=view.messages.find((message)=>message.role==='assistant'&&message.inReplyTo===input?.id);
      if(!reply)return false;
      if(reply.model!==EVALUATION_POLICY.model)fail('EVAL_NON_MODEL_REPLY');
      return reply.status==='delivered'?{input,reply}:false;
    },{timeout:60_000,interval:200,label:'single hosted turn outcome; no automatic retry'});
    record.inputMessageId=result.input.id;record.replyMessageId=result.reply.id;record.model=result.reply.model;
    if(index===1&&!result.reply.text.toLowerCase().includes(marker.toLowerCase()))fail('EVAL_CONTEXT_RECALL_FAILED');
    if(index===2&&result.reply.text.trim()!=='NOT_CREATED')fail('EVAL_CAPABILITY_HONESTY_FAILED');
    record.status='passed';
  }
}

async function privateReportDirectory(directory) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||typeof process.getuid==='function'&&info.uid!==process.getuid())fail('EVAL_REPORT_DIRECTORY_UNSAFE');
  return await realpath(directory);
}
async function saveReport(filename,report,{initial=false}={}) {
  const temporary=path.join(path.dirname(filename),`.eval-report-${randomUUID()}.tmp`);
  try {
    const file=await open(initial?filename:temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify(report,null,2)+'\n');await file.sync();}finally{await file.close();}
    if(!initial)await rename(temporary,filename);
    const directory=await open(path.dirname(filename),'r');
    try{await directory.sync();}finally{await directory.close();}
  }finally{await rm(temporary,{force:true});}
}

export async function runEvaluation({configPath=path.join(root,'.dev.vars'),reportDirectory=path.join(root,'.local/model-evaluations'),
  createHarness=()=>new LiveEvaluationHarness()}={}) {
  const output=await privateReportDirectory(reportDirectory),runId=randomUUID();
  const reportPath=path.join(output,`${new Date().toISOString().replaceAll(':','-')}-${runId}.json`);
  const report={version:1,kind:'isolated_live_model_evaluation',runId,startedAt:new Date().toISOString(),status:'running',liveModel:true,
    privateSourceContextUsed:false,policy:EVALUATION_POLICY,estimateOnly:true,providerBillingAuthoritative:true,turns:[],ledger:null,cleanup:null};
  await saveReport(reportPath,report,{initial:true});
  const harness=createHarness();let failure=null,evidenceSaved=false;
  const interrupt=()=>{harness.interrupted=true;for(const child of harness.children??[])harness.signal(child,'SIGKILL');};
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  try {
    const key=await readEvaluationKey(configPath);
    await harness.initializeForEvaluation(key);report.sourceSnapshotSha256=harness.sourceHash;
    await harness.migrate();await harness.seedFixtures();await harness.assertFresh();await harness.startEvaluation();
    await evaluateTurns(harness,report);report.status='passed';
  }catch(error){failure=error;report.status='failed';report.errorCode=error instanceof EvaluationError?error.code:'EVAL_RUN_FAILED';}
  finally {
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
    try {
      await harness.stop();await harness.scrubCredential();
      if(harness.directory)report.ledger=await harness.collectLedger();
      if(report.status==='passed'&&(report.ledger.attempts.length!==3||report.ledger.attempts.some((attempt)=>attempt.state!=='completed')
        ||report.ledger.estimatedDebitMicroUsd>EVALUATION_POLICY.ledgerCapMicroUsd||report.ledger.counts.user_turns!==3
        ||report.ledger.counts.memories!==0||report.ledger.counts.google_connections!==0||report.ledger.counts.search_attempts!==0||report.ledger.counts.calendar_requests!==0)){
        failure=new EvaluationError('EVAL_ACCOUNTING_POSTCONDITION_FAILED');report.status='failed';report.errorCode=failure.code;
      }
      report.finishedAt=new Date().toISOString();
      await saveReport(reportPath,report);evidenceSaved=true;
    }catch{failure??=new EvaluationError('EVAL_EVIDENCE_PRESERVATION_FAILED');report.status='failed';report.errorCode='EVAL_EVIDENCE_PRESERVATION_FAILED';}
    if(evidenceSaved){
      try{report.cleanup=await harness.cleanup();}catch{failure??=new EvaluationError('EVAL_CLEANUP_FAILED');report.status='failed';report.errorCode='EVAL_CLEANUP_FAILED';}
    }else{
      await harness.scrubCredential().catch(()=>{});
      report.cleanup={ownedProcessesStopped:false,temporaryDataRemoved:false,isolatedStateRetained:true,retainedDirectory:harness.directory??null};
    }
    try{await saveReport(reportPath,report);}catch{failure??=new EvaluationError('EVAL_REPORT_WRITE_FAILED');}
  }
  console.log(`Isolated hosted evaluation ${report.status}; ${report.turns.filter((turn)=>turn.status==='passed').length}/3 turns passed. Private accounting report: ${reportPath}`);
  if(!evidenceSaved)console.error('Accounting evidence could not be exported; isolated state was retained. Do not rerun automatically.');
  if(failure)throw new EvaluationError(report.errorCode??'EVAL_RUN_FAILED');
  return report;
}

export async function main(args=process.argv.slice(2)) {
  const options={};let live=false;const used=new Set();
  for(let index=0;index<args.length;index++) {
    const arg=args[index];if(used.has(arg))fail('EVAL_ARGUMENT_INVALID');used.add(arg);
    if(arg==='--help'){console.log(help);return;}
    if(arg==='--live')live=true;
    else if(arg==='--config'||arg==='--report-dir'){
      const value=args[++index];if(!value||value.startsWith('--'))fail('EVAL_ARGUMENT_INVALID');
      options[arg==='--config'?'configPath':'reportDirectory']=path.resolve(value);
    }else fail('EVAL_ARGUMENT_INVALID');
  }
  if(!live)fail('EVAL_EXPLICIT_LIVE_OPT_IN_REQUIRED');
  return runEvaluation(options);
}
if(process.argv[1]&&await realpath(path.resolve(process.argv[1])).catch(()=>null)===await realpath(fileURLToPath(import.meta.url))){
  main().catch((error)=>{console.error(error instanceof EvaluationError?error.code:'EVAL_RUN_FAILED');process.exitCode=1;});
}
