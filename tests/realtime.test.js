const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { WebSocket } = require('ws');
const root = path.resolve(__dirname, '..');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-realtime-'));
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', WRANGLER_LOG_PATH: path.join(state,'wrangler.log') };
const headers = { authorization: 'Bearer local-test-token', 'content-type': 'application/json' };
let worker, url, output = '';
const sockets = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(route, credentials) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + route, credentials ? { headers: { 'x-agent-user': credentials.username, authorization: 'Bearer ' + credentials.password } } : {});
  sockets.push(ws);
  ws.messages = [];
  ws.on('message', data => ws.messages.push(JSON.parse(data)));
  await once(ws, 'open');
  return ws;
}
async function message(ws, predicate) {
  for (let n=0;n<100;n++) {
    const index = ws.messages.findIndex(predicate);
    if (index >= 0) return ws.messages.splice(index,1)[0];
    await delay(25);
  }
  throw new Error('Missing WebSocket message: ' + JSON.stringify(ws.messages));
}
const node = { name: 'Realtime', username: 'realtime-user', password: 'test-pass', hidden: false, monthstart: '1' };
const metrics = counter => ({ network_in: counter, network_out: counter*2, cpu: counter%100, online4: true, online6: false });
async function configure(servers) {
  const current = await (await fetch(url+'/api/admin/config',{headers})).json();
  const response = await fetch(url+'/api/admin/config',{method:'PUT',headers,body:JSON.stringify({revision:current.revision,config:{servers}})});
  assert.equal(response.status,200,await response.text());
}
before(async()=>{
  const migrated=spawnSync(process.execPath,[wrangler,'d1','migrations','apply','sss-server-status-local','--local','--config','wrangler.local.toml','--persist-to',state],{cwd:root,env,encoding:'utf8'});
  assert.equal(migrated.status,0,migrated.stdout+migrated.stderr);
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  url='http://127.0.0.1:'+port;
  worker=spawn(process.execPath,[wrangler,'dev','--name','sss-realtime-test','--inspector-port','0','--config','wrangler.local.toml','--port',String(port),'--ip','127.0.0.1','--persist-to',state,'--test-scheduled'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  worker.stdout.on('data',b=>output+=b);worker.stderr.on('data',b=>output+=b);
  for(let n=0;n<120;n++){try{if((await fetch(url+'/api/health')).ok)return;}catch{} await delay(250);}
  throw new Error(output);
});
after(async()=>{
  for(const ws of sockets)ws.terminate();
  if(worker?.exitCode===null){worker.kill();await Promise.race([once(worker,'exit'),delay(5000)]);}
  fs.rmSync(state,{recursive:true,force:true});
});
test('real-time transport, idle policy, authorization, persistence and rolling upgrades',async t=>{
  await configure([node]);
  let agent, viewer;
  await t.test('rejects credentials before upgrade; public channel is read only',async()=>{
    const response=await fetch(url+'/api/agent/ws');assert.equal(response.status,426);
    const invalid=new WebSocket(url.replace('http:','ws:')+'/api/agent/ws',{headers:{'x-agent-user':node.username,authorization:'Bearer wrong'}});
    const error=await once(invalid,'error');assert.match(error[0].message,/401/);
    const ro=await connect('/api/live'); const closed=once(ro,'close');ro.send(JSON.stringify({metrics:metrics(999)}));assert.equal((await closed)[0],1008);
  });
  await t.test('idle agent receives 60 seconds, viewer immediately switches it to 1 second',async()=>{
    agent=await connect('/api/agent/ws',node);
    assert.equal((await message(agent,m=>m.type==='interval')).seconds,60);
    viewer=await connect('/api/live');
    assert.equal((await message(agent,m=>m.type==='interval'&&m.seconds===1)).seconds,1);
    assert.equal((await message(viewer,m=>m.type==='stats')).servers.length,1);
  });
  await t.test('pushes fresh metrics without polling and never exposes credentials',async()=>{
    agent.send(JSON.stringify({metrics:metrics(100)}));
    assert.equal((await message(agent,m=>m.type==='ack')).seconds,1);
    const pushed=await message(viewer,m=>m.type==='stats'&&m.servers[0]?.network_in===100);
    assert.equal(pushed.servers[0].online4,true);
    assert.ok(!JSON.stringify(pushed).includes(node.password));
    const snapshot=await (await fetch(url+'/json/stats.json')).json();assert.equal(snapshot.servers[0].network_in,100);
  });
  await t.test('many real-time reports are buffered; scheduled checkpoint saves latest sample',async()=>{
    for(let n=101;n<=105;n++){agent.send(JSON.stringify({metrics:metrics(n)}));await message(agent,m=>m.type==='ack');}
    const sql=spawnSync(process.execPath,[wrangler,'d1','execute','sss-server-status-local','--local','--config','wrangler.local.toml','--persist-to',state,'--command',"SELECT COUNT(*) AS amount FROM agent_metrics" ,'--json'],{cwd:root,env,encoding:'utf8'});
    assert.equal(sql.status,0,sql.stderr);assert.equal(JSON.parse(sql.stdout)[0].results[0].amount,0);
    assert.equal((await fetch(url+'/__scheduled?cron=*+*+*+*+*')).status,200);
    await delay(300);
    const saved=spawnSync(process.execPath,[wrangler,'d1','execute','sss-server-status-local','--local','--config','wrangler.local.toml','--persist-to',state,'--command','SELECT metrics_json FROM agent_metrics','--json'],{cwd:root,env,encoding:'utf8'});
    assert.equal(saved.status,0,saved.stderr);assert.equal(JSON.parse(JSON.parse(saved.stdout)[0].results[0].metrics_json).network_in,105);
  });
  await t.test('hide broadcasts immediately while retaining reporting and cumulative traffic',async()=>{
    await configure([{...node,hidden:true}]);
    const hidden=await message(viewer,m=>m.type==='stats'&&m.servers[0]?.hidden);
    assert.equal(hidden.servers[0].monthly_network_in,5);
    agent.send(JSON.stringify({metrics:metrics(3)}));await message(agent,m=>m.type==='ack');
    const reset=await message(viewer,m=>m.type==='stats'&&m.servers[0]?.network_in===3);
    assert.equal(reset.servers[0].monthly_network_in,8);
  });
  await t.test('closing the last viewer returns agents to idle frequency',async()=>{
    const closed=once(viewer,'close');viewer.close();await closed;
    assert.equal((await message(agent,m=>m.type==='interval'&&m.seconds===60)).seconds,60);
  });
  await t.test('password rotation revokes existing connection and deletion cannot resurrect a node',async()=>{
    const closed=once(agent,'close');await configure([{...node,password:'rotated'}]);assert.equal((await closed)[0],1008);
    const fresh=await connect('/api/agent/ws',{...node,password:'rotated'});await message(fresh,m=>m.type==='interval');
    fresh.send(JSON.stringify({metrics:metrics(200)}));await message(fresh,m=>m.type==='ack');
    const gone=once(fresh,'close');await configure([]);assert.equal((await gone)[0],1008);
    assert.equal((await (await fetch(url+'/json/stats.json')).json()).servers.length,0);
  });
  await t.test('invalid/null and oversized messages close only the offending agent',async()=>{
    await configure([node]);
    for (const [payload,code] of [['null',1008],['x'.repeat(33000),1009]]) {
      const bad=await connect('/api/agent/ws',node);await message(bad,m=>m.type==='interval');
      const closed=once(bad,'close');bad.send(payload);assert.equal((await closed)[0],code);
      assert.equal((await fetch(url+'/api/health')).status,200);
    }
  });
  await t.test('Python standard-library client exchanges real frames with local DO',async()=>{
    await configure([node]);
    const code=`import importlib.util,sys\nspec=importlib.util.spec_from_file_location('agent','agent/client-linux.py')\na=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)\nw=a.AgentWebSocket(sys.argv[1],'realtime-user','test-pass')\nassert w.receive(5)['seconds']==60\nw.report({'network_in':321,'network_out':654,'online4':True})\nassert w.receive(5)['type']=='ack'\nw.send_frame(b'probe',9)\nw.close()\n`;
    const child=spawn('python3',['-c',code,url],{cwd:root,stdio:['ignore','pipe','pipe']});let log='';child.stderr.on('data',b=>log+=b);
    assert.equal((await once(child,'exit'))[0],0,log);
    assert.equal((await (await fetch(url+'/json/stats.json')).json()).servers[0].network_in,321);
  });
});

test('eleven simulated nodes stream concurrently to a live dashboard',async()=>{
  const nodes=Array.from({length:11},(_,i)=>({...node,name:'load-'+i,username:'load-'+i,password:'load-pass-'+i}));
  await configure(nodes);
  const viewer=await connect('/api/live');await message(viewer,m=>m.type==='stats');
  const agents=await Promise.all(nodes.map(n=>connect('/api/agent/ws',n)));
  for(const agent of agents)assert.equal((await message(agent,m=>m.type==='interval')).seconds,1);
  for(let round=1;round<=3;round++){
    for(const agent of agents)agent.send(JSON.stringify({metrics:metrics(round*100)}));
    for(const agent of agents)await message(agent,m=>m.type==='ack');
    const snapshot=await message(viewer,m=>m.type==='stats'&&m.servers.length===11&&m.servers.every(s=>s.network_in===round*100));
    assert.ok(snapshot.servers.every(s=>s.online4));
    if(round<3)await delay(1000);
  }
  for(const agent of agents)agent.close();viewer.close();
});
