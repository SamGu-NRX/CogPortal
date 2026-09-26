// Verification-only host: real candidate Activity/console/stream, fake Discord identity and API responses.
import {createServer} from 'node:http';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const base='/Users/samgu/.codex/worktrees/dd61/CogPortal';
const candidate='/Users/samgu/Programming Projects/CogPortal-verifier-8459519';
const dir=base+'/verification-finalization/readiness/activity';
const require=createRequire(base+'/package.json');
const esbuild=require(base+'/node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild');
const {WebSocketServer}=require(base+'/node_modules/.pnpm/ws@8.21.0/node_modules/ws');
await esbuild.build({entryPoints:[candidate+'/apps/portal/src/activity-main.tsx'],bundle:true,outfile:dir+'/fixture.js',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[base+'/apps/portal/node_modules'],alias:{'@':candidate+'/apps/portal/src','@cogworks/contracts/schema':candidate+'/packages/contracts/src/schema.ts'},plugins:[{name:'fixture-only-boundaries',setup(b){
 b.onResolve({filter:/\.css$/},()=>({path:'style',namespace:'empty'})); b.onLoad({filter:/.*/,namespace:'empty'},()=>({contents:''}));
 b.onResolve({filter:/^@discord\/embedded-app-sdk$/},()=>({path:'sdk',namespace:'fixture'}));
 b.onResolve({filter:/^\.\/env.client$/},()=>({path:'env',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='env'?`export const clientEnv={VITE_DISCORD_CLIENT_ID:'fixture',VITE_PORTAL_ORIGIN:'http://127.0.0.1:5191'};`:`export const Common={LayoutModeTypeObject:{FOCUSED:0,PIP:1,GRID:2}};export const Events={ACTIVITY_LAYOUT_MODE_UPDATE:'layout'};export class DiscordSDK {ready=async()=>{};subscribe=async()=>{};unsubscribe=async()=>{};commands={authorize:async()=>({code:'fixture'}),authenticate:async()=>({}),openExternalLink:async({url})=>{document.getElementById('destination').textContent=url;}}}` }));
}}]});
let mode='teamless', linked=false, offline=false; const logs=[];
function record(x){logs.push({at:Date.now(),...x});fs.writeFileSync(dir+'/local-requests.json',JSON.stringify(logs,null,2));}
const now=Date.now(); const surface={id:'surface_01234567890123456789',team:{id:'fixture-team',name:'Disposable Activity team'},benchmark:{id:'audio-identification',version:1,title:'Fixture Audio'},actor:{login:'fixture',name:'Fixture'},sha:'1'.repeat(40),shortSha:'1111111',branch:'fixture',dirty:false,stage:'hosted',status:'running',phase:'evaluating',createdAt:now,updatedAt:now,finishedAt:null,elapsedMs:1000,progress:null,primaryMetric:null,metrics:[],localRunId:'fixture-local',practiceRunId:'fixture-practice',officialRunId:null,published:false,nextOfficialAttempt:null,events:[],actions:[],simulated:true};
const server=createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1:5191');record({method:req.method,path:u.pathname});res.setHeader('Content-Type','application/json');
 if(u.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(dir+'/fixture.js'));return;}
 if(u.pathname==='/control/link'){linked=true;res.end('{}');return;}
 if(u.pathname==='/control/drop'){offline=true;for(const s of wss.clients)s.close();setTimeout(()=>{offline=false;record({event:'network-restored'});},10000);res.end('{}');return;}
 if(u.pathname.endsWith('/oauth/state')){res.end(JSON.stringify({state:'x'.repeat(48)}));return;}
 if(u.pathname.endsWith('/oauth/token')){res.end(JSON.stringify({accessToken:'fixture',user:{id:'fixture',username:'fixture',globalName:null}}));return;}
 if(u.pathname.endsWith('/activity/session')){res.end(JSON.stringify(mode==='teamless'?{linked:'no_team',portalUrl:'http://127.0.0.1:5191/connect'}:mode==='unlinked'&&!linked?{linked:false,linkUrl:'http://127.0.0.1:5191/link-fixture'}:{linked:true,githubLogin:'fixture',team:{id:'fixture-team',name:'Disposable Activity team',discordChannelId:null}}));return;}
 if(u.pathname.endsWith('/run-surfaces')){res.end(JSON.stringify([surface]));return;}
 if(u.pathname==='/'){mode=u.searchParams.get('mode')||'teamless';if(u.searchParams.has('reset'))linked=false;res.setHeader('Content-Type','text/html');res.end(`<title>Activity local fixture</title><aside>LOCAL FIXTURE. Discord identity and API are simulated. <button onclick="fetch('/control/link',{method:'POST'})">Simulate completed browser link</button><button onclick="fetch('/control/drop',{method:'POST'})">Drop fixture stream for ten seconds</button><output id="destination"></output></aside><div id="root"></div><script type="module" src="/fixture.js"></script>`);return;}
 res.statusCode=404;res.end('{}');
});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{record({event:'upgrade',offline});if(offline){socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');return;}wss.handleUpgrade(req,socket,head,ws=>{record({event:'socket-open'});ws.send(JSON.stringify({...surface,updatedAt:Date.now(),elapsedMs:Date.now()-now}));});});
server.listen(5191,'127.0.0.1',()=>console.log('Local-only fixture at 127.0.0.1:5191'));
