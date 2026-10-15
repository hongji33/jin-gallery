'use strict';
class MemoryStore {
  constructor(seed={}) { this.docs=new Map(Object.entries(structuredClone(seed))); this.queue=Promise.resolve(); }
  async get(path) { return structuredClone(this.docs.get(path)||null); }
  transaction(fn) {
    const job=this.queue.then(async()=> {
      const snapshot=new Map(structuredClone([...this.docs]));
      const writes=[];
      const tx={
        get:async path=>structuredClone(snapshot.get(path)||null),
        list:async path=> [...snapshot].filter(([key])=>key.startsWith(path+'/') && key.slice(path.length+1).indexOf('/')<0).map(([key,d])=>({...structuredClone(d),id:key.slice(path.length+1)})),
        set:(path,data)=>writes.push(['set',path,structuredClone(data)]),
        delete:path=>writes.push(['delete',path])
      };
      const result=await fn(tx);
      for(const [op,path,data] of writes) { if(op==='set') snapshot.set(path,data); else snapshot.delete(path); }
      this.docs=snapshot; return result;
    });
    this.queue=job.catch(()=>{}); return job;
  }
}
module.exports={MemoryStore};
