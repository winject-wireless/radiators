#!/usr/bin/env python3
"""Schema v2 JSON antenna simulation with native CSXCAD geometry and ports."""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import numpy as np

from v2_geometry import add_local_mesh, install_geometry, positive, vec3


def require(cond, message):
    if not cond:
        raise ValueError(message)


def finite(x):
    v=float(x)
    return v if math.isfinite(v) else None


def finite_values(values):
    return [finite(x) for x in np.asarray(values).ravel()]


def frequencies(sweeps, f0, fc):
    points=set()
    require(bool(sweeps), "At least one S11 sweep is required")
    for sweep in sweeps:
        a=float(sweep["start"])
        b=float(sweep["end"])
        step=positive(sweep["step"],"s11.step")
        require(a>0 and b>=a, "S11 start/end invalid")
        n=int(math.floor((b-a)/step+1e-8))+1
        require(n<=20001, "Single sweep exceeds 20001 points")
        for idx in range(n):
            points.add(round(a+idx*step,4))
        if not math.isclose(a+(n-1)*step,b,abs_tol=0.001):
            points.add(round(b,4))
    result=np.asarray(sorted(points))
    require(len(result)<=30000,"Too many S11 frequency points")
    require(result[0]>=f0-fc and result[-1]<=f0+fc,"S11 frequencies outside excitation band")
    return result


def add_material(csx, m):
    name=m["name"]
    kind=m["type"]
    if kind=="pec":
        return csx.AddMetal(name)
    if kind=="dielectric":
        eps=positive(m["epsilon"],"dielectric.epsilon")
        require(eps>=1,"relative permittivity must be >= 1")
        kappa=float(m.get("kappa_s_per_m",0))
        require(math.isfinite(kappa) and kappa>=0,"dielectric conductivity invalid")
        return csx.AddMaterial(name,epsilon=eps,kappa=kappa)
    if kind=="conductive":
        # Bulk finite-conductivity material; mesh must resolve its skin depth.
        kappa=positive(m["conductivity_s_per_m"],"conductive conductivity")
        return csx.AddMaterial(name,epsilon=1.0,kappa=kappa)
    if kind=="conducting_sheet":
        conductivity=positive(m["conductivity_s_per_m"],"sheet conductivity")
        thickness=positive(m["thickness_m"],"sheet thickness in meters")
        return csx.AddConductingSheet(name,conductivity=conductivity,thickness=thickness)
    raise ValueError(f"Unsupported material type {kind!r}")


def add_port(fdtd, props, material_defs, s):
    pid=int(s.get("id",s.get("port_number",1)))
    require(pid>=1,"Port ID must be >= 1")
    kind=s["type"]
    a=vec3(s["start"],"port.start").tolist()
    b=vec3(s["stop"],"port.stop").tolist()
    drive=1.0 if s.get("excite",False) else 0.0
    priority=int(s.get("priority",5))
    if kind in ("lumped","lumped_port"):
        direction=s.get("direction",s.get("excitation_direction"))
        require(direction in ("x","y","z"),"Lumped port requires direction=x/y/z")
        r=positive(s.get("impedance_ohm",50),"port impedance")
        return fdtd.AddLumpedPort(pid,r,a,b,direction,drive,priority=priority)
    if kind=="msl":
        name=s["metal_material"]
        require(material_defs[name]["type"]=="pec","MSLPort metal_material must be PEC")
        propagation=s["propagation_direction"]
        direction=s["excitation_direction"]
        require(propagation in "xyz" and direction in "xyz" and propagation!=direction,
                "MSL port propagation/excitation axes invalid")
        return fdtd.AddMSLPort(pid,props[name],a,b,propagation,direction,drive,priority=priority)
    if kind=="coaxial":
        name=s["metal_material"]
        require(material_defs[name]["type"]=="pec","CoaxialPort metal_material must be PEC")
        dielectric=s.get("dielectric_material")
        if dielectric:
            require(material_defs[dielectric]["type"]=="dielectric","Coax dielectric must be a dielectric material")
        ri=positive(s["inner_radius"],"coax.inner_radius")
        ro=positive(s["outer_inner_radius"],"coax.outer_inner_radius")
        ros=positive(s["outer_radius"],"coax.outer_radius")
        require(ri<ro<ros,"Coax radii must satisfy inner < outer_inner < outer")
        direction=s["propagation_direction"]
        require(direction in "xyz","Coax propagation direction must be x/y/z")
        return fdtd.AddCoaxialPort(pid,props[name],props.get(dielectric),a,b,direction,
                                   ri,ro,ros,drive,priority=priority)
    raise ValueError(f"Unsupported port type {kind!r}")


