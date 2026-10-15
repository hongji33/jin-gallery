'use strict';
// 실제 Firebase SDK·Auth·Functions·Firestore를 사용하는 화면 검증. 운영 자격증명은 사용하지 않습니다.
const {chromium}=require('playwright');
const {initializeApp}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getFirestore}=require('firebase-admin/firestore');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
if(!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('에뮬레이터에서만 실행할 수 있습니다.');
initializeApp({projectId:'demo-jin-gallery'});
(async()=>{
  const uid='browser-firebase-teacher',email='browser-firebase@example.test',password=crypto.randomBytes(16).toString('base64url'),cid='2026-3-3';
  await getAuth().createUser({uid,email,password});
  await getFirestore().doc('v2Accounts/'+uid).set({role:'teacher',classIds:[cid],active:true});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
  // 네트워크 없이 설치된 동일 버전 Firebase 브라우저 SDK를 로드합니다. 인증·DB·서버는 실제 에뮬레이터입니다.
  await context.route('https://www.gstatic.com/firebasejs/**',route=>{
    const file=new URL(route.request().url()).pathname.split('/').at(-1);
    route.fulfill({body:fs.readFileSync(path.join('node_modules/firebase',file)),contentType:'text/javascript'});
  });
  await context.route('https://fonts.googleapis.com/**',route=>route.fulfill({body:'',contentType:'text/css'}));
  await context.route('https://fonts.gstatic.com/**',route=>route.abort());
  await context.route('https://cdnjs.cloudflare.com/**',route=>route.fulfill({body:'',contentType:'text/javascript'}));
  await page.addInitScript(()=>{window.print=()=>{};});
  const origin='http://127.0.0.1:5000';
  try{
    await page.goto(origin);await page.click('#siteQrClose');
    await page.click('[data-tab="dash"]');await page.fill('#teacherEmail',email);await page.fill('#teacherPassword',password);await page.click('#pinSubmit');
    await page.waitForSelector('[data-view="dash"].active');
    await page.fill('#issueCount','2');await page.click('#issueNumbers');await page.waitForSelector('#distributionCards .badge-print-item');
    const text=await page.locator('#distributionCards .badge-print-item').allTextContents();
    assert.equal(text.length,2);
    const cards=text.map(t=>({code:/개인번호 (\d{4})/.exec(t)[1],password:/접속 비밀번호 ([A-Z2-9]{8})/.exec(t)[1]}));
    await page.click('#checkNumbers');await page.waitForFunction(()=>document.querySelector('#numberHint').textContent.includes('중복 없음'));
    await page.click('#clearCredentials');await page.fill('#inActivityName','Firebase 민화');await page.click('#btnAddActivity');await page.waitForFunction(()=>document.querySelector('#activityList').textContent.includes('Firebase 민화'));
    await page.click('#teacherLogout');
    async function login(card,nickname){
      await page.waitForSelector('[data-view="setup"].active');await page.selectOption('#inGrade','3');await page.selectOption('#inClass','3');
      await page.fill('#inNumber',card.code);await page.fill('#studentPassword',card.password);await page.click('#btnEnterClass');await page.waitForSelector('#setupStage2:visible');
      await page.waitForFunction(()=>document.querySelector('#inActivity').value.length>0);
      await page.fill('#inNickname',nickname);await page.click('#btnSaveProfile');await page.waitForSelector('[data-view="gallery"].active');
    }
    await login(cards[0],'청자소년');
    await page.click('[data-tab="register"]');await page.fill('#inTitle','Firebase 작품');await page.fill('#inQ0','어떤 느낌인가요?');await page.fill('#inQ1','어떤 이야기가 떠오르나요?');
    const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=10;c.height=10;c.getContext('2d').fillRect(0,0,10,10);return c.toDataURL('image/png').split(',')[1];});
    await page.setInputFiles('#inImage',{name:'art.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.waitForSelector('#imgPreview img');await page.click('#btnSubmitArt');
    await page.waitForFunction(()=>document.querySelector('[data-view="register"]').textContent.includes('Firebase 작품') && document.querySelector('#inTitle').value==='');
    const docs=await getFirestore().collection(`v2Classes/${cid}/artworks`).get();assert.equal(docs.size,1);const aid=docs.docs[0].id;
    await page.click('#btnLogout');await login(cards[1],'민화소녀');
    // Firebase SESSION 인증이 같은 탭의 QR 접속에서 복원되고 작품이 열려야 합니다.
    await page.goto(`${origin}/?view=artwork&id=${aid}`);await page.waitForSelector('#qa_0');
    await page.fill('#qa_0','따뜻하고 편안한 그림입니다.');await page.fill('#qa_1','친구와 즐겁게 보내는 시간이 떠오릅니다.');await page.fill('#qaQuestion','어떤 생각으로 이 색을 선택했나요?');await page.click('#btnSubmitQuiz');
    await page.waitForFunction(()=>document.querySelector('#artworkDetail').textContent.includes('이미 참여했어요'));
    await page.click('[data-tab="pledge"]');await page.fill('#inPledge','작품을 더 자세히 감상하겠습니다.');await page.click('#btnSavePledge');await page.waitForFunction(()=>document.querySelector('#pledgeGrid').textContent.includes('작품을 더 자세히'));
    await page.click('[data-tab="hof"]');await page.waitForSelector('#hofGrid .art-card');
    const before=await page.evaluate(()=>({session:GallerySecure.session(),text:document.querySelector('#idChip').textContent}));assert.equal(before.session.role,'student');
    await page.click('#btnLogout');await page.waitForFunction(()=>firebase.auth().currentUser===null);
    await page.click('[data-tab="dash"]');await page.fill('#teacherEmail',email);await page.fill('#teacherPassword',password);await page.click('#pinSubmit');await page.waitForSelector('[data-view="dash"].active');
    const oldSid=before.session.studentId;
    await page.locator(`[data-reissue="${oldSid}"]`).click();await page.waitForSelector('#distributionCards .badge-print-item');
    const nextText=await page.locator('#distributionCards .badge-print-item').textContent(),nextCode=/개인번호 (\d{4})/.exec(nextText)[1];assert.notEqual(nextCode,cards[1].code);
    const saved=await getFirestore().doc(`v2Classes/${cid}/students/${oldSid}`).get();assert.ok(saved.data().points>0);
    assert.equal((await getFirestore().doc(`v2Classes/${cid}/artworks/${aid}`).get()).exists,true);
    assert.equal((await getFirestore().doc(`v2Classes/${cid}/reflections/${oldSid}`).get()).exists,true);
    await page.click('#clearCredentials');await page.click('#teacherLogout');await page.fill('#inNumber',cards[1].code);await page.fill('#studentPassword',cards[1].password);await page.click('#btnEnterClass');await page.waitForFunction(()=>document.querySelector('#stage1Hint').textContent.includes('확인해 주세요'));
    assert.equal(await page.evaluate(()=>firebase.auth().currentUser),null);assert.deepEqual(errors,[]);
    console.log('PASS 실제 Firebase 화면: 교사 인증·발급·학생 인증·작품·QR 세션 복원·채점·다짐·명예의 전당·로그아웃·재발급 및 구 로그인 차단');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
