const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function fixture({ saved = [], attachments = [], failWrite = false, interval = '3', viewer = null, now = Math.floor(Date.now()/1000) } = {}) {
  const source=fs.readFileSync(path.join(root,'cloudflare/worker.js'),'utf8');
  const { RealtimeHub }=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const nodes=[{name:'hidden node',username:'node',password:'pass',hidden:true,monthstart:'1'}];
  const config={revision:1,config_json:JSON.stringify({servers:nodes})};
  const writes=[],notifications=[];
  let previous=1;
  const sockets=attachments.map(a=>({readyState:1,a,deserializeAttachment(){return this.a;},serializeAttachment(a){this.a=a;},send(){},close(){this.readyState=3;}}));
  const env={TG_BOT_TOKEN:'test',TG_CHAT_ID:'local',SSS_REALTIME_INTERVAL:interval,DB:{prepare(sql){let values;return {
    bind(...args){values=args;return this;},
    async first(){return config;},
    async all(){return {results:sql.includes('notification_state')?[{username:'node',is_online:previous}]:saved};},
    async run(){
      if(sql.includes('INSERT INTO agent_metrics')){if(failWrite)throw Error('D1 temporarily unavailable');writes.push(values);}
      if(sql.includes('UPDATE notification_state')){previous=values[0];notifications.push(values);}
      return {meta:{changes:1}};
    }
  };}}};
  let ready;
  const ctx={blockConcurrencyWhile(fn){ready=fn();},getWebSockets(role){return role==='viewer'?(viewer?[viewer]:[]):sockets;}};
  const hub=new RealtimeHub(ctx,env);await ready;
  return {hub,writes,notifications,sockets,nodes,config};
}
function row(last_seen,counter=100){return {username:'node',last_seen,metrics_json:JSON.stringify({online4:true,network_in:counter,network_out:counter,monthly_network_in:50}),traffic_period:'2026-10',traffic_base_in:0,traffic_base_out:0};}
test('hub sends configured integer intervals in hints and ACKs, retaining idle 60 seconds',async()=>{
  for(const interval of [1,2,5,10,59,60]){
    const messages=[];
    const viewer={readyState:1,send(){}};
    const f=await fixture({interval:String(interval),viewer,attachments:[{role:'agent',username:'node',password:'pass'}]});
    const agent=f.sockets[0];agent.send=data=>messages.push(JSON.parse(data));
    f.hub.hint();assert.equal(messages.at(-1).seconds,interval);
    await f.hub.webSocketMessage(agent,JSON.stringify({metrics:{network_in:1,network_out:1}}));
    assert.equal(messages.at(-1).seconds,interval);
    viewer.readyState=3;f.hub.hint();assert.equal(messages.at(-1).seconds,60);
  }
});
test('hibernation reconstructs newer socket state instead of stale D1 checkpoint',async()=>{
  const f=await fixture({saved:[row(100)],attachments:[{role:'agent',username:'node',password:'pass',row:row(120,200)}]});
  assert.equal(f.hub.rows.get('node').last_seen,120);
  await f.hub.flush();assert.equal(f.writes.length,1);assert.equal(JSON.parse(f.writes[0][1]).network_in,200);
  await f.hub.flush();assert.equal(f.writes.length,1,'clean checkpoints do not write unchanged nodes');
  assert.equal(f.hub.activeInterval,3);
});
test('hibernation rejects revoked credentials and never restores their attached metrics',async()=>{
  const f=await fixture({attachments:[{role:'agent',username:'node',password:'revoked',row:row(120)}]});
  assert.equal(f.sockets[0].readyState,3);assert.equal(f.hub.rows.size,0);
});
test('D1 write failure keeps dirty metrics for the next checkpoint',async()=>{
  const f=await fixture({failWrite:true,attachments:[{role:'agent',username:'node',password:'pass',row:row(120)}]});
  await assert.rejects(f.hub.flush(),/temporarily unavailable/);
  assert.ok(f.hub.dirty.has('node'));
});
test('a continuously visible dashboard stays at one second across 24 simulated hours',async()=>{
  const pushed=[],acks=[];
  const viewer={readyState:1,send(data){pushed.push(JSON.parse(data));}};
  const f=await fixture({interval:'1',viewer,attachments:[{role:'agent',username:'node',password:'pass'}]});
  const agent=f.sockets[0];agent.send=data=>acks.push(JSON.parse(data));
  const originalNow=Date.now;
  const start=Date.UTC(2026,9,1,12);
  try {
    // Accelerate the clock, including crossing UTC midnight. This checks policy
    // and the actual ACK/push path, not production latency or metered usage.
    for(let second=0;second<=86400;second++){
      Date.now=()=>start+second*1000;
      assert.equal(f.hub.interval(),1);
      if(second%3600!==0)continue;
      await f.hub.webSocketMessage(agent,JSON.stringify({metrics:{network_in:second,network_out:second,online4:true}}));
      assert.equal(acks.at(-1).seconds,1);
      assert.equal(pushed.at(-1).servers[0].last_seen,Date.now()/1000);
      assert.equal(f.writes.length,0,'reports and dashboard pushes must not persist each sample');
    }
    await f.hub.flush();assert.equal(f.writes.length,1);
    viewer.readyState=3;assert.equal(f.hub.interval(),60);
    viewer.readyState=1;assert.equal(f.hub.interval(),1);
  } finally {Date.now=originalNow;}
});
test('offline status and hidden-node notification use actual heartbeat, not checkpoint time',async()=>{
  const now=Math.floor(Date.now()/1000);
  const f=await fixture({saved:[row(now-181)]});
  const snapshot=await f.hub.snapshot();assert.equal(snapshot.servers[0].online4,false);assert.equal(snapshot.servers[0].hidden,true);
  const original=global.fetch;let sent=0;
  global.fetch=async()=>{sent++;return new Response('{"ok":true}');};
  try {await f.hub.handle(new Request('https://internal/scheduled',{method:'POST'}));}
  finally {global.fetch=original;}
  assert.equal(sent,1);assert.equal(f.notifications[0][0],0);assert.equal(f.writes.length,0);
});
test('live heartbeat prevents an offline alert when the stored checkpoint is old',async()=>{
  const now=Math.floor(Date.now()/1000);
  const f=await fixture({saved:[row(now-240)],attachments:[{role:'agent',username:'node',password:'pass',row:row(now)}]});
  const original=global.fetch;let sent=0;global.fetch=async()=>{sent++;return new Response('{"ok":true}');};
  try {await f.hub.handle(new Request('https://internal/scheduled',{method:'POST'}));}
  finally {global.fetch=original;}
  assert.equal(sent,0);assert.equal(f.writes[0][2],now);
});
test('Agent WebSocket framing rejects malformed input and preserves timed-out partial frames',()=>{
  const result=spawnSync('python3',['-m','unittest','discover','-s','tests','-p','agent_realtime_test.py'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('dashboard pauses hidden tabs, marks stale connections and ignores late events from replaced sockets',()=>{
  const vm=require('node:vm');
  const elements={rows:{innerHTML:'',querySelectorAll:()=>[]},summary:{},updated:{}};
  const listeners={},timers=new Map(),sockets=[];let id=0;
  class Socket {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;sockets.push(this);}
    send(data){this.sent=data;}
    close(){this.readyState=3;}
  }
  const document={hidden:false,addEventListener:(name,fn)=>listeners[name]=fn,getElementById:name=>elements[name],querySelectorAll:()=>[]};
  const context=vm.createContext({document,window:{location:{href:'https://example.test/'},matchMedia:()=>({matches:false})},WebSocket:Socket,URL,
    SSSVisibility:require('../service/web/js/visibility.js'),requestAnimationFrame:()=>{},
    setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:n=>timers.delete(n),
    setInterval:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearInterval:n=>timers.delete(n)});
  const source=fs.readFileSync(path.join(root,'service/web/js/app.js'),'utf8').replace(/  initTheme\(\);[\s\S]*?\}\)\(\);\s*$/, '  globalThis.live = { initLive, connectLive };\n})();');
  vm.runInContext(source,context);context.live.initLive();
  const first=sockets[0];assert.equal(first.url,'wss://example.test/api/live');first.readyState=1;first.onopen();
  first.onmessage({data:JSON.stringify({type:'stats',servers:[],updated:100})});assert.match(elements.updated.textContent,/Updated/);
  assert.ok(![...timers.values()].some(t=>t.ms===10000),'no old ten-second polling');
  document.hidden=true;listeners.visibilitychange();assert.equal(first.readyState,3);assert.equal(timers.size,0);
  document.hidden=false;listeners.visibilitychange();const second=sockets[1];second.readyState=1;second.onopen();
  first.onclose();assert.ok([...timers.values()].some(t=>t.ms===30000),'late close did not cancel current heartbeat');
  second.onclose();assert.match(elements.updated.textContent,/stale/);assert.ok([...timers.values()].some(t=>t.ms===60000),'slow fallback rather than fast polling');
});
