'use strict';
const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const {getAuth} = require('firebase-admin/auth');
const {onCall,HttpsError} = require('firebase-functions/v2/https');
const core = require('./core.cjs');
initializeApp();
const firestore=getFirestore();
const emulator=process.env.FUNCTIONS_EMULATOR==='true';
const options={region:'asia-northeast3',enforceAppCheck:!emulator,maxInstances:10,timeoutSeconds:60,memory:'512MiB'};
const store={
  async get(path) { const d=await firestore.doc(path).get(); return d.exists?d.data():null; },
  transaction(fn) {
    return firestore.runTransaction(async native=> {
      const writes=[];
      const tx={
        async get(path) { const d=await native.get(firestore.doc(path)); return d.exists?d.data():null; },
        async list(path) { const q=await native.get(firestore.collection(path)); return q.docs.map(d=>({...d.data(),id:d.id})); },
        set(path,data) { writes.push(['set',path,data]); },
        delete(path) { writes.push(['delete',path]); }
      };
      const result=await fn(tx);
      if(writes.length>450) throw new core.GalleryError('resource-exhausted','처리할 기록이 너무 많습니다.');
      // 서버에서도 모든 조회를 마친 뒤 쓰기를 적용합니다. 오류 시 전체 롤백됩니다.
      for(const [op,path,data] of writes) { const ref=firestore.doc(path); if(op==='set') native.set(ref,data); else native.delete(ref); }
      return result;
    });
  }
};
function call(fn) {
  return onCall(options,async request=> {
    try { return await fn(request); }
    catch(e) {
      if(e instanceof core.GalleryError) throw new HttpsError(e.code,e.message);
      // 비밀번호, 토큰, 요청 본문을 로그에 남기지 않습니다.
      console.error('gallery-operation-failed',e.code || e.name);
      throw new HttpsError('internal','처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    }
  });
}
exports.studentLogin=call(async req=> {
  const result=await core.studentLogin(store,req.data,req.rawRequest.ip || 'unknown');
  return {token:await getAuth().createCustomToken(result.uid,result.claims),classId:result.classId};
});
exports.issueStudents=call(req=>core.issueStudents(store,req.auth,req.data));
exports.checkCodes=call(req=>core.checkCodes(store,req.auth,req.data.classId));
exports.galleryCommand=call(req=>core.command(store,req.auth,req.data));