def setup_mesh(mesh, cfg, geometry_bounds, source_bounds, geometry_previews, port_definitions, domain_start, domain_stop):
    mesh_cfg=cfg["mesh"]
    resolution=positive(mesh_cfg.get("resolution_mm",mesh_cfg.get("max_cell_mm",5)),"mesh max_cell_mm")
    growth=float(mesh_cfg.get("growth_ratio",1.4))
    require(1.01<=growth<=2,"mesh.growth_ratio must be 1.01..2")
    if mesh_cfg.get("grid_mode", "feature") == "uniform":
        # A rectilinear grid aligned to constant spacing avoids near-coincident
        # geometry extrema turning the Courant timestep into femtoseconds.
        # Use this mode for long arrays of rods and curved thin-wire feeds.
        step=positive(mesh_cfg.get("uniform_step_mm",resolution),"mesh.uniform_step_mm")
        counts=[]
        for i,axis in enumerate("xyz"):
            n=max(1,int(math.ceil(float(domain_stop[i]-domain_start[i])/step)))
            require(n<=2500, f"Uniform grid {axis}: too many intervals ({n})")
            mesh.AddLine(axis,np.linspace(domain_start[i],domain_stop[i],n+1).tolist())
            counts.append(n)
        cells=math.prod(counts)
        require(cells<=int(mesh_cfg.get("max_cells",5000000)),
                f"Uniform mesh exceeds cell budget: {cells}")
        return counts,cells
    require(mesh_cfg.get("grid_mode","feature") == "feature",
            "mesh.grid_mode must be 'feature' or 'uniform'")
    for i,axis in enumerate("xyz"):
        mesh.AddLine(axis,[float(domain_start[i]),float(domain_stop[i])])
    for lo,hi in geometry_bounds+source_bounds:
        for i,axis in enumerate("xyz"):
            # Surface positions and bounds are required to keep narrow gaps from
            # being lost when the global mesh is smoothed.
            for value in (lo[i],hi[i]):
                if domain_start[i]<value<domain_stop[i]:
                    mesh.AddLine(axis,float(value))

    # Insert exact cylinder/port end planes, not only their inflated
    # bounding boxes. Otherwise a thin ground disk may disappear into the mesh.
    def add_point_planes(point):
        for i,axis in enumerate("xyz"):
            value=float(point[i])
            if domain_start[i]<value<domain_stop[i]:
                mesh.AddLine(axis,value)
    for preview in geometry_previews:
        if "start" in preview:
            add_point_planes(preview["start"])
            add_point_planes(preview["stop"])
        elif "center" in preview:
            add_point_planes(preview["center"])
        elif "points" in preview:
            points=preview["points"]
            # Avoid adding every helix vertex: thousands of almost
            # coincident lines would explode the grid.
            add_point_planes(points[0])
            add_point_planes(points[-1])
    for port in port_definitions:
        add_point_planes(port["start"])
        add_point_planes(port["stop"])

    local_step=mesh_cfg.get("local_min_cell_mm")
    if local_step is not None:
        step=positive(local_step,"mesh.local_min_cell_mm")
        for lo,hi in geometry_bounds+source_bounds:
            # Local automatic refinement only around each small bounding
            # envelope. For long structures use explicit refinements instead.
            span=hi-lo
            if np.max(span)<=float(mesh_cfg.get("auto_refine_max_span_mm",40)):
                add_local_mesh(mesh,domain_start,domain_stop,lo,hi,step)

    for region in mesh_cfg.get("refinements",[]):
        a=vec3(region["start"],"mesh region start")
        b=vec3(region["stop"],"mesh region stop")
        require(np.all(b>a),"mesh refinement stop <= start")
        add_local_mesh(mesh,domain_start,domain_stop,a,b,region["resolution_mm"])

    mesh.SmoothMeshLines("all",resolution,growth)
    counts=[len(mesh.GetLines(axis))-1 for axis in "xyz"]
    cells=math.prod(counts)
    max_cells=int(mesh_cfg.get("max_cells",5000000))
    require(cells<=max_cells,f"Mesh exceeds cell budget: {cells} > {max_cells}")
    return counts,cells


