'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../functions/core.cjs');
const {MemoryStore}=require('./memory-store.cjs');
const cid='2026-3-1', other='2026-3-2', teacher={uid:'teacher',token:{}};
const base=`v2Classes/${cid}`;
const quiz=[{type:'mc',text:'작품의 색은?',choices:['빨강','파랑'],correctIndex:1},{type:'text',text:'어떤 느낌인가요?'}];
function student(card,version=1){return {uid:card.studentId,token:{authVersion:version}};}
async function fixture(n=3){
  const store=new MemoryStore({'v2Accounts/teacher':{role:'teacher',classIds:[cid,other],active:true}});
  const {cards}=await core.issueStudents(store,teacher,{classId:cid,count:n},{randomIndex:()=>0});
  const {id:activityId}=await core.command(store,teacher,{classId:cid,action:'activity.add',payload:{name:'민화'}});
  for(let i=0;i<cards.length;i++) await core.command(store,student(cards[i]),{classId:cid,action:'profile',payload:{nickname:'학생'+i,activityId}});
  const artworkId=`${cards[0].studentId}__${activityId}`;
  await core.command(store,student(cards[0]),{classId:cid,action:'artwork.save',payload:{id:artworkId,activityId,title:'나의 민화',quiz,imageData:'data:image/jpeg;base64,/9j/AA=='}});
  return {store,cards,activityId,artworkId,cmd:(a,action,payload)=>core.command(store,a,{classId:cid,action,payload})};
}
async function rejected(fn,code){await assert.rejects(fn,e=>e.code===code);}
test('4자리·앞자리 0 유지, 반별 중복 방지, 타 반 동일 번호 허용, 비밀번호 원문 미저장',async()=>{
  const {store,cards}=await fixture();
  assert.deepEqual(cards.map(x=>x.code),['0000','0001','0002']);
  assert.ok(cards.every(x=>/^\d{4}$/.test(x.code) && x.password.length===8));
  const second=await core.issueStudents(store,teacher,{classId:other,count:1},{randomIndex:()=>0});
  assert.equal(second.cards[0].code,'0000');
  assert.deepEqual(await core.checkCodes(store,teacher,cid),{count:3,valid:true,problems:[]});
  assert.ok(!JSON.stringify([...store.docs]).includes(cards[0].password));
  const first=(await store.get(`${base}/students/${cards[0].studentId}`));
  assert.equal(first.number,undefined);assert.equal(first.code,undefined);
});
test('동시 일괄 발급에서도 중복 없음',async()=>{
  const {store}=await fixture(1);
  const results=await Promise.all([1,2].map(()=>core.issueStudents(store,teacher,{classId:cid,count:2},{randomIndex:()=>0})));
  const codes=results.flatMap(x=>x.cards.map(c=>c.code)); assert.equal(new Set(codes).size,4);
});
test('개인번호만·틀린 비밀번호·다른 반 로그인 거부, 올바른 인증 UID 연결',async()=>{
  const {store,cards}=await fixture(1), card=cards[0];
  const input={schoolYear:'2026',grade:3,classNum:1,code:card.code};
  await rejected(()=>core.studentLogin(store,input,'test-ip'),'unauthenticated');
  await rejected(()=>core.studentLogin(store,{...input,password:'WRONGPASS'},'test-ip'),'unauthenticated');
  await rejected(()=>core.studentLogin(store,{...input,classNum:2,password:card.password},'test-ip'),'unauthenticated');
  const result=await core.studentLogin(store,{...input,password:card.password},'test-ip');
  assert.equal(result.uid,card.studentId);assert.equal(result.claims.authVersion,1);
});
test('반복 로그인 공격 제한',async()=>{
  const {store}=await fixture(1), input={schoolYear:'2026',grade:3,classNum:1,code:'9999',password:'WRONGPASS'};
  for(let i=0;i<10;i++) await rejected(()=>core.studentLogin(store,input,'same-ip',1000),'unauthenticated');
  await rejected(()=>core.studentLogin(store,input,'same-ip',1000),'resource-exhausted');
  await rejected(()=>core.studentLogin(store,input,'same-ip',901001),'unauthenticated');
});
test('학생의 교사 역할 위조·다른 반·타인 작품 수정·학생 발급 거부',async()=>{
  const {store,cards,artworkId,cmd}=await fixture(2);
  const forged={...student(cards[1]),token:{authVersion:1,role:'teacher'}};
  await rejected(()=>core.issueStudents(store,forged,{classId:cid,count:1}),'permission-denied');
  await rejected(()=>core.command(store,student(cards[1]),{classId:other,action:'activity.add',payload:{name:'위조'}}),'permission-denied');
  await rejected(()=>cmd(forged,'artwork.save',{id:artworkId,title:'변경',quiz}),'permission-denied');
  await rejected(()=>cmd(forged,'activity.add',{name:'위조'}),'permission-denied');
  await rejected(()=>cmd(null,'reflection.save',{text:'위조'}),'unauthenticated');
});
test('서버 채점·정답 분리·중복 제출 차단·트랜잭션 포인트 정합성',async()=>{
  const {store,cards,artworkId,cmd}=await fixture();
  const art=await store.get(`${base}/artworks/${artworkId}`);
  assert.equal(art.quiz[0].correctIndex,undefined);
  const payload={artworkId,answers:[1,'이 작품의 색과 형태에서 따뜻한 느낌이 듭니다.'],critique:'색을 이렇게 선택한 이유는 무엇인가요?',score:99999,viewerId:cards[0].studentId};
  const results=await Promise.allSettled([cmd(student(cards[1]),'quiz.submit',payload),cmd(student(cards[1]),'quiz.submit',payload)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'already-exists');
  const r=results.find(r=>r.status==='fulfilled').value;
  assert.ok(r.score<10); assert.equal((await store.get(`${base}/students/${cards[1].studentId}`)).points,r.viewerPoints);
  assert.equal((await store.get(`${base}/students/${cards[0].studentId}`)).authorPoints,2+Math.ceil(r.score/3));
  await rejected(()=>cmd(student(cards[0]),'quiz.submit',payload),'permission-denied');
});
test('좋아요·베스트 요청 재시도는 한 번만 지급, 무단 베스트 거부, 감상 삭제 시 점수 회수',async()=>{
  const {store,cards,artworkId,cmd}=await fixture();
  const result=await cmd(student(cards[1]),'quiz.submit',{artworkId,answers:[1,'멋진 그림입니다.'],critique:'어떻게 그렸나요?'});
  const rid=`${artworkId}__${cards[1].studentId}`;
  for(let i=0;i<2;i++) await cmd(student(cards[2]),'like',{responseId:rid,liked:true});
  await rejected(()=>cmd(student(cards[1]),'like',{responseId:rid,liked:true}),'permission-denied');
  await rejected(()=>cmd(student(cards[2]),'best',{artworkId,responseId:rid}),'permission-denied');
  for(let i=0;i<2;i++) await cmd(student(cards[0]),'best',{artworkId,responseId:rid});
  assert.equal((await store.get(`${base}/students/${cards[1].studentId}`)).points,result.viewerPoints+6);
  await rejected(()=>cmd(student(cards[2]),'response.delete',{id:rid}),'permission-denied');
  await cmd(student(cards[1]),'response.delete',{id:rid});
  assert.equal((await store.get(`${base}/students/${cards[1].studentId}`)).points,0);
  assert.equal((await store.get(`${base}/students/${cards[0].studentId}`)).authorPoints,0);
  assert.equal((await store.get(`${base}/artworks/${artworkId}`)).bestResponseId,null);
});
test('다짐 타인 삭제 거부, 작품 연쇄 삭제와 포인트 회수',async()=>{
  const {store,cards,artworkId,cmd}=await fixture(2);
  await cmd(student(cards[1]),'reflection.save',{text:'성실하게 감상하겠습니다.'});
  await rejected(()=>cmd(student(cards[0]),'reflection.delete',{id:cards[1].studentId}),'permission-denied');
  await cmd(student(cards[1]),'quiz.submit',{artworkId,answers:[0,'아름다운 작품입니다.'],critique:'어떻게 그렸나요?'});
  await cmd(student(cards[0]),'artwork.delete',{id:artworkId});
  assert.equal(await store.get(`${base}/artworks/${artworkId}`),null);
  assert.equal((await store.get(`${base}/students/${cards[1].studentId}`)).points,0);
});
test('재발급 후 ID·기록 유지, 구 번호·구 비밀번호·구 토큰 버전 차단',async()=>{
  const {store,cards,artworkId,cmd}=await fixture(1),old=cards[0];
  await cmd(student(old),'reflection.save',{text:'새롭게 도전하겠습니다.'});
  const {cards:[next]}=await core.issueStudents(store,teacher,{classId:cid,studentId:old.studentId},{randomIndex:()=>0});
  assert.equal(next.studentId,old.studentId); assert.notEqual(next.code,old.code);
  assert.ok(await store.get(`${base}/artworks/${artworkId}`));
  assert.ok(await store.get(`${base}/reflections/${old.studentId}`));
  await rejected(()=>cmd(student(old),'reflection.save',{text:'이전 로그인'}),'permission-denied');
  const login={schoolYear:'2026',grade:3,classNum:1};
  await rejected(()=>core.studentLogin(store,{...login,code:old.code,password:old.password},'ip'),'unauthenticated');
  await rejected(()=>core.studentLogin(store,{...login,code:next.code,password:old.password},'ip'),'unauthenticated');
  const r=await core.studentLogin(store,{...login,code:next.code,password:next.password},'ip'); assert.equal(r.claims.authVersion,2);
});
test('학생 삭제는 새 반의 기록·계정만 비활성화, 기존 운영 컬렉션 유지',async()=>{
  const {store,cards,cmd}=await fixture(1);
  store.docs.set('students/3-1-1',{nickname:'운영 자료'});
  await cmd(teacher,'student.delete',{id:cards[0].studentId});
  assert.equal((await store.get(`v2Accounts/${cards[0].studentId}`)).active,false);
  assert.equal(await store.get(`${base}/students/${cards[0].studentId}`),null);
  assert.deepEqual(await store.get('students/3-1-1'),{nickname:'운영 자료'});
});
test('잘못된 제출은 기록·점수 일부 저장 없이 롤백',async()=>{
  const {store,cards,artworkId,cmd}=await fixture(2),before=JSON.stringify([...store.docs]);
  await rejected(()=>cmd(student(cards[1]),'quiz.submit',{artworkId,answers:[999,'답변'],critique:'질문'}),'invalid-argument');
  assert.equal(JSON.stringify([...store.docs]),before);
  await rejected(()=>cmd(student(cards[1]),'points',{points:9999}),'invalid-argument');
});
