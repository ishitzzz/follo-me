chrome.runtime.onMessage.addListener((e,t,r)=>{if((e==null?void 0:e.type)==="PING"){r({ok:!0});return}return!1});chrome.runtime.sendMessage({type:"CS_READY"}).catch(()=>{});
