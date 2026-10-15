(function(){
  'use strict';
  var session=null,token=null,listener=null,subscriptions=[];
  async function call(method,args){
    var r=await fetch('/__lab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:method,args:args,token:token})});
    var data=await r.json();if(data.error)throw new Error(data.error.message);return data.result;
  }
  function stop(){subscriptions.splice(0).forEach(function(s){s.stop();});}
  async function login(method,args){stop();var r=await call(method,args);session=r.session;token=r.token;await listener(session);return session;}
  function snapshot(rows){return {docs:rows.map(function(r){return {id:r.id,data:function(){var copy=Object.assign({},r);delete copy.id;return copy;}};})};}
  async function poll(){await Promise.all(subscriptions.map(function(s){return s.poll();}));}
  function collection(name){
    var q={orderBy:function(){return q;},limit:function(){return q;},onSnapshot:function(cb){
      var active=true,last=null,s={stop:function(){active=false;},poll:async function(){
        var rows=await call('read',{classId:session.classId,name:name});
        var json=JSON.stringify(rows);if(active && json!==last){last=json;cb(snapshot(rows));}
      }};
      subscriptions.push(s);s.poll();return s.stop;
    },doc:function(sid){return reference(name+'/'+sid);},add:function(data){return api.command('activity.add',data);}};
    return q;
  }
  function reference(p){
    var parts=p.split('/');
    return {get:async function(){var d=await call('read',{classId:session.classId,name:parts[0],id:parts[1]});return {exists:!!d,data:function(){return d;}};},
      set:function(data){return api.command(parts[0]==='artworks'?'artwork.save':'reflection.save',Object.assign({},data,{id:parts[1]}));},
      update:function(data){return api.command('artwork.save',Object.assign({},data,{id:parts[1]}));},
      delete:function(){var map={activities:'activity.delete',artworks:'artwork.delete',reflections:'reflection.delete'};return api.command(map[parts[0]],{id:parts[1]});}};
  }
  var api={
    initialize:async function(c,cb){listener=cb;await cb(null);},session:function(){return session;},
    loginTeacher:function(email,password){return login('teacher',{email:email,password:password});},loginStudent:function(data){return login('student',data);},
    selectClass:async function(cid){stop();session=Object.assign({},session,{classId:cid});await listener(session);},
    logout:async function(){stop();session=null;token=null;await listener(null);},
    command:async function(action,payload){var result=await call('command',{classId:session.classId,action:action,payload:payload});await poll();return result;},
    issue:async function(count){var result=await call('issue',{classId:session.classId,count:count});await poll();return result;},
    reissue:async function(sid){var result=await call('issue',{classId:session.classId,studentId:sid});await poll();return result;},
    check:function(){return call('check',{classId:session.classId});},
    getOwnStudent:function(){return call('read',{classId:session.classId,name:'students',id:session.studentId});},
    quizKeys:async function(aid){return (await call('read',{classId:session.classId,name:'quizKeys',id:aid})).quiz;},
    roster:function(cb){return collection('roster').onSnapshot(cb);},db:{doc:reference,collection:collection}
  };
  window.GallerySecure=api;
})();
