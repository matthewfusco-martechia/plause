import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../packages/contracts/src/index';
import type { SunshineEvent } from '../packages/messaging-sunshine/src/index';
import { decryptText } from '../packages/security/src/index';
import { getWebConversation } from '../apps/api/src/store';
import { onboardingEventConflict, onboardingLifecycleStatements, onboardingReadiness, processOnboarding, recordOnboardingContact } from '../apps/api/src/messaging-onboarding';
import { testEnv } from './setup';

const env = (): Env => ({ ...testEnv, APP_ENV:'staging', PUBLIC_ORIGIN:'https://staging.plause.app', MESSAGING_PROVIDER:'sunshine',
  MODEL_PROVIDER:'mock', LIVE_MESSAGING_ENABLED:'true', APPLE_CHANNEL_APPROVED:'true', ONBOARDING_MESSAGES_ENABLED:'true',
  AUTH_GOOGLE_ENABLED:'true', AUTH_GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com', AUTH_GOOGLE_CLIENT_SECRET:'fixture-google-secret',
  SUNSHINE_SUBDOMAIN:'fixture', SUNSHINE_APP_ID:'fixture_app', SUNSHINE_APPLE_INTEGRATION_ID:'fixture_apple', SUNSHINE_WEBHOOK_ID:'fixture_webhook',
  SUNSHINE_WEBHOOK_SECRET:'fixture-webhook-secret', SUNSHINE_KEY_ID:'fixture_key', SUNSHINE_KEY_SECRET:'fixture-key-secret',
  SUNSHINE_BOT_SWITCHBOARD_ID:'fixture_bot', SUNSHINE_AGENT_SWITCHBOARD_ID:'fixture_human' });
function message(options: { subject?:string; destination?:string; at?:number; text?:string; control?:'bot'|'human'|'unknown'; eventId?:string; messageId?:string } = {}): Extract<SunshineEvent,{type:'message.received'}> {
  return { type:'message.received', eventId:options.eventId ?? `evt_${crypto.randomUUID()}`, occurredAt:new Date(options.at ?? Date.now()).toISOString(),
    businessId:'fixture_app', channel:'apple_business', subject:{provider:'sunshine',businessId:'fixture_app',subjectId:options.subject ?? 'fixture_subject'},
    providerConversationId:options.destination ?? 'fixture_destination', messageId:options.messageId ?? `message_${crypto.randomUUID()}`,
    text:options.text ?? 'Hello, I would like a personal assistant.', control:options.control ?? 'bot' };
}
function closed(source: ReturnType<typeof message>, type:'conversation.closed'|'subject.revoked'|'client.active' = 'conversation.closed'): SunshineEvent {
  return { type,eventId:`evt_${crypto.randomUUID()}`,occurredAt:new Date(Date.parse(source.occurredAt)+1).toISOString(),businessId:source.businessId,
    channel:source.channel,subject:source.subject,providerConversationId:source.providerConversationId };
}
const accepted = () => Response.json({messages:[{id:'provider_reply',author:{type:'business'}}]});
beforeEach(async () => {
  await testEnv.DB.batch(['messaging_onboarding_notices','messaging_onboarding_events','messaging_onboarding_contacts','messaging_onboarding_subjects']
    .map((table) => testEnv.DB.prepare(`DELETE FROM ${table}`)));
});

