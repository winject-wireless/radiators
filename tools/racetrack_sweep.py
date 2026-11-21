#!/usr/bin/env python3
"""24-case standalone center-fed racetrack sweep (solid copper geometry).
EM conductor model: PEC 1/2/3/4mm round wire; copper skin loss is estimated
separately because openEMS wire primitives cannot resolve 1.3um skin depth.
"""
import argparse
import csv
import json
import math
from pathlib import Path

C=299792458.0
F=2450000000
LAMBDA=C/F*1000
RATIOS=(1.30,1.50,1.73,1.90,2.10,2.30) # outer height / outer width
DIAMETERS=(1,2,3,4) # millimetres
GAP=4.0 # actual metal-to-metal separation, millimetres
COPPER_SIGMA=5.8e7
MU0=4*math.pi*1e-7
OUT=Path("results/racetrack_copper_sweep")


def cases():
    return [(ar,d) for ar in RATIOS for d in DIAMETERS]


def key(ar,d):
    return "racetrack_ar%03d_d%d_2450" % (round(ar*100),d)


def geom(ar,d):
    # Closed-loop centerline perimeter lambda, prior to feed interruption.
    w=(LAMBDA+math.pi*d)/(2*(ar-1)+math.pi)
    h=ar*w
    r=(w-d)/2
    straight=(h-w)/2
    gap_half=(GAP+d)/2
    assert straight>gap_half and r>0
    return (w,h,r,straight,gap_half)


def vertices(r,s,g):
    point=lambda x,z:[round(x,6),0,round(z,6)]
    p=[]
    n=max(4,math.ceil((s-g)/1))
    for i in range(n+1):p.append(point(r,g+(s-g)*i/n))
    for i in range(1,49):
        a=math.pi*i/48
        p.append(point(r*math.cos(a),s+r*math.sin(a)))
    n=max(8,math.ceil(2*s/1))
    for i in range(1,n+1):p.append(point(-r,s-2*s*i/n))
    for i in range(1,49):
        a=math.pi+math.pi*i/48
        p.append(point(r*math.cos(a),-s+r*math.sin(a)))
    n=max(4,math.ceil((s-g)/1))
    for i in range(1,n+1):p.append(point(r,-s+(s-g)*i/n))
    assert len(p)==len(set(map(tuple,p)))
    return p


def config(ar,d):
    w,h,r,s,g=geom(ar,d)
    x=round(r,6)
    # Align 1mm Cartesian grid with x=feed and both z=feed terminals.
    domain={"start":[round(x-90,6),-90,-90-g],
            "stop":[round(x+90,6),90,90+g],
            "boundary":["PML_8"]*6}
    return {
      "schema_version":2,
      "name":"Standalone racetrack solid copper D=%d mm H/W=%.2f"%(d,ar),
      "description":"Standalone center-of-straight fed racetrack. Solid copper physical rod; "
         "PEC surrogate wire EM model (finite-conductivity losses NOT solved). "
         "4mm metal-to-metal feed gap; ideal 50 ohm port. One-wavelength "
         "complete centerline perimeter before feed gap; NOT tuned. "
         "1mm mesh screening only; validate winning cases with mesh convergence.",
      "units":"mm",
      "sweep_parameters":{"aspect_ratio_height_over_width":ar,"diameter_mm":d,
           "outer_width_mm":round(w,6),"outer_height_mm":round(h,6),
           "metal_to_metal_gap_mm":GAP,
           "nominal_centerline_perimeter_mm":round(LAMBDA,6)},
      "physical_conductor":{"type":"solid copper","conductivity_s_per_m":COPPER_SIGMA,
           "em_model":"PEC surrogate; AC loss estimated separately"},
      "domain":domain,
      "mesh":{"grid_mode":"uniform","uniform_step_mm":1,"max_cell_mm":1,
              "max_cells":7_000_000,"growth_ratio":1.35},
      "solver":{"max_timesteps":35000,"end_criteria":0.0001,
                "resources":{"cpus":2,"memory_gib":5}},
      "excitation":{"center_hz":F,"bandwidth_hz":350_000_000},
      "materials":[{"name":"ideal-copper-surrogate","type":"pec"}],
      "geometry":[{"name":"racetrack-round-rod","shape":"wire",
          "material":"ideal-copper-surrogate","wire_diameter":d,
          "points":vertices(r,s,g),"priority":10}],
      "ports":[{"id":1,"name":"midpoint-50-ohm-feed","type":"lumped",
          "start":[x,0,-g],"stop":[x,0,g],"direction":"z",
          "impedance_ohm":50,"excite":True}],
      "outputs":{"s11":[{"start":2_150_000_000,"step":5_000_000,
                         "end":2_750_000_000}],
          "radiation_frequencies_hz":[F],"include_impedance":True,
          "include_polarization":False,"include_realized_gain":True,
          "radiation_grid":{"theta_step_deg":10,"phi_step_deg":10}}
    }


def self_test():
    assert len(cases())==24
    for ar,d in cases():
        c=config(ar,d)
        p=c["ports"][0]; domain=c["domain"]; g=c["geometry"][0]
        w,h,r,s,gap=geom(ar,d)
        assert abs(h/w-ar)<1e-9
        assert abs(4*s+2*math.pi*r-LAMBDA)<1e-8
        assert p["stop"][2]-p["start"][2]-d == GAP
        assert g["wire_diameter"]==d
        assert len(g["points"])>=90
        for end in (p["start"],p["stop"]):
            for j in range(3):
                v=end[j]-domain["start"][j]
                assert abs(v-round(v))<1e-5,(ar,d,j,v)
        assert 180*180*(180+d+GAP)<c["mesh"]["max_cells"]
    print("PASS: 24 valid geometries, centered feed, 4mm air gap, grid alignment")


