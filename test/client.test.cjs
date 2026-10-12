'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('public/index.html','utf8');
test('학생 입력은 4자리 문자열이며 출석번호·PIN·로컬 프로필·익명 인증을 사용하지 않음',()=>{
  assert.match(html,/<input type="text" id="inNumber"[^>]*maxlength="4"/);
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(script,/signInAnonymously|TEACHER_PIN|jpmp_teacher_ok|myProfile\.number|settings\/app|firebaseConfig\s*=/);
  assert.doesNotMatch(script,/localStorage\.setItem|localStorage\.getItem|FieldValue\.increment/);
  new vm.Script(script);new vm.Script(fs.readFileSync('public/secure-client.js','utf8'));
});
test('학생 기능 화면 및 기존 디자인 토큰 유지, 배부 카드 인쇄 영역 표시 규칙',()=>{
  for(const view of ['setup','register','gallery','artwork','hof','pledge','dash','questions']) assert.ok(html.includes(`data-view="${view}"`));
  for(const token of ['--wall:#FFF8FC','--frame:#F6C9E3','--font-display:', '--radius-l:24px']) assert.ok(html.includes(token));
  assert.match(html,/#credentialPrintArea \*\{visibility:visible;\}/);
  const staticHtml=html.slice(0,html.indexOf('<script>'));
  const ids=[...staticHtml.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size,'중복 HTML ID가 없어야 함');
});
test('기본 프로젝트는 demo 전용, 서버만 데이터 변경, 전체 미정의 경로 접근 거부',()=>{
  const config=fs.readFileSync('public/config.js','utf8');assert.match(config,/emulator: true/);assert.match(config,/projectId:"demo-jin-gallery"/);
  const runtime=fs.readFileSync('public/secure-client.js','utf8');
  assert.match(runtime,/c\.firebase\.projectId==='jin-gallery'/);
  assert.match(runtime,/Auth\.Persistence\.SESSION/);
  const rules=fs.readFileSync('firestore.rules','utf8');
  assert.doesNotMatch(rules,/allow write: if (?!false)/);
  assert.match(rules,/request\.auth\.token\.authVersion == account\(\)\.authVersion/);
});
