#!/usr/bin/env python3
"""Regenerate the FR4 4x4 antenna geometry + preview from editable dimensions.

Uses the checked-in JSON as a solver-setting template. No openEMS needed
for geometry generation. Requires only the Python standard library.
"""
from pathlib import Path
import json
import math

F0, ER, H = 2.45e9, 4.3, 1.6
PX, PY = 72.0, 78.0
INSET, SLOT_GAP, FEED_DROP = 9.0, 1.0, 20.0
C, EPS0 = 299792458, 8.8541878128e-12
PATH = Path(__file__).with_name("patch_array_4x4_fr4_2450.json")

def eff(w):
    return (ER+1)/2+(ER-1)/(2*math.sqrt(1+12*H/w))

def impedance(w):
    u=w/H
    if u<=1:
        return 60/math.sqrt(eff(w))*math.log(8/u+u/4)
    return 120*math.pi/(math.sqrt(eff(w))*(u+1.393+0.667*math.log(u+1.444)))

def width(z):
    a,b=.025,25
    for _ in range(90):
        m=(a+b)/2
        if impedance(m)>z: a=m
        else: b=m
    return (a+b)/2

R=lambda x: round(float(x),4)
W50,W70=width(50),width(math.sqrt(5000))
QL=C/(4*F0*math.sqrt(eff(W70)))*1000
W=C/(2*F0)*math.sqrt(2/(ER+1))*1000
DL=0.412*H*(eff(W)+.3)*(W/H+.264)/((eff(W)-.258)*(W/H+.8))
L=C/(2*F0*math.sqrt(eff(W)))*1000-2*DL
SW=W50+2*SLOT_GAP
xs=[(i-1.5)*PX for i in range(4)]
ys=[(i-1.5)*PY for i in range(4)]
ry=[v-FEED_DROP for v in ys]
gx=[-PX,PX]
gy=[(ry[2*i]+ry[2*i+1])/2 for i in range(2)]
root=(gy[0]+gy[1])/2
metal=[]

def box(name,mat,x0,y0,x1,y1,z,priority=10):
    if not(x0<x1 and y0<y1): raise ValueError("Degenerate geometry: "+name)
    return dict(name=name,material=mat,shape="box",priority=priority,
                start=[R(x0),R(y0),R(z)],stop=[R(x1),R(y1),R(z)])

def strip(name,a,b,w):
    if a[0]==b[0]:
        return box(name,"copper",a[0]-w/2,min(a[1],b[1]),
                   a[0]+w/2,max(a[1],b[1]),H)
    if a[1]==b[1]:
        return box(name,"copper",min(a[0],b[0]),a[1]-w/2,
                   max(a[0],b[0]),a[1]+w/2,H)
    raise ValueError("Only Manhattan feed traces are supported")

def branch(name,parent,child):
    dx,dy=child[0]-parent[0],child[1]-parent[1]
    ln=math.hypot(dx,dy)
    if ln<=QL+1: raise ValueError("Not enough length for QW arm: "+name)
    middle=(parent[0]+dx/ln*QL,parent[1]+dy/ln*QL)
    metal.extend([strip(name+"-70ohm",parent,middle,W70),
                  strip(name+"-50ohm",middle,child,W50)])

# Every patch is fed from negative Y: same antenna polarization and port phase.
for i,cy in enumerate(ys):
    for j,cx in enumerate(xs):
        n=f"patch-r{i+1}c{j+1}"
        x0,x1=cx-W/2,cx+W/2
        y0,y1=cy-L/2,cy+L/2
        start=y0+INSET
        metal.extend([
            box(n+"-body","copper",x0,start,x1,y1,H),
            box(n+"-left-tab","copper",x0,y0,cx-SW/2,start,H),
            box(n+"-right-tab","copper",cx+SW/2,y0,x1,start,H),
            strip(n+"-inset-feed",(cx,ry[i]),(cx,start+.3),W50)
        ])
for i in range(4):
    for half in range(2):
        for j in range(2*half,2*half+2):
            branch(f"row{i+1}-half{half+1}-col{j+1}",(gx[half],ry[i]),(xs[j],ry[i]))
for half in range(2):
    for g in range(2):
        for i in range(2*g,2*g+2):
            branch(f"quadrant-r{g+1}c{half+1}-row{i+1}",(gx[half],gy[g]),(gx[half],ry[i]))
for g in range(2):
    for half in range(2):
        branch(f"group{g+1}-half{half+1}",(0,gy[g]),(gx[half],gy[g]))
for g in range(2):
    branch(f"root-group{g+1}",(0,root),(0,gy[g]))
metal.append(box("input-solder-pad","copper",-2,root-2,2,root+2,H))

cfg=json.loads(PATH.read_text())
cfg["geometry"]=[
    dict(name="fr4-1p6mm",shape="box",material="fr4",priority=1,
         start=[-140,-149,0],stop=[140,140,H]),
    box("full-bottom-ground","copper",-140,-149,140,140,0)
]+metal
cfg["materials"][0]["epsilon"]=ER
cfg["materials"][0]["kappa_s_per_m"]=round(2*math.pi*F0*EPS0*ER*.02,9)
cfg["mesh"]["refinements"]=[
    dict(start=[R(x-SW/2-1),R(y-L/2-1),-.2],
         stop=[R(x+SW/2+1),R(y-L/2+INSET+1),H+.2],
         resolution_mm=.5)
    for y in ys for x in xs]
cfg["ports"][0]["start"]=[0,R(root),0]
cfg["ports"][0]["stop"]=[0,R(root),H]
assert len(cfg["geometry"])==127
PATH.write_text(json.dumps(cfg,indent=2)+"\n")

import html
parts=['<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="1156" viewBox="0 0 280 289">',
       '<rect width="280" height="289" fill="#dfe9be" stroke="#455338" stroke-width="0.4"/>']
for g in metal:
    a,b=g["start"],g["stop"]
    color="#ef8750" if g["name"]=="input-solder-pad" else "#0c555a"
    parts.append('<rect x="%.4f" y="%.4f" width="%.4f" height="%.4f" fill="%s"><title>%s</title></rect>'%
                 (a[0]+140,140-b[1],b[0]-a[0],b[1]-a[1],color,html.escape(g["name"])))
for i,y in enumerate(ys):
    for j,x in enumerate(xs):
        parts.append('<text x="%.2f" y="%.2f" font-family="sans-serif" font-size="5.5" text-anchor="middle" dominant-baseline="middle" fill="white">R%dC%d</text>'%
                     (x+140,140-y,i+1,j+1))
parts.append('<circle cx="140" cy="%.2f" r="1.5" fill="white" stroke="#ef8750" stroke-width="0.5"/>'%(140-root))
parts.append("</svg>")
PATH.with_suffix(".svg").write_text("\n".join(parts)+"\n")
print("Regenerated",PATH,"and SVG. Patch %.3f x %.3f mm; QW %.3f mm"%(W,L,QL))