describe('Deterministic Messages onboarding', () => {
  it('is opt-in and requires the approved provider and configured identity origin', async () => {
    const current=env(); expect(onboardingReadiness(current)).toEqual({enabled:true,configured:true});
    for (const changed of [{ONBOARDING_MESSAGES_ENABLED:'false'}, {APPLE_CHANNEL_APPROVED:'false'}, {SUNSHINE_KEY_SECRET:''},
      {AUTH_GOOGLE_CLIENT_SECRET:''}, {PUBLIC_ORIGIN:'http://localhost:8787'}, {MESSAGING_PROVIDER:'web' as const},
      {ONBOARDING_GLOBAL_DAILY_LIMIT:'0'}, {ONBOARDING_GLOBAL_DAILY_LIMIT:'5001'}, {ONBOARDING_GLOBAL_DAILY_LIMIT:'1.5'}]) {
      const other={...current,...changed}; expect(onboardingReadiness(other).configured).toBe(false);
      expect(await recordOnboardingContact(other,message())).toEqual({handled:false,recorded:false,duplicate:false});
      expect(await processOnboarding(other)).toBe(0);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists one public notice without creating accounts, private history, or storing the inbound text', async () => {
    const current=env(), source=message({text:'My confidential incoming question must never be retained.'});
    expect(await recordOnboardingContact(current,source)).toEqual({handled:true,recorded:true,duplicate:false});
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({n:2});
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).toEqual({n:0});
    const contact=await current.DB.prepare('SELECT * FROM messaging_onboarding_contacts').first<{routing_ciphertext:string}>();
    expect(JSON.stringify(contact)).not.toContain(source.subject.subjectId); expect(JSON.stringify(contact)).not.toContain(source.text);
    expect(JSON.parse(await decryptText(contact!.routing_ciphertext,current.CONTENT_ENCRYPTION_KEY))).toEqual({businessId:'fixture_app',subjectId:'fixture_subject',providerConversationId:'fixture_destination'});
    expect(JSON.stringify((await current.DB.prepare('SELECT * FROM messaging_onboarding_events').all()).results)).not.toContain(source.text);
    const fake=vi.fn(async (_url:RequestInfo|URL,init?:RequestInit) => {
      expect(init?.method).toBe('POST'); const body=JSON.parse(String(init?.body));
      expect(body.destination).toEqual({integrationId:'fixture_apple'}); expect(body.author.subtypes).toEqual(['AI']);
      expect(body.content.text).toContain('I’m Plause, an AI assistant'); expect(body.content.text).toContain('https://staging.plause.app/?onboarding=messages');
      expect(body.content.text).toContain('signup is currently closed'); expect(body.content.text).not.toContain(source.text); return accepted();
    });
    expect(await processOnboarding(current,{fetchImpl:fake as typeof fetch})).toBe(1);
    expect(await current.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({status:'sent'});
    expect(await processOnboarding(current,{fetchImpl:fake as typeof fetch})).toBe(0); expect(fake).toHaveBeenCalledTimes(1);
  });

  it('describes cloud signup as restricted to approved participants without disclosing admission subjects', async () => {
    const current = { ...env(), AUTH_SIGNUP_ENABLED: 'true', AUTH_SIGNUP_SUBJECTS: '["private-fixture-admission-subject"]' };
    await recordOnboardingContact(current, message());
    const fake = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const text = JSON.parse(String(init?.body)).content.text;
      expect(text).toContain('Approved participants can create an account there.');
      expect(text).not.toContain('private-fixture-admission-subject'); expect(text).not.toContain('You can create an account there.');
      return accepted();
    });
    expect(await processOnboarding(current, { fetchImpl: fake as typeof fetch })).toBe(1);
    expect(fake).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });

  it('deduplicates exact event retries and rejects conflicting event content', async () => {
    const current=env(), source=message(); await recordOnboardingContact(current,source);
    expect(await recordOnboardingContact(current,source)).toMatchObject({duplicate:true});
    await expect(recordOnboardingContact(current,{...source,text:'A conflicting payload.'})).rejects.toMatchObject({code:'provider_event_conflict'});
    expect(await onboardingEventConflict(current,source.businessId,source.eventId)).toBe(true);
    expect(await onboardingEventConflict(current,'another_app',source.eventId)).toBe(false);
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_notices').first()).toEqual({n:1});
  });

  it('limits welcome to once per contact per UTC day without conflating different subjects', async () => {
    const current=env(); await recordOnboardingContact(current,message()); await recordOnboardingContact(current,message());
    await recordOnboardingContact(current,message({subject:'another_subject',destination:'another_destination'}));
    await recordOnboardingContact(current,message({destination:'same_subject_new_destination'}));
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_notices').first()).toEqual({n:2});
  });

  it.each(['human','unknown'] as const)('does not send when provider control is %s', async (control) => {
    const current=env(); await recordOnboardingContact(current,message({control})); expect(await processOnboarding(current)).toBe(0);
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_notices').first()).toEqual({n:0}); expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels an older public notice on human ownership rather than resurrecting it when bot control returns', async () => {
    const current=env(),source=message();await recordOnboardingContact(current,source);
    await recordOnboardingContact(current,message({control:'human',at:Date.parse(source.occurredAt)+1}));
    await recordOnboardingContact(current,message({control:'bot',at:Date.parse(source.occurredAt)+2}));
    expect(await current.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({status:'cancelled'});
    expect(await processOnboarding(current)).toBe(0);expect(fetch).not.toHaveBeenCalled();
  });

  it('does not greet expired or implausibly future incoming events', async () => {
    // Keep the exact boundary stable while encryption/DB awaits take real time.
    const now=Date.now(), clock=vi.spyOn(Date,'now').mockReturnValue(now);
    try {
      const current=env(); await recordOnboardingContact(current,message({at:now-300_001}));
      await recordOnboardingContact(current,message({at:now+300_001,subject:'future_subject'}));
      expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_notices').first()).toEqual({n:0});
    } finally { clock.mockRestore(); }
  });

  it('does not take over private bound conversations or retain link codes', async () => {
    const current=env(), source=message();
    expect(await recordOnboardingContact(current,{...source,text:`link plause ${'a'.repeat(43)}`})).toMatchObject({handled:false});
    await current.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,status,provider_conversation_id)
      VALUES('sunshine','fixture_app','fixture_subject','u_alex','apple_business','active','fixture_destination')`).run();
    expect(await recordOnboardingContact(current,source)).toMatchObject({handled:false});
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_events').first()).toEqual({n:0});
  });

  it('still acknowledges the original public retry after linking without turning it into an AI input', async () => {
    const current=env(),source=message();await recordOnboardingContact(current,source);
    await current.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,status,provider_conversation_id)
      VALUES('sunshine','fixture_app','fixture_subject','u_alex','apple_business','active','fixture_destination')`).run();
    expect(await recordOnboardingContact(current,source)).toMatchObject({handled:true,duplicate:true});
    await expect(recordOnboardingContact(current,{...source,text:'Changed same-event text.'})).rejects.toMatchObject({code:'provider_event_conflict'});
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).toEqual({n:0});
  });

  it('suppresses unattributed new-destination routing for existing or revoked account subjects', async () => {
    const current=env();
    await current.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,status,provider_conversation_id)
      VALUES('sunshine','fixture_app','fixture_subject','u_alex','apple_business','revoked','old_destination')`).run();
    expect(await recordOnboardingContact(current,message())).toMatchObject({handled:true});
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_contacts').first()).toEqual({n:0});
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_notices').first()).toEqual({n:0});
  });

  it('checks all existing canonical provider namespaces atomically', async () => {
    const current=env(), source=message(); const conversationId=await getWebConversation(current,'u_alex');
    await current.DB.prepare(`INSERT INTO provider_lifecycle_events(provider,business_id,event_id,conversation_id,payload_hash,mutation_token,received_at)
      VALUES('sunshine','fixture_app',?,?,'hash','token',?)`).bind(source.eventId,conversationId,Date.now()).run();
    await expect(recordOnboardingContact(current,source)).rejects.toMatchObject({code:'provider_event_conflict'});
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_notices').first()).toEqual({n:0});
  });

  it('atomically enforces a daily global send cap under concurrent processors', async () => {
    const current={...env(),ONBOARDING_GLOBAL_DAILY_LIMIT:'1'};
    await recordOnboardingContact(current,message()); await recordOnboardingContact(current,message({subject:'second_subject',destination:'second_destination'}));
    const fake=vi.fn(async()=>accepted()); await Promise.all([processOnboarding(current,{fetchImpl:fake as typeof fetch}),processOnboarding(current,{fetchImpl:fake as typeof fetch})]);
    expect(fake).toHaveBeenCalledTimes(1); expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_notices WHERE dispatched_at IS NOT NULL').first()).toEqual({n:1});
  });

  it('leaves uncertain sends unknown and reconciles with GET only across recovery', async () => {
    const current=env(); await recordOnboardingContact(current,message());
    let sent:Record<string,unknown>|undefined; const fake=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
      if(init?.method==='POST'){sent=JSON.parse(String(init.body));throw new Error('Acknowledgment was lost.');}
      return Response.json({messages:[{id:'provider_existing',author:{type:'business'},content:sent!.content,metadata:sent!.metadata}]});
    });
    await processOnboarding(current,{fetchImpl:fake as typeof fetch});
    expect(await current.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({status:'delivery_unknown'});
    await current.DB.prepare('UPDATE messaging_onboarding_notices SET next_attempt_at=0').run(); await processOnboarding(current,{fetchImpl:fake as typeof fetch});
    expect(await current.DB.prepare('SELECT status,provider_message_id FROM messaging_onboarding_notices').first()).toEqual({status:'sent',provider_message_id:'provider_existing'});
    expect(fake.mock.calls.map((call)=>call[1]?.method)).toEqual(['POST','GET']);
  });

  it('recovers an interrupted claimed attempt as unknown without posting again', async () => {
    const current=env(); await recordOnboardingContact(current,message());
    await current.DB.prepare("UPDATE messaging_onboarding_notices SET status='sending',attempt_token='old_attempt',lease_until=0,dispatched_at=?").bind(Date.now()).run();
    const fake=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{expect(init?.method).toBe('GET');return Response.json({messages:[]});});
    expect(await processOnboarding(current,{fetchImpl:fake as typeof fetch})).toBe(0);
    expect(await current.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({status:'delivery_unknown'}); expect(fake).toHaveBeenCalledTimes(1);
  });

  it('does not retry definitive provider rejection', async () => {
    const current=env(); await recordOnboardingContact(current,message()); const fake=vi.fn(async()=>new Response(null,{status:403}));
    await processOnboarding(current,{fetchImpl:fake as typeof fetch}); await processOnboarding(current,{fetchImpl:fake as typeof fetch});
    expect(await current.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({status:'failed'});expect(fake).toHaveBeenCalledTimes(1);
  });

  it('preserves a final delivery failure that arrives before the POST acknowledgment', async () => {
    const current=env(),source=message();await recordOnboardingContact(current,source);
    const fake=vi.fn(async()=>{
      await recordOnboardingContact(current,{type:'delivery.updated',eventId:'early_delivery_failure',occurredAt:new Date().toISOString(),
        businessId:source.businessId,channel:source.channel,subject:source.subject,providerConversationId:source.providerConversationId,
        messageId:'provider_reply',state:'failed'});
      return accepted();
    });
    await processOnboarding(current,{fetchImpl:fake as typeof fetch});
    expect(await current.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({status:'failed'});
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('honors global pause without consuming an attempt', async () => {
    const current=env(); await recordOnboardingContact(current,message());
    await current.DB.prepare("INSERT INTO system_settings(key,value) VALUES('outbound_paused','true')").run(); expect(await processOnboarding(current)).toBe(0);
    expect(await current.DB.prepare('SELECT status,dispatched_at FROM messaging_onboarding_notices').first()).toEqual({status:'pending',dispatched_at:null}); expect(fetch).not.toHaveBeenCalled();
  });

  it('rechecks closure after claim immediately before the real provider call', async () => {
    const current=env(),source=message(); await recordOnboardingContact(current,source);const fake=vi.fn(async()=>accepted());
    await processOnboarding(current,{fetchImpl:fake as typeof fetch,beforeDispatch:async()=>{await recordOnboardingContact(current,closed(source));}});
    expect(fake).not.toHaveBeenCalled();expect(await current.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({status:'failed'});
  });

  it('keeps an identical public route stable when another message arrives during dispatch preparation', async () => {
    const current=env();await recordOnboardingContact(current,message());const fake=vi.fn(async()=>accepted());
    await processOnboarding(current,{fetchImpl:fake as typeof fetch,beforeDispatch:async()=>{await recordOnboardingContact(current,message());}});
    expect(fake).toHaveBeenCalledTimes(1);expect(await current.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({status:'sent'});
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_notices').first()).toEqual({n:1});
  });

  it('keeps revocation sticky across delayed messages and client.active', async () => {
    const current=env(),source=message();await recordOnboardingContact(current,source);await recordOnboardingContact(current,closed(source,'subject.revoked'));
    await recordOnboardingContact(current,message({at:Date.parse(source.occurredAt)+2}));await recordOnboardingContact(current,closed(source,'client.active'));
    expect(await current.DB.prepare('SELECT routing_ciphertext,status FROM messaging_onboarding_contacts').first()).toEqual({routing_ciphertext:null,status:'revoked'});
    expect(await processOnboarding(current)).toBe(0);expect(fetch).not.toHaveBeenCalled();
  });

  it('remembers subject revocation even before any first message', async () => {
    const current=env(),source=message(); await recordOnboardingContact(current,closed(source,'subject.revoked'));
    await recordOnboardingContact(current,message({at:Date.parse(source.occurredAt)+2}));
    expect(await current.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_contacts').first()).toEqual({n:0});expect(await processOnboarding(current)).toBe(0);
  });

  it('can attach the same lifecycle changes to the canonical bound-event transaction', async () => {
    const current=env(),source=message();await recordOnboardingContact(current,source);
    const event:SunshineEvent={type:'handoff.changed',eventId:'handoff_event',occurredAt:new Date(Date.parse(source.occurredAt)+1).toISOString(),
      businessId:'fixture_app',channel:'apple_business',providerConversationId:'fixture_destination',control:'human'};
    await current.DB.batch(await onboardingLifecycleStatements(current,event,{gate:'1=1',gateBindings:[],now:Date.now()}));
    expect(await current.DB.prepare('SELECT control FROM messaging_onboarding_contacts').first()).toEqual({control:'human'});
    expect(await current.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({status:'cancelled'});
  });
});
