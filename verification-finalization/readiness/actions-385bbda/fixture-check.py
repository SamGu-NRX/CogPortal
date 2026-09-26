import sqlite3,json,time,urllib.request,urllib.error,http.cookiejar
from pathlib import Path
ROOT=Path('/Users/samgu/Programming Projects/CogPortal-verifier-actions-385bbda')
OUT=Path('/Users/samgu/.codex/worktrees/dd61/CogPortal/verification-finalization/readiness/actions-385bbda')
p=next(p for p in (ROOT/'apps/portal/.wrangler/state/v3/d1/miniflare-D1DatabaseObject').glob('*.sqlite') if p.name!='metadata.sqlite')
c=sqlite3.connect(p);c.row_factory=sqlite3.Row
team='team_source_accept';uid='LKF2CPVCu9OoHoUJSj0JopaeBkZSvhAS';now=int(time.time()*1000)
surfaces=['surface_'+f'{i:020x}' for i in range(1,6)]
c.execute('update teams set repo_id=900001,repo_owner=?,repo_name=?,repo_full_name=?,repo_url=? where id=?',('fixture-org','repo-a','fixture-org/repo-a','https://github.com/fixture-org/repo-a',team))
# Add independent local-only fixtures for hosted verification and unknown official history.
for i,s in enumerate(surfaces[3:]):
 c.execute('insert into run_surfaces (id,team_id,created_by_user_id,benchmark_id,benchmark_version,created_at,updated_at) values (?,?,?,?,?,?,?)',(s,team,uid,'audio-identification',1,now+i,now+i))
device=c.execute('select id from cli_devices where user_id=? limit 1',(uid,)).fetchone()[0]
c.execute('insert into local_run_sessions (id,team_id,user_id,device_id,benchmark_id,benchmark_version,repository_id,repository_full_name,sha,dirty,status,phase,created_at,updated_at,finished_at,branch,surface_id) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',('local_source_check',team,uid,device,'audio-identification',1,900001,'fixture-org/repo-a','71258046e60fecd3295c0b52236fc6e476b0e9cf',0,'succeeded','succeeded',now,now,now,'main',surfaces[3]))
c.execute('update run_surfaces set local_run_id=? where id=?',('local_source_check',surfaces[3]))
row=dict(c.execute('select * from runs where id=?',('run_source_official',)).fetchone());row.update(id='run_source_unknown_official',surface_id=surfaces[4],repository_id=None,repository_full_name=None,created_at=now,finished_at=now)
c.execute('insert into runs ('+','.join(row)+') values ('+','.join('?' for _ in row)+')',list(row.values()));c.commit()
op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def req(path,data=None):
 try:
  r=op.open(urllib.request.Request('http://localhost:5196'+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'}));return {'status':r.status,'body':json.load(r)}
 except urllib.error.HTTPError as e:return {'status':e.code,'body':json.load(e)}
def state():
 return {t:[dict(r) for r in c.execute('select * from '+t+' order by 1')] for t in ['runs','official_attempts','leaderboard_selections','run_surfaces','local_run_sessions']}
r={'login':req('/api/dev/login',{'login':'ui-accept-e8'}),'before_swap':req('/api/runs/run_source_old')}
r['swap']=req('/api/team/repository',{'fullName':'cogworks-demo/face-finder'})
assert r['swap']['status']==200
r['fixture_schema']={t:[dict(x) for x in c.execute('pragma table_info('+t+')')] for t in ['runs','local_run_sessions','run_surfaces']}
# Every attempted mutation has a real row of the required type and a succeeded state.
paths=[('/api/runs/run_source_old/promote','old direct promote'),('/api/runs/run_source_legacy/promote','unknown direct promote'),('/api/runs/run_source_official/publish','old direct publish'),('/api/runs/run_source_unknown_official/publish','unknown direct publish')]
for surface,actions in [(surfaces[0],['promote_official','rerun_hosted']),(surfaces[1],['promote_official','rerun_hosted']),(surfaces[2],['publish_result']),(surfaces[4],['publish_result']),(surfaces[3],['verify_hosted'])]:
 for action in actions:paths.append(('/api/run-surfaces/'+surface+'/actions/'+action,surface+' '+action))
r['refusals']=[]
for path,label in paths:
 before=state();res=req(path,{});after=state()
 r['refusals'].append({'label':label,'path':path,**res,'state_unchanged':before==after})
# The same actual local session with absent identity must refuse as well.
c.execute('update local_run_sessions set repository_id=NULL where id=?',('local_source_check',));c.commit()
before=state();res=req('/api/run-surfaces/'+surfaces[3]+'/actions/verify_hosted',{});after=state()
r['refusals'].append({'label':'unknown verify_hosted',**res,'state_unchanged':before==after})
r['after']={path:req(path) for path in ['/api/runs/run_source_old','/api/runs/run_source_legacy','/api/dashboard?benchmark=audio-identification','/api/run-surfaces/'+surfaces[0],'/api/run-surfaces/'+surfaces[1],'/api/run-surfaces/'+surfaces[3]]}
r['final_fixture_rows']={t:[dict(x) for x in c.execute('select * from '+t+' where '+('id=?' if t=='teams' else 'team_id=?'),(team,))] for t in ['teams','runs','local_run_sessions','run_surfaces','official_attempts','leaderboard_selections']}
(OUT/'action-refusals.json').write_text(json.dumps(r,indent=2))
for x in r['refusals']:print(x)
