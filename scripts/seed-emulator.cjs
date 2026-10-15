'use strict';
// 에뮬레이터만 사용합니다. 실행마다 임시 교사 비밀번호를 새로 생성합니다.
process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';
const {initializeApp}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getFirestore}=require('firebase-admin/firestore');
const {randomBytes}=require('node:crypto');
initializeApp({projectId:'demo-jin-gallery'});
(async()=> {
  const auth=getAuth(),db=getFirestore(),uid='emulator-teacher',email='teacher@example.test',password=randomBytes(12).toString('base64url');
  try { await auth.updateUser(uid,{email,password}); }
  catch(e) { if(e.code!=='auth/user-not-found') throw e; await auth.createUser({uid,email,password}); }
  const classIds=Array.from({length:3},(_,g)=>Array.from({length:20},(_,c)=>`2026-${g+1}-${c+1}`)).flat();
  await db.doc(`v2Accounts/${uid}`).set({role:'teacher',classIds,active:true});
  console.log('로컬 테스트 교사 이메일:',email);
  console.log('이번 실행의 임시 교사 비밀번호:',password);
  console.log('이 자격증명은 에뮬레이터 전용입니다. 공개 저장소에 저장하지 마세요.');
})().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});
