import{C as vt,T as $t,D as bt,c as xt,p as wt}from"./schemes-CBXqI9vh.js";function M(e,t){return typeof e=="number"?e:t[e.uniform]??0}function L(e,t){return t?[e[0]-t[0],e[1]-t[1],e[2]-t[2]]:e}function E(e,t,n,s){let o=s^Math.imul(e|0,374761393)^Math.imul(t|0,668265263)^Math.imul(n|0,605014474);return o=Math.imul(o^o>>>13,1274126177),o^=o>>>16,(o>>>0)/4294967296}function yt(e,t,n,s){const o=Math.floor(e),a=Math.floor(t),c=Math.floor(n),i=e-o,r=t-a,l=n-c,u=N=>N*N*(3-2*N),h=u(i),m=u(r),f=u(l),d=E(o,a,c,s),$=E(o+1,a,c,s),x=E(o,a+1,c,s),w=E(o+1,a+1,c,s),O=E(o,a,c+1,s),mt=E(o+1,a,c+1,s),Y=E(o,a+1,c+1,s),ft=E(o+1,a+1,c+1,s),G=d+($-d)*h,dt=x+(w-x)*h,W=O+(mt-O)*h,pt=Y+(ft-Y)*h,X=G+(dt-G)*m,gt=W+(pt-W)*m;return X+(gt-X)*f}function Mt(e,t,n,s,o=4){let a=0,c=.5,i=1,r=0;for(let l=0;l<o;l++)a+=c*yt(e*i,t*i,n*i,s+l*131),r+=c,c*=.5,i*=2.03;return a/r}function I(e,t){return{d:t,mat:e.mat??0}}function kt(e,t){return e.d<=t.d?e:t}function St(e,t,n){const s=Math.max(1e-6,n);return Math.min(e,t)-Math.log1p(Math.exp(-s*Math.abs(e-t)))/s}function p(e,t,n={}){switch(e.kind){case"sphere":{const s=L(t,e.c),o=Math.sqrt(s[0]*s[0]+s[1]*s[1]+s[2]*s[2])-M(e.r,n);return I(e,o)}case"box":{const s=L(t,e.c),o=e.b,a=Math.abs(s[0])-o[0],c=Math.abs(s[1])-o[1],i=Math.abs(s[2])-o[2],r=Math.max(a,0),l=Math.max(c,0),u=Math.max(i,0),h=Math.sqrt(r*r+l*l+u*u)+Math.min(Math.max(a,Math.max(c,i)),0);return I(e,h)}case"torus":{const s=L(t,e.c),o=M(e.R,n),a=M(e.r,n),c=Math.sqrt(s[0]*s[0]+s[2]*s[2])-o,i=Math.sqrt(c*c+s[1]*s[1])-a;return I(e,i)}case"capsule":{const s=[t[0]-e.a[0],t[1]-e.a[1],t[2]-e.a[2]],o=[e.b[0]-e.a[0],e.b[1]-e.a[1],e.b[2]-e.a[2]],a=o[0]*o[0]+o[1]*o[1]+o[2]*o[2];let c=a>0?(s[0]*o[0]+s[1]*o[1]+s[2]*o[2])/a:0;c=Math.min(1,Math.max(0,c));const i=[s[0]-o[0]*c,s[1]-o[1]*c,s[2]-o[2]*c],r=Math.sqrt(i[0]*i[0]+i[1]*i[1]+i[2]*i[2])-M(e.r,n);return I(e,r)}case"plane":{const s=t[0]*e.n[0]+t[1]*e.n[1]+t[2]*e.n[2]+e.h;return I(e,s)}case"union":{let s={d:1/0,mat:0};for(const o of e.children)s=kt(s,p(o,t,n));return s}case"smoothUnion":{const s=Math.max(1e-6,M(e.k,n));let o={d:1/0,mat:0};for(const a of e.children){const c=p(a,t,n);if(o.d===1/0){o=c;continue}o={d:St(o.d,c.d,s),mat:o.d<=c.d?o.mat:c.mat}}return o}case"subtract":{const s=p(e.a,t,n),o=p(e.b,t,n);return{d:Math.max(s.d,-o.d),mat:s.mat}}case"intersect":{let s={d:1/0,mat:0};for(const o of e.children){const a=p(o,t,n);a.d>s.d&&(s=a)}return s.d===1/0?{d:1/0,mat:0}:s}case"repeat":{const s=[t[0],t[1],t[2]];for(let o=0;o<3;o++){const a=M(e.c[o],n);a>0&&(s[o]=((t[o]+.5*a)%a+a)%a-.5*a)}return p(e.child,s,n)}case"twist":{const s=M(e.k,n),o=Math.cos(s*t[1]),a=Math.sin(s*t[1]),c=[o*t[0]-a*t[2],t[1],a*t[0]+o*t[2]];return p(e.child,c,n)}case"displace":{const s=M(e.amp,n),o=M(e.freq,n),a=Mt(t[0]*o,t[1]*o,t[2]*o,e.seed),c=p(e.child,t,n);return{d:c.d+s*(a-.5)*2,mat:c.mat}}case"translate":return p(e.child,L(t,e.t),n);case"scale":{const s=M(e.s,n)||1,o=p(e.child,[t[0]/s,t[1]/s,t[2]/s],n);return{d:o.d*s,mat:o.mat}}}}function k(e,t=new Set){const n=s=>{s!==void 0&&typeof s!="number"&&t.add(s.uniform)};switch(e.kind){case"sphere":n(e.r);break;case"torus":n(e.R),n(e.r);break;case"capsule":n(e.r);break;case"smoothUnion":n(e.k),e.children.forEach(s=>k(s,t));break;case"twist":n(e.k),k(e.child,t);break;case"displace":n(e.amp),n(e.freq),k(e.child,t);break;case"scale":n(e.s),k(e.child,t);break;case"union":case"intersect":e.children.forEach(s=>k(s,t));break;case"subtract":k(e.a,t),k(e.b,t);break;case"repeat":e.c.forEach(n),k(e.child,t);break;case"translate":k(e.child,t);break}return t}const Ct=`
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
`;function b(e){return typeof e=="number"?`(${e})`:e.uniform}function C(e){return`vec3(${e[0]}, ${e[1]}, ${e[2]})`}function At(e){return`vec3(${b(e[0])}, ${b(e[1])}, ${b(e[2])})`}let nt=0;function y(e,t){const n=`r${nt++}`,s=o=>`${o.mat??0}.0`;switch(e.kind){case"sphere":{const o=e.c?`(${t} - ${C(e.c)})`:t;return{code:`vec2 ${n} = vec2(length(${o}) - ${b(e.r)}, ${s(e)});`,out:n}}case"box":{const o=e.c?`abs(${t} - ${C(e.c)}) - ${C(e.b)}`:`abs(${t}) - ${C(e.b)}`;return{code:`vec3 ${n}q = ${o};
vec2 ${n} = vec2(length(max(${n}q, 0.0)) + min(max(${n}q.x, max(${n}q.y, ${n}q.z)), 0.0), ${s(e)});`,out:n}}case"torus":{const o=e.c?`(${t} - ${C(e.c)})`:t;return{code:`vec2 ${n}x = vec2(length(${o}.xz) - ${b(e.R)}, ${o}.y);
vec2 ${n} = vec2(length(${n}x) - ${b(e.r)}, ${s(e)});`,out:n}}case"capsule":{const o=C(e.a),a=C(e.b);return{code:`vec3 ${n}pa = ${t} - ${o};
vec3 ${n}ba = ${a} - ${o};
float ${n}h = clamp(dot(${n}pa, ${n}ba) / max(dot(${n}ba, ${n}ba), 1e-8), 0.0, 1.0);
vec2 ${n} = vec2(length(${n}pa - ${n}ba * ${n}h) - ${b(e.r)}, ${s(e)});`,out:n}}case"plane":{const o=C(e.n);return{code:`vec2 ${n} = vec2(dot(${t}, ${o}) + (${e.h}), ${s(e)});`,out:n}}case"union":{const o=e.children.map(i=>y(i,t)),a=o.map(i=>i.code).join(`
`),c=o.map(i=>i.out).reduce((i,r)=>`sdf_min2(${i}, ${r})`);return{code:`${a}
vec2 ${n} = ${c};`,out:n}}case"smoothUnion":{const o=e.children.map(r=>y(r,t)),a=o.map(r=>r.code).join(`
`),c=b(e.k);let i=o[0].out;for(let r=1;r<o.length;r++){const l=o[r].out;i=`vec2(sdf_smin(${i}.x, ${l}.x, ${c}), ${i}.x <= ${l}.x ? ${i}.y : ${l}.y)`}return{code:`${a}
vec2 ${n} = ${i};`,out:n}}case"subtract":{const o=y(e.a,t),a=y(e.b,t);return{code:`${o.code}
${a.code}
vec2 ${n} = vec2(max(${o.out}.x, -${a.out}.x), ${o.out}.y);`,out:n}}case"intersect":{const o=e.children.map(i=>y(i,t)),a=o.map(i=>i.code).join(`
`),c=o.map(i=>i.out).reduce((i,r)=>`sdf_max2(${i}, ${r})`);return{code:`${a}
vec2 ${n} = ${c};`,out:n}}case"repeat":{const o=At(e.c),a=`${n}qp`,c=y(e.child,a);return{code:`vec3 ${a} = ${t};
${[0,1,2].map(i=>`if (${o}[${i}] > 0.0) ${a}[${i}] = mod(${a}[${i}] + 0.5 * ${o}[${i}], ${o}[${i}]) - 0.5 * ${o}[${i}];`).join(`
`)}
${c.code}
vec2 ${n} = ${c.out};`,out:n}}case"twist":{const o=`${n}qp`,a=y(e.child,o);return{code:`float ${n}c = cos(${b(e.k)} * ${t}.y);
float ${n}s = sin(${b(e.k)} * ${t}.y);
vec3 ${o} = vec3(${n}c * ${t}.x - ${n}s * ${t}.z, ${t}.y, ${n}s * ${t}.x + ${n}c * ${t}.z);
${a.code}
vec2 ${n} = ${a.out};`,out:n}}case"displace":{const o=y(e.child,t);return{code:`${o.code}
vec2 ${n} = vec2(${o.out}.x + ${b(e.amp)} * (sdf_fbm(${t} * ${b(e.freq)} + ${e.seed}.0) - 0.5) * 2.0, ${o.out}.y);`,out:n}}case"translate":{const o=y(e.child,`(${t} - ${C(e.t)})`);return{code:o.code+`
vec2 ${n} = ${o.out};`,out:n}}case"scale":{const o=y(e.child,`(${t} / ${b(e.s)})`);return{code:`${o.code}
vec2 ${n} = vec2(${o.out}.x * ${b(e.s)}, ${o.out}.y);`,out:n}}}}function Dt(e){nt=0;const t=[...k(e)].sort(),n=t.map(a=>`uniform float ${a};`).join(`
`),s=y(e,"p");return{glsl:`${Ct}
${n}
vec2 map(vec3 p){
${s.code}
return ${s.out};
}`,uniforms:t}}const Et=.001,qt=100,Rt=128;function _t(e,t,n,s={},o={}){const a=o.maxSteps??Rt,c=o.maxDist??qt,i=o.eps??Et,r=o.stepScale??1;let l=0;for(let h=0;h<a;h++){const m=[t[0]+n[0]*l,t[1]+n[1]*l,t[2]+n[2]*l],f=p(e,m,s);if(f.d<i)return{hit:!0,dist:l,mat:f.mat,pos:m,normal:It(e,m,s),steps:h+1};if(l+=f.d*r,l>c)break}const u=[t[0]+n[0]*l,t[1]+n[1]*l,t[2]+n[2]*l];return{hit:!1,dist:l,mat:0,pos:u,normal:null,steps:a}}function It(e,t,n={},s=1e-4){const o=s,a=p(e,[t[0]+o,t[1],t[2]],n).d-p(e,[t[0]-o,t[1],t[2]],n).d,c=p(e,[t[0],t[1]+o,t[2]],n).d-p(e,[t[0],t[1]-o,t[2]],n).d,i=p(e,[t[0],t[1],t[2]+o],n).d-p(e,[t[0],t[1],t[2]-o],n).d,r=[a,c,i],l=Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2])||1;return[r[0]/l,r[1]/l,r[2]/l]}const Tt=96,Ft=.001,Pt=100;function st(e){const t=[e.target[0]-e.pos[0],e.target[1]-e.pos[1],e.target[2]-e.pos[2]],n=Math.sqrt(t[0]*t[0]+t[1]*t[1]+t[2]*t[2])||1,s=[t[0]/n,t[1]/n,t[2]/n],o=[0,1,0];let a=s[1]*o[2]-s[2]*o[1],c=s[2]*o[0]-s[0]*o[2],i=s[0]*o[1]-s[1]*o[0];const r=Math.sqrt(a*a+c*c+i*i)||1,l=[a/r,c/r,i/r],u=l[1]*s[2]-l[2]*s[1],h=l[2]*s[0]-l[0]*s[2],m=l[0]*s[1]-l[1]*s[0];return{fwd:s,right:l,up:[u,h,m]}}function Lt(e,t,n={}){const s=n.steps??Tt,o=n.maxDist??Pt,a=n.eps??Ft,c=n.stepScale??1,i=n.skyTop??[.12,.2,.35],r=n.skyBottom??[.02,.03,.06];return`#version 300 es
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
uniform vec3 uMatColor[8];
uniform float uMatSpec[8];
uniform int uDebug;
${t.map(u=>`uniform float ${u};`).join(`
`)}
${e}

vec3 sdfNormal(vec3 p){
  const float e = ${a};
  float dx = map(p + vec3(e, 0.0, 0.0)).x - map(p - vec3(e, 0.0, 0.0)).x;
  float dy = map(p + vec3(0.0, e, 0.0)).x - map(p - vec3(0.0, e, 0.0)).x;
  float dz = map(p + vec3(0.0, 0.0, e)).x - map(p - vec3(0.0, 0.0, e)).x;
  return normalize(vec3(dx, dy, dz));
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k){
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
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++){
    float h = 0.01 + 0.12 * float(i) / 4.0;
    float d = map(p + n * h).x;
    occ += (h - d) * sca;
    sca *= 0.95;
  }
  return clamp(1.0 - 2.0 * occ, 0.0, 1.0);
}

vec2 raymarch(vec3 ro, vec3 rd){
  float t = 0.0;
  float m = 0.0;
  for (int i = 0; i < ${s}; i++){
    vec3 p = ro + rd * t;
    vec2 h = map(p);
    if (h.x < ${a}) return vec2(t, h.y);
    t += h.x * ${c};
    m = h.y;
    if (t > ${o}) break;
  }
  return vec2(-1.0, m);
}

void main(){
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  vec3 rd = normalize(uv.x * uCamRight + uv.y * uCamUp + (1.0 / uTanFov) * uCamFwd);
  vec3 ro = uCamPos;
  vec2 res = raymarch(ro, rd);
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
    vec3 skyAmb = mix(vec3(${r[0]}, ${r[1]}, ${r[2]}),
                      vec3(${i[0]}, ${i[1]}, ${i[2]}), n.y * 0.5 + 0.5);
    col = albedo * (skyAmb * 0.6 * ao + uLightColor * dif * sh) + uLightColor * spec * sh;
    float fog = 1.0 - exp(-0.008 * res.x);
    col = mix(col, vec3(${i[0]}, ${i[1]}, ${i[2]}) * 0.5, fog);
    }
  } else {
    float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    col = mix(vec3(${r[0]}, ${r[1]}, ${r[2]}),
              vec3(${i[0]}, ${i[1]}, ${i[2]}), t);
    float sun = pow(max(dot(rd, normalize(uLightDir)), 0.0), 600.0);
    col += uLightColor * sun * 2.0;
  }
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`}const zt=`#version 300 es
layout(location = 0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;function J(e,t,n){const s=e.createShader(t);if(e.shaderSource(s,n),e.compileShader(s),!e.getShaderParameter(s,e.COMPILE_STATUS))throw new Error("Raymarch shader compile failed: "+e.getShaderInfoLog(s));return s}const Q=[{color:[.55,.5,.45],spec:.1},{color:[.45,.36,.28],spec:.15},{color:[.5,.42,.38],spec:.3},{color:[.36,.44,.5],spec:.5},{color:[.4,.4,.42],spec:.2},{color:[.55,.5,.45],spec:.1},{color:[.55,.5,.45],spec:.1},{color:[.55,.5,.45],spec:.1}];class Ut{constructor(t){this.canvas=t,this.program=null,this.uniCache=new Map,this.vao=null,this.sdfUniformNames=[],this.uniforms={},this.materials=Q,this.lightDir=[.5,.8,.3],this.lightColor=[1,.95,.88],this.debugMode=0;const n=t.getContext("webgl2",{antialias:!1});if(!n)throw new Error("WebGL2 not available for the raymarch renderer");this.gl=n}setScene(t,n={}){const s=this.gl,{glsl:o,uniforms:a}=Dt(t);this.sdfUniformNames=a;const c=Lt(o,a,n),i=s.createProgram();if(s.attachShader(i,J(s,s.VERTEX_SHADER,zt)),s.attachShader(i,J(s,s.FRAGMENT_SHADER,c)),s.linkProgram(i),!s.getProgramParameter(i,s.LINK_STATUS))throw new Error("Raymarch program link failed: "+s.getProgramInfoLog(i));if(this.program&&s.deleteProgram(this.program),this.program=i,this.uniCache.clear(),!this.vao){this.vao=s.createVertexArray(),s.bindVertexArray(this.vao);const r=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,r),s.bufferData(s.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),s.STATIC_DRAW),s.enableVertexAttribArray(0),s.vertexAttribPointer(0,2,s.FLOAT,!1,0,0)}}setUniforms(t){Object.assign(this.uniforms,t)}setMaterials(t){this.materials=t}setLight(t,n){this.lightDir=t,this.lightColor=n}setDebug(t){this.debugMode=t}uni(t){let n=this.uniCache.get(t);return n===void 0&&(n=this.gl.getUniformLocation(this.program,t),this.uniCache.set(t,n)),n??null}resize(t,n){const s=Math.min(window.devicePixelRatio||1,2);this.canvas.width=Math.floor(t*s),this.canvas.height=Math.floor(n*s)}render(t){const n=this.gl;if(!this.program)throw new Error("setScene() before render()");n.viewport(0,0,this.canvas.width,this.canvas.height),n.useProgram(this.program),n.bindVertexArray(this.vao);const{fwd:s,right:o,up:a}=st(t),c=Math.tan(t.fovY/2),i=(f,d)=>n.uniform3f(this.uni(f),d[0],d[1],d[2]),r=(f,d)=>n.uniform1f(this.uni(f),d);n.uniform2f(this.uni("uResolution"),this.canvas.width,this.canvas.height),i("uCamPos",t.pos),i("uCamFwd",s),i("uCamRight",o),i("uCamUp",a),r("uTanFov",c),r("uAspect",t.aspect);const l=this.lightDir,u=Math.sqrt(l[0]*l[0]+l[1]*l[1]+l[2]*l[2])||1;i("uLightDir",[l[0]/u,l[1]/u,l[2]/u]),i("uLightColor",this.lightColor);const h=new Float32Array(24),m=new Float32Array(8);for(let f=0;f<8;f++){const d=this.materials[f]??Q[0];h[f*3]=d.color[0],h[f*3+1]=d.color[1],h[f*3+2]=d.color[2],m[f]=d.spec}n.uniform3fv(this.uni("uMatColor"),h),n.uniform1fv(this.uni("uMatSpec"),m),n.uniform1i(this.uni("uDebug"),this.debugMode);for(const f of this.sdfUniformNames)r(f,this.uniforms[f]??0);n.drawArrays(n.TRIANGLES,0,3)}}const Nt=1e-5;function Bt(e,t,n=Nt){const s=t.length,o=new Array(s);for(let a=0;a<s;a++){const c=n*Math.max(1,Math.abs(t[a])),i=t.slice();i[a]=t[a]+c;const r=t.slice();r[a]=t[a]-c,o[a]=(e(i)-e(r))/(2*c)}return o}function jt(e,t,n={}){const s=n.eta??.01,o=n.maxIter??500,a=n.tol??1e-9,c=n.logEvery??25,i=n.project;let r=e.slice();i&&(r=i(r));let l=t(r);const u=[l];let h=0;for(let d=0;d<o;d++){const $=Bt(t,r);for(let w=0;w<r.length;w++)r[w]-=s*$[w];i&&(r=i(r));const x=t(r);if(h=d+1,(d+1)%c===0&&u.push(x),Math.abs(l-x)<a||(l=x,!isFinite(x)))break}const m=t(r);u.push(m);const f=Math.max(1,e.length);return{theta:r,log:{iterations:h,residual:m,rmse:Math.sqrt(2*m/f),history:u}}}function Ht(e,t,n={}){const s=l=>{const u=[l[0],l[1],l[2]],h=Math.max(0,l[3]);return e.map(m=>{const f=u[0]-m.pos[0],d=u[1]-m.pos[1],$=u[2]-m.pos[2],x=Math.sqrt(f*f+d*d+$*$)||1,w=(m.normal[0]*f+m.normal[1]*d+m.normal[2]*$)/x;return h*Math.max(0,w)})},o=l=>{const u=s(l);let h=0;for(let m=0;m<u.length;m++){const f=u[m]-e[m].target;h+=.5*f*f}return h},{theta:a,log:c}=jt([t.position[0],t.position[1],t.position[2],t.intensity],o,{eta:n.eta??.1,maxIter:n.maxIter??2e3,tol:n.tol??1e-10,logEvery:n.logEvery??50,project:l=>[l[0],l[1],l[2],Math.max(0,l[3])]}),i=Math.sqrt(2*c.residual/Math.max(1,e.length)),r=n.rmsePass??.05;return{position:[a[0],a[1],a[2]],intensity:Math.max(0,a[3]),rmse:i,passed:i<=r,log:c}}class Vt{constructor(){this.defs=new Map,this.initial=new Map,this.listeners=new Map,this.global=[]}define(t){const n={...t,value:this.clamp(t,t.value)};this.defs.set(t.name,n),this.initial.set(t.name,n.value)}has(t){return this.defs.has(t)}get(t){const n=this.defs.get(t);if(!n)throw new Error(`unknown param: ${t}`);return n.value}def(t){const n=this.defs.get(t);if(!n)throw new Error(`unknown param: ${t}`);return{...n}}names(){return[...this.defs.keys()]}set(t,n){const s=this.defs.get(t);if(!s)throw new Error(`unknown param: ${t}`);const o=this.clamp(s,n);if(o!==s.value){s.value=o;for(const a of this.listeners.get(t)??[])a(t,o);for(const a of this.global)a(t,o)}}onChange(t,n){const s=this.listeners.get(t)??[];s.push(n),this.listeners.set(t,s)}onAnyChange(t){this.global.push(t)}snapshot(){const t={};for(const[n,s]of this.defs)t[n]=s.value;return t}reset(){for(const[t,n]of this.initial)this.set(t,n)}clamp(t,n){const s=t.step??0;let o=Math.min(t.max,Math.max(t.min,n));return s>0&&(o=Math.round(o/s)*s),Math.min(t.max,Math.max(t.min,o))}}function Kt(e,t,n){e.classList.add("ppe-tuning-deck");for(const s of n){const o=e.ownerDocument.createElement("div");o.className="ppe-deck-section";const a=e.ownerDocument.createElement("h3");a.textContent=s.title,o.appendChild(a);for(const c of s.params)t.has(c)&&o.appendChild(Ot(e.ownerDocument,t,c));for(const[c,i]of Object.entries(s.curves??{}))o.appendChild(Gt(e.ownerDocument,c,i));e.appendChild(o)}}function Ot(e,t,n){const s=t.def(n),o=e.createElement("div");o.className="ppe-param";const a=e.createElement("label");a.textContent=s.unit?`${s.name} (${s.unit})`:s.name,s.drives&&(a.title=`drives: ${s.drives}`);const c=e.createElement("input");c.type="range",c.min=String(s.min),c.max=String(s.max),c.step=String(s.step??(s.max-s.min)/200),c.value=String(s.value),c.setAttribute("aria-label",s.name);const i=e.createElement("span");i.className="ppe-readout";const r=()=>{i.textContent=Wt(t.get(n))};c.addEventListener("input",()=>{t.set(n,parseFloat(c.value)),r()}),t.onChange(n,()=>{c.value=String(t.get(n)),r()}),r();const l=Yt(e,t,n);return o.append(a,c,i,l),o}function Yt(e,t,n){const s=t.def(n),o=e.createElement("div");o.className="ppe-dial",o.setAttribute("role","slider"),o.setAttribute("aria-label",s.name+" dial"),o.tabIndex=0;const a=()=>{const u=(t.get(n)-s.min)/Math.max(1e-9,s.max-s.min);o.style.setProperty("--rot",`${-135+u*270}deg`),o.setAttribute("aria-valuenow",String(t.get(n)))};let c=!1,i=0,r=0;o.addEventListener("pointerdown",u=>{var h,m;c=!0,i=u.clientY,r=t.get(n),(m=(h=u.target).setPointerCapture)==null||m.call(h,u.pointerId)}),o.addEventListener("pointermove",u=>{if(!c)return;const h=s.max-s.min;t.set(n,r+(i-u.clientY)/160*h),a()});const l=()=>{c=!1};return o.addEventListener("pointerup",l),o.addEventListener("pointercancel",l),o.addEventListener("keydown",u=>{const h=s.step??(s.max-s.min)/100;(u.key==="ArrowUp"||u.key==="ArrowRight")&&(t.set(n,t.get(n)+h),a(),u.preventDefault()),(u.key==="ArrowDown"||u.key==="ArrowLeft")&&(t.set(n,t.get(n)-h),a(),u.preventDefault())}),t.onChange(n,a),a(),o}function Gt(e,t,n){const s=e.createElement("div");s.className="ppe-curve";const o=e.createElement("label");o.textContent=t;const a=e.createElement("canvas");a.width=160,a.height=90,a.setAttribute("aria-label",t+" curve editor"),s.append(o,a);const c=a.getContext("2d"),i=()=>{c.clearRect(0,0,a.width,a.height),c.strokeStyle="#38bdf8",c.lineWidth=2,c.beginPath();for(let u=0;u<=40;u++){const h=u/40,m=h*a.width,f=a.height-n.eval(h)*a.height;u===0?c.moveTo(m,f):c.lineTo(m,f)}c.stroke(),c.fillStyle="#fb923c";for(const u of n.points)c.beginPath(),c.arc(u.x*a.width,a.height-u.y*a.height,5,0,Math.PI*2),c.fill()};let r=-1;const l=u=>{const h=a.getBoundingClientRect();return{x:Math.min(1,Math.max(0,(u.clientX-h.left)/h.width)),y:Math.min(1,Math.max(0,1-(u.clientY-h.top)/h.height))}};return a.addEventListener("pointerdown",u=>{var d;const h=l(u);let m=-1,f=1e9;n.points.forEach(($,x)=>{const w=Math.hypot($.x-h.x,$.y-h.y);w<f&&(f=w,m=x)}),r=f<.15?m:-1,r>=0?(d=a.setPointerCapture)==null||d.call(a,u.pointerId):n.addPoint(h.x,h.y),i()}),a.addEventListener("pointermove",u=>{if(r<0)return;const h=l(u);n.movePoint(r,h.x,h.y),i()}),a.addEventListener("pointerup",()=>{r=-1}),i(),s}function Wt(e){return Math.abs(e)>=100?e.toFixed(0):Math.abs(e)>=1?e.toFixed(2):e.toFixed(3)}const Xt=`
.ppe-tuning-deck { font-family: system-ui, sans-serif; color: #e2e8f0; }
.ppe-deck-section { margin-bottom: 14px; }
.ppe-deck-section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #7dd3fc; margin: 0 0 8px; }
.ppe-param { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; margin-bottom: 8px; align-items: center; }
.ppe-param label { font-size: 12px; grid-column: 1 / -1; }
.ppe-param input[type=range] { width: 100%; accent-color: #fb923c; }
.ppe-readout { font-size: 11px; color: #94a3b8; font-variant-numeric: tabular-nums; }
.ppe-dial { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #38bdf8; position: relative; cursor: ns-resize; grid-row: span 1; justify-self: end; }
.ppe-dial::after { content: ''; position: absolute; left: 50%; top: 2px; width: 2px; height: 9px; background: #fb923c; transform-origin: 50% 11px; transform: translateX(-50%) rotate(var(--rot, 0deg)); }
.ppe-curve label { font-size: 12px; }
.ppe-curve canvas { border: 1px solid #1e293b; border-radius: 8px; background: #0b1220; touch-action: none; }
`;function Jt(e,t){const n=Math.min(1,Math.max(0,t));return e.a*n*n+e.b*n+e.c0}function ot(e,t){const n={};for(const s of e.terms)n[s.coeff]=Jt(s,t);return n}function Qt(e,t){const n={};for(const s of e){const o=t[s.name]??.5;Object.assign(n,ot(s,o))}return n}const P=[{name:"Organicness",description:"How living the surfaces feel: fbm displacement amplitude and detail frequency.",terms:[{coeff:"uDisplaceAmp",a:.1,b:.5,c0:0,note:"fbm displacement amplitude in world units"},{coeff:"uDisplaceFreq",a:1,b:3,c0:1.5,note:"fbm domain frequency"}]},{name:"Sharpness",description:"How crisp the blends are: larger exponential smin k hugs min() tighter.",terms:[{coeff:"uBlendK",a:6,b:24,c0:2,note:"exponential smin k; 2 soft up to 32 crisp"}]},{name:"Warp",description:"How twisted space gets: domain twist rate around the vertical axis.",terms:[{coeff:"uTwistK",a:.3,b:.5,c0:0,note:"twist radians per world unit of height"}]},{name:"Spread",description:"How far apart repeated structures sit: repetition cell size.",terms:[{coeff:"uCellSize",a:2,b:4,c0:2,note:"repeat cell size in world units"}]},{name:"Density",description:"How many structures grow: pillar radius and mound height scale.",terms:[{coeff:"uPillarR",a:.2,b:.8,c0:.4,note:"pillar radius in world units"},{coeff:"uMoundH",a:.5,b:1.5,c0:1,note:"mound height scale"}]}];function Zt(){const e={};for(const t of P)Object.assign(e,ot(t,.5));return e}const R=document.getElementById("scene"),te=document.getElementById("status"),B=document.getElementById("solve-log"),ee=document.getElementById("deck"),T=document.getElementById("btn-solve"),Z=document.getElementById("btn-view"),j=document.getElementById("input-scheme"),H=document.getElementById("input-help");function q(e){te.textContent=e}const at={kind:"union",children:[{kind:"displace",amp:{uniform:"uDisplaceAmp"},freq:{uniform:"uDisplaceFreq"},seed:7,child:{kind:"twist",k:{uniform:"uTwistK"},child:{kind:"smoothUnion",k:{uniform:"uBlendK"},children:[{kind:"sphere",c:[-1.3,.9,0],r:1.15,mat:0},{kind:"box",c:[1.3,.8,.2],b:[.95,.8,.95],mat:1},{kind:"torus",c:[0,2.4,-.4],R:.85,r:.3,mat:2}]}}},{kind:"plane",n:[0,1,0],h:.7,mat:3}]};let D;try{D=new Ut(R)}catch(e){throw q("WebGL2 is required for the raymarch renderer: "+e.message),e}D.setScene(at);D.setMaterials([{color:[.85,.36,.26],spec:.25},{color:[.26,.55,.85],spec:.45},{color:[.95,.74,.3],spec:.85},{color:[.33,.43,.3],spec:0}]);const A=Zt();D.setUniforms(A);let v=[-6,4,5],_=1;function it(){const e=Math.hypot(v[0],v[1],v[2])||1;D.setLight([v[0]/e,v[1]/e,v[2]/e],[_,_*.95,_*.88])}it();const g=new vt;g.position=[0,2.4,8.2];g.yaw=0;g.pitch=-.08;const U=new bt,ne=new $t,ct={desktop:U,touch:ne};let K=U;const V={desktop:"WASD move, mouse look (click scene to lock)",touch:"left thumb joystick, right thumb drag to look",xr:"immersive XR is out of scope for this demo build"};async function se(){try{const e=await xt({navigator,matchMedia:window.matchMedia.bind(window)}),t=wt(e,"auto");K=ct[t]??U,H.textContent=V[t]}catch{H.textContent=V.desktop}}j.onchange=()=>{K=ct[j.value]??U,H.textContent=V[j.value]??""};function rt(){const e=Math.cos(g.pitch);return[-Math.sin(g.yaw)*e,Math.sin(g.pitch),-Math.cos(g.yaw)*e]}const lt=document.createElement("style");lt.textContent=Xt;document.head.appendChild(lt);const S=new Vt;S.define({name:"uBlendK",min:1,max:40,value:A.uBlendK,step:.1,drives:"exponential smin k"});S.define({name:"uTwistK",min:-.8,max:.8,value:A.uTwistK,step:.01,drives:"twist radians per unit height"});S.define({name:"uDisplaceAmp",min:0,max:.8,value:A.uDisplaceAmp,step:.01,drives:"fbm displacement amplitude"});S.define({name:"uDisplaceFreq",min:.5,max:8,value:A.uDisplaceFreq,step:.1,drives:"fbm domain frequency"});for(const e of P)S.define({name:"sem:"+e.name,min:0,max:1,value:.5,step:.01,drives:e.name+": g(u) = a*u^2 + b*u + c0"});S.onAnyChange((e,t)=>{if(e.startsWith("sem:")){const n={};for(const o of P)n[o.name]=S.get("sem:"+o.name);const s=Qt(P,n);for(const[o,a]of Object.entries(s))A[o]=a,S.has(o)&&S.set(o,a)}else A[e]=t;D.setUniforms(A)});Kt(ee,S,[{title:"Raw math",params:["uBlendK","uTwistK","uDisplaceAmp","uDisplaceFreq"]},{title:"Semantic",params:P.map(e=>"sem:"+e.name)}]);const tt=["shaded","depth","normal"];let z=0;Z.onclick=()=>{z=(z+1)%tt.length,D.setDebug(z),Z.textContent="View: "+tt[z]};let F=!1;function oe(){const e=rt(),t=[g.position[0]+e[0],g.position[1]+e[1],g.position[2]+e[2]],n=st({pos:g.position,target:t,aspect:R.width/R.height}),s=Math.tan(.5),o=R.width/Math.max(1,R.height),a=Math.hypot(v[0],v[1],v[2])||1,c=[v[0]/a,v[1]/a,v[2]/a],i=[];for(let r=0;r<5;r++)for(let l=0;l<7;l++){const u=(l/6-.5)*.9,h=(r/4-.5)*.9,m=[n.fwd[0]+n.right[0]*u*s*o+n.up[0]*h*s,n.fwd[1]+n.right[1]*u*s*o+n.up[1]*h*s,n.fwd[2]+n.right[2]*u*s*o+n.up[2]*h*s],f=Math.hypot(m[0],m[1],m[2])||1,d=_t(at,g.position,[m[0]/f,m[1]/f,m[2]/f],A);if(!d.hit||!d.normal)continue;const $=d.normal,x=Math.max(0,$[0]*c[0]+$[1]*c[1]+$[2]*c[2]);i.push({pos:d.pos,normal:$,target:Math.min(1,x*1.7+.12)})}return i}function ae(e,t){const n=t.log.history,s=[];s.push(`target: brighten the framed region (${t.log.iterations} samples of the solve)`),s.push(`start light_pos: [${e.map(o=>o.toFixed(2)).join(", ")}]`),s.push(`solved light_pos: [${t.position.map(o=>o.toFixed(2)).join(", ")}]  I=${t.intensity.toFixed(3)}`),s.push(`iterations: ${t.log.iterations}   residual: ${n[0].toExponential(3)} -> ${n[n.length-1].toExponential(3)}`),s.push(`rmse: ${t.rmse.toFixed(5)}   verdict: ${t.passed?"MATCHED":"NOT MATCHED (see residual)"}`),s.push("iteration log (residual per 50 steps):");for(let o=0;o<n.length;o++)s.push(`  step ${(o*50).toString().padStart(4)}  residual ${n[o].toExponential(4)}`);B.textContent=s.join(`
`),B.scrollTop=B.scrollHeight}T.onclick=()=>{F||(F=!0,T.disabled=!0,q("sampling the view on the CPU (depth + normal from the SDF)..."),setTimeout(()=>{try{const e=oe();if(e.length<6){q("no surface in the frame: move the camera toward the world and retry."),F=!1,T.disabled=!1;return}q(`solving: dragging light_pos over ${e.length} samples...`),setTimeout(()=>{const t=[v[0],v[1],v[2]],n=Ht(e,{position:t,intensity:_},{eta:.1,maxIter:2e3});ae(t,n);const s=t,o=n.position,a=_,c=n.intensity,i=performance.now(),r=1600,l=()=>{const u=Math.min(1,(performance.now()-i)/r),h=u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2;v=[s[0]+(o[0]-s[0])*h,s[1]+(o[1]-s[1])*h,s[2]+(o[2]-s[2])*h],_=a+(c-a)*h,it(),u<1?requestAnimationFrame(l):(q(n.passed?"solve converged: render matches the target.":"solve finished with residual: check the log."),F=!1,T.disabled=!1)};l()},30)}catch(e){q("solve failed: "+e.message),F=!1,T.disabled=!1}},30))};function ut(){D.resize(window.innerWidth,window.innerHeight)}window.addEventListener("resize",ut);ut();let et=performance.now();function ht(){const e=performance.now(),t=Math.min(.05,(e-et)/1e3);et=e,K.poll(g,t);const n=rt();D.render({pos:g.position,target:[g.position[0]+n[0],g.position[1]+n[1],g.position[2]+n[2]],fovY:1,aspect:R.width/Math.max(1,R.height)}),requestAnimationFrame(ht)}se().finally(()=>{q("ready: drag the Tuning Deck, or run the inverse-lighting solve."),ht()});
