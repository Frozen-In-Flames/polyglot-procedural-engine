const H=1.5*Math.sqrt(3);function d(t,e){return typeof t=="number"?t:e[t.uniform]??0}function F(t,e){return e?[t[0]-e[0],t[1]-e[1],t[2]-e[2]]:t}function M(t,e,a,s){let c=s^Math.imul(t|0,374761393)^Math.imul(e|0,668265263)^Math.imul(a|0,605014474);return c=Math.imul(c^c>>>13,1274126177),c^=c>>>16,(c>>>0)/4294967296}function j(t,e,a,s){const c=Math.floor(t),r=Math.floor(e),o=Math.floor(a),i=t-c,n=e-r,l=a-o,u=A=>A*A*(3-2*A),f=u(i),x=u(n),h=u(l),$=M(c,r,o,s),k=M(c+1,r,o,s),C=M(c,r+1,o,s),w=M(c+1,r+1,o,s),S=M(c,r,o+1,s),U=M(c+1,r,o+1,s),R=M(c,r+1,o+1,s),I=M(c+1,r+1,o+1,s),q=$+(k-$)*f,O=C+(w-C)*f,N=S+(U-S)*f,B=R+(I-R)*f,D=q+(O-q)*x,V=N+(B-N)*x;return D+(V-D)*h}function Y(t,e,a,s,c=4){let r=0,o=.5,i=1,n=0;for(let l=0;l<c;l++)r+=o*j(t*i,e*i,a*i,s+l*131),n+=o,o*=.5,i*=2.03;return r/n}function _(t,e){return{d:e,mat:t.mat??0}}function G(t,e){return t.d<=e.d?t:e}function X(t,e,a){const s=Math.max(1e-6,a);return Math.min(t,e)-Math.log1p(Math.exp(-s*Math.abs(t-e)))/s}function m(t,e,a={}){switch(t.kind){case"sphere":{const s=F(e,t.c),c=Math.sqrt(s[0]*s[0]+s[1]*s[1]+s[2]*s[2])-d(t.r,a);return _(t,c)}case"box":{const s=F(e,t.c),c=t.b,r=Math.abs(s[0])-c[0],o=Math.abs(s[1])-c[1],i=Math.abs(s[2])-c[2],n=Math.max(r,0),l=Math.max(o,0),u=Math.max(i,0),f=Math.sqrt(n*n+l*l+u*u)+Math.min(Math.max(r,Math.max(o,i)),0);return _(t,f)}case"torus":{const s=F(e,t.c),c=d(t.R,a),r=d(t.r,a),o=Math.sqrt(s[0]*s[0]+s[2]*s[2])-c,i=Math.sqrt(o*o+s[1]*s[1])-r;return _(t,i)}case"capsule":{const s=[e[0]-t.a[0],e[1]-t.a[1],e[2]-t.a[2]],c=[t.b[0]-t.a[0],t.b[1]-t.a[1],t.b[2]-t.a[2]],r=c[0]*c[0]+c[1]*c[1]+c[2]*c[2];let o=r>0?(s[0]*c[0]+s[1]*c[1]+s[2]*c[2])/r:0;o=Math.min(1,Math.max(0,o));const i=[s[0]-c[0]*o,s[1]-c[1]*o,s[2]-c[2]*o],n=Math.sqrt(i[0]*i[0]+i[1]*i[1]+i[2]*i[2])-d(t.r,a);return _(t,n)}case"plane":{const s=e[0]*t.n[0]+e[1]*t.n[1]+e[2]*t.n[2]+t.h;return _(t,s)}case"union":{let s={d:1/0,mat:0};for(const c of t.children)s=G(s,m(c,e,a));return s}case"smoothUnion":{const s=Math.max(1e-6,d(t.k,a));let c={d:1/0,mat:0};for(const r of t.children){const o=m(r,e,a);if(c.d===1/0){c=o;continue}c={d:X(c.d,o.d,s),mat:c.d<=o.d?c.mat:o.mat}}return c}case"polySmin":{const s=Math.max(1e-9,d(t.k,a)),c=m(t.children[0],e,a),r=m(t.children[1],e,a),o=Math.max(s-Math.abs(c.d-r.d),0)/s;return{d:Math.min(c.d,r.d)-s/4*o*o,mat:c.d<=r.d?c.mat:r.mat}}case"subtract":{const s=m(t.a,e,a),c=m(t.b,e,a);return{d:Math.max(s.d,-c.d),mat:s.mat}}case"intersect":{let s={d:1/0,mat:0};for(const c of t.children){const r=m(c,e,a);r.d>s.d&&(s=r)}return s.d===1/0?{d:1/0,mat:0}:s}case"repeat":{const s=[e[0],e[1],e[2]];for(let c=0;c<3;c++){const r=d(t.c[c],a);r>0&&(s[c]=((e[c]+.5*r)%r+r)%r-.5*r)}return m(t.child,s,a)}case"twist":{const s=d(t.k,a),c=Math.cos(s*e[1]),r=Math.sin(s*e[1]),o=[c*e[0]-r*e[2],e[1],r*e[0]+c*e[2]];return m(t.child,o,a)}case"displace":{const s=d(t.amp,a),c=d(t.freq,a),r=Y(e[0]*c,e[1]*c,e[2]*c,t.seed),o=m(t.child,e,a);return{d:o.d+s*(r-.5)*2,mat:o.mat}}case"translate":return m(t.child,F(e,t.t),a);case"scale":{const s=d(t.s,a)||1,c=m(t.child,[e[0]/s,e[1]/s,e[2]/s],a);return{d:c.d*s,mat:c.mat}}case"scale3":{const s=t.s[0]||1,c=t.s[1]||1,r=t.s[2]||1,o=Math.min(s,c,r),i=m(t.child,[e[0]/s,e[1]/c,e[2]/r],a);return{d:i.d*o,mat:i.mat}}}}function b(t,e=new Set){const a=s=>{s!==void 0&&typeof s!="number"&&e.add(s.uniform)};switch(t.kind){case"sphere":a(t.r);break;case"torus":a(t.R),a(t.r);break;case"capsule":a(t.r);break;case"smoothUnion":a(t.k),t.children.forEach(s=>b(s,e));break;case"polySmin":a(t.k),b(t.children[0],e),b(t.children[1],e);break;case"twist":a(t.k),b(t.child,e);break;case"displace":a(t.amp),a(t.freq),b(t.child,e);break;case"scale":a(t.s),b(t.child,e);break;case"scale3":b(t.child,e);break;case"union":case"intersect":t.children.forEach(s=>b(s,e));break;case"subtract":b(t.a,e),b(t.b,e);break;case"repeat":t.c.forEach(a),b(t.child,e);break;case"translate":b(t.child,e);break}return e}const E=`
float sdf_smin(float a, float b, float k){
  float kk = max(k, 1e-6);
  return min(a, b) - log(1.0 + exp(-kk * abs(a - b))) / kk;
}
float sdf_hash(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float sdf_vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sdf_hash(i), sdf_hash(i + vec3(1,0,0)), u.x),
                  mix(sdf_hash(i + vec3(0,1,0)), sdf_hash(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(sdf_hash(i + vec3(0,0,1)), sdf_hash(i + vec3(1,0,1)), u.x),
                  mix(sdf_hash(i + vec3(0,1,1)), sdf_hash(i + vec3(1,1,1)), u.x), u.y), u.z);
}
float sdf_fbm(vec3 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * sdf_vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
vec2 sdf_min2(vec2 a, vec2 b){ return a.x <= b.x ? a : b; }
vec2 sdf_max2(vec2 a, vec2 b){ return a.x >= b.x ? a : b; }
`;function z(t){return Number.isInteger(t)?t.toFixed(1):String(t)}function v(t){return typeof t=="number"?`(${z(t)})`:t.uniform}function y(t){return`vec3(${t[0]}, ${t[1]}, ${t[2]})`}function K(t){return`vec3(${v(t[0])}, ${v(t[1])}, ${v(t[2])})`}let P=0;function g(t,e){const a=`r${P++}`,s=c=>`${c.mat??0}.0`;switch(t.kind){case"sphere":{const c=t.c?`(${e} - ${y(t.c)})`:e;return{code:`vec2 ${a} = vec2(length(${c}) - ${v(t.r)}, ${s(t)});`,out:a}}case"box":{const c=t.c?`abs(${e} - ${y(t.c)}) - ${y(t.b)}`:`abs(${e}) - ${y(t.b)}`;return{code:`vec3 ${a}q = ${c};
vec2 ${a} = vec2(length(max(${a}q, 0.0)) + min(max(${a}q.x, max(${a}q.y, ${a}q.z)), 0.0), ${s(t)});`,out:a}}case"torus":{const c=t.c?`(${e} - ${y(t.c)})`:e;return{code:`vec2 ${a}x = vec2(length(${c}.xz) - ${v(t.R)}, ${c}.y);
vec2 ${a} = vec2(length(${a}x) - ${v(t.r)}, ${s(t)});`,out:a}}case"capsule":{const c=y(t.a),r=y(t.b);return{code:`vec3 ${a}pa = ${e} - ${c};
vec3 ${a}ba = ${r} - ${c};
float ${a}h = clamp(dot(${a}pa, ${a}ba) / max(dot(${a}ba, ${a}ba), 1e-8), 0.0, 1.0);
vec2 ${a} = vec2(length(${a}pa - ${a}ba * ${a}h) - ${v(t.r)}, ${s(t)});`,out:a}}case"plane":{const c=y(t.n);return{code:`vec2 ${a} = vec2(dot(${e}, ${c}) + (${z(t.h)}), ${s(t)});`,out:a}}case"union":{const c=t.children.map(i=>g(i,e)),r=c.map(i=>i.code).join(`
`),o=c.map(i=>i.out).reduce((i,n)=>`sdf_min2(${i}, ${n})`);return{code:`${r}
vec2 ${a} = ${o};`,out:a}}case"smoothUnion":{const c=t.children.map(n=>g(n,e)),r=c.map(n=>n.code).join(`
`),o=v(t.k);let i=c[0].out;for(let n=1;n<c.length;n++){const l=c[n].out;i=`vec2(sdf_smin(${i}.x, ${l}.x, ${o}), ${i}.x <= ${l}.x ? ${i}.y : ${l}.y)`}return{code:`${r}
vec2 ${a} = ${i};`,out:a}}case"subtract":{const c=g(t.a,e),r=g(t.b,e);return{code:`${c.code}
${r.code}
vec2 ${a} = vec2(max(${c.out}.x, -${r.out}.x), ${c.out}.y);`,out:a}}case"polySmin":{const c=g(t.children[0],e),r=g(t.children[1],e),o=v(t.k);return{code:`${c.code+`
`+r.code}
float ${a}h = max(${o} - abs(${c.out}.x - ${r.out}.x), 0.0) / ${o};
vec2 ${a} = vec2(min(${c.out}.x, ${r.out}.x) - (${o} / 4.0) * ${a}h * ${a}h, ${c.out}.x <= ${r.out}.x ? ${c.out}.y : ${r.out}.y);`,out:a}}case"intersect":{const c=t.children.map(i=>g(i,e)),r=c.map(i=>i.code).join(`
`),o=c.map(i=>i.out).reduce((i,n)=>`sdf_max2(${i}, ${n})`);return{code:`${r}
vec2 ${a} = ${o};`,out:a}}case"repeat":{const c=K(t.c),r=`${a}qp`,o=g(t.child,r);return{code:`vec3 ${r} = ${e};
${[0,1,2].map(i=>`if (${c}[${i}] > 0.0) ${r}[${i}] = mod(${r}[${i}] + 0.5 * ${c}[${i}], ${c}[${i}]) - 0.5 * ${c}[${i}];`).join(`
`)}
${o.code}
vec2 ${a} = ${o.out};`,out:a}}case"twist":{const c=`${a}qp`,r=g(t.child,c);return{code:`float ${a}c = cos(${v(t.k)} * ${e}.y);
float ${a}s = sin(${v(t.k)} * ${e}.y);
vec3 ${c} = vec3(${a}c * ${e}.x - ${a}s * ${e}.z, ${e}.y, ${a}s * ${e}.x + ${a}c * ${e}.z);
${r.code}
vec2 ${a} = ${r.out};`,out:a}}case"displace":{const c=g(t.child,e);return{code:`${c.code}
vec2 ${a} = vec2(${c.out}.x + ${v(t.amp)} * (sdf_fbm(${e} * ${v(t.freq)} + ${t.seed}.0) - 0.5) * 2.0, ${c.out}.y);`,out:a}}case"translate":{const c=g(t.child,`(${e} - ${y(t.t)})`);return{code:c.code+`
vec2 ${a} = ${c.out};`,out:a}}case"scale":{const c=g(t.child,`(${e} / ${v(t.s)})`);return{code:`${c.code}
vec2 ${a} = vec2(${c.out}.x * ${v(t.s)}, ${c.out}.y);`,out:a}}case"scale3":{const c=`vec3(${t.s[0].toFixed(6)}, ${t.s[1].toFixed(6)}, ${t.s[2].toFixed(6)})`,r=Math.min(t.s[0]||1,t.s[1]||1,t.s[2]||1).toFixed(6),o=g(t.child,`(${e} / ${c})`);return{code:`${o.code}
vec2 ${a} = vec2(${o.out}.x * ${r}, ${o.out}.y);`,out:a}}}}function W(t){P=0;const e=[...b(t)].sort(),a=e.map(r=>`uniform float ${r};`).join(`
`),s=g(t,"p");return{glsl:`${E}
${a}
vec2 map(vec3 p){
${s.code}
return ${s.out};
}`,uniforms:e}}const Z=.85;function p(t,e={},a={}){const s=a.extent??8;switch(t.kind){case"sphere":case"box":case"torus":case"capsule":case"plane":return 1;case"union":case"intersect":case"smoothUnion":case"polySmin":{let c=0;for(const r of t.children){const o=p(r,e,a);if(!Number.isFinite(o))return NaN;c=Math.max(c,o)}return c}case"subtract":{const c=p(t.a,e,a),r=p(t.b,e,a);return!Number.isFinite(c)||!Number.isFinite(r)?NaN:Math.max(c,r)}case"translate":return p(t.child,e,a);case"scale":return p(t.child,e,a);case"scale3":return p(t.child,e,a);case"repeat":return p(t.child,e,a);case"twist":{const c=p(t.child,e,a);if(!Number.isFinite(c))return NaN;const r=Math.abs(d(t.k,e));return c*(1+r*s)}case"displace":{const c=p(t.child,e,a);if(!Number.isFinite(c))return NaN;const r=Math.abs(d(t.amp,e)),o=Math.abs(d(t.freq,e)),i=1.875;let n=0;for(let l=0;l<4;l++)n+=.5**l/i*2.03**l;return c+r*2*H*o*n}default:return NaN}}const J=.001,Q=100,tt=128;function nt(t,e,a,s={},c={}){const r=Math.hypot(a[0],a[1],a[2]);if(Math.abs(r-1)>1e-6)throw new Error(`marchRay: ray direction must be unit length, got |d| = ${r}`);const o=c.maxSteps??tt,i=c.maxDist??Q,n=c.eps??J,l=c.lipschitz??p(t,s,{extent:c.extent}),f=Number.isFinite(l)&&l>0?Math.min(1,1/l):Z;let x=c.omega??c.stepScale??f;!c.allowUnsafeOmega&&x>f&&(console.warn(`[sdf] omega ${x} exceeds 1/L = ${f.toFixed(4)}; clamped (pass allowUnsafeOmega to opt in to tunneling risk)`),x=f);let h=0;for(let k=0;k<o;k++){const C=c.pixelAngle!=null?Math.max(n,h*c.pixelAngle):n,w=[e[0]+a[0]*h,e[1]+a[1]*h,e[2]+a[2]*h],S=m(t,w,s);if(S.d<C)return{hit:!0,dist:h,mat:S.mat,pos:w,normal:et(t,w,s),steps:k+1};if(h+=S.d*x,h>i)break}const $=[e[0]+a[0]*h,e[1]+a[1]*h,e[2]+a[2]*h];return{hit:!1,dist:h,mat:0,pos:$,normal:null,steps:o}}function et(t,e,a={},s=1e-4){const c=s,r=m(t,[e[0]+c,e[1],e[2]],a).d-m(t,[e[0]-c,e[1],e[2]],a).d,o=m(t,[e[0],e[1]+c,e[2]],a).d-m(t,[e[0],e[1]-c,e[2]],a).d,i=m(t,[e[0],e[1],e[2]+c],a).d-m(t,[e[0],e[1],e[2]-c],a).d,n=[r,o,i],l=Math.sqrt(n[0]*n[0]+n[1]*n[1]+n[2]*n[2])||1;return[n[0]/l,n[1]/l,n[2]/l]}const at=96,ct=.001,st=100;function rt(t){const e=[t.target[0]-t.pos[0],t.target[1]-t.pos[1],t.target[2]-t.pos[2]],a=Math.sqrt(e[0]*e[0]+e[1]*e[1]+e[2]*e[2])||1,s=[e[0]/a,e[1]/a,e[2]/a],c=[0,1,0];let r=s[1]*c[2]-s[2]*c[1],o=s[2]*c[0]-s[0]*c[2],i=s[0]*c[1]-s[1]*c[0];const n=Math.sqrt(r*r+o*o+i*i)||1,l=[r/n,o/n,i/n],u=l[1]*s[2]-l[2]*s[1],f=l[2]*s[0]-l[0]*s[2],x=l[0]*s[1]-l[1]*s[0];return{fwd:s,right:l,up:[u,f,x]}}function ot(t,e,a={}){const s=a.steps??at,c=a.maxDist??st,r=a.eps??ct,o=a.skyTop??[.12,.2,.35],i=a.skyBottom??[.02,.03,.06],n=e.filter(u=>!t.includes(`uniform float ${u};`)).map(u=>`uniform float ${u};`).join(`
`),l=u=>Number.isInteger(u)?u.toFixed(1):String(u);return`#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uResolution;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTanFov;
uniform float uAspect;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uStepScale;
uniform float uFoveate;
uniform vec3 uMatColor[8];
uniform float uMatSpec[8];
uniform int uDebug;
${n}
${t}

vec3 sdfNormal(vec3 p){
  const float e = ${l(r)};
  float dx = map(p + vec3(e, 0.0, 0.0)).x - map(p - vec3(e, 0.0, 0.0)).x;
  float dy = map(p + vec3(0.0, e, 0.0)).x - map(p - vec3(0.0, e, 0.0)).x;
  float dz = map(p + vec3(0.0, 0.0, e)).x - map(p - vec3(0.0, 0.0, e)).x;
  return normalize(vec3(dx, dy, dz));
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k){
  // Penumbra form: s = clamp(min_i (k f(p + t_i l) / t_i), 0, 1).
  // Larger k = harder edges. Smooth in the field, so finite differences
  // stay well-behaved if shadows ever enter a solve loop.
  float res = 1.0;
  float t = mint;
  for (int i = 0; i < 24; i++){
    float h = map(ro + rd * t).x;
    if (h < 0.001) return 0.0;
    res = min(res, k * h / t);
    t += h;
    if (t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}

float ambientOcclusion(vec3 p, vec3 n){
  // AO = clamp(1 - k sum_i 2^{-i} (h_i - f(p + h_i n)), 0, 1, with k = 2.
  // Each tap compares the sample height h_i against the field value along
  // the normal; occluded taps (f < h_i) accumulate with halving weight.
  float occ = 0.0;
  float w = 1.0;
  for (int i = 0; i < 5; i++){
    float h = 0.01 + 0.14 * float(i);
    float d = map(p + n * h).x;
    occ += w * (h - d);
    w *= 0.5;
  }
  return clamp(1.0 - 2.0 * occ, 0.0, 1.0);
}

vec2 raymarch(vec3 ro, vec3 rd, int budget){
  float t = 0.0;
  float m = 0.0;
  for (int i = 0; i < ${s}; i++){
    if (i >= budget) break;
    vec3 p = ro + rd * t;
    vec2 h = map(p);
    if (h.x < ${l(r)}) return vec2(t, h.y);
    t += h.x * uStepScale;
    m = h.y;
    if (t > ${l(c)}) break;
  }
  return vec2(-1.0, m);
}

int foveaBudget(vec2 frag){
  // N_steps(e) = N_0 / (1 + e/e_2), e_2 = 2.3 deg. Full budget in the
  // fovea, fewer steps peripherally: math-side XR cost control.
  if (uFoveate < 0.5) return ${s};
  vec2 c = (frag - 0.5 * uResolution) / uResolution.y;
  float eDeg = atan(length(c) * uTanFov) * 57.29578;
  return int(float(${s}) / (1.0 + eDeg / 2.3));
}

void main(){
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  vec3 rd = normalize(uv.x * uCamRight + uv.y * uCamUp + (1.0 / uTanFov) * uCamFwd);
  vec3 ro = uCamPos;
  vec2 res = raymarch(ro, rd, foveaBudget(gl_FragCoord.xy));
  vec3 col;
  if (res.x > 0.0){
    vec3 p = ro + rd * res.x;
    vec3 n = sdfNormal(p);
    if (uDebug == 1){
      float d = clamp(res.x / 40.0, 0.0, 1.0);
      col = vec3(d);
    } else if (uDebug == 2){
      col = n * 0.5 + 0.5;
    } else {
    int mi = int(res.y + 0.5);
    vec3 albedo = uMatColor[mi];
    float specAmt = uMatSpec[mi];
    vec3 l = normalize(uLightDir);
    float dif = max(dot(n, l), 0.0);
    float sh = softShadow(p + n * 0.02, l, 0.02, 24.0, 8.0);
    float ao = ambientOcclusion(p, n);
    vec3 h = normalize(l - rd);
    float spec = pow(max(dot(n, h), 0.0), 48.0) * specAmt;
    vec3 skyAmb = mix(vec3(${i[0]}, ${i[1]}, ${i[2]}),
                      vec3(${o[0]}, ${o[1]}, ${o[2]}), n.y * 0.5 + 0.5);
    col = albedo * (skyAmb * 0.6 * ao + uLightColor * dif * sh) + uLightColor * spec * sh;
    float fog = 1.0 - exp(-0.008 * res.x);
    col = mix(col, vec3(${o[0]}, ${o[1]}, ${o[2]}) * 0.5, fog);
    }
  } else {
    float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    col = mix(vec3(${i[0]}, ${i[1]}, ${i[2]}),
              vec3(${o[0]}, ${o[1]}, ${o[2]}), t);
    float sun = pow(max(dot(rd, normalize(uLightDir)), 0.0), 600.0);
    col += uLightColor * sun * 2.0;
  }
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`}const it=`#version 300 es
layout(location = 0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;function L(t,e,a){const s=t.createShader(e);if(t.shaderSource(s,a),t.compileShader(s),!t.getShaderParameter(s,t.COMPILE_STATUS))throw new Error("Raymarch shader compile failed: "+t.getShaderInfoLog(s));return s}const T=[{color:[.55,.5,.45],spec:.1},{color:[.45,.36,.28],spec:.15},{color:[.5,.42,.38],spec:.3},{color:[.36,.44,.5],spec:.5},{color:[.4,.4,.42],spec:.2},{color:[.55,.5,.45],spec:.1},{color:[.55,.5,.45],spec:.1},{color:[.55,.5,.45],spec:.1}];class lt{constructor(e){this.canvas=e,this.program=null,this.uniCache=new Map,this.vao=null,this.sdfUniformNames=[],this.uniforms={},this.materials=T,this.lightDir=[.5,.8,.3],this.lightColor=[1,.95,.88],this.stepScale=.85,this.omegaCap=1,this.unsafeOmega=!1,this.root=null,this.foveate=!1,this.debugMode=0;const a=e.getContext("webgl2",{antialias:!1});if(!a)throw new Error("WebGL2 not available for the raymarch renderer");this.gl=a}setScene(e,a={}){const s=this.gl,{glsl:c,uniforms:r}=W(e);this.sdfUniformNames=r,this.stepScale=a.stepScale??.85,this.root=e,this.updateOmegaCap();const o=ot(c,r,a),i=s.createProgram();if(s.attachShader(i,L(s,s.VERTEX_SHADER,it)),s.attachShader(i,L(s,s.FRAGMENT_SHADER,o)),s.linkProgram(i),!s.getProgramParameter(i,s.LINK_STATUS))throw new Error("Raymarch program link failed: "+s.getProgramInfoLog(i));if(this.program&&s.deleteProgram(this.program),this.program=i,this.uniCache.clear(),!this.vao){this.vao=s.createVertexArray(),s.bindVertexArray(this.vao);const n=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,n),s.bufferData(s.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),s.STATIC_DRAW),s.enableVertexAttribArray(0),s.vertexAttribPointer(0,2,s.FLOAT,!1,0,0)}}setUniforms(e){Object.assign(this.uniforms,e),this.updateOmegaCap()}setMaterials(e){this.materials=e}setLight(e,a){this.lightDir=e,this.lightColor=a}setStepScale(e){const a=this.unsafeOmega?e:Math.min(e,this.omegaCap);a!==e&&console.warn(`[raymarch] step scale ${e} exceeds 1/L = ${this.omegaCap.toFixed(4)}; clamped`),this.stepScale=Math.min(1,Math.max(.1,a))}setUnsafeOmega(e){this.unsafeOmega=e}setFoveation(e){this.foveate=e}updateOmegaCap(){if(!this.root)return;const e=p(this.root,this.uniforms);this.omegaCap=Number.isFinite(e)&&e>0?Math.min(1,1/e):.85,!this.unsafeOmega&&this.stepScale>this.omegaCap&&(this.stepScale=this.omegaCap)}setDebug(e){this.debugMode=e}uni(e){let a=this.uniCache.get(e);return a===void 0&&(a=this.gl.getUniformLocation(this.program,e),this.uniCache.set(e,a)),a??null}resize(e,a){const s=Math.min(window.devicePixelRatio||1,2);this.canvas.width=Math.floor(e*s),this.canvas.height=Math.floor(a*s)}render(e){const a=this.gl;if(!this.program)throw new Error("setScene() before render()");a.viewport(0,0,this.canvas.width,this.canvas.height),a.useProgram(this.program),a.bindVertexArray(this.vao);const{fwd:s,right:c,up:r}=rt(e),o=Math.tan(e.fovY/2),i=(h,$)=>a.uniform3f(this.uni(h),$[0],$[1],$[2]),n=(h,$)=>a.uniform1f(this.uni(h),$);a.uniform2f(this.uni("uResolution"),this.canvas.width,this.canvas.height),i("uCamPos",e.pos),i("uCamFwd",s),i("uCamRight",c),i("uCamUp",r),n("uTanFov",o),n("uAspect",e.aspect);const l=this.lightDir,u=Math.sqrt(l[0]*l[0]+l[1]*l[1]+l[2]*l[2])||1;i("uLightDir",[l[0]/u,l[1]/u,l[2]/u]),i("uLightColor",this.lightColor);const f=new Float32Array(24),x=new Float32Array(8);for(let h=0;h<8;h++){const $=this.materials[h]??T[0];f[h*3]=$.color[0],f[h*3+1]=$.color[1],f[h*3+2]=$.color[2],x[h]=$.spec}a.uniform3fv(this.uni("uMatColor"),f),a.uniform1fv(this.uni("uMatSpec"),x),a.uniform1i(this.uni("uDebug"),this.debugMode),n("uStepScale",this.stepScale),n("uFoveate",this.foveate?1:0);for(const h of this.sdfUniformNames)n(h,this.uniforms[h]??0);a.drawArrays(a.TRIANGLES,0,3)}}export{lt as R,rt as c,nt as m};
