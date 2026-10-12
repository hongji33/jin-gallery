'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {initializeApp:adminApp}=require('firebase-admin/app');
const {getAuth:adminAuth}=require('firebase-admin/auth');
const {getFirestore:adminDb}=require('firebase-admin/firestore');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword,signInWithCustomToken}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const {getFirestore,connectFirestoreEmulator,doc,setDoc,getDoc}=require('firebase/firestore');
if(!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('이 테스트는 에뮬레이터에서만 실행합니다.');
const projectId='demo-jin-gallery';adminApp({projectId});
function client(name){
  const app=initializeApp({projectId,apiKey:'demo-key',authDomain:`${projectId}.firebaseapp.com`},name);
  const auth=getAuth(app),functions=getFunctions(app,'asia-northeast3'),db=getFirestore(app);
  connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectFunctionsEmulator(functions,'127.0.0.1',5001);connectFirestoreEmulator(db,'127.0.0.1',8080);
  return {app,auth,db,call:async(name,data)=>(await httpsCallable(functions,name)(data)).data};
}
test('실제 Auth·Functions·Firestore 에뮬레이터 통합: 발급, 로그인, 권한, 서버 점수, 재발급',async()=>{
  const uid='integration-teacher',email='integration@example.test',password=randomBytes(16).toString('base64url'),cid='2026-3-1';
  try {await adminAuth().deleteUser(uid);} catch(e){if(e.code!=='auth/user-not-found')throw e;}
  await adminAuth().createUser({uid,email,password});
  await adminDb().doc(`v2Accounts/${uid}`).set({role:'teacher',active:true,classIds:[cid]});
  const t=client('teacher'),a=client('student-a'),b=client('student-b');
  try{
    await signInWithEmailAndPassword(t.auth,email,password);
    const {cards}=await t.call('issueStudents',{classId:cid,count:2});assert.equal(new Set(cards.map(c=>c.code)).size,2);
    const activity=await t.call('galleryCommand',{classId:cid,action:'activity.add',payload:{name:'통합 테스트'}});
    for(const [i,c] of [a,b].entries()){
      const card=cards[i],data={schoolYear:'2026',grade:3,classNum:1,code:card.code};
      await assert.rejects(()=>c.call('studentLogin',data));
      const result=await c.call('studentLogin',{...data,password:card.password});await signInWithCustomToken(c.auth,result.token);
      await c.call('galleryCommand',{classId:cid,action:'profile',payload:{nickname:`학생${i}`,activityId:activity.id}});
      await assert.rejects(()=>setDoc(doc(c.db,`v2Classes/${cid}/students/${card.studentId}`),{points:9999}));
      await assert.rejects(()=>getDoc(doc(c.db,`v2Classes/${cid}/credentials/${card.studentId}`)));
      await assert.rejects(()=>c.call('issueStudents',{classId:cid,count:1}));
    }
    const artworkId=`${cards[0].studentId}__${activity.id}`;
    await a.call('galleryCommand',{classId:cid,action:'artwork.save',payload:{id:artworkId,activityId:activity.id,title:'민화',imageData:'data:image/jpeg;base64,/9j/AA==',quiz:[{type:'mc',text:'색?',choices:['빨강','파랑'],correctIndex:1},{type:'text',text:'느낌?'}]}});
    await assert.rejects(()=>b.call('galleryCommand',{classId:cid,action:'artwork.delete',payload:{id:artworkId}}));
    const result=await b.call('galleryCommand',{classId:cid,action:'quiz.submit',payload:{artworkId,answers:[1,'멋진 그림입니다.'],critique:'어떤 생각으로 그렸나요?',score:9999}});
    const s=(await getDoc(doc(b.db,`v2Classes/${cid}/students/${cards[1].studentId}`))).data();assert.equal(s.points,result.viewerPoints);
    const art=(await getDoc(doc(b.db,`v2Classes/${cid}/artworks/${artworkId}`))).data();assert.equal(art.quiz[0].correctIndex,undefined);
    await assert.rejects(()=>getDoc(doc(b.db,`v2Classes/${cid}/quizKeys/${artworkId}`)));
    await t.call('issueStudents',{classId:cid,studentId:cards[1].studentId});
    await assert.rejects(()=>getDoc(doc(b.db,`v2Classes/${cid}/students/${cards[1].studentId}`)));
    await assert.rejects(()=>b.call('galleryCommand',{classId:cid,action:'reflection.save',payload:{text:'구 토큰'}}));
  } finally {await Promise.all([t,a,b].map(c=>deleteApp(c.app)));}
});
