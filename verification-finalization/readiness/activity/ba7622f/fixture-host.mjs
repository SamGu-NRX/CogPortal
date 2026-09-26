// Verification-only host: real candidate Activity/console/stream, fake Discord identity and API responses.
import {createServer} from 'node:http';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const base='/Users/samgu/.codex/worktrees/dd61/CogPortal';
const candidate='/Users/samgu/Programming Projects/CogPortal-verifier-activity-ba7622f';
const dir=base+'/verification-finalization/readiness/activity/ba7622f';
fs.mkdirSync(dir,{recursive:true});
const require=createRequire(base+'/package.json');
const esbuild=require(base+'/node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild');
const {WebSocketServer}=require(base+'/node_modules/.pnpm/ws@8.21.0/node_modules/ws');
await esbuild.build({entryPoints:[candidate+'/apps/portal/src/activity-main.tsx'],bundle:true,outfile:dir+'/fixture.js',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[base+'/apps/portal/node_modules'],alias:{'@':candidate+'/apps/portal/src','@cogworks/contracts/schema':candidate+'/packages/contracts/src/schema.ts'},plugins:[{name:'fixture-only-boundaries',setup(b){
 b.onResolve({filter:/\.css$/},()=>({path:'style',namespace:'empty'})); b.onLoad({filter:/.*/,namespace:'empty'},()=>({contents:''}));
 b.onResolve({filter:/^@discord\/embedded-app-sdk$/},()=>({path:'sdk',namespace:'fixture'}));
 b.onResolve({filter:/^\.\/env.client$/},()=>({path:'env',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='env'?`export const clientEnv={VITE_DISCORD_CLIENT_ID:'fixture',VITE_PORTAL_ORIGIN:'http://127.0.0.1:5191'};`:`export const Common={LayoutModeTypeObject:{FOCUSED:0,PIP:1,GRID:2}};export const Events={ACTIVITY_LAYOUT_MODE_UPDATE:'layout'};export class DiscordSDK {ready=async()=>{};subscribe=async(event,fn)=>{fn({layout_mode:Number(new URLSearchParams(location.search).get('layout')||0)});};unsubscribe=async(event,fn)=>{fn({layout_mode:Number(new URLSearchParams(location.search).get('layout')||0)});};commands={authorize:async()=>({code:'fixture'}),authenticate:async()=>({}),openExternalLink:async({url})=>{document.getElementById('destination').textContent=url;return await (await fetch('/control/open')).json();}}}` }));
}}]});
let mode='unlinked', linked=false, offline=false, expired=false, failSurfaces=false, cancelOpen=false, hold=false, held=null; const logs=[];
function record(x){logs.push({at:Date.now(),...x});fs.writeFileSync(dir+'/requests.json',JSON.stringify(logs,null,2));}
const now=Date.now(); const surface={id:'surface_01234567890123456789',team:{id:'fixture-team',name:'Disposable Activity team'},benchmark:{id:'audio-identification',version:1,title:'Fixture Audio'},actor:{login:'fixture',name:'Fixture'},sha:'1'.repeat(40),shortSha:'1111111',branch:'fixture',dirty:false,stage:'hosted',status:'running',phase:'evaluating',createdAt:now,updatedAt:now,finishedAt:null,elapsedMs:1000,progress:null,primaryMetric:null,metrics:[],localRunId:'fixture-local',practiceRunId:'fixture-practice',officialRunId:null,published:false,nextOfficialAttempt:null,events:[],actions:[],simulated:true};
function sessionAnswer(){return linked||mode==='surfacefail'?{linked:true,githubLogin:'fixture',team:{id:'fixture-team',name:'Disposable Activity team',discordChannelId:null}}:mode==='teamless'?{linked:'no_team',portalUrl:'http://127.0.0.1:5191/connect'}:{linked:false,linkUrl:'http://127.0.0.1:5191/link-fixture'};}
const server=createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1:5191');record({method:req.method,path:u.pathname});res.setHeader('Content-Type','application/json');
 if(u.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(dir+'/fixture.js'));return;}
 if(u.pathname==='/control/open'){res.end(JSON.stringify({opened:!cancelOpen}));return;}
 if(u.pathname==='/control/cancel'){cancelOpen=!cancelOpen;res.end('{}');return;}
 if(u.pathname==='/control/expire'){expired=true;res.end('{}');return;}
 if(u.pathname==='/control/fail'){failSurfaces=true;res.end('{}');return;}
 if(u.pathname==='/control/hold'){hold=true;res.end('{}');return;}
 if(u.pathname==='/control/release'){hold=false;if(held){held.end(JSON.stringify(sessionAnswer()));held=null;}res.end('{}');return;}
 if(u.pathname==='/control/link'){linked=true;res.end('{}');return;}
 if(u.pathname==='/control/drop'){offline=true;for(const s of wss.clients)s.close();setTimeout(()=>{offline=false;record({event:'network-restored'});},10000);res.end('{}');return;}
 if(u.pathname.endsWith('/oauth/state')){res.end(JSON.stringify({state:'x'.repeat(48)}));return;}
 if(u.pathname.endsWith('/oauth/token')){res.end(JSON.stringify({accessToken:'fixture',user:{id:'fixture',username:'fixture',globalName:null}}));return;}
 if(u.pathname.endsWith('/activity/session')){if(expired){res.statusCode=401;res.end(JSON.stringify({error:{message:'The Activity session expired. Close the Activity and open it again.'}}));return;}if(hold){held=res;return;}res.end(JSON.stringify(sessionAnswer()));return;}
 if(u.pathname.endsWith('/run-surfaces')){if(failSurfaces){res.statusCode=503;res.end(JSON.stringify({error:{message:'Fixture run surfaces are unavailable.'}}));return;}res.end(JSON.stringify([surface]));return;}
 if(u.pathname.startsWith('/assets/')){const name=u.pathname.slice(8);if(name.includes('/')){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'font/woff2');res.end(fs.readFileSync(dir+'/assets/'+name));return;}
 if(u.pathname==='/'){mode=u.searchParams.get('mode')||'unlinked';linked=false;expired=false;failSurfaces=mode==='surfacefail';cancelOpen=false;hold=false;res.setHeader('Content-Type','text/html');res.end(`<title>Activity local fixture</title><link rel="stylesheet" href="/assets/run-surface-stream-C3FCCHRi.css"><aside style="${u.searchParams.has('clean')?'display:none;':''}font:12px sans-serif;position:absolute;top:0;left:0;z-index:9999;max-width:100%;background:#fff">LOCAL FIXTURE. Discord identity and API are simulated. <button onclick="fetch('/control/link',{method:'POST'})">Simulate completed browser link</button><button onclick="fetch('/control/drop',{method:'POST'})">Drop fixture stream for ten seconds</button><button onclick="fetch('/control/cancel',{method:'POST'})">Toggle open cancellation</button><button onclick="fetch('/control/expire',{method:'POST'})">Expire fixture session</button><button onclick="fetch('/control/fail',{method:'POST'})">Fail fixture surfaces</button><button onclick="fetch('/control/hold',{method:'POST'})">Hold session check</button><button onclick="fetch('/control/release',{method:'POST'})">Release session check</button><output id="destination"></output></aside><div id="root"></div><script type="module" src="/fixture.js"></script>`);return;}
 res.statusCode=404;res.end('{}');
});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{record({event:'upgrade',offline});if(offline){socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');return;}wss.handleUpgrade(req,socket,head,ws=>{record({event:'socket-open'});ws.send(JSON.stringify({...surface,updatedAt:Date.now(),elapsedMs:Date.now()-now}));});});
server.listen(5191,'127.0.0.1',()=>console.log('Local-only fixture at 127.0.0.1:5191'));
