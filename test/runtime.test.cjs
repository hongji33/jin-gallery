'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/secure-client.js','utf8');
function fixture(){
  const records={'v2Accounts/student':{role:'student',studentId:'student',classId:'2026-3-1',authVersion:1,active:true},'v2Classes/2026-3-1/students/student':{nickname:'민화',grade:3,classNum:1},'v2Accounts/teacher':{role:'teacher',classIds:['2026-3-1'],active:true}};
  const calls=[],events=[],watchers=[];
  let authChanged=null,failLogin=false;
  const auth={useEmulator(){},async setPersistence(p){calls.push(['persistence',p]);},onAuthStateChanged(cb){authChanged=cb;},async signOut(){calls.push(['signOut']);if(authChanged)await authChanged(null);},async signInWithCustomToken(token){calls.push(['custom',token]);return {user:{uid:'student'}};},async signInWithEmailAndPassword(){return {user:{uid:'teacher'}};}};
  const firestore={useEmulator(){},doc(p){return {async get(){const d=records[p];return {exists:!!d,data:()=>d};}};},collection(p){const q={orderBy(){return q;},limit(){return q;},onSnapshot(cb){const w={cb,stopped:false};watchers.push(w);return ()=>{w.stopped=true;};}};return q;}};
  const functions={useEmulator(){},httpsCallable(name){return async data=>{calls.push(['rpc',name,data]);if(failLogin)throw new Error('실패');return {data:name==='studentLogin'?{token:'server-token'}:{ok:true}};};}};
  const firebase={initializeApp(c){calls.push(['config',c]);},auth:()=>auth,firestore:()=>firestore,app:()=>({functions:()=>functions}),appCheck:()=>({activate(provider,refresh){calls.push(['appCheck',provider,refresh]);}})};
  firebase.appCheck.ReCaptchaEnterpriseProvider=class {constructor(siteKey){this.siteKey=siteKey;}};
  firebase.auth.Auth={Persistence:{SESSION:'session'}};
  const context={window:{},firebase,location:{hostname:'localhost'}};vm.createContext(context);vm.runInContext(source,context);
  const api=context.window.GallerySecure,config={emulator:true,region:'asia-northeast3',firebase:{projectId:'demo-jin-gallery'}};
  return {api,calls,events,watchers,config,initialize:()=>api.initialize(config,s=>events.push(s),()=>{}),fail:()=>{failLogin=true;}};
}
test('운영 프로젝트 자동 연결 거부, 로그인은 서버 토큰과 UID 계정 매핑에서만 복원',async()=>{
  const f=fixture();await assert.rejects(()=>f.api.initialize({...f.config,firebase:{projectId:'jin-gallery'}},()=>{}));
  await f.initialize();await f.api.loginStudent({code:'0047',password:'SECRET'});
  assert.equal(f.api.session().studentId,'student');assert.equal(f.api.session().classId,'2026-3-1');
  assert.ok(f.calls.some(x=>x[0]==='persistence' && x[1]==='session'));
  assert.ok(f.calls.some(x=>x[0]==='custom' && x[1]==='server-token'));
  assert.equal((await f.api.getOwnStudent()).nickname,'민화');
  await f.api.command('reflection.save',{text:'다짐'});
  assert.equal(f.calls.at(-1)[2].classId,'2026-3-1');
});
test('로그아웃은 구독·프로필을 해제하고 뒤늦은 이전 반 콜백을 차단',async()=>{
  const f=fixture();await f.initialize();await f.api.loginStudent({});
  let received=0;f.api.db.collection('students').onSnapshot(()=>received++);
  f.watchers[0].cb({docs:[]});assert.equal(received,1);
  await f.api.logout();assert.equal(f.api.session(),null);assert.equal(f.watchers[0].stopped,true);
  f.watchers[0].cb({docs:[]});assert.equal(received,1);
});
test('교사 수업 선택은 계정 담당 반만 허용, 실패한 학생 로그인은 교사 세션도 제거',async()=>{
  const f=fixture();await f.initialize();await f.api.loginTeacher('test','test');
  await assert.rejects(()=>f.api.selectClass('2026-3-2'));
  f.fail();await assert.rejects(()=>f.api.loginStudent({code:'0000',password:'WRONG'}));
  assert.equal(f.api.session(),null);assert.equal(f.events.at(-1),null);
});
test('실제 프로젝트는 Enterprise App Check 제공자와 토큰 자동 갱신을 사용',async()=>{
  const f=fixture();
  await f.api.initialize({...f.config,emulator:false,firebase:{projectId:'jin-gallery-v2'},appCheckSiteKey:'public-site-key'},()=>{});
  const call=f.calls.find(x=>x[0]==='appCheck');assert.equal(call[1].siteKey,'public-site-key');assert.equal(call[2],true);
});
