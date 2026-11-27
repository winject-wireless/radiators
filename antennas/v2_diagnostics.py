"""Passive diagnostic objects for the native schema-v2 solver.

The compact result format uses little-endian float32 vectors with real
timestamps. Diagnostic files use generated names, never user-supplied paths.
"""
import base64
import math
import re
import numpy as np
from v2_geometry import transformed, vec3

FIELDS = {"E": (0, "V/m"), "H": (1, "A/m"), "J": (2, "A/m²"),
          "J_total": (3, "A/m²"), "D": (4, "C/m²"), "B": (5, "T")}
MAX_POINTS = 4096
MAX_FLOATS = 4_000_000
MAX_OBJECTS = 32


def prepare(config, ds, de):
    """Validate and resolve axis-aligned measurement primitives."""
    objects = config.get("probes", [])
    if not isinstance(objects, list) or len(objects) > MAX_OBJECTS:
        raise ValueError("probes must be an array of at most 32 objects")
    out, names = [], set()
    for i, p in enumerate(objects):
        if not isinstance(p, dict):
            raise ValueError("Invalid diagnostic object")
        if p.get("enabled", True) is False:
            continue
        name = p.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 120 or name in names:
            raise ValueError("Diagnostic names must be unique nonempty strings (max 120 characters)")
        names.add(name)
        kind = p.get("type")
        a, b = [vec3(p[k], name+"."+k) for k in ("start", "stop")]
        if np.any(b < a):
            raise ValueError(name+": start must be <= stop")
        # Transform all eight corners, and allow only axis permutations/sign flips.
        tf = p.get("transform", {})
        rot = vec3(tf.get("rotate_deg", [0,0,0]), name+".rotate_deg")
        if not np.allclose(rot / 90, np.round(rot / 90), atol=1e-9):
            raise ValueError(name+": diagnostic boxes only support 90-degree rotations")
        corners = transformed([[x,y,z] for x in (a[0],b[0])
                               for y in (a[1],b[1]) for z in (a[2],b[2])], p)
        lo, hi = corners.min(axis=0), corners.max(axis=0)
        hi[np.isclose(hi,lo,atol=1e-9,rtol=0)] = lo[np.isclose(hi,lo,atol=1e-9,rtol=0)]
        if np.any(lo < ds) or np.any(hi > de):
            raise ValueError(name+": probe outside simulation domain")
        nz = np.flatnonzero(hi-lo > 1e-9)
        axis = None
        sign = 1
        if kind == "current":
            if len(nz) != 2: raise ValueError(name+": current probe requires a plane")
            axis = next(k for k in range(3) if k not in nz)
        elif kind == "voltage":
            if len(nz) != 1: raise ValueError(name+": voltage probe requires a line")
            axis = int(nz[0])
        elif kind in ("electric_field", "magnetic_field"):
            if len(nz): raise ValueError(name+": field probe requires a point")
        elif kind == "field_dump":
            if len(nz) < 2: raise ValueError(name+": field dump requires a plane or volume")
            if p.get("field","E") not in FIELDS: raise ValueError(name+": unknown field")
        else:
            raise ValueError(name+": unknown diagnostic type")
        if axis is not None:
            local_axes = np.flatnonzero(b-a > 1e-9)
            local_axis = int(local_axes[0]) if kind=="voltage" else next(k for k in range(3) if k not in local_axes)
            direction = p.get("direction", "xyz"[local_axis])
            if direction not in ("xyz"[local_axis], "-"+ "xyz"[local_axis]):
                raise ValueError(name+": direction must follow local probe axis")
            v = np.eye(3)[local_axis]
            origin, tip = transformed([[0,0,0],v], p)
            sign = (1 if tip[axis]-origin[axis] > 0 else -1) * (-1 if direction.startswith("-") else 1)
        sub = p.get("sub_sampling", [2,2,2])
        if not isinstance(sub,list) or len(sub)!=3 or any(type(x)!=int or not 1<=x<=100 for x in sub):
            raise ValueError(name+": sub_sampling must contain 3 integers from 1 to 100")
        td = p.get("time_domain", {}).get("enabled", True)
        fd = p.get("frequency_domain", {})
        fs = fd.get("frequencies_hz", p.get("frequencies_hz", [])) if fd.get("enabled", bool(p.get("frequencies_hz"))) else []
        if not isinstance(fs,list) or len(fs)>12 or any(type(f) not in (int,float) or not math.isfinite(f) or f<=0 for f in fs):
            raise ValueError(name+": invalid diagnostic frequencies")
        if not td and not fs: raise ValueError(name+": enable time or frequency capture")
        ex=config.get("excitation", {})
        f0,fc=ex.get("center_hz"),ex.get("bandwidth_hz")
        if f0 is not None and fc is not None and any(not f0-fc<=f<=f0+fc for f in fs):
            raise ValueError(name+": diagnostic frequencies outside excitation band")
        dump_mode=p.get("dump_mode","node")
        if dump_mode not in ("node","cell"): raise ValueError(name+": use node or cell interpolation")
        oversampling=p.get("time_domain",{}).get("oversampling")
        if oversampling is not None and (type(oversampling)!=int or not 1<=oversampling<=100):
            raise ValueError(name+": oversampling must be an integer from 1 to 100")
        # Scalar probes always capture their native TD files; FD uses native accumulated DFT.
        out.append(dict(id="diag_%03d"%i, name=name, type=kind, start=lo.tolist(), stop=hi.tolist(),
                        axis=axis, sign=sign, field=p.get("field","E"), td=bool(td), fs=fs, sub=sub,
                        dump_mode=1 if dump_mode=="node" else 2, oversampling=oversampling))
    return out


