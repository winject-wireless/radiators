"use strict";
const el=id=>document.getElementById(id);
const palette={paper_bgcolor:"#101c30",plot_bgcolor:"#101c30",font:{color:"#dce9fa",size:11},margin:{l:52,r:12,t:14,b:45}};
const getJSON=async url=>{const r=await fetch(url);if(!r.ok)throw Error(url+": HTTP "+r.status);return r.json()};
let runs=[],active=null;
const status=s=>el("status").textContent=s;
const format=(n,d=2)=>Number.isFinite(n)?Number(n).toFixed(d):"—";
function plotCurve(id,freq,values,axis){
 return Plotly.react(id,[{x:freq.map(f=>f/1e9),y:values,mode:"lines",type:"scatter",line:{width:2,color:"#6ce0e1"}}],
 {...palette,xaxis:{title:"Frequency (GHz)",gridcolor:"#243a56"},yaxis:{title:axis,gridcolor:"#243a56"}},{responsive:true,displaylogo:false});
}
async function renderPattern(){
 try{
  const pattern=active.patterns[Number(el("freq").value)];
  const folder=el("run").value.replace(/result\.json$/,"");
  const p=await getJSON(folder+pattern.file);
  const th=p.theta_deg.map(v=>v*Math.PI/180),ph=p.phi_deg.map(v=>v*Math.PI/180);
  const x=[],y=[],z=[],col=[];
  for(let t=0;t<th.length;t++){
   const xx=[],yy=[],zz=[],cc=[];
   for(let k=0;k<=ph.length;k++){
    const j=k%ph.length,db=p.directivity_dbi[t][j],rad=Math.pow(10,(db-p.max_directivity_dbi)/10);
    xx.push(rad*Math.sin(th[t])*Math.cos(ph[j]));
    yy.push(rad*Math.sin(th[t])*Math.sin(ph[j]));
    zz.push(rad*Math.cos(th[t]));cc.push(db);
   }x.push(xx);y.push(yy);z.push(zz);col.push(cc);
  }
  await Plotly.react("farfield",[{type:"surface",x,y,z,surfacecolor:col,colorscale:"Viridis",
   colorbar:{title:"dBi"},hovertemplate:"Directivity %{surfacecolor:.2f} dBi<extra></extra>"}],
   {...palette,margin:{l:0,r:0,t:0,b:0},scene:{aspectmode:"data",xaxis:{title:"X"},yaxis:{title:"Y"},zaxis:{title:"Z"}}},
   {responsive:true,displaylogo:false});
  el("peak").textContent=format(p.max_directivity_dbi)+" dBi";
  el("eff").textContent=Number.isFinite(p.radiation_efficiency)?format(100*p.radiation_efficiency,1)+" %":"Unavailable";
  status("Completed · "+format(p.frequency_hz/1e9,3)+" GHz");
 }catch(err){status("Pattern error: "+err.message);console.error(err)}
}
async function renderRun(){
 try{
  status("Loading simulation…");active=await getJSON(el("run").value);
  el("mesh").textContent=active.mesh_total_cells.toLocaleString();
  el("config").textContent=JSON.stringify(active.input_config,null,2);
  const s=active.s11;
  await Promise.all([
   plotCurve("mag",s.frequency_hz,s.logmag_db,"S11 log magnitude (dB)"),
   plotCurve("phase",s.frequency_hz,s.phase_deg,"S11 phase (degrees)"),
   plotCurve("vswr",s.frequency_hz,s.vswr,"VSWR")]);
  el("freq").replaceChildren(...active.patterns.map((p,i)=>{
   const option=document.createElement("option");option.value=i;option.textContent=format(p.frequency_hz/1e9,3)+" GHz";return option;
  }));
  await renderPattern();
 }catch(err){status("Result error: "+err.message);console.error(err)}
}
(async()=>{
 try{
  if(!window.Plotly)throw Error("Plotly CDN not available");
  runs=(await getJSON("./manifest.json")).runs;
  if(!runs.length){status("No published simulations yet.");return}
  el("run").replaceChildren(...runs.map(r=>{
   const option=document.createElement("option");option.value=r.path;option.textContent=r.name;return option;
  }));
  el("run").addEventListener("change",renderRun);
  el("freq").addEventListener("change",renderPattern);
  await renderRun();
 }catch(err){status("Viewer error: "+err.message);console.error(err)}
})();
