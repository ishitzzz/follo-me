'use strict';
// First-run welcome screen. Prompts Google sign-in (so we can count users) but
// never blocks: "Maybe later" closes and Morph still works anonymously.

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const s = $('status');
  s.textContent = text || '';
  s.className = 'status' + (kind ? ' ' + kind : '');
}

$('signin').addEventListener('click', () => {
  $('signin').disabled = true;
  setStatus('Opening Google sign-in…');
  chrome.runtime.sendMessage({ type: 'morph:signin' }, (r) => {
    if (chrome.runtime.lastError || !r) {
      $('signin').disabled = false;
      setStatus('Couldn’t start sign-in. Please try again.', 'err');
      return;
    }
    if (r.signedIn) {
      $('signin').textContent = '✓ Signed in';
      setStatus('Signed in' + (r.email ? ' as ' + r.email : '') + '. You’re all set — press Alt+M on any page.', 'ok');
      $('later').textContent = 'Close';
    } else if (r.notConfigured) {
      $('signin').disabled = false;
      setStatus('Google sign-in isn’t configured for this build yet.', 'err');
    } else {
      $('signin').disabled = false;
      setStatus('Sign-in was cancelled. You can still use Morph without signing in.', 'err');
    }
  });
});

$('later').addEventListener('click', () => { window.close(); });
