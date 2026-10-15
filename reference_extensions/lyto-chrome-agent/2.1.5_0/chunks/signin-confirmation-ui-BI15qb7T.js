const u="lyto-signin-confirmation-ui";function s(n){if(!n||!(n instanceof HTMLElement))return!1;const t=window.getComputedStyle(n);return t.display!=="none"&&t.visibility!=="hidden"&&t.opacity!=="0"&&n.offsetParent!==null}function p(){const n=document.querySelectorAll('input[type="password"]');for(const t of n){if(!s(t))continue;const i=t.closest("form");if(!i||!s(i))continue;const e=i.querySelector('input[type="email"], input[type="text"], input[name*="user"], input[name*="login"], input[name*="email"], input[autocomplete="username"], input[autocomplete="email"]')||null,o=i.querySelector('button[type="submit"], input[type="submit"], [type="submit"], button:not([type="button"])')||null;return{form:i,passwordInput:t,usernameInput:e&&s(e)?e:null,submitButton:o&&s(o)?o:null}}return null}function d(){return`
    .lyto-signin-confirmation {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483646;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      max-width: 320px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.15);
      border-radius: 12px;
      background: #fff;
      border: 1px solid #e5e7eb;
      overflow: hidden;
    }
    .lyto-signin-confirmation.dark {
      background: #1f2937;
      border-color: #374151;
    }
    .lyto-signin-confirmation-header {
      padding: 12px 16px;
      background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .lyto-signin-confirmation-body {
      padding: 12px 16px;
    }
    .lyto-signin-confirmation-desc {
      margin-bottom: 12px;
      color: #4b5563;
    }
    .lyto-signin-confirmation.dark .lyto-signin-confirmation-desc {
      color: #9ca3af;
    }
    .lyto-signin-confirmation-btn {
      width: 100%;
      padding: 10px 16px;
      border-radius: 8px;
      border: none;
      background: #f97316;
      color: #fff;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .lyto-signin-confirmation-btn:hover {
      background: #ea580c;
    }
    .lyto-signin-confirmation-dismiss {
      margin-top: 8px;
      padding: 6px 12px;
      background: transparent;
      border: none;
      color: #6b7280;
      font-size: 12px;
      cursor: pointer;
    }
  `}function l(){return{header:"Permission to submit login form",desc:"Lyto does NOT read or fill passwords. Fill credentials via Chrome autofill (or manually), then click Submit.",submitButton:"Submit",dismissButton:"OK"}}function m(n,t){var a,c;const i=document.createElement("style");i.textContent=d(),document.head.appendChild(i);const e=l(),o=document.createElement("div");return o.id=u,o.className="lyto-signin-confirmation",o.innerHTML=`
    <div class="lyto-signin-confirmation-header">
      <span>🔐</span>
      <span>${e.header}</span>
    </div>
    <div class="lyto-signin-confirmation-body">
      <p class="lyto-signin-confirmation-desc">${e.desc}</p>
      <button class="lyto-signin-confirmation-btn" data-action="submit">${e.submitButton}</button>
      <button class="lyto-signin-confirmation-dismiss" data-action="dismiss">${e.dismissButton}</button>
    </div>
  `,(a=o.querySelector('[data-action="submit"]'))==null||a.addEventListener("click",()=>{n.submitButton&&n.submitButton.click(),r(),t()}),(c=o.querySelector('[data-action="dismiss"]'))==null||c.addEventListener("click",()=>{r(),t()}),o}function f(n,t){r();const i=m(n,t??(()=>{}));document.body.appendChild(i)}function r(){var n;(n=document.getElementById(u))==null||n.remove()}export{p as detectLoginForm,r as hideSigninConfirmationUI,f as showSigninConfirmationUI};