def install(csx, objects):
    for p in objects:
        a,b = p["start"],p["stop"]
        if p["type"] == "field_dump":
            code,_ = FIELDS[p["field"]]
            for mode, enabled in (("td", p["td"]), ("fd", bool(p["fs"]))):
                if not enabled: continue
                kw = dict(dump_type=code+(10 if mode=="fd" else 0), file_type=1,
                          dump_mode=p["dump_mode"], sub_sampling=p["sub"])
                if mode=="td" and p["oversampling"] is not None: kw["over_sampling"]=p["oversampling"]
                if mode=="fd": kw["frequency"]=p["fs"]
                csx.AddDump(p["id"]+"_"+mode, **kw).AddBox(a,b)
        else:
            code = {"voltage":0,"current":1,"electric_field":2,"magnetic_field":3}[p["type"]]
            kw = {}
            if p["type"]=="current": kw["norm_dir"]=p["axis"]
            if p["fs"]: kw["frequency"]=p["fs"]
            if p["oversampling"] is not None: kw["over_sampling"]=p["oversampling"]
            csx.AddProbe(p["id"],code,**kw).AddBox(a,b)


def packed(a):
    a = np.asarray(a, dtype="<f4")
    if not np.isfinite(a).all(): raise ValueError("Nonfinite diagnostic samples")
    return base64.b64encode(a.tobytes(order="C")).decode("ascii")


def read_probe(path, p, budget):
    n = 3 if p["type"] in ("electric_field","magnetic_field") else 1
    unit = {"voltage":"V","current":"A","electric_field":"V/m","magnetic_field":"A/m"}[p["type"]]
    out = dict(unit=unit, components=n)
    def table(file, cols):
        data = np.loadtxt(file, comments="%", ndmin=2)
        if not len(data) or data.shape[1]!=cols or not np.isfinite(data).all():
            raise ValueError("Unexpected diagnostic probe columns")
        return data
    if p["td"]:
        d = table(path/p["id"],1+n)
        if d.size>budget: raise ValueError("Probe sample limit exceeded; reduce capture sampling")
        if np.any(np.diff(d[:,0])<=0): raise ValueError("Non-increasing probe timestamps")
        out.update(time_s=d[:,0].tolist(), values=(d[:,1:]*p["sign"]).tolist())
        # The native header reports the actual snapped measurement coordinates in metres.
        with (path/p["id"]).open() as f:
            for line in f:
                if not line.startswith("%"): break
                m=re.search(r"(start|stop)-coordinates:\s*\(([^)]*)\)\s*m",line)
                if m:
                    coords=[float(v)*1000 for v in m.group(2).split(",")]
                    if len(coords)==3: out["sample_"+m.group(1)]=coords
    if p["fs"]:
        d=table(path/(p["id"]+"_FD"),1+2*n)
        out["frequency_hz"]=d[:,0].tolist()
        out["real"]=(d[:,1::2]*p["sign"]).tolist()
        out["imag"]=(d[:,2::2]*p["sign"]).tolist()
    return out


