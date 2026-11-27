// Remote runner API. Tokens are session-memory only; never stored in configs.
export function remoteEndpoint(value, pageProtocol=globalThis.location?.protocol) {
  const u=new URL(value);
  if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error("Enter a runner HTTP(S) base URL without credentials, query or fragment.");
  if(u.protocol==="http:"&&!["localhost","127.0.0.1","[::1]"].includes(u.hostname))throw Error("Use HTTPS for a remote host; HTTP is allowed only for localhost.");
  return u.href.replace(/\/+$/,"");
}
export class RemoteRunner {
  // Window.fetch must keep its global receiver, not the RemoteRunner instance.
  constructor(url,token,fetcher=(...args)=>globalThis.fetch(...args)) {
    this.url=remoteEndpoint(url);this.token=String(token??"").trim();this.fetcher=fetcher;
    if(!this.token)throw Error("Enter runner token");
    this.id=null;this.cancelled=false;this.cancelRequest=null;this.submitted=false;
  }
  async request(path,method="GET",body) {
    const response=await this.fetcher(this.url+path,{method,headers:{Authorization:"Bearer "+this.token,...(body?{"Content-Type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),cache:"no-store",credentials:"omit",redirect:"error",signal:AbortSignal.timeout(30000)});
    const data=await response.json();
    if(!response.ok)throw Error(data.error||("Runner HTTP "+response.status));
    return data;
  }
  health(){return this.request("/v1/health");}
  jobs(){return this.request("/v1/jobs");}
  cancelJob(id){if(!/^[a-f0-9]{32}$/.test(id))throw Error("Invalid job ID");return this.request("/v1/jobs/"+id,"DELETE");}
  abort(){
    this.cancelled=true;
    if(this.id&&this.submitted&&!this.cancelRequest)this.cancelRequest=this.request("/v1/jobs/"+this.id,"DELETE").catch(e=>{this.cancelRequest=null;throw e;});
    return this.cancelRequest??Promise.resolve();
  }
  async run(config,{onStatus}={}) {
    this.id=crypto.randomUUID().replaceAll("-","");
    const path="/v1/jobs/"+this.id;
    // Keep the ID on ambiguous network errors so the user can cancel on the host.
    try{
      await this.request("/v1/jobs","POST",{id:this.id,config});
      this.submitted=true;
    }catch(e){
      // The POST may have reached the server before its response was lost.
      try{await this.cancelJob(this.id);}catch{}
      throw Error("Remote submission failed ("+this.id+"): "+e.message);
    }
    let failures=0;
    for(;;){
      if(this.cancelled)await this.abort();
      let state;
      try{state=await this.request(path);failures=0;}
      catch(e){if(++failures>=5){try{await this.cancelJob(this.id);}catch{}throw Error("Lost remote job "+this.id+": "+e.message);}await new Promise(r=>setTimeout(r,1500));continue;}
      onStatus?.(state);
      if(state.state==="cancelled")throw Error(state.error||"Remote job cancelled");
      if(state.state==="failed")throw Error(state.error||"Remote solver failed");
      if(state.state==="done")return await this.request(path+"/result");
      await new Promise(r=>setTimeout(r,1000));
    }
  }
}
