(function(global){
  'use strict';
  var config, auth, firestore, functions, session=null, subscriptions=[], listener=null;
  var loginInProgress=false, generation=0;
  function fail(message){ throw new Error(message); }
  function current(){ if(!session) fail('먼저 로그인해 주세요.'); return session; }
  function classPath(){ return 'v2Classes/'+current().classId; }
  async function rpc(name, data){ return (await functions.httpsCallable(name)(data)).data; }
  function clear(){
    generation++;
    subscriptions.splice(0).forEach(function(stop){ stop(); });
    session=null;
    if(listener) listener(null);
  }
  async function load(user){
    clear();
    if(!user) return;
    var turn=generation;
    var snapshot=await firestore.doc('v2Accounts/'+user.uid).get();
    if(!snapshot.exists) fail('이 계정에는 수업 권한이 없습니다.');
    var a=snapshot.data();
    if(!a.active) fail('사용할 수 없는 계정입니다.');
    var cid;
    if(a.role==='student') cid=a.classId;
    else if(a.role==='teacher' && Array.isArray(a.classIds) && a.classIds.length) cid=a.classIds[0];
    else fail('이 계정에는 수업 권한이 없습니다.');
    if(turn!==generation) return;
    session={uid:user.uid,role:a.role,studentId:a.studentId||null,classId:cid,classIds:a.classIds||[cid]};
    if(listener) await listener(session,{restored:!loginInProgress});
    return session;
  }
  function queryFacade(q){
    return {
      orderBy:function(){ return queryFacade(q.orderBy.apply(q,arguments)); },
      limit:function(n){ return queryFacade(q.limit(n)); },
      onSnapshot:function(next,error){
        var turn=generation;
        var stop=q.onSnapshot(function(snap){ if(turn===generation) next(snap); },function(err){
          if(turn!==generation) return;
          if(error) error(err);
          if(err.code==='permission-denied') api.logout();
        });
        subscriptions.push(stop); return stop;
      }
    };
  }
  function reference(path){
    var parts=path.split('/'), collection=parts[0], docId=parts[1];
    if(parts.length!==2 || !/^[A-Za-z0-9_-]+$/.test(docId)) fail('잘못된 문서 경로입니다.');
    var native=firestore.doc(classPath()+'/'+path);
    return {
      get:function(){ return native.get(); },
      set:function(data){
        if(collection==='artworks') return api.command('artwork.save',Object.assign({},data,{id:docId}));
        if(collection==='reflections') return api.command('reflection.save',{text:data.text});
        fail('허용되지 않은 저장 작업입니다.');
      },
      update:function(data){
        if(collection==='artworks') return api.command('artwork.save',Object.assign({},data,{id:docId}));
        fail('허용되지 않은 수정 작업입니다.');
      },
      delete:function(){
        var actions={activities:'activity.delete',artworks:'artwork.delete',responses:'response.delete',reflections:'reflection.delete',students:'student.delete'};
        if(!actions[collection]) fail('허용되지 않은 삭제 작업입니다.');
        return api.command(actions[collection],{id:docId});
      }
    };
  }
  var api={
    initialize:async function(c,onSession,onError){
      config=c; listener=onSession;
      if(!c || !c.firebase || c.firebase.projectId==='jin-gallery') fail('기존 운영 프로젝트로는 실행할 수 없습니다. 새 테스트 프로젝트를 설정하세요.');
      if(c.emulator && !['localhost','127.0.0.1'].includes(location.hostname)) fail('에뮬레이터는 localhost에서만 실행할 수 있습니다.');
      if(!c.emulator && (!c.appCheckSiteKey || c.firebase.projectId.startsWith('demo-'))) fail('테스트 프로젝트와 App Check 설정이 필요합니다.');
      firebase.initializeApp(c.firebase);
      auth=firebase.auth(); firestore=firebase.firestore(); functions=firebase.app().functions(c.region);
      if(c.emulator){
        auth.useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
        firestore.useEmulator('127.0.0.1',8080);
        functions.useEmulator('127.0.0.1',5001);
      } else firebase.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(c.appCheckSiteKey),true);
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
      auth.onAuthStateChanged(async function(user){
        if(loginInProgress) return;
        try { await load(user); }
        catch(e){ clear(); await auth.signOut(); if(onError) onError(e); }
      });
    },
    session:function(){ return session; },
    loginStudent:async function(data){
      loginInProgress=true;
      try{
        clear(); await auth.signOut();
        var response=await rpc('studentLogin',data);
        var credential=await auth.signInWithCustomToken(response.token);
        await load(credential.user);
        return current();
      } catch(e){ clear(); await auth.signOut(); throw e; }
      finally { loginInProgress=false; }
    },
    loginTeacher:async function(email,password){
      loginInProgress=true;
      try{
        clear(); await auth.signOut();
        var credential=await auth.signInWithEmailAndPassword(email,password);
        await load(credential.user);
        if(current().role!=='teacher'){ await api.logout(); fail('교사 권한이 없는 계정입니다.'); }
        return current();
      } catch(e){ clear(); await auth.signOut(); throw e; }
      finally { loginInProgress=false; }
    },
    selectClass:async function(cid){
      var a=current();
      if(a.role!=='teacher' || !a.classIds.includes(cid)) fail('담당 수업이 아닙니다.');
      subscriptions.splice(0).forEach(function(stop){ stop(); }); generation++;
      session=Object.assign({},a,{classId:cid});
      if(listener) await listener(session);
    },
    logout:async function(){ clear(); if(auth) await auth.signOut(); },
    command:function(action,payload){ return rpc('galleryCommand',{classId:current().classId,action:action,payload:payload}); },
    issue:function(count){ return rpc('issueStudents',{classId:current().classId,count:count}); },
    reissue:function(sid){ return rpc('issueStudents',{classId:current().classId,studentId:sid}); },
    check:function(){ return rpc('checkCodes',{classId:current().classId}); },
    getOwnStudent:async function(){ return (await firestore.doc(classPath()+'/students/'+current().studentId).get()).data(); },
    quizKeys:async function(aid){ return (await firestore.doc(classPath()+'/quizKeys/'+aid).get()).data().quiz; },
    roster:function(callback){
      return queryFacade(firestore.collection(classPath()+'/roster')).onSnapshot(callback);
    },
    db:{
      doc:reference,
      collection:function(name){
        if(!['students','activities','artworks','responses','reflections'].includes(name)) fail('허용되지 않은 조회입니다.');
        var result=queryFacade(firestore.collection(classPath()+'/'+name));
        result.doc=function(docId){ return reference(name+'/'+docId); };
        result.add=function(data){ if(name!=='activities') fail('허용되지 않은 작업입니다.'); return api.command('activity.add',{name:data.name}); };
        return result;
      }
    }
  };
  global.GallerySecure=Object.freeze(api);
})(window);