def generate():
    Path("antennas").mkdir(exist_ok=True)
    paths=[]
    for ar,d in cases():
        path=Path("antennas")/(key(ar,d)+".json")
        assert not path.exists(),path
        path.write_text(json.dumps(config(ar,d),indent=2,allow_nan=False)+"\n")
        paths.append(str(path))
    Path("racetrack-sweep-inputs.txt").write_text("\n".join(paths)+"\n")
    print("Generated",len(paths),"cases")


def copper_ac_resistance(d):
    # Rough uniform-current conductor resistance. Not the loop's port loss.
    delta=math.sqrt(1/(math.pi*F*MU0*COPPER_SIGMA))
    rs=1/(COPPER_SIGMA*delta)
    length=(LAMBDA-(GAP+d))*1e-3
    return delta*1e6,rs*length/(math.pi*d*1e-3)


def summarize():
    OUT.mkdir(parents=True,exist_ok=True)
    rows=[]
    for ar,d in cases():
        name=key(ar,d)
        mm,ohm=copper_ac_resistance(d)
        w,h,*_=geom(ar,d)
        entry={"case":name,"H/W":ar,"diameter_mm":d,
            "width_mm":round(w,4),"height_mm":round(h,4),
            "skin_depth_um":round(mm,4),
            "copper_uniform_current_Rac_estimate_ohm":round(ohm,6),
            "valid":False,"error":"","S11_2450_dB":None,
            "VSWR_2450":None,"Zreal_2450_ohm":None,
            "Zimag_2450_ohm":None,"min_S11_dB":None,
            "min_S11_frequency_MHz":None,"near_zero_X_frequency_MHz":None,
            "peak_directivity_2450_dBi":None}
        file=Path("results")/name/"result.json"
        try:
            if not file.is_file():raise ValueError("Missing FDTD result")
            result=json.loads(file.read_text())
            freqs=result["s11"]["frequency_hz"]
            ix=min(range(len(freqs)),key=lambda i:abs(freqs[i]-F))
            assert abs(freqs[ix]-F)<1
            S=result["s11"]["logmag_db"]
            V=result["s11"]["vswr"]
            R=result["impedance"]["real_ohm"]
            X=result["impedance"]["imag_ohm"]
            if not all(len(a)==len(freqs) and
                       all(v is not None and math.isfinite(v) for v in a)
                       for a in (S,V,R,X)):
                raise ValueError("Nonfinite S11/VSWR/impedance; possibly unexcited port")
            pat=result["patterns"][0]
            G=pat["max_directivity_dbi"]
            if G is None or not math.isfinite(G):raise ValueError("Invalid pattern")
            si=min(range(len(S)),key=lambda i:S[i])
            xi=min(range(len(X)),key=lambda i:abs(X[i]))
            entry.update(valid=True,S11_2450_dB=round(S[ix],4),
                VSWR_2450=round(V[ix],4),
                Zreal_2450_ohm=round(R[ix],4),
                Zimag_2450_ohm=round(X[ix],4),
                min_S11_dB=round(S[si],4),
                min_S11_frequency_MHz=round(freqs[si]/1e6,3),
                near_zero_X_frequency_MHz=round(freqs[xi]/1e6,3),
                peak_directivity_2450_dBi=round(G,4))
        except Exception as error:entry["error"]=str(error)
        rows.append(entry)
    ranked=sorted((r for r in rows if r["valid"]),key=lambda r:r["S11_2450_dB"])
    ranked += [r for r in rows if not r["valid"]]
    with (OUT/"ranking.csv").open("w",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=list(ranked[0]))
        writer.writeheader()
        writer.writerows(ranked)
    (OUT/"all_results.json").write_text(json.dumps(ranked,indent=2,allow_nan=False)+"\n")
    lines=["# Standalone 2.45 GHz racetrack sweep",
      "", "Midpoint of straight side feed held fixed; 4mm metal air gap, 50 ohms.",
      "H/W ratios "+str(RATIOS)+"; solid copper diameters "+str(DIAMETERS)+" mm.",
      "**EM solver uses PEC round wire, not real lossy copper**. Surface-loss "
      "values are simple uniform-current estimates, not port losses.",
      "Valid: %d/24"%sum(bool(r["valid"]) for r in rows),
      "", "| Case | S11 at 2450 dB | Z at 2450 ohm | VSWR |",
      "|---|---:|---:|---:|"]
    for r in ranked:
        if r["valid"]:
            lines.append("| %s | %.2f | %.1f %+.1fj | %.2f |"%
                (r["case"],r["S11_2450_dB"],r["Zreal_2450_ohm"],
                 r["Zimag_2450_ohm"],r["VSWR_2450"]))
        else:lines.append("- FAILED "+r["case"]+": "+r["error"])
    (OUT/"summary.md").write_text("\n".join(lines)+"\n")
    print("Valid cases:",sum(bool(r["valid"]) for r in rows),"/24")
    return 0 if all(r["valid"] for r in rows) else 1


if __name__=="__main__":
    ap=argparse.ArgumentParser()
    m=ap.add_mutually_exclusive_group(required=True)
    for flag in ("self-test","generate","summarize"):
        m.add_argument("--"+flag,action="store_true")
    args=ap.parse_args()
    if args.self_test:self_test()
    elif args.generate:generate()
    else:raise SystemExit(summarize())
