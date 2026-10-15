'use strict';
const {test,before,after}=require('node:test');
const fs=require('node:fs');
const {initializeTestEnvironment,assertFails,assertSucceeds}=require('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc,collection,getDocs}=require('firebase/firestore');
let env;
const cid='2026-3-1',other='2026-3-2',base=`v2Classes/${cid}`;
before(async()=>{
  env=await initializeTestEnvironment({projectId:'demo-jin-gallery',firestore:{host:'127.0.0.1',port:8080,rules:fs.readFileSync('firestore.rules','utf8')}});
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.firestore();
    const seed={
      'v2Accounts/student-a':{role:'student',classId:cid,studentId:'student-a',authVersion:1,active:true},
      'v2Accounts/student-b':{role:'student',classId:other,studentId:'student-b',authVersion:1,active:true},
      'v2Accounts/teacher':{role:'teacher',classIds:[cid],active:true},
      'v2Accounts/disabled':{role:'student',classId:cid,studentId:'disabled',authVersion:1,active:false},
      [base]:{grade:3,classNum:1},
      [`${base}/students/student-a`]:{nickname:'가',points:0},
      [`${base}/artworks/art`]:{authorId:'student-a'},
      [`${base}/responses/r`]:{viewerId:'student-a',answers:['반 안 공유']},
      [`${base}/reflections/student-a`]:{text:'다짐'},
      [`${base}/activities/a`]:{name:'민화'},
      [`${base}/roster/student-a`]:{code:'0047'},
      [`${base}/credentials/student-a`]:{hash:'비밀 해시'},
      [`${base}/codes/0047`]:{studentId:'student-a'},
      [`${base}/quizKeys/art`]:{quiz:[{correctIndex:1}]},
      'students/3-1-1':{nickname:'이전 자료'}
    };
    await Promise.all(Object.entries(seed).map(([p,d])=>setDoc(doc(db,p),d)));
  });
});
after(async()=>{if(env) await env.cleanup();});
test('비로그인·타 반·비활성 계정·구 인증 버전 읽기 거부',async()=>{
  for(const ctx of [env.unauthenticatedContext(),env.authenticatedContext('student-b',{authVersion:1}),env.authenticatedContext('disabled',{authVersion:1}),env.authenticatedContext('student-a',{authVersion:0})])
    await assertFails(getDoc(doc(ctx.firestore(),`${base}/students/student-a`)));
});
test('학생의 반 안 전시 데이터 조회는 허용, 모든 직접 쓰기는 거부',async()=>{
  const db=env.authenticatedContext('student-a',{authVersion:1}).firestore();
  for(const name of ['students','artworks','responses','reflections','activities']){
    await assertSucceeds(getDocs(collection(db,`${base}/${name}`)));
    await assertFails(setDoc(doc(db,`${base}/${name}/forged`),{points:99999}));
  }
});
test('학생은 다른 계정·명부·비밀번호·번호 인덱스를 읽거나 교사 권한을 만들 수 없음',async()=>{
  const db=env.authenticatedContext('student-a',{authVersion:1,role:'teacher'}).firestore();
  await assertSucceeds(getDoc(doc(db,'v2Accounts/student-a')));
  for(const path of ['v2Accounts/teacher',`${base}/roster/student-a`,`${base}/credentials/student-a`,`${base}/codes/0047`,'students/3-1-1']) await assertFails(getDoc(doc(db,path)));
  await assertFails(setDoc(doc(db,'v2Accounts/student-a'),{role:'teacher',active:true,classIds:[cid]}));
});
test('교사 담당 반 명부 조회 허용, 인증 비밀 조회·학생 직접 점수 수정·타 반 조회 거부',async()=>{
  const db=env.authenticatedContext('teacher').firestore();
  await assertSucceeds(getDocs(collection(db,`${base}/roster`)));
  await assertFails(getDoc(doc(db,`${base}/credentials/student-a`)));
  await assertFails(setDoc(doc(db,`${base}/students/student-a`),{points:99999}));
  await assertFails(getDoc(doc(db,`v2Classes/${other}`)));
});
test('정답 키는 작품 소유자와 교사만 개별 조회 가능',async()=>{
  await assertSucceeds(getDoc(doc(env.authenticatedContext('student-a',{authVersion:1}).firestore(),`${base}/quizKeys/art`)));
  await assertSucceeds(getDoc(doc(env.authenticatedContext('teacher').firestore(),`${base}/quizKeys/art`)));
  await assertFails(getDocs(collection(env.authenticatedContext('student-a',{authVersion:1}).firestore(),`${base}/quizKeys`)));
});
