function B(n){const s=Math.max(0,Math.floor(n/1e3)),l=Math.floor(s/60),o=s%60;return`${l.toString().padStart(2,"0")}:${o.toString().padStart(2,"0")}`}function w(){if(document.getElementById("lyto-focus-keyframes"))return;const n=document.createElement("style");n.id="lyto-focus-keyframes",n.textContent=`
    @keyframes lyto-fade-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes lyto-slide-up {
      from { transform: translateY(24px) scale(0.94); opacity: 0 }
      to   { transform: translateY(0)    scale(1);    opacity: 1 }
    }
    @keyframes lyto-pulse-ring {
      0%   { box-shadow: 0 0 0   0   rgba(255,122,0,0.4) }
      70%  { box-shadow: 0 0 0  12px rgba(255,122,0,0)   }
      100% { box-shadow: 0 0 0   0   rgba(255,122,0,0)   }
    }
  `,document.head.appendChild(n)}let m=null,c=null;function S(n,s,l=!0){if(b(),!document.body){const t=setInterval(()=>{document.body&&(clearInterval(t),S(n,s,l))},100);return}w();const o=l?{overlayBg:"rgba(0,0,0,0.65)",cardBg:"rgba(8,8,14,0.88)",cardBorder:"rgba(255,122,0,0.5)",cardShadow:"0 0 48px rgba(255,122,0,0.25), 0 20px 60px rgba(0,0,0,0.6)",logo:"rgba(255,122,0,0.7)",timer:"#ffffff",timerShadow:"0 0 30px rgba(255,122,0,0.5)",sub:"rgba(255,122,0,0.6)",goal:"rgba(255,255,255,0.55)"}:{overlayBg:"rgba(0,0,0,0.35)",cardBg:"rgba(255,255,255,0.97)",cardBorder:"rgba(255,122,0,0.3)",cardShadow:"0 0 40px rgba(255,122,0,0.12), 0 20px 60px rgba(0,0,0,0.15)",logo:"rgba(255,122,0,0.75)",timer:"#1a1a2e",timerShadow:"none",sub:"rgba(255,122,0,0.65)",goal:"rgba(30,30,50,0.6)"},i=document.createElement("div");i.id="lyto-focus-cinematic-overlay",i.style.cssText=`
    position:fixed; top:0; left:0; width:100%; height:100%;
    background:rgba(0,0,0,0); z-index:999998;
    display:flex; align-items:center; justify-content:center;
    pointer-events:none !important;
    transition:background 500ms ease;
  `,requestAnimationFrame(()=>{i.style.background=o.overlayBg}),document.body.appendChild(i),m=i;const e=document.createElement("div");e.id="lyto-focus-cinematic-container",e.style.cssText=`
    position:fixed; top:50%; left:50%;
    transform:translate(-50%,-50%) scale(0.85); opacity:0;
    z-index:999999; padding:44px 64px; border-radius:20px;
    background:${o.cardBg}; backdrop-filter:blur(20px);
    border:1.5px solid ${o.cardBorder};
    box-shadow:${o.cardShadow};
    text-align:center; user-select:none;
    transition:all 450ms cubic-bezier(0.2,0.9,0.2,1);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  `;const d=document.createElement("div");d.textContent="lyto",d.style.cssText=`
    color:${o.logo}; font-size:14px; font-weight:800;
    letter-spacing:4px; text-transform:uppercase; margin-bottom:20px;
  `;const p=document.createElement("div"),g=n-Date.now();p.textContent=B(g),p.style.cssText=`
    color:${o.timer}; font-size:88px; font-weight:700; line-height:1;
    text-shadow:${o.timerShadow};
    font-family:-apple-system,BlinkMacSystemFont,"SF Mono","Segoe UI Mono",Menlo,monospace;
    letter-spacing:-2px;
  `;const a=document.createElement("div");if(a.textContent="Focus mode started",a.style.cssText=`
    color:${o.sub}; font-size:13px; font-weight:500;
    letter-spacing:1px; margin-top:12px; text-transform:uppercase;
  `,e.appendChild(d),e.appendChild(p),e.appendChild(a),s){const t=document.createElement("div");t.textContent=s,t.style.cssText=`
      color:${o.goal}; font-size:16px; margin-top:16px;
      font-weight:400; max-width:360px; line-height:1.4;
    `,e.appendChild(t)}document.body.appendChild(e),c=e,requestAnimationFrame(()=>{e.style.transform="translate(-50%,-50%) scale(1)",e.style.opacity="1"}),setTimeout(()=>b(),3e3)}function b(){c&&(c.style.transition="all 350ms ease",c.style.transform="translate(-50%,-50%) scale(0.85)",c.style.opacity="0",setTimeout(()=>{c==null||c.remove(),c=null},350)),m&&(m.style.transition="background 350ms ease",m.style.background="rgba(0,0,0,0)",setTimeout(()=>{m==null||m.remove(),m=null},350))}let u=null;function E(n,s,l=!0){if(x(),!document.body)return;w();const o=l?{overlayBg:"rgba(0,0,0,0.78)",cardBg:"rgba(10,10,18,0.96)",cardBorder:"rgba(255,122,0,0.4)",cardShadow:"0 0 60px rgba(255,122,0,0.18), 0 24px 60px rgba(0,0,0,0.6)",logo:"rgba(255,122,0,0.8)",msg:"#ffffff",goal:"rgba(255,122,0,0.7)"}:{overlayBg:"rgba(0,0,0,0.45)",cardBg:"rgba(255,255,255,0.98)",cardBorder:"rgba(255,122,0,0.25)",cardShadow:"0 0 40px rgba(255,122,0,0.1), 0 24px 60px rgba(0,0,0,0.15)",logo:"rgba(255,122,0,0.75)",msg:"#1a1a2e",goal:"rgba(255,122,0,0.7)"},i=document.createElement("div");i.id="lyto-distraction-overlay",i.style.cssText=`
    position:fixed; top:0; left:0; width:100%; height:100%;
    background:${o.overlayBg}; backdrop-filter:blur(12px);
    z-index:2147483646; display:flex; align-items:center; justify-content:center;
    animation:lyto-fade-in 300ms ease forwards;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    cursor:pointer;
  `;const e=document.createElement("div");e.style.cssText=`
    background:${o.cardBg}; border:1.5px solid ${o.cardBorder};
    border-radius:24px; padding:40px 44px 36px; max-width:420px; width:88%;
    text-align:center;
    box-shadow:${o.cardShadow};
    animation:lyto-slide-up 350ms cubic-bezier(0.2,0.9,0.2,1) forwards;
    cursor:default;
  `;const d=document.createElement("div");d.textContent="lyto",d.style.cssText=`
    color:${o.logo}; font-size:13px; font-weight:800;
    letter-spacing:4px; text-transform:uppercase; margin-bottom:20px;
  `;const p=document.createElement("div");p.textContent="🎯",p.style.cssText="font-size:44px; margin-bottom:18px; line-height:1;";const g=document.createElement("p");if(g.textContent=n,g.style.cssText=`
    color:${o.msg}; font-size:21px; font-weight:600;
    line-height:1.45; margin:0 0 14px; padding:0;
  `,s){const a=document.createElement("p"),t=s.length>60?s.slice(0,57)+"…":s;a.textContent=`Goal: ${t}`,a.style.cssText=`
      color:${o.goal}; font-size:13px; font-weight:500;
      margin:0 0 24px; padding:0; line-height:1.4;
    `,e.appendChild(d),e.appendChild(p),e.appendChild(g),e.appendChild(a)}else e.appendChild(d),e.appendChild(p),e.appendChild(g);{const a=document.createElement("div");a.style.cssText="display:flex; gap:10px; justify-content:center;";const t=document.createElement("button");t.textContent="Close tab",t.style.cssText=`
      background:#ff7a00; color:#fff; border:none; border-radius:50px;
      padding:12px 24px; font-size:14px; font-weight:600; cursor:pointer;
      font-family:inherit; transition:background 180ms, transform 100ms; outline:none; flex:1;
    `,t.onmouseenter=()=>{t.style.background="#e06a00"},t.onmouseleave=()=>{t.style.background="#ff7a00"},t.onmousedown=()=>{t.style.transform="scale(0.97)"},t.onmouseup=()=>{t.style.transform="scale(1)"},t.onclick=f=>{f.stopPropagation(),chrome.runtime.sendMessage({type:"FOCUS_CLOSE_DISTRACTION_TAB"}).catch(()=>{}),x()};const r=document.createElement("button");r.textContent="Stay blocked";const h=l?"rgba(255,122,0,0.12)":"rgba(255,122,0,0.08)",C=l?"rgba(255,255,255,0.6)":"rgba(30,30,50,0.6)",v="rgba(255,122,0,0.3)";r.style.cssText=`
      background:${h}; color:${C}; border:1.5px solid ${v};
      border-radius:50px; padding:12px 24px; font-size:14px; font-weight:500; cursor:pointer;
      font-family:inherit; transition:background 180ms, transform 100ms; outline:none; flex:1;
    `,r.onmouseenter=()=>{r.style.background="rgba(255,122,0,0.2)"},r.onmouseleave=()=>{r.style.background=h},r.onmousedown=()=>{r.style.transform="scale(0.97)"},r.onmouseup=()=>{r.style.transform="scale(1)"},r.onclick=f=>{f.stopPropagation(),a.style.opacity="0.4",a.style.pointerEvents="none";const y=document.createElement("div"),k=l?"rgba(255,122,0,0.5)":"rgba(255,122,0,0.6)";y.textContent="Blocked until focus ends",y.style.cssText=`
        font-size:12px; color:${k}; margin-top:10px; text-align:center;
        font-family:inherit; font-weight:500; letter-spacing:0.5px;
      `,e.appendChild(y)},a.appendChild(t),a.appendChild(r),e.appendChild(a)}i.appendChild(e),document.body.appendChild(i),u=i}function x(){if(u){const n=u;n.style.transition="opacity 250ms ease",n.style.opacity="0",setTimeout(()=>{n.remove()},260),u=null}}function $(){b(),x(),document.querySelectorAll("#lyto-focus-cinematic-overlay, #lyto-focus-cinematic-container, #lyto-distraction-overlay, .lyto-focus-timer, #lyto-focus-timer, #lyto-hud-host").forEach(n=>n.remove()),document.body.style.overflow="",document.body.style.position="",document.documentElement.style.overflow="",document.documentElement.style.position=""}export{$ as cleanupAllFocusUI,x as removeDistractionOverlay,E as showDistractionOverlay,S as startCinematicEntrance,b as stopCinematicEntrance};
