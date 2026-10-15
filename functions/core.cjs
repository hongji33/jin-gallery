'use strict';
const crypto = require('node:crypto');
const {promisify} = require('node:util');
const scrypt = promisify(crypto.scrypt);
const BEST_BONUS = 5;
class GalleryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new GalleryError(code, message); }
function text(value, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('invalid-argument', '입력 내용을 확인해 주세요.');
  return value.trim();
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) fail('invalid-argument', '잘못된 식별자입니다.');
  return value;
}
function classroom(year, grade, classNum) {
  if (!/^20\d{2}$/.test(String(year)) || !Number.isInteger(grade) || grade < 1 || grade > 3 || !Number.isInteger(classNum) || classNum < 1 || classNum > 20) fail('invalid-argument', '학년·반을 확인해 주세요.');
  return `${year}-${grade}-${classNum}`;
}
function classParts(cid) {
  const m = /^(20\d{2})-([1-3])-([1-9]|1\d|20)$/.exec(cid || '');
  if (!m) fail('invalid-argument', '수업을 확인해 주세요.');
  return {schoolYear:m[1], grade:Number(m[2]), classNum:Number(m[3])};
}
function password() {
  // 혼동 문자를 제외한 32개 문자, 8자리 = 40비트. 번호와 독립적으로 생성합니다.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:8}, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}
async function hashPassword(value, salt = crypto.randomBytes(16).toString('hex')) {
  return {salt, hash:(await scrypt(value, salt, 32)).toString('hex')};
}
async function verifyPassword(value, credential) {
  const salt = credential?.salt || '00000000000000000000000000000000';
  const actual = await scrypt(value, salt, 32);
  const expected = Buffer.from(credential?.hash || '0'.repeat(64), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}
async function actor(tx, auth, cid, teacherOnly = false) {
  if (!auth?.uid) fail('unauthenticated', '먼저 로그인해 주세요.');
  const a = await tx.get(`v2Accounts/${id(auth.uid)}`);
  if (!a?.active) fail('permission-denied', '사용할 수 없는 계정입니다.');
  if (a.role === 'teacher' && Array.isArray(a.classIds) && a.classIds.includes(cid)) return {...a, uid:auth.uid};
  if (!teacherOnly && a.role === 'student' && a.classId === cid && a.authVersion === auth.token?.authVersion) return {...a, uid:auth.uid};
  fail('permission-denied', '이 수업에 접근할 권한이 없습니다.');
}
function root(cid) { classParts(cid); return `v2Classes/${cid}`; }
function owns(a, ownerId) {
  if (a.role !== 'teacher' && a.studentId !== ownerId) fail('permission-denied', '본인 기록만 수정할 수 있습니다.');
}
async function need(tx, path) {
  const d = await tx.get(path);
  if (!d) fail('not-found', '기록을 찾을 수 없습니다.');
  return d;
}
function quizInput(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) fail('invalid-argument', '퀴즈 2개를 입력해 주세요.');
  return raw.map(q => {
    const out = {type:q.type, text:text(q.text, 500)};
    if (q.type === 'mc') {
      if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 4 || !Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.choices.length) fail('invalid-argument', '객관식 보기를 확인해 주세요.');
      return {...out, choices:q.choices.map(x=>text(x, 200)), correctIndex:q.correctIndex};
    }
    if (q.type !== 'text') fail('invalid-argument', '퀴즈 유형을 확인해 주세요.');
    return out;
  });
}
function publishedQuiz(quiz) { return quiz.map(({correctIndex, ...q})=>q); }
function answerScore(t) { return t.length >= 40 ? 3 : t.length >= 20 ? 2 : t.length >= 8 ? 1 : 0; }
function responsePoints(r, art) {
  return {viewer:5 + r.score + Object.keys(r.likes || {}).length + (art.bestResponseId === r.id ? BEST_BONUS : 0), author:2 + Math.ceil(r.score / 3)};
}
function addDelta(deltas, sid, field, n) {
  const d = deltas.get(sid) || {points:0, authorPoints:0}; d[field] += n; deltas.set(sid, d);
}
async function applyDeltas(tx, base, deltas) {
  for (const [sid, delta] of deltas) {
    const p = await need(tx, `${base}/students/${sid}`);
    const points = p.points + delta.points, authorPoints = p.authorPoints + delta.authorPoints;
    if (points < 0 || authorPoints < 0) fail('failed-precondition', '점수 무결성 검사를 통과하지 못했습니다.');
    tx.set(`${base}/students/${sid}`, {...p, points, authorPoints});
  }
}
function audit(tx, base, uid, action, detail, now) {
  tx.set(`${base}/audit/${crypto.randomUUID()}`, {uid, action, ...detail, createdAt:now});
}
async function issueStudents(store, auth, input, options = {}) {
  const {classId:cid, count, studentId} = input;
  const base = root(cid), parts = classParts(cid), now = options.now || new Date().toISOString();
  const reissue = !!studentId;
  if (!reissue && (!Number.isInteger(count) || count < 1 || count > 40)) fail('invalid-argument', '한 번에 1~40명을 발급해 주세요.');
  if (reissue) id(studentId);
  const n = reissue ? 1 : count;
  // 권한 없는 요청이 대량 해시 연산을 유발하지 못하게 먼저 검사하고, 쓰기 트랜잭션에서도 재검사합니다.
  await store.transaction(tx=>actor(tx,auth,cid,true));
  // 트랜잭션 재시도에도 비밀번호 해시 연산을 반복하지 않습니다.
  const secrets = await Promise.all(Array.from({length:n}, async()=> { const p=password(); return {password:p, ...await hashPassword(p)}; }));
  return store.transaction(async tx => {
    const a = await actor(tx, auth, cid, true);
    const existingClass = await tx.get(base);
    const roster = await tx.list(`${base}/roster`), codes = await tx.list(`${base}/codes`);
    if (!reissue && roster.filter(x=>x.active).length + count > 40) fail('failed-precondition', '반별 발급 인원은 최대 40명입니다.');
    const used = new Set(codes.map(x=>x.id));
    if (10000 - used.size < n) fail('resource-exhausted', '사용 가능한 개인번호가 부족합니다.');
    const available = Array.from({length:10000}, (_,i)=>String(i).padStart(4,'0')).filter(x=>!used.has(x));
    const old = reissue ? await need(tx, `${base}/roster/${studentId}`) : null;
    if (old && !old.active) fail('failed-precondition', '삭제된 학생입니다.');
    const previousAccount = old ? await need(tx, `v2Accounts/${studentId}`) : null;
    const cards = [];
    for (let i=0; i<n; i++) {
      const at = options.randomIndex ? options.randomIndex(available.length) : crypto.randomInt(available.length);
      const code = available.splice(at,1)[0], sid = reissue ? studentId : crypto.randomUUID();
      const version = reissue ? previousAccount.authVersion+1 : 1;
      if (old) tx.set(`${base}/codes/${old.code}`, {studentId:sid, retired:true});
      tx.set(`${base}/codes/${code}`, {studentId:sid, retired:false});
      tx.set(`${base}/roster/${sid}`, {studentId:sid, code, active:true, issuedAt:now});
      tx.set(`${base}/credentials/${sid}`, {salt:secrets[i].salt, hash:secrets[i].hash});
      tx.set(`v2Accounts/${sid}`, {role:'student', classId:cid, studentId:sid, authVersion:version, active:true});
      if (!reissue) tx.set(`${base}/students/${sid}`, {...parts, nickname:'', points:0, authorPoints:0, createdAt:now});
      cards.push({studentId:sid, code, password:secrets[i].password});
    }
    if (!existingClass) tx.set(base, {...parts, createdAt:now});
    audit(tx,base,a.uid,reissue?'reissue':'issue',{count:n, studentIds:cards.map(x=>x.studentId)},now);
    return {cards};
  });
}
async function checkCodes(store, auth, cid) {
  const base=root(cid);
  return store.transaction(async tx=> {
    await actor(tx, auth, cid, true);
    const rows=(await tx.list(`${base}/roster`)).filter(x=>x.active), seen=new Set(), problems=[];
    for (const r of rows) {
      if (!/^\d{4}$/.test(r.code) || seen.has(r.code)) problems.push(r.studentId);
      seen.add(r.code);
      const c=await tx.get(`${base}/codes/${r.code}`);
      if (!c || c.retired || c.studentId!==r.studentId) problems.push(r.studentId);
    }
    return {count:rows.length, valid:problems.length===0, problems:[...new Set(problems)]};
  });
}
async function studentLogin(store, input, clientKey, now = Date.now()) {
  const cid=classroom(input.schoolYear,input.grade,input.classNum), base=root(cid);
  if (!/^\d{4}$/.test(input.code || '') || typeof input.password !== 'string' || input.password.length>64 || input.password.length<1) fail('unauthenticated','번호와 접속 비밀번호를 확인해 주세요.');
  const keys=[`ip-${cid}-${crypto.createHash('sha256').update(clientKey).digest('hex')}`,`code-${cid}-${input.code}`];
  const accepted=await store.transaction(async tx=> {
    const buckets=await Promise.all(keys.map(k=>tx.get(`v2LoginLimits/${k}`)));
    // 학교 공용 네트워크에서 한 반 40명이 함께 로그인할 수 있도록 IP 제한은 반별 적용합니다.
    if (buckets.some((b,i)=>b && now-b.start<900000 && b.count >= (i===0?120:10))) return false;
    buckets.forEach((b,i)=>tx.set(`v2LoginLimits/${keys[i]}`, {start:b && now-b.start<900000?b.start:now, count:b && now-b.start<900000?b.count+1:1}));
    return true;
  });
  if (!accepted) fail('resource-exhausted','로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.');
  const code=await store.get(`${base}/codes/${input.code}`);
  const sid=code?.studentId;
  const credential=sid && !code.retired ? await store.get(`${base}/credentials/${sid}`) : null;
  const ok=await verifyPassword(input.password,credential);
  const account=sid ? await store.get(`v2Accounts/${sid}`) : null;
  if (!ok || code?.retired || !account?.active || account.classId!==cid || account.role!=='student') fail('unauthenticated','번호와 접속 비밀번호를 확인해 주세요.');
  // 비밀번호 검증 도중 재발급된 경우 구 비밀번호로 새 세션을 만들지 못하게 합니다.
  return store.transaction(async tx=> {
    const latestCode=await tx.get(`${base}/codes/${input.code}`);
    const latestCredential=await tx.get(`${base}/credentials/${sid}`);
    const latestAccount=await tx.get(`v2Accounts/${sid}`);
    if(!latestCode || latestCode.retired || latestCode.studentId!==sid || !latestAccount?.active || latestAccount.authVersion!==account.authVersion || latestCredential?.hash!==credential.hash) fail('unauthenticated','번호와 접속 비밀번호를 확인해 주세요.');
    return {uid:sid, claims:{authVersion:account.authVersion}, classId:cid};
  });
}
async function command(store, auth, input, now = new Date().toISOString()) {
  const {classId:cid, action, payload:p={}}=input, base=root(cid);
  return store.transaction(async tx=> {
    const a=await actor(tx,auth,cid), deltas=new Map();
    const self=a.studentId;
    let result={ok:true};
    switch(action) {
      case 'profile': {
        if (a.role!=='student') fail('permission-denied','학생 로그인으로 이용해 주세요.');
        const s=await need(tx,`${base}/students/${self}`);
        const act=await need(tx,`${base}/activities/${id(p.activityId)}`);
        const nickname=text(p.nickname,12);
        tx.set(`${base}/students/${self}`,{...s,nickname,activityId:p.activityId,activityName:act.name});
        result={profile:{id:self,grade:s.grade,classNum:s.classNum,nickname,activityId:p.activityId,activityName:act.name}};
        break;
      }
      case 'activity.add': {
        if(a.role!=='teacher') fail('permission-denied','교사 전용 기능입니다.');
        const aid=crypto.randomUUID(); tx.set(`${base}/activities/${aid}`,{name:text(p.name,40),createdAt:now}); result={id:aid}; break;
      }
      case 'activity.delete': {
        if(a.role!=='teacher') fail('permission-denied','교사 전용 기능입니다.');
        const aid=id(p.id);
        const art=await tx.list(`${base}/artworks`);
        if(art.some(x=>x.activityId===aid)) fail('failed-precondition','작품이 있는 활동은 삭제할 수 없습니다.');
        tx.delete(`${base}/activities/${aid}`); break;
      }
      case 'artwork.save': {
        const aid=id(p.id), previous=await tx.get(`${base}/artworks/${aid}`);
        if(previous) owns(a,previous.authorId);
        else if(a.role!=='student') fail('permission-denied','학생 로그인으로 등록해 주세요.');
        const owner=previous?.authorId || self, student=await need(tx,`${base}/students/${owner}`);
        const activityId=previous?.activityId || id(p.activityId);
        const activity=await need(tx,`${base}/activities/${activityId}`);
        if(aid!==`${owner}__${activityId}`) fail('invalid-argument','작품 식별자가 일치하지 않습니다.');
        if(!student.nickname) fail('failed-precondition','닉네임을 먼저 등록해 주세요.');
        const quiz=quizInput(p.quiz);
        const image=p.imageData===undefined?previous?.imageData:p.imageData;
        if(typeof image!=='string' || image.length>700000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)) fail('invalid-argument','작품 이미지를 확인해 주세요.');
        const responses=await tx.list(`${base}/responses`);
        if(previous && responses.some(r=>r.artworkId===aid)) {
          const keys=await need(tx,`${base}/quizKeys/${aid}`);
          if(JSON.stringify(quiz)!==JSON.stringify(keys.quiz)) fail('failed-precondition','답변이 제출된 퀴즈는 변경할 수 없습니다.');
        }
        const {grade,classNum,schoolYear}=classParts(cid);
        tx.set(`${base}/artworks/${aid}`,{authorId:owner,authorNickname:student.nickname,grade,classNum,schoolYear,activityId,activityName:activity.name,title:text(p.title,120),medium:text(p.medium||'',100,false),desc:text(p.desc||'',2000,false),quiz:publishedQuiz(quiz),imageData:image,createdAt:previous?.createdAt||now,bestResponseId:previous?.bestResponseId||null});
        tx.set(`${base}/quizKeys/${aid}`,{quiz}); break;
      }
      case 'quiz.submit': {
        if(a.role!=='student') fail('permission-denied','학생 로그인으로 이용해 주세요.');
        const aid=id(p.artworkId), art=await need(tx,`${base}/artworks/${aid}`);
        if(art.authorId===self) fail('permission-denied','본인 작품에는 응답할 수 없습니다.');
        const rid=`${aid}__${self}`;
        if(await tx.get(`${base}/responses/${rid}`)) fail('already-exists','이미 참여한 작품입니다.');
        const keys=await need(tx,`${base}/quizKeys/${aid}`), student=await need(tx,`${base}/students/${self}`);
        if(!student.nickname) fail('failed-precondition','닉네임을 먼저 등록해 주세요.');
        if(!Array.isArray(p.answers) || p.answers.length!==keys.quiz.length) fail('invalid-argument','퀴즈에 모두 답해 주세요.');
        let score=0;
        const answers=keys.quiz.map((q,i)=> {
          if(q.type==='mc') {
            const choice=p.answers[i];
            if(!Number.isInteger(choice) || choice<0 || choice>=q.choices.length) fail('invalid-argument','보기를 선택해 주세요.');
            if(choice===q.correctIndex) score+=2;
            return q.choices[choice];
          }
          const answer=text(p.answers[i],2000); score+=answerScore(answer); return answer;
        });
        const critique=text(p.critique,80); if(critique.length>=10) score++;
        tx.set(`${base}/responses/${rid}`,{artworkId:aid,viewerId:self,viewerNickname:student.nickname,authorId:art.authorId,answers,critique,score,likes:{},createdAt:now});
        addDelta(deltas,self,'points',5+score); addDelta(deltas,art.authorId,'authorPoints',2+Math.ceil(score/3));
        result={score,viewerPoints:5+score}; break;
      }
      case 'like': {
        if(a.role!=='student') fail('permission-denied','학생 로그인으로 이용해 주세요.');
        const rid=id(p.responseId), r=await need(tx,`${base}/responses/${rid}`);
        if(r.viewerId===self) fail('permission-denied','본인 글에는 좋아요를 누를 수 없습니다.');
        if(typeof p.liked!=='boolean') fail('invalid-argument','좋아요 상태를 확인해 주세요.');
        const likes={...r.likes}, had=!!likes[self];
        if(had!==p.liked) {
          if(p.liked) likes[self]=true; else delete likes[self];
          tx.set(`${base}/responses/${rid}`,{...r,likes}); addDelta(deltas,r.viewerId,'points',p.liked?1:-1);
        }
        break;
      }
      case 'best': {
        const aid=id(p.artworkId), art=await need(tx,`${base}/artworks/${aid}`); owns(a,art.authorId);
        const next=p.responseId===null?null:id(p.responseId);
        const r=next ? await need(tx,`${base}/responses/${next}`) : null;
        if(r && r.artworkId!==aid) fail('invalid-argument','다른 작품의 답변입니다.');
        if(art.bestResponseId!==next) {
          if(art.bestResponseId) { const old=await need(tx,`${base}/responses/${art.bestResponseId}`); addDelta(deltas,old.viewerId,'points',-BEST_BONUS); }
          if(r) addDelta(deltas,r.viewerId,'points',BEST_BONUS);
          tx.set(`${base}/artworks/${aid}`,{...art,bestResponseId:next});
        }
        break;
      }
      case 'reflection.save': {
        if(a.role!=='student') fail('permission-denied','학생 로그인으로 이용해 주세요.');
        const s=await need(tx,`${base}/students/${self}`);
        if(!s.nickname) fail('failed-precondition','닉네임을 먼저 등록해 주세요.');
        tx.set(`${base}/reflections/${self}`,{studentId:self,nickname:s.nickname,grade:s.grade,classNum:s.classNum,text:text(p.text,2000),createdAt:now}); break;
      }
      case 'reflection.delete': {
        const sid=id(p.id); owns(a,sid); tx.delete(`${base}/reflections/${sid}`); break;
      }
      case 'response.delete': {
        const rid=id(p.id), r=await need(tx,`${base}/responses/${rid}`); owns(a,r.viewerId);
        const art=await need(tx,`${base}/artworks/${r.artworkId}`), award=responsePoints({...r,id:rid},art);
        addDelta(deltas,r.viewerId,'points',-award.viewer); addDelta(deltas,r.authorId,'authorPoints',-award.author);
        tx.delete(`${base}/responses/${rid}`);
        if(art.bestResponseId===rid) tx.set(`${base}/artworks/${r.artworkId}`,{...art,bestResponseId:null});
        break;
      }
      case 'artwork.delete':
      case 'student.delete': {
        const sid=action==='student.delete'?id(p.id):null;
        if(sid && a.role!=='teacher') fail('permission-denied','교사 전용 기능입니다.');
        const allArt=await tx.list(`${base}/artworks`);
        const artMap=new Map(allArt.map(x=>[x.id,x]));
        const target= sid ? allArt.filter(x=>x.authorId===sid) : [await need(tx,`${base}/artworks/${id(p.id)}`).then(x=>({...x,id:p.id}))];
        if(!sid) owns(a,target[0].authorId);
        const targetIds=new Set(target.map(x=>x.id));
        const responses=(await tx.list(`${base}/responses`)).filter(r=>targetIds.has(r.artworkId) || (sid && r.viewerId===sid));
        // 거대 연쇄 삭제를 부분 실행하지 않습니다. 수업 크기 초과 시 별도 관리 작업이 필요합니다.
        if(responses.length+target.length*2>380) fail('resource-exhausted','한 번에 삭제할 기록이 너무 많습니다. 작품별로 삭제해 주세요.');
        for(const r of responses) {
          const art=artMap.get(r.artworkId);
          if(!art) fail('failed-precondition','연결된 작품이 없습니다.');
          const award=responsePoints(r,art);
          addDelta(deltas,r.viewerId,'points',-award.viewer); addDelta(deltas,r.authorId,'authorPoints',-award.author);
          tx.delete(`${base}/responses/${r.id}`);
          if(art.bestResponseId===r.id && !targetIds.has(art.id)) tx.set(`${base}/artworks/${art.id}`,{...stripId(art),bestResponseId:null});
        }
        for(const art of target) { tx.delete(`${base}/artworks/${art.id}`); tx.delete(`${base}/quizKeys/${art.id}`); }
        if(sid) {
          const roster=await need(tx,`${base}/roster/${sid}`), account=await need(tx,`v2Accounts/${sid}`);
          tx.set(`${base}/roster/${sid}`,{...roster,active:false});
          tx.set(`${base}/codes/${roster.code}`,{studentId:sid,retired:true});
          tx.set(`v2Accounts/${sid}`,{...account,active:false,authVersion:account.authVersion+1});
          tx.delete(`${base}/credentials/${sid}`); tx.delete(`${base}/reflections/${sid}`);
          // 점수 정합성 검사를 마친 뒤 학생 문서를 삭제합니다.
          await applyDeltas(tx,base,deltas); deltas.clear(); tx.delete(`${base}/students/${sid}`);
        }
        break;
      }
      default: fail('invalid-argument','지원하지 않는 작업입니다.');
    }
    await applyDeltas(tx,base,deltas);
    if(a.role==='teacher') audit(tx,base,a.uid,action,{},now);
    return result;
  });
}
function stripId({id,...data}) { return data; }
module.exports={GalleryError,classroom,classParts,hashPassword,verifyPassword,issueStudents,checkCodes,studentLogin,command,actor};
