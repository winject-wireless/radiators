// Solver diagnostics: bounded waveform previews, full-probe statistics and
// exact final mesh spacing. All values use the solver's original units.
export function meshStatistics(lines) {
  return lines.map((axis,k)=>{
    let min=Infinity,max=0,at=null;
    for(let i=1;i<axis.length;i++){
      const d=axis[i]-axis[i-1];
      if(d<min){min=d;at=[axis[i-1],axis[i]];}
      max=Math.max(max,d);
    }
    return {axis:"xyz"[k],intervals:axis.length-1,min_mm:Number.isFinite(min)?min:null,max_mm:max,min_at_mm:at};
  });
}

export function probeDiagnostics(probe, limit=4000) {
  const {t,v}=probe;
  let peak=0, sum=0, count=0, invalid=0;
  for(let i=0;i<v.length;i++){
    if(!Number.isFinite(t[i])||!Number.isFinite(v[i])){invalid++;continue;}
    peak=Math.max(peak,Math.abs(v[i]));sum+=v[i]*v[i];count++;
  }
  // Preserve extrema in each bucket in time order, rather than aliasing RF peaks.
  const stride=Math.max(1,Math.ceil(v.length/Math.max(1,Math.floor(limit/2))));
  const indices=[];
  for(let a=0;a<v.length;a+=stride){
    let lo=-1,hi=-1;
    for(let i=a;i<Math.min(a+stride,v.length);i++){
      if(!Number.isFinite(t[i])||!Number.isFinite(v[i]))continue;
      if(lo<0||v[i]<v[lo])lo=i;
      if(hi<0||v[i]>v[hi])hi=i;
    }
    if(lo>=0){indices.push(Math.min(lo,hi));if(lo!==hi)indices.push(Math.max(lo,hi));}
  }
  return {samples:v.length,invalid_samples:invalid,peak_abs:count?peak:null,rms:count?Math.sqrt(sum/count):null,
    start_s:Number.isFinite(t[0])?t[0]:null,stop_s:Number.isFinite(t[t.length-1])?t[t.length-1]:null,
    sample_interval_s:t.length>1&&Number.isFinite(t[1]-t[0])?t[1]-t[0]:null,
    preview_decimated:stride>1,time_s:indices.map(i=>t[i]),value:indices.map(i=>v[i])};
}

export function updateSolverDiagnostics(d,line) {
  let m;
  if((m=/FDTD timestep is:\s*([\d.eE+-]+)\s*s/.exec(line)))d.timestep_s=Number(m[1]);
  if((m=/Excitation signal length is:\s*(\d+)\s*timesteps/.exec(line)))d.excitation_timesteps=Number(m[1]);
  if((m=/Max\. number of timesteps:\s*(\d+)/.exec(line)))d.max_timesteps=Number(m[1]);
  if((m=/Timestep:\s*(\d+)/.exec(line)))d.executed_timesteps=Number(m[1]);
  if((m=/end-criteria.*?reached after\s*(\d+)\s*timesteps\s*\(([-\d.]+)dB\)/i.exec(line))){
    d.executed_timesteps=Number(m[1]);d.final_energy_db=Number(m[2]);d.termination="converged";
  }
  if((m=/simulation aborted after\s*(\d+)\s*timesteps\s*\(([-\d.]+)dB\)/i.exec(line))){
    d.executed_timesteps=Number(m[1]);d.final_energy_db=Number(m[2]);d.termination="aborted";
  }
  if((m=/Time for\s*(\d+)\s*iterations/i.exec(line))){
    d.executed_timesteps=Number(m[1]);d.termination??=d.executed_timesteps>=d.max_timesteps?"max_timesteps":"unknown";
  }
}

export function diagnosticWarnings(s,v,i) {
  const warnings=[];
  if(s.excitation_timesteps&&s.executed_timesteps<s.excitation_timesteps)warnings.push("Run ended before excitation finished; S11 and far-field are not reliable.");
  else if(s.termination==="max_timesteps")warnings.push("Maximum timesteps reached without confirmed energy convergence.");
  else if(s.termination==="aborted")warnings.push("Run aborted before confirmed convergence.");
  if(s.excitation_timesteps&&s.max_timesteps<3*s.excitation_timesteps)warnings.push("Maximum timesteps is below three times the excitation length.");
  for(const [name,p] of [["Voltage",v],["Current",i]]){
    if(p.samples<2||p.invalid_samples)warnings.push(name+" probe has missing or invalid samples.");
    else if(p.peak_abs===0)warnings.push(name+" probe is identically zero. Check feed contact and probe discretization.");
  }
  return warnings;
}