def output_data(config, resultdir):
    from CSXCAD import ContinuousStructure
    from openEMS import openEMS

    require(config.get("schema_version")==2,"simulate_v2 requires schema_version=2")
    require(config.get("units")=="mm","v2 supports millimetres only")
    excitation=config["excitation"]
    f0=positive(excitation["center_hz"],"excitation.center_hz")
    fc=positive(excitation["bandwidth_hz"],"excitation.bandwidth_hz")
    require(f0>fc,"Excitation bandwidth must be < center frequency")
    outputcfg=config.get("outputs",{})
    sweep=outputcfg.get("s11",config.get("s11"))
    freq=frequencies(sweep,f0,fc)
    patterns=outputcfg.get("radiation_frequencies_hz",config.get("radiation_pattern_frequencies_hz",[]))
    require(0<len(patterns)<=12,"Must request 1..12 far-field frequencies")
    patterns=[float(f) for f in patterns]
    require(all(f0-fc<=f<=f0+fc for f in patterns),"Far-field frequencies outside excitation bandwidth")

    domain=config["domain"]
    dstart=vec3(domain["start"],"domain.start")
    dstop=vec3(domain["stop"],"domain.stop")
    require(np.all(dstop>dstart),"Invalid simulation domain")
    boundary=domain.get("boundary",["PML_8"]*6)
    require(len(boundary)==6,"Require six boundary conditions")
    solver=config.get("solver",{})
    fdtd=openEMS(NrTS=int(solver.get("max_timesteps",20000)),
                 EndCriteria=float(solver.get("end_criteria",1e-4)))
    fdtd.SetGaussExcite(f0,fc)
    fdtd.SetBoundaryCond(boundary)
    csx=ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh=csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)

    props={}
    material_defs={}
    for m in config["materials"]:
        name=m["name"]
        require(name not in props,f"Duplicate material {name}")
        props[name]=add_material(csx,m)
        material_defs[name]=m
    require(bool(config["geometry"]),"At least one geometry object required")
    geometry_bounds=[]
    previews=[]
    for g in config["geometry"]:
        mat=g["material"]
        require(mat in props,f"Undefined material {mat}")
        if material_defs[mat]["type"]=="conducting_sheet":
            require(g.get("shape",g.get("type"))=="box",
                    "Conducting sheets require 2D box geometry")
            require(sum(float(a)==float(b) for a,b in zip(g["start"],g["stop"]))==1,
                    "Conducting sheet must have exactly one zero-thickness dimension")
        lo,hi,preview=install_geometry(props[mat],g)
        require(np.all(lo>=dstart) and np.all(hi<=dstop),
                f"Geometry {g.get('name',g.get('shape'))} must fit inside domain including thickness")
        previews.append(preview)
        geometry_bounds.append((lo,hi))

    configured_ports=config.get("ports",config.get("sources",[]))
    require(bool(configured_ports),"At least one port is required")
    active=[p for p in configured_ports if p.get("excite",p.get("enabled",False))]
    require(len(active)==1,"Exactly one port must be excited in each FDTD run")
    require(len({int(p.get("id",p.get("port_number",1))) for p in configured_ports})==len(configured_ports),
            "Port IDs must be unique")
    port_bounds=[]
    for s in configured_ports:
        a=vec3(s["start"],"port.start")
        b=vec3(s["stop"],"port.stop")
        ext=float(s.get("outer_radius",0)) if s["type"]=="coaxial" else 0.
        lo=np.minimum(a,b)-ext
        hi=np.maximum(a,b)+ext
        require(np.all(lo>=dstart) and np.all(hi<=dstop),"Port must fit within domain")
        port_bounds.append((lo,hi))

    counts,cells=setup_mesh(mesh,config,geometry_bounds,port_bounds,previews,configured_ports,dstart,dstop)
    ports={int(s.get("id",s.get("port_number",1))):add_port(fdtd,props,material_defs,s)
           for s in configured_ports}
    driven=active[0]
    driven_id=int(driven.get("id",driven.get("port_number",1)))
    nf2ff=fdtd.CreateNF2FFBox()
    resultdir.mkdir(parents=True,exist_ok=True)
    fdtd_path=resultdir/"fdtd"
    csx.Write2XML(str(resultdir/"geometry.xml"))
    fdtd.Run(str(fdtd_path),cleanup=True,verbose=1)

    current=ports[driven_id]
    current.CalcPort(str(fdtd_path),freq)
    gamma=np.asarray(current.uf_ref)/np.asarray(current.uf_inc)
    mag=np.abs(gamma)
    vswr=np.where(mag<1,(1+mag)/np.maximum(1-mag,1e-15),np.inf)
    impedance=np.asarray(current.uf_tot)/np.asarray(current.if_tot)
    result={
        "schema_version":2,
        "name":config["name"],
        "description":config.get("description",""),
        "generated_at_utc":datetime.now(timezone.utc).isoformat(),
        "input_config":config,
        "geometry_preview":previews,
        "mesh_cells":counts,
        "mesh_total_cells":cells,
        "port_name":driven.get("name",f"port-{driven_id}"),
        "port_id":driven_id,
        "s11":{
            "frequency_hz":freq.tolist(),
            "real":finite_values(gamma.real),
            "imag":finite_values(gamma.imag),
            "logmag_db":finite_values(20*np.log10(np.maximum(mag,1e-16))),
            "phase_deg":finite_values(np.rad2deg(np.angle(gamma))),
            "vswr":finite_values(vswr)
        },
        "impedance":{
            "frequency_hz":freq.tolist(),
            "real_ohm":finite_values(impedance.real),
            "imag_ohm":finite_values(impedance.imag)
        },
        "patterns":[]
    }
    angular=config.get("radiation_pattern_grid",outputcfg.get("radiation_grid",{}))
    tstep=positive(angular.get("theta_step_deg",10),"theta_step_deg")
    pstep=positive(angular.get("phi_step_deg",10),"phi_step_deg")
    require(tstep<=30 and pstep<=30,"Angular steps must be <=30 deg")
    theta=np.linspace(0,180,round(180/tstep)+1)
    phi=np.linspace(0,360,round(360/pstep),endpoint=False)
    require(theta.size*phi.size<=30000,"Radiation grid too large")
    include_pol=bool(outputcfg.get("include_polarization",False))
    include_realized=bool(outputcfg.get("include_realized_gain",False))
    include_impedance=bool(outputcfg.get("include_impedance",True))
    if not include_impedance:
        result.pop("impedance")
    for f in patterns:
        filename=f"nf2ff_{int(f)}.h5"
        ff=nf2ff.CalcNF2FF(str(fdtd_path),f,theta,phi,
                          outfile=filename,read_cached=False,verbose=True)
        field=np.asarray(ff.E_norm[0],dtype=float).reshape((len(theta),len(phi)))
        dmax=10*np.log10(float(ff.Dmax[0]))
        dbi=dmax+20*np.log10(np.maximum(field/max(float(field.max()),1e-100),1e-16))
        current.CalcPort(str(fdtd_path),np.asarray([f]))
        accepted=float(np.asarray(current.P_acc).ravel()[0])
        eta=finite(float(ff.Prad[0])/accepted) if accepted>0 else None
        reflection=complex(np.asarray(current.uf_ref).ravel()[0]/
                           np.asarray(current.uf_inc).ravel()[0])
        mismatch=max(0,1-abs(reflection)**2)
        gain_factor=eta*mismatch if eta is not None else None
        record={
            "frequency_hz":f,
            "theta_deg":theta.tolist(),
            "phi_deg":phi.tolist(),
            "directivity_dbi":dbi.tolist(),
            "max_directivity_dbi":finite(dmax),
            "radiated_power_w":finite(ff.Prad[0]),
            "radiation_efficiency":eta,
            "mismatch_efficiency":finite(mismatch),
            "unit":"dBi"
        }
        if include_realized:
            record["realized_gain_dbi"]=(dbi+10*np.log10(max(gain_factor,1e-30))).tolist() if gain_factor is not None else None
        if include_pol:
            for key in ("E_theta","E_phi"):
                val=np.asarray(getattr(ff,key)[0]).reshape((len(theta),len(phi)))
                record[key+"_real"]=val.real.tolist()
                record[key+"_imag"]=val.imag.tolist()
        pattern_file=f"pattern_{int(f)}Hz.json"
        (resultdir/pattern_file).write_text(json.dumps(record))
        result["patterns"].append({
            "frequency_hz":f,
            "file":pattern_file,
            "max_directivity_dbi":record["max_directivity_dbi"],
            "radiation_efficiency":eta,
            "max_realized_gain_dbi":finite(dmax+10*np.log10(max(gain_factor,1e-30)))
                if gain_factor is not None and include_realized else None
        })
    (resultdir/"result.json").write_text(json.dumps(result,indent=2))
    print("Simulation result:",resultdir/"result.json")


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("config",type=Path)
    p.add_argument("--output",type=Path,required=True)
    args=p.parse_args()
    output_data(json.loads(args.config.read_text()),args.output.resolve())


if __name__=="__main__":
    main()
