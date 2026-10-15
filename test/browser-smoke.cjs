'use strict';
// 실제 화면 + 실제 서버 업무 로직을 로컬 메모리 저장소로 검증합니다.
// Firebase Security Rules/SDK 통합 검증은 rules/integration 테스트와 별도입니다.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const core=require('../functions/core.cjs');
const {MemoryStore}=require('./memory-store.cjs');
const store=new MemoryStore({'v2Accounts/browser-teacher':{role:'teacher',classIds:['2026-3-1','2026-3-2'],active:true}});
const sessions=new Map(),teacherPassword=crypto.randomBytes(12).toString('base64url');
const mock=fs.readFileSync('test/browser-service.js','utf8');
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==='/__lab'){
      const chunks=[];for await(const c of req)chunks.push(c);
      const {method,args,token}=JSON.parse(Buffer.concat(chunks));
      let a=sessions.get(token),result;
      function mint(account){const token=crypto.randomBytes(16).toString('hex');sessions.set(token,account);return {token,session:account.session};}
      if(method==='teacher'){
        assert.equal(args.email,'teacher@example.test');assert.equal(args.password,teacherPassword);
        result=mint({uid:'browser-teacher',token:{},session:{uid:'browser-teacher',role:'teacher',classIds:['2026-3-1','2026-3-2'],classId:'2026-3-1'}});
      }else if(method==='student'){
        const r=await core.studentLogin(store,args,'browser-test');
        result=mint({uid:r.uid,token:r.claims,session:{uid:r.uid,studentId:r.uid,role:'student',classId:r.classId,classIds:[r.classId]}});
      }else if(method==='command')result=await core.command(store,a,{classId:args.classId,action:args.action,payload:args.payload});
      else if(method==='issue')result=await core.issueStudents(store,a,args,{randomIndex:()=>0});
      else if(method==='check')result=await core.checkCodes(store,a,args.classId);
      else if(method==='read'){
        const cid=args.classId;
        await store.transaction(tx=>core.actor(tx,a,cid,args.name==='roster'));
        const base=`v2Classes/${cid}/${args.name}`;
        if(args.id){
          if(args.name==='quizKeys'){
            const art=await store.get(`v2Classes/${cid}/artworks/${args.id}`);
            if(a.session.role!=='teacher' && art.authorId!==a.uid)throw new Error('permission-denied');
          }
          result=await store.get(`${base}/${args.id}`);
        }else result=await store.transaction(tx=>tx.list(base));
      }else throw new Error('unknown-test-method');
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({result}));
    }else{
      const url=new URL(req.url,'http://localhost');
      const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(!['index.html','config.js','secure-client.js'].includes(file)){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');
      res.end(fs.readFileSync(path.join('public',file)));
    }
  }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:e.code||'test-error',message:e.message}}));}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('https://**/*',route=>route.fulfill({status:200,body:'',contentType:'text/javascript'}));
  await context.route('**/secure-client.js',route=>route.fulfill({body:mock,contentType:'text/javascript'}));
  page.on('dialog',dialog=>dialog.accept());
  await page.addInitScript(()=>{window.print=()=>{window.__printCount=(window.__printCount||0)+1;};});
  try{
    await page.goto(url);await page.click('#siteQrClose');
    assert.equal(await page.locator('#inNumber').getAttribute('maxlength'),'4');
    await page.click('[data-tab="dash"]');await page.fill('#teacherEmail','teacher@example.test');await page.fill('#teacherPassword',teacherPassword);await page.click('#pinSubmit');
    await page.waitForSelector('[data-view="dash"].active');
    await page.fill('#issueCount','2');await page.click('#issueNumbers');
    await page.waitForSelector('#distributionCards .badge-print-item');
    assert.equal(await page.locator('#distributionCards .badge-print-item').count(),2);
    const texts=await page.locator('#distributionCards .badge-print-item').allTextContents();
    const cards=texts.map(t=>({code:/개인번호 (\d{4})/.exec(t)[1],password:/접속 비밀번호 ([A-Z2-9]{8})/.exec(t)[1]}));
    assert.deepEqual(cards.map(x=>x.code),['0000','0001']);
    await page.click('#checkNumbers');await page.waitForFunction(()=>document.querySelector('#numberHint').textContent.includes('중복 없음'));
    await page.click('#printCredentials');await page.waitForFunction(()=>window.__printCount===1);
    await page.emulateMedia({media:'print'});
    assert.equal(await page.locator('#credentialPrintContent .bp-nick').first().evaluate(el=>getComputedStyle(el).visibility),'visible');
    await page.emulateMedia({media:'screen'});
    await page.click('#clearCredentials');assert.equal(await page.locator('#credentialPrintContent').textContent(),'');
    await page.fill('#inActivityName','민화');await page.click('#btnAddActivity');await page.waitForFunction(()=>document.querySelector('#activityList').textContent.includes('민화'));
    await page.click('#btnPreQrPrint');await page.waitForFunction(()=>window.__printCount===2);
    await page.click('#teacherLogout');await page.waitForSelector('[data-view="setup"].active');
    await page.selectOption('#inGrade','3');await page.selectOption('#inClass','1');
    await page.fill('#inNumber',cards[0].code);await page.fill('#studentPassword',cards[0].password);await page.click('#btnEnterClass');await page.waitForSelector('#setupStage2:visible');
    await page.fill('#inNickname','청자소년');await page.click('#btnSaveProfile');await page.waitForSelector('[data-view="gallery"].active');
    assert.ok(!(await page.locator('#idChip').textContent()).includes('undefined'));
    await page.click('[data-tab="register"]');await page.fill('#inTitle','나의 민화');
    await page.fill('#inQ0','어떤 느낌인가요?');await page.fill('#inQ1','무슨 이야기가 떠오르나요?');
    // 브라우저에서 실제 이미지 축소·JPEG 변환 경로를 사용합니다.
    const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=10;c.height=10;const ctx=c.getContext('2d');ctx.fillStyle='pink';ctx.fillRect(0,0,10,10);return c.toDataURL('image/png').split(',')[1];});
    await page.setInputFiles('#inImage',{name:'art.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.waitForSelector('#imgPreview img');await page.click('#btnSubmitArt');await page.waitForFunction(()=>document.querySelector('[data-view="register"]').textContent.includes('나의 민화') && document.querySelector('#inTitle').value==='');
    await page.click('[data-tab="pledge"]');await page.fill('#inPledge','색을 더 다양하게 사용하겠습니다.');await page.click('#btnSavePledge');await page.waitForFunction(()=>document.querySelector('#pledgeGrid').textContent.includes('색을 더 다양하게'));
    await page.click('#btnLogout');await page.waitForSelector('[data-view="setup"].active');
    await page.fill('#inNumber',cards[1].code);await page.fill('#studentPassword',cards[1].password);await page.click('#btnEnterClass');await page.waitForSelector('#setupStage2:visible');
    await page.fill('#inNickname','민화소녀');await page.click('#btnSaveProfile');await page.waitForSelector('[data-view="gallery"].active');
    // 갤러리의 학생 열람 제한을 유지하므로 작품 QR 딥링크로 입장합니다.
    const artworkEntry=[...store.docs].find(([k])=>k.includes('/artworks/'));
    const artworkId=artworkEntry[0].split('/').at(-1);
    await page.goto(`${url}/?view=artwork&id=${artworkId}`);
    if(await page.locator('#siteQrClose').isVisible()) await page.click('#siteQrClose');
    // 테스트 서비스 세션은 메모리로만 유지하므로 재로그인 후 딥링크를 이어갑니다.
    await page.fill('#inNumber',cards[1].code);await page.fill('#studentPassword',cards[1].password);await page.click('#btnEnterClass');await page.waitForSelector('#setupStage2:visible');await page.click('#btnSaveProfile');
    await page.waitForSelector('#qa_0');await page.fill('#qa_0','따뜻하고 편안한 느낌이 듭니다.');await page.fill('#qa_1','친구와 함께하는 즐거운 이야기가 떠오릅니다.');await page.fill('#qaQuestion','이 색을 선택한 이유가 궁금합니다.');await page.click('#btnSubmitQuiz');
    await page.waitForFunction(()=>document.querySelector('#artworkDetail').textContent.includes('이미 참여했어요'));
    await page.click('[data-tab="hof"]');await page.waitForSelector('#hofGrid .art-card');
    await page.setViewportSize({width:390,height:844});
    await page.click('[data-tab="setup"]');
    fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/student-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS 브라우저: 교사 로그인·4자리 발급·중복 검사·인쇄·학생 로그인·작품 이미지·퀴즈·점수·다짐·명예의 전당·모바일 화면');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