def read_dump(file, mode, budget):
    import h5py
    with h5py.File(file,"r") as h:
        axes=[np.asarray(h["Mesh/"+k],float).ravel()*1000 for k in "xyz"]
        shape=tuple(map(len,axes))
        n=math.prod(shape)
        if n<1 or n>MAX_POINTS: raise ValueError("Field dump exceeds 4096 spatial samples; increase subsampling")
        group=h["FieldData/"+mode.upper()]
        # Older openEMS stores (component,z,y,x); new files store (component,x,y,z).
        version=float(np.asarray(h.attrs.get("openEMS_HDF5_version",0.2)).ravel()[0])
        legacy=bool(np.asarray(h.attrs.get("legacy_fmt",version<=0.2)).ravel()[0])
        def flatten(a):
            a=np.asarray(a)
            expected=(3,*shape[::-1]) if legacy else (3,*shape)
            if a.shape!=expected: raise ValueError("Unexpected HDF5 field shape: "+str(a.shape))
            if legacy: a=a.transpose(0,3,2,1)
            return a.transpose(1,2,3,0).reshape(n,3)
        if mode=="td":
            keys=sorted(group.keys(),key=int)
            if len(keys)*n*3>budget: raise ValueError("Field capture exceeds transfer budget; increase spatial subsampling or shorten the simulation")
            frames=[]; times=[]
            for k in keys:
                frames.append(flatten(group[k][...]))
                times.append(float(np.asarray(group[k].attrs["time"]).ravel()[0]))
            if not frames: raise ValueError("No time-domain field samples")
            vals=np.asarray(frames)
            return dict(axes_mm=[a.tolist() for a in axes],time_s=times,
                        frames_f32=packed(vals),peak=float(np.linalg.norm(vals,axis=-1).max())), vals.size
        keys=sorted((k for k in group if re.fullmatch(r"f\d+(?:_real)?",k)),key=lambda k:int(k.split("_")[0][1:]))
        if len(keys)*n*6>budget: raise ValueError("Frequency field exceeds transfer budget")
        frames=[]; freqs=[]
        for k in keys:
            d=group[k]
            a=d[...]
            if k.endswith("_real"):
                a=a+1j*group[k.replace("_real","_imag")][...]
            elif a.dtype.fields and set(a.dtype.fields)=={"r","i"}: a=a["r"]+1j*a["i"]
            if not np.iscomplexobj(a): raise ValueError("Expected complex vector field")
            frames.append(flatten(a))
            freq=d.attrs.get("frequency")
            if freq is None: freq=np.asarray(group.attrs["frequency"])[int(k.split("_")[0][1:])]
            freqs.append(float(np.asarray(freq).ravel()[0]))
        if not frames: raise ValueError("No frequency-domain field samples")
        vals=np.asarray(frames)
        return dict(axes_mm=[a.tolist() for a in axes],frequency_hz=freqs,
                    real_f32=packed(vals.real),imag_f32=packed(vals.imag),
                    peak=float(np.linalg.norm(vals,axis=-1).max())), vals.size*2


def collect(path, objects):
    records=[]; budget=MAX_FLOATS
    for p in objects:
        record={k:p[k] for k in ("id","name","type","start","stop","axis","sign","field")}
        errors=[]
        if p["type"]=="field_dump":
            record["unit"]=FIELDS[p["field"]][1]
            for mode,enabled in (("td",p["td"]),("fd",bool(p["fs"]))):
                if not enabled: continue
                try:
                    record[mode],used=read_dump(path/(p["id"]+"_"+mode+".h5"),mode,budget)
                    budget-=used
                except Exception as exc: errors.append(mode+": "+str(exc))
        else:
            try:
                data=read_probe(path,p,budget)
                budget-=len(data.get("time_s",[]))*(data["components"]+1)
                record.update(data)
            except Exception as exc: errors.append(str(exc))
        if errors: record["warning"]="; ".join(errors)
        records.append(record)
    return records
