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
  // timeout 0 disables it: a finished result can be tens of megabytes of
  // inlined patterns over a slow link, and must not be cut off at 30 s.
  async request(path,method="GET",body,{timeout=30000}={}) {
    const response=await this.fetcher(this.url+path,{method,headers:{Authorization:"Bearer "+this.token,...(body?{"Content-Type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),cache:"no-store",credentials:"omit",redirect:"error",
      ...(timeout?{signal:AbortSignal.timeout(timeout)}:{})});
    // Check the status and the type first: a reverse proxy answers 502 with an
    // HTML page, which must be reported as HTTP 502, not as a JSON parse error.
    const type=response.headers.get("content-type")||"";
    const json=/^application\/(\w+\+)?json\b/i.test(type);
    if(!response.ok){
      let detail="";
      try{detail=json?String((await response.json())?.error??""):(await response.text()).replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim().slice(0,160);}catch{/* body unreadable */}
      throw Error("Runner HTTP "+response.status+(detail?": "+detail:""));
    }
    if(!json)throw Error("Runner returned "+(type||"no content type")+" instead of JSON (HTTP "+response.status+")");
    return response.json();
  }
  health(){return this.request("/v1/health");}
  jobs(){return this.request("/v1/jobs");}
  cancelJob(id){if(!/^[a-f0-9]{32}$/.test(id))throw Error("Invalid job ID");return this.request("/v1/jobs/"+id,"DELETE");}
  abort(){
    this.cancelled=true;
    if(this.id&&this.submitted&&!this.cancelRequest)this.cancelRequest=this.request("/v1/jobs/"+this.id,"DELETE").catch(e=>{this.cancelRequest=null;throw e;});
    return this.cancelRequest??Promise.resolve();
  }
  async run(config,{onStatus,requireCapacity=false}={}) {
    this.id=crypto.randomUUID().replaceAll("-","");
    const path="/v1/jobs/"+this.id;
    // Keep the ID on ambiguous network errors so the user can cancel on the host.
    try{
      await this.request("/v1/jobs","POST",{id:this.id,config,...(requireCapacity?{require_capacity:true}:{})});
      this.submitted=true;
    }catch(e){
      // The POST may have reached the server before its response was lost.
      try{await this.cancelJob(this.id);}catch{}
      throw Error("Remote submission failed ("+this.id+"): "+e.message);
    }
    // A native run can take hours. A phone changing network, or a sleeping tab,
    // must never cancel it: poll with backoff and keep the job on the host.
    // Only abort() (the Stop button) cancels, and the job ID stays available so
    // the client can reattach after the connection comes back.
    let failures=0;
    for(;;){
      if(this.cancelled)await this.abort();
      let state;
      try{state=await this.request(path);failures=0;}
      catch(e){
        if(this.cancelled){await this.abort();throw Error("Remote job cancelled");}
        const wait=Math.min(30000,1500*2**Math.min(failures++,4));
        onStatus?.({state:"unreachable",attempts:failures,retry_ms:wait,error:e.message,
          message:`Connection lost (${e.message}); retrying in ${Math.round(wait/1000)} s. The remote job keeps running — press Stop to cancel it.`});
        await new Promise(r=>setTimeout(r,wait));
        continue;
      }
      onStatus?.(state);
      if(state.state==="cancelled")throw Error(state.error||"Remote job cancelled");
      if(state.state==="failed")throw Error(state.error||"Remote solver failed");
      if(state.state==="done"){
        // Treat a failed download like any other connection loss: the job stays
        // done on the host, so the next poll returns done and retries it.
        try{return await this.request(path+"/result","GET",undefined,{timeout:0});}
        catch(e){
          if(this.cancelled)throw Error("Remote job cancelled");
          const wait=Math.min(30000,1500*2**Math.min(failures++,4));
          onStatus?.({state:"unreachable",attempts:failures,retry_ms:wait,error:e.message,
            message:`Result download failed (${e.message}); retrying in ${Math.round(wait/1000)} s.`});
          await new Promise(r=>setTimeout(r,wait));
          continue;
        }
      }
      await new Promise(r=>setTimeout(r,1000));
    }
  }
}
