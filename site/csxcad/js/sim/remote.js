// Remote runner API. Tokens are tab-session scoped by the UI; never stored in configs.
export function remoteEndpoint(value) {
  const u=new URL(value);
  if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error("Enter a runner HTTP(S) base URL without credentials, query or fragment.");
  return u.href.replace(/\/+$/,"");
}
const RESULT_TIMEOUT=600000, RESULT_ATTEMPTS=5;
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
      const error=Error("Runner HTTP "+response.status+(detail?": "+detail:""));error.status=response.status;throw error;
    }
    if(!json)throw Error("Runner returned "+(type||"no content type")+" instead of JSON (HTTP "+response.status+")");
    return response.json();
  }
  health(){return this.request("/v1/health");}
  jobs(){return this.request("/v1/jobs");}
  async submitBatch(id,pool,jobs){
    // Repeating the same IDs is safe if the HTTP response was lost.
    for(let attempt=0;;attempt++){
      try{return await this.request("/v1/batches","POST",{id,...(pool==null?{}:{pool}),jobs},{timeout:120000});}
      catch(e){if(e.status&&e.status<500)throw e;
        if(attempt>=2)throw Error("Submission unconfirmed; reconnect to recover any accepted jobs: "+e.message);
        await new Promise(r=>setTimeout(r,1000*2**attempt));}
    }
  }
  purgeJob(id){if(!/^[a-f0-9]{32}$/.test(id))throw Error("Invalid job ID");return this.request("/v1/jobs/"+id+"/result","DELETE");}
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
      // The POST may have reached the server. Never cancel an ambiguous submission.
      throw Error("Remote submission unconfirmed ("+this.id+"): "+e.message);
    }
    return this.attach(this.id,{onStatus});
  }
  async attach(id,{onStatus}={}){
    if(!/^[a-f0-9]{32}$/.test(id))throw Error("Invalid job ID");
    this.id=id;this.submitted=true;
    const path="/v1/jobs/"+id;
    let failures=0,downloads=0;
    for(;;){
      if(this.cancelled){
        try{await this.abort();}
        catch(e){
          if(e.status===404||e.status===403||e.status===401)throw e;
          onStatus?.({state:"unreachable",message:"Cancellation not confirmed; retrying.",error:e.message});
          await new Promise(r=>setTimeout(r,3000));continue;
        }
      }
      let state;
      try{state=await this.request(path);failures=0;}
      catch(e){
        if(e.status===404||e.status===403||e.status===401)throw e;
        const wait=Math.min(30000,1500*2**Math.min(failures++,4));
        onStatus?.({state:"unreachable",attempts:failures,retry_ms:wait,error:e.message,
          message:`Connection lost (${e.message}); retrying in ${Math.round(wait/1000)} s. The remote job keeps running — press Stop to cancel it.`});
        await new Promise(r=>setTimeout(r,wait));
        continue;
      }
      onStatus?.(state);
      if(state.state==="cancelled"){const e=Error(state.error||"Remote job cancelled");e.jobState="cancelled";throw e;}
      if(state.state==="failed")throw Error(state.error||"Remote solver failed");
      if(state.state==="done"){
        // A failed download is retried a bounded number of times with its own
        // backoff: a pruned or malformed result must end the run rather than
        // poll forever with the case stuck "running". RESULT_TIMEOUT is long
        // (inlined patterns are large) but never absent, or a half-open
        // connection would hang with no retry at all.
        try{return await this.request(path+"/result","GET",undefined,{timeout:RESULT_TIMEOUT});}
        catch(e){
          if(e.status===404||e.status===403||e.status===401)throw e;
          if(++downloads>=RESULT_ATTEMPTS)throw Error("Remote result download failed after "+downloads+" attempts ("+this.id+"): "+e.message);
          const wait=Math.min(30000,1500*2**Math.min(downloads-1,4));
          onStatus?.({state:"unreachable",attempts:downloads,retry_ms:wait,error:e.message,
            message:`Result download failed (${e.message}); retry ${downloads} of ${RESULT_ATTEMPTS-1} in ${Math.round(wait/1000)} s.`});
          await new Promise(r=>setTimeout(r,wait));
          continue;
        }
      }
      await new Promise(r=>setTimeout(r,1000));
    }
  }
}
