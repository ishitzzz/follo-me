/*
 * Connectors — detect which app the user is on and let them connect it so Morph can
 * pull real data for richer edits (e.g. on Gmail, chart your emails over time).
 *
 * Google apps connect natively via incremental chrome.identity scopes (GCP-native, no
 * extra infra). Non-Google apps (GitHub/X/Notion/…) go through an open-source OAuth
 * layer (Nango, self-hosted) — see CONNECTORS.md. Registry + detect() are pure.
 * Attaches window.Morph.connectors.
 */
(function () {
  'use strict';
  window.Morph = window.Morph || {};

  const STORE_KEY = 'morph:connectors';

  // host regex -> app. Auth is handled by Composio (one key, managed OAuth) via the
  // backend, except `publicData` apps (e.g. GitHub) which need no auth at all.
  const APPS = [
    { id: 'gmail', name: 'Gmail', re: /(^|\.)mail\.google\.com$/i, blurb: 'chart and summarize your inbox' },
    { id: 'gcal', name: 'Google Calendar', re: /(^|\.)calendar\.google\.com$/i, blurb: 'visualize your schedule' },
    { id: 'gdrive', name: 'Google Drive', re: /(^|\.)drive\.google\.com$/i, blurb: 'use your files' },
    { id: 'youtube', name: 'YouTube', re: /(^|\.)youtube\.com$/i, blurb: 'use your subscriptions & history' },
    { id: 'github', name: 'GitHub', re: /(^|\.)github\.com$/i, publicData: true, blurb: 'chart your repos, stars & forks' },
    { id: 'x', name: 'X', re: /(^|\.)(x|twitter)\.com$/i, blurb: 'use your timeline & engagement' },
    { id: 'linkedin', name: 'LinkedIn', re: /(^|\.)linkedin\.com$/i, blurb: 'use your network & posts' },
    { id: 'notion', name: 'Notion', re: /(^|\.)notion\.so$/i, blurb: 'use your pages & databases' },
    { id: 'slack', name: 'Slack', re: /(^|\.)slack\.com$/i, blurb: 'use your channels & messages' },
    { id: 'linear', name: 'Linear', re: /(^|\.)linear\.app$/i, blurb: 'use your issues & cycles' },
  ];

  // Pure: hostname -> app | null.
  function detect(host) {
    const h = String(host || '').toLowerCase();
    return APPS.find((a) => a.re.test(h)) || null;
  }
  function byId(id) { return APPS.find((a) => a.id === id) || null; }

  // GitHub top-level paths that are NOT user/org profiles, so the repo-stars chip
  // and the public-data fetch must skip them. GitHub reserves these names, so they
  // can never be real usernames. Shared by suggestionsFor + fetchGithub so the two
  // can never drift. Not exhaustive, but covers the common landing pages.
  const GH_RESERVED = new Set([
    'orgs', 'organizations', 'settings', 'account', 'notifications', 'search',
    'marketplace', 'explore', 'features', 'pricing', 'about', 'sponsors', 'topics',
    'collections', 'trending', 'new', 'login', 'join', 'pulls', 'issues',
    'dashboard', 'codespaces', 'apps',
  ]);

  // Site-special prompt suggestions surfaced as chips: ONLY where a site unlocks
  // something model-powered (e.g. a GitHub repo chart on a profile page). Returns
  // [] otherwise so the bar stays clean — generic restyle is just typed into the bar.
  function suggestionsFor(host, pathname) {
    const app = detect(host);
    if (app && app.id === 'github') {
      const m = String(pathname || '').match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/?$/);
      if (m && !GH_RESERVED.has(m[1].toLowerCase())) return ['Graph my repo stars'];
    }
    return [];
  }

  function getStore() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORE_KEY, (d) => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve({});
          resolve((d && d[STORE_KEY]) || {});
        });
      } catch (_) { resolve({}); }
    });
  }
  function setStore(map) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set({ [STORE_KEY]: map }, () => resolve()); }
      catch (_) { resolve(); }
    });
  }

  async function isConnected(appId) {
    const s = await getStore();
    return !!(s[appId] && s[appId].connected);
  }
  async function setConnected(appId, connected) {
    const s = await getStore();
    if (connected) s[appId] = { connected: true, connectedAt: Date.now() };
    else delete s[appId];
    await setStore(s);
  }
  async function listConnected() {
    const s = await getStore();
    return Object.keys(s).filter((k) => s[k] && s[k].connected);
  }

  // --- data pull (no-OAuth public sources) ---------------------------------
  // For publicData apps, fetch REAL records to (a) enrich the model context and
  // (b) feed the trusted renderData chart op. fetchSiteDataset returns
  //   { key, text, dataset: { fields, records } } | null
  // fetchSiteData stays (text only) for back-compat callers.
  async function fetchSiteData(app, loc) {
    const r = await fetchSiteDataset(app, loc);
    return r ? r.text : '';
  }

  async function fetchSiteDataset(app, loc) {
    try {
      if (!app) return null;
      if (app.id === 'github') return await fetchGithub(loc || location);
      return null;
    } catch (_) { return null; }
  }

  async function fetchGithub(loc) {
    const m = String((loc && loc.pathname) || '').match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/?$/);
    if (!m) return null; // only on a user/org profile root
    const user = m[1];
    if (GH_RESERVED.has(user.toLowerCase())) return null;
    const r = await fetch('https://api.github.com/users/' + user + '/repos?per_page=100&sort=pushed', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) return null;
    const repos = await r.json();
    return githubDataset(repos, user);
  }

  // Pure: raw GitHub /repos array -> { key, text, dataset } | null. Records are
  // TYPED (numbers are numbers) so renderData can chart them without the model
  // ever transcribing a value. The text tells the model the dataKey + field names.
  function githubDataset(repos, user) {
    if (!Array.isArray(repos) || !repos.length) return null;
    const all = repos.map((x) => ({
      name: String((x && x.name) || ''),
      stars: Number((x && x.stargazers_count) || 0) || 0,
      forks: Number((x && x.forks_count) || 0) || 0,
    }));
    // total reflects ALL repos; the charted records are capped at the top 60 by stars.
    const total = all.reduce((s, r) => s + r.stars, 0);
    const records = all.sort((a, b) => b.stars - a.stars).slice(0, 60);
    const lines = records.map((r) => `${r.name}: ${r.stars} stars, ${r.forks} forks`);
    const text =
      `CONNECTOR DATA — GitHub public repos for @${user} (total stars: ${total}).\n` +
      `To chart this, emit op "renderData" with dataKey:"github", x:"name", y:"stars" (or y:"forks").\n` +
      `Records:\n` + lines.join('\n');
    return { key: 'github', text, dataset: { fields: ['name', 'stars', 'forks'], records } };
  }

  window.Morph.connectors = {
    APPS, detect, byId, suggestionsFor, isConnected, setConnected, listConnected,
    fetchSiteData, fetchSiteDataset, githubDataset, STORE_KEY,
  };
})();
