const OS = (() => {
  let token = localStorage.getItem('oh_token') || '';

  // ===== API Layer =====
  async function api(path, opts = {}) {
    if (!token) { promptToken(); return { error: 'No token' }; }
    const headers = { 'Authorization': `Bearer ${token}`, ...opts.headers };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      ...opts,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { promptToken(); return { error: 'Unauthorized' }; }
    return res.json();
  }

  function promptToken() {
    showWelcome();
  }

  function showWelcome() {
    document.getElementById('app').style.display = 'none';
    document.getElementById('welcome-screen').classList.remove('hidden');
    const input = document.getElementById('welcome-token');
    input.value = '';
    input.focus();
    document.getElementById('welcome-error').classList.add('hidden');
    document.getElementById('welcome-login').classList.remove('hidden');
    document.getElementById('welcome-setup').classList.add('hidden');
  }

  async function welcomeLogin() {
    const input = document.getElementById('welcome-token');
    const t = input.value.trim();
    const errEl = document.getElementById('welcome-error');
    if (!t) { errEl.textContent = 'Please enter your admin token'; errEl.classList.remove('hidden'); return; }

    try {
      const res = await fetch('/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t }),
      });
      if (!res.ok) {
        errEl.textContent = 'Invalid token. Check config/openhinge.json for the correct token.';
        errEl.classList.remove('hidden');
        input.select();
        return;
      }
      const data = await res.json();
      token = t;
      localStorage.setItem('oh_token', t);
      errEl.classList.add('hidden');

      // Go straight to dashboard
      welcomeGo();
    } catch {
      errEl.textContent = 'Could not connect to server';
      errEl.classList.remove('hidden');
    }
  }

  function welcomeGo() {
    document.getElementById('welcome-screen').classList.add('hidden');
    document.getElementById('app').style.display = '';
    const startPage = window.location.hash.replace('#', '') || 'dashboard';
    navigate(titles[startPage] ? startPage : 'dashboard', false);
  }

  // Enter key on token input
  document.getElementById('welcome-token')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') welcomeLogin();
  });

  // ===== Toast =====
  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ===== Navigation =====
  const titles = {
    dashboard: 'Dashboard', providers: 'Providers', souls: 'Souls',
    keys: 'API Keys', usage: 'Usage', logs: 'Request Logs',
    cloudflare: 'Cloudflare', settings: 'Settings', docs: 'Documentation',
  };

  function navigate(page, pushHash = true) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const el = document.getElementById(`page-${page}`);
    if (el) el.classList.add('active');
    const nav = document.querySelector(`[data-page="${page}"]`);
    if (nav) nav.classList.add('active');
    document.getElementById('page-title').textContent = titles[page] || page;
    if (pushHash) window.location.hash = page === 'dashboard' ? '' : page;
    loaders[page]?.();
  }

  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); navigate(el.dataset.page); });
  });

  // Hash-based URL routing
  window.addEventListener('hashchange', () => {
    const page = window.location.hash.replace('#', '') || 'dashboard';
    if (titles[page]) navigate(page, false);
  });

  // ===== Modal =====
  function openModal(title, html) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-overlay').classList.remove('hidden');
  }
  function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); }

  // ===== Helpers =====
  const h = s => s?.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) || '';
  const ago = ts => { if (!ts) return '—'; const s = Math.floor((Date.now() - new Date(ts + 'Z').getTime()) / 1000); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s/60)}m ago`; if (s < 86400) return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`; };
  const num = n => n != null ? n.toLocaleString() : '0';

  function healthBadge(status) {
    const m = { healthy: 'success', degraded: 'warning', down: 'danger', unknown: 'muted' };
    return `<span class="badge badge-${m[status] || 'muted'}"><span class="badge-dot"></span>${status}</span>`;
  }

  function providerBadge(type) {
    const colors = { claude: 'primary', openai: 'success', gemini: 'warning', ollama: 'muted' };
    return `<span class="badge badge-${colors[type] || 'muted'}">${type}</span>`;
  }

  // ===== Cached data =====
  let _providers = [];
  let _souls = [];

  async function loadProvidersList() {
    const { data } = await api('/admin/providers');
    _providers = data || [];
    return _providers;
  }

  async function loadSoulsList() {
    const { data } = await api('/admin/souls');
    _souls = data || [];
    return _souls;
  }

  // ===== Page Loaders =====
  const loaders = {};

  // -- Dashboard --
  loaders.dashboard = async () => {
    const el = document.getElementById('page-dashboard');
    const [status, logs] = await Promise.all([
      api('/admin/system/status'),
      api('/admin/cost/logs?limit=5'),
    ]);

    el.innerHTML = `
      <div class="stats-grid">
        ${statCard('Providers', status.providers, 'Active connections')}
        ${statCard('Souls', status.souls, 'AI endpoints')}
        ${statCard('API Keys', status.api_keys, 'Active keys')}
        ${statCard('Requests Today', num(status.today_requests), `${num(status.total_requests)} total`)}
        ${statCard('Memory', `${status.memory?.heap || 0} MB`, `Uptime: ${formatUptime(status.uptime)}`)}
      </div>

      <div class="card">
        <div class="card-header"><h3>Recent Requests</h3></div>
        ${logs.data?.length ? `<div class="table-wrapper" style="border:none">
          <table><thead><tr><th>Soul</th><th>Provider</th><th>Tokens</th><th>Latency</th><th>Time</th></tr></thead>
          <tbody>${logs.data.map(l => `<tr>
            <td><code>${h(l.soul_name || '—')}</code></td>
            <td>${h(l.provider_name || '—')}</td>
            <td class="text-mono">${num(l.input_tokens)}/${num(l.output_tokens)}</td>
            <td class="text-mono">${l.latency_ms}ms</td>
            <td class="text-muted text-sm">${ago(l.created_at)}</td>
          </tr>`).join('')}</tbody></table>
        </div>` : '<p class="text-muted text-sm" style="padding:16px">No requests yet</p>'}
      </div>
    `;

    // Update server status
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    dot.classList.add('online');
    text.textContent = `v${status.version || '0.1.0'}`;
  };

  function statCard(label, value, sub) {
    return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub || ''}</div></div>`;
  }
  function formatUptime(s) { if (!s) return '—'; const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); return h > 0 ? `${h}h ${m}m` : `${m}m`; }

  // -- Providers --
  let _provFilter = { search: '', type: '', health: '', enabled: '' };
  let _provSelected = new Set();

  loaders.providers = async () => {
    const allData = await loadProvidersList();
    const el = document.getElementById('page-providers');

    // Apply client-side filters
    let data = allData;
    if (_provFilter.search) {
      const q = _provFilter.search.toLowerCase();
      data = data.filter(p => p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q));
    }
    if (_provFilter.type) data = data.filter(p => p.type === _provFilter.type);
    if (_provFilter.health) data = data.filter(p => p.health_status === _provFilter.health);
    if (_provFilter.enabled === '1') data = data.filter(p => p.is_enabled);
    if (_provFilter.enabled === '0') data = data.filter(p => !p.is_enabled);

    // Clean up selected set
    const dataIds = new Set(data.map(p => p.id));
    for (const id of _provSelected) { if (!dataIds.has(id)) _provSelected.delete(id); }
    const selCount = _provSelected.size;
    const allSelected = data.length > 0 && selCount === data.length;

    const types = [...new Set(allData.map(p => p.type))];
    const hasFilters = _provFilter.search || _provFilter.type || _provFilter.health || _provFilter.enabled;

    const enabledBadge = (p) => p.is_enabled
      ? '<span class="badge badge-success" style="font-size:10px">On</span>'
      : '<span class="badge badge-muted" style="font-size:10px">Off</span>';

    el.innerHTML = `
      <div class="section-header">
        <div><h2>LLM Providers</h2><p>${allData.length} provider${allData.length !== 1 ? 's' : ''} configured</p></div>
        <button class="btn btn-primary" onclick="OS.addProviderModal()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Provider
        </button>
      </div>

      <div class="log-toolbar">
        <div class="log-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" placeholder="Search providers..." value="${h(_provFilter.search)}" onkeydown="if(event.key==='Enter')OS.provFilter('search',this.value)" onblur="OS.provFilter('search',this.value)">
        </div>
        <div class="log-divider"></div>
        <div class="log-filters">
          <select onchange="OS.provFilter('type',this.value)">
            <option value="">All Types</option>
            ${types.map(t => `<option value="${h(t)}" ${_provFilter.type===t?'selected':''}>${t}</option>`).join('')}
          </select>
          <select onchange="OS.provFilter('health',this.value)">
            <option value="" ${!_provFilter.health?'selected':''}>All Health</option>
            <option value="healthy" ${_provFilter.health==='healthy'?'selected':''}>Healthy</option>
            <option value="degraded" ${_provFilter.health==='degraded'?'selected':''}>Degraded</option>
            <option value="down" ${_provFilter.health==='down'?'selected':''}>Down</option>
          </select>
          <select onchange="OS.provFilter('enabled',this.value)">
            <option value="" ${!_provFilter.enabled?'selected':''}>All Status</option>
            <option value="1" ${_provFilter.enabled==='1'?'selected':''}>Enabled</option>
            <option value="0" ${_provFilter.enabled==='0'?'selected':''}>Disabled</option>
          </select>
          ${hasFilters ? `<button class="log-clear" onclick="OS.provClearFilters()">Clear</button>` : ''}
        </div>
      </div>

      ${selCount > 0 ? `<div class="bulk-bar">
        <span class="bulk-count">${selCount} selected</span>
        <div class="bulk-actions">
          <button class="btn btn-ghost btn-sm" onclick="OS.provBulk('health')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            Health Check
          </button>
          <button class="btn btn-ghost btn-sm" onclick="OS.provBulk('enable')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Enable
          </button>
          <button class="btn btn-ghost btn-sm" onclick="OS.provBulk('disable')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            Disable
          </button>
          <button class="btn btn-ghost btn-sm" style="color:var(--destructive)" onclick="OS.provBulk('delete')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Delete
          </button>
        </div>
        <button class="btn btn-ghost btn-sm text-muted" onclick="OS.provSelectNone()">Deselect all</button>
      </div>` : ''}

      ${data?.length ? `<div class="table-wrapper"><table>
        <thead><tr>
          <th style="width:36px;padding-right:0"><input type="checkbox" style="width:auto" ${allSelected?'checked':''} onchange="OS.provSelectAll(this.checked)"></th>
          <th>Name</th>
          <th>Type</th>
          <th>Priority</th>
          <th>Enabled</th>
          <th>Health</th>
          <th>Last Check</th>
          <th></th>
        </tr></thead>
        <tbody>${data.map(p => `<tr class="${_provSelected.has(p.id)?'row-selected':''}">
          <td style="padding-right:0"><input type="checkbox" style="width:auto" ${_provSelected.has(p.id)?'checked':''} onchange="OS.provToggle('${p.id}',this.checked)"></td>
          <td style="color:var(--text);font-weight:500">${h(p.name)}</td>
          <td>${providerBadge(p.type)}</td>
          <td class="text-mono">${p.priority}</td>
          <td>${enabledBadge(p)}</td>
          <td>${healthBadge(p.health_status)}</td>
          <td class="text-muted text-sm">${ago(p.last_health_check)}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-ghost btn-icon btn-sm" title="Health Check" onclick="event.stopPropagation();OS.healthCheckOne('${p.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick="event.stopPropagation();OS.editProviderModal('${p.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon btn-sm" title="Delete" onclick="event.stopPropagation();OS.deleteProvider('${p.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState('No providers found', hasFilters ? 'Try adjusting your filters.' : 'Add a provider to start routing AI requests.')}

      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" onclick="OS.healthCheck()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          Run All Health Checks
        </button>
      </div>
    `;
  };

  // -- Souls --
  loaders.souls = async () => {
    const [souls, providers] = await Promise.all([loadSoulsList(), loadProvidersList()]);
    const el = document.getElementById('page-souls');

    const providerName = id => { const p = providers.find(p => p.id === id); return p ? p.name : '—'; };

    el.innerHTML = `
      <div class="section-header">
        <div><h2>Souls</h2><p>AI personas with system prompts and custom endpoints</p></div>
        <button class="btn btn-primary" onclick="OS.addSoulModal()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Soul
        </button>
      </div>
      ${souls?.length ? `<div class="table-wrapper"><table>
        <thead><tr><th>Name</th><th>Endpoint</th><th>Provider</th><th>Model</th><th>Status</th><th></th></tr></thead>
        <tbody>${souls.map(s => `<tr>
          <td style="color:var(--text);font-weight:500">${h(s.name)}</td>
          <td><code class="text-sm">/v1/souls/${h(s.slug)}/chat/completions</code></td>
          <td>${s.provider_id ? h(providerName(s.provider_id)) : '<span class="text-muted">Default</span>'}</td>
          <td class="text-mono text-sm">${h(s.model || 'default')}</td>
          <td>${s.is_enabled ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-muted">Disabled</span>'}</td>
          <td style="text-align:right">
            <button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick="OS.editSoulModal('${s.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon btn-sm" title="Delete" onclick="OS.deleteSoul('${s.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState('No souls configured', 'Create a soul to define an AI endpoint with a system prompt.')}
    `;
  };

  // -- Keys --
  loaders.keys = async () => {
    const [{ data }, souls] = await Promise.all([api('/admin/keys'), loadSoulsList()]);
    const el = document.getElementById('page-keys');

    const soulName = id => { const s = souls.find(s => s.id === id); return s ? s.name : id?.slice(0, 8); };
    const soulBadges = (k) => {
      if (k.soul_ids && k.soul_ids.length > 0) {
        return k.soul_ids.map(id => `<span class="badge badge-primary" style="margin:1px">${h(soulName(id))}</span>`).join('');
      }
      if (k.soul_id) return `<span class="badge badge-primary">${h(soulName(k.soul_id))}</span>`;
      return '<span class="badge badge-success">All souls</span>';
    };

    el.innerHTML = `
      <div class="section-header">
        <div><h2>API Keys</h2><p>Manage access tokens for consumers</p></div>
        <button class="btn btn-primary" onclick="OS.createKeyModal()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Create Key
        </button>
      </div>
      ${data?.length ? `<div class="table-wrapper"><table>
        <thead><tr><th>Name</th><th>Prefix</th><th>Souls</th><th>Rate Limit</th><th>Requests</th><th>Last Used</th><th></th></tr></thead>
        <tbody>${data.map(k => `<tr>
          <td style="color:var(--text);font-weight:500">${h(k.name)}</td>
          <td><code>${h(k.key_prefix)}...</code></td>
          <td>${soulBadges(k)}</td>
          <td class="text-mono">${k.rate_limit_rpm}/min</td>
          <td class="text-mono">${num(k.total_requests)}</td>
          <td class="text-muted text-sm">${ago(k.last_used_at)}</td>
          <td style="text-align:right">
            <button class="btn btn-ghost btn-icon btn-sm" title="Revoke" onclick="OS.revokeKey('${k.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            </button>
            <button class="btn btn-ghost btn-icon btn-sm" title="Delete" onclick="OS.deleteKey('${k.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState('No API keys', 'Create a key to authenticate API consumers.')}
    `;
  };

  // -- Usage --
  loaders.usage = async () => {
    const el = document.getElementById('page-usage');
    const [report, bySoul] = await Promise.all([
      api('/admin/cost/report?days=30'),
      api('/admin/cost/by-soul?days=30'),
    ]);

    const totalReqs = (report.data || []).reduce((s, r) => s + (r.requests || 0), 0);
    const totalInput = (report.data || []).reduce((s, r) => s + (r.input_tokens || 0), 0);
    const totalOutput = (report.data || []).reduce((s, r) => s + (r.output_tokens || 0), 0);

    el.innerHTML = `
      <div class="section-header"><div><h2>Usage</h2><p>Last 30 days</p></div></div>
      <div class="stats-grid" style="grid-template-columns: repeat(3, 1fr)">
        ${statCard('Total Requests', num(totalReqs), '30-day period')}
        ${statCard('Input Tokens', num(totalInput), '30-day period')}
        ${statCard('Output Tokens', num(totalOutput), '30-day period')}
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-header"><h3>Daily Breakdown</h3></div>
          ${report.data?.length ? `<div class="table-wrapper" style="border:none"><table>
            <thead><tr><th>Date</th><th>Requests</th><th>Input</th><th>Output</th></tr></thead>
            <tbody>${report.data.map(r => `<tr>
              <td>${r.date}</td><td class="text-mono">${num(r.requests)}</td>
              <td class="text-mono">${num(r.input_tokens)}</td><td class="text-mono">${num(r.output_tokens)}</td>
            </tr>`).join('')}</tbody>
          </table></div>` : '<p class="text-muted text-sm" style="padding:16px">No data</p>'}
        </div>

        <div class="card">
          <div class="card-header"><h3>Usage by Soul</h3></div>
          ${bySoul.data?.length ? `<div class="table-wrapper" style="border:none"><table>
            <thead><tr><th>Soul</th><th>Requests</th><th>Tokens</th></tr></thead>
            <tbody>${bySoul.data.map(s => `<tr>
              <td><code>${h(s.slug)}</code></td><td class="text-mono">${num(s.requests)}</td><td class="text-mono">${num((s.input_tokens||0)+(s.output_tokens||0))}</td>
            </tr>`).join('')}</tbody>
          </table></div>` : '<p class="text-muted text-sm" style="padding:16px">No data</p>'}
        </div>
      </div>
    `;
  };

  // -- Logs --
  let _logFilters = { page: 1, per_page: 50, soul_id: '', provider_id: '', status: '', model: '', search: '', sort: 'created_at', order: 'desc' };

  loaders.logs = async () => {
    const el = document.getElementById('page-logs');

    // Load filter options
    const [souls, providers] = await Promise.all([loadSoulsList(), loadProvidersList()]);

    // Build query string
    const params = new URLSearchParams();
    params.set('page', String(_logFilters.page));
    params.set('per_page', String(_logFilters.per_page));
    if (_logFilters.soul_id) params.set('soul_id', _logFilters.soul_id);
    if (_logFilters.provider_id) params.set('provider_id', _logFilters.provider_id);
    if (_logFilters.status) params.set('status', _logFilters.status);
    if (_logFilters.model) params.set('model', _logFilters.model);
    if (_logFilters.search) params.set('search', _logFilters.search);
    if (_logFilters.sort) params.set('sort', _logFilters.sort);
    if (_logFilters.order) params.set('order', _logFilters.order);

    const result = await api(`/admin/cost/logs/query?${params.toString()}`);
    const { data, total, page, per_page, pages } = result;

    const hasFilters = _logFilters.search || _logFilters.soul_id || _logFilters.provider_id || _logFilters.status || _logFilters.model;

    const sortArrow = (col) => {
      if (_logFilters.sort !== col) return '';
      return `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-left:3px;vertical-align:middle"><path d="${_logFilters.order === 'asc' ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'}"/></svg>`;
    };
    const thClass = (col) => `sortable${_logFilters.sort === col ? ' sorted' : ''}`;

    const soulOpts = (souls || []).map(s => `<option value="${h(s.id)}" ${_logFilters.soul_id === s.id ? 'selected' : ''}>${h(s.name)}</option>`).join('');
    const provOpts = (providers || []).map(p => `<option value="${h(p.id)}" ${_logFilters.provider_id === p.id ? 'selected' : ''}>${h(p.name)}</option>`).join('');

    // Pagination range
    const pageNums = [];
    const maxVisible = 5;
    let pStart = Math.max(1, page - Math.floor(maxVisible / 2));
    let pEnd = Math.min(pages, pStart + maxVisible - 1);
    if (pEnd - pStart < maxVisible - 1) pStart = Math.max(1, pEnd - maxVisible + 1);
    for (let i = pStart; i <= pEnd; i++) pageNums.push(i);

    el.innerHTML = `
      <div class="section-header"><div><h2>Request Logs</h2><p>${num(total)} total request${total !== 1 ? 's' : ''}</p></div></div>

      <div class="log-toolbar">
        <div class="log-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" placeholder="Search by model, soul, provider, error..." value="${h(_logFilters.search)}" onkeydown="if(event.key==='Enter')OS.logFilter('search',this.value)">
        </div>
        <div class="log-divider"></div>
        <div class="log-filters">
          <select onchange="OS.logFilter('soul_id',this.value)">
            <option value="">All Souls</option>${soulOpts}
          </select>
          <select onchange="OS.logFilter('provider_id',this.value)">
            <option value="">All Providers</option>${provOpts}
          </select>
          <select onchange="OS.logFilter('status',this.value)">
            <option value="" ${!_logFilters.status?'selected':''}>All Status</option>
            <option value="success" ${_logFilters.status==='success'?'selected':''}>Success</option>
            <option value="error" ${_logFilters.status==='error'?'selected':''}>Error</option>
            <option value="rate_limited" ${_logFilters.status==='rate_limited'?'selected':''}>Rate Limited</option>
            <option value="budget_exceeded" ${_logFilters.status==='budget_exceeded'?'selected':''}>Budget Exceeded</option>
          </select>
          <select onchange="OS.logFilter('per_page',this.value)">
            ${[25,50,100].map(n => `<option value="${n}" ${_logFilters.per_page===n?'selected':''}>${n} rows</option>`).join('')}
          </select>
          ${hasFilters ? `<button class="log-clear" onclick="OS.logClearFilters()">Clear</button>` : ''}
        </div>
      </div>

      ${data?.length ? `<div class="table-wrapper"><table>
        <thead><tr>
          <th class="${thClass('created_at')}" onclick="OS.logSort('created_at')">Time${sortArrow('created_at')}</th>
          <th>Key</th>
          <th>Soul</th>
          <th>Provider</th>
          <th class="${thClass('model')}" onclick="OS.logSort('model')">Model${sortArrow('model')}</th>
          <th class="${thClass('input_tokens')}" onclick="OS.logSort('input_tokens')">In${sortArrow('input_tokens')}</th>
          <th class="${thClass('output_tokens')}" onclick="OS.logSort('output_tokens')">Out${sortArrow('output_tokens')}</th>
          <th class="${thClass('latency_ms')}" onclick="OS.logSort('latency_ms')">Latency${sortArrow('latency_ms')}</th>
          <th class="${thClass('status')}" onclick="OS.logSort('status')">Status${sortArrow('status')}</th>
        </tr></thead>
        <tbody>${data.map(l => `<tr class="log-row" onclick="OS.logDetail('${h(l.request_id || '')}')">
          <td class="text-muted text-sm" style="white-space:nowrap">${ago(l.created_at)}</td>
          <td class="text-sm">${h(l.key_name || '—')}</td>
          <td><code class="text-sm">${h(l.soul_name || '—')}</code></td>
          <td class="text-sm">${h(l.provider_name || '—')}</td>
          <td class="text-mono text-sm truncate" style="max-width:140px">${h(l.model)}</td>
          <td class="text-mono text-sm">${num(l.input_tokens)}</td>
          <td class="text-mono text-sm">${num(l.output_tokens)}</td>
          <td class="text-mono text-sm">${l.latency_ms}ms</td>
          <td>${l.status === 'success' ? '<span class="badge badge-success">OK</span>' : `<span class="badge badge-danger">${h(l.status)}</span>`}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState('No requests found', hasFilters ? 'Try adjusting your filters.' : 'Send a request to see it logged here.')}

      ${pages > 1 ? `<div class="log-pagination">
        <span class="page-info">Showing ${(page-1)*per_page+1}–${Math.min(page*per_page, total)} of ${num(total)}</span>
        <div class="page-btns">
          <button class="page-btn" onclick="OS.logPage(${page-1})" ${page<=1?'disabled':''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          ${pageNums.map(n => `<button class="page-btn${n===page?' active':''}" onclick="OS.logPage(${n})">${n}</button>`).join('')}
          <button class="page-btn" onclick="OS.logPage(${page+1})" ${page>=pages?'disabled':''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
      </div>` : ''}
    `;
  };

  // -- Cloudflare --
  loaders.cloudflare = async () => {
    const { data } = await api('/admin/settings/cloudflare');
    const cf = data || {};
    const el = document.getElementById('page-cloudflare');

    const isConfigured = cf.enabled && cf.hostname && cf.domain;
    const fullDomain = cf.hostname && cf.domain ? `${cf.hostname}.${cf.domain}` : '';

    // Fetch live status if configured
    let tunnelStatus = null;
    let localStatus = null;
    if (isConfigured && cf.api_token && cf.account_id && cf.tunnel_id) {
      const [tsRes, lsRes] = await Promise.all([
        api('/admin/cloudflare/tunnel-status', { method: 'POST', body: { api_token: cf.api_token, account_id: cf.account_id, tunnel_id: cf.tunnel_id } }),
        api('/admin/cloudflare/local-status'),
      ]);
      tunnelStatus = tsRes.data || null;
      localStatus = lsRes.data || null;
    }

    const statusBadge = tunnelStatus
      ? (tunnelStatus.is_connected
          ? `<span class="badge badge-success"><span class="badge-dot"></span>Connected (${tunnelStatus.connections?.length || 0} conn${(tunnelStatus.connections?.length || 0) !== 1 ? 's' : ''})</span>`
          : `<span class="badge badge-danger"><span class="badge-dot"></span>Disconnected</span>`)
      : (isConfigured ? '<span class="badge badge-muted">Unknown</span>' : '');

    const localBadge = localStatus
      ? (localStatus.running
          ? `<span class="badge badge-success" style="font-size:10px">cloudflared running (PID ${localStatus.pid})</span>`
          : '<span class="badge badge-warning" style="font-size:10px">cloudflared not running</span>')
      : '';

    el.innerHTML = `
      <div class="section-header"><div><h2>Cloudflare</h2><p>Tunnel and DNS configuration for external access</p></div></div>

      ${isConfigured ? `
      <div class="card" style="max-width:700px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
          ${statusBadge}
          <code style="font-size:14px;color:var(--primary)">${h(fullDomain)}</code>
          ${localBadge}
        </div>
        <div class="table-wrapper" style="border:none">
          <table>
            <tbody>
              <tr><td class="text-muted" style="width:140px">Domain</td><td><code>${h(cf.domain)}</code></td></tr>
              <tr><td class="text-muted">Subdomain</td><td><code>${h(cf.hostname)}</code></td></tr>
              <tr><td class="text-muted">Tunnel</td><td><code class="text-sm">${h(cf.tunnel_name || cf.tunnel_id || '—')}</code></td></tr>
              <tr><td class="text-muted">Route</td><td><code>${h(fullDomain)} -> http://localhost:3700</code></td></tr>
            </tbody>
          </table>
        </div>
      </div>
      ` : ''}

      <div class="card" style="max-width:700px">
        <div class="card-header"><h3>${isConfigured ? 'Edit Configuration' : 'Setup Cloudflare'}</h3></div>
        <form id="cf-form" onsubmit="OS.saveCloudflare(event)">
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
              <input type="checkbox" name="enabled" ${cf.enabled ? 'checked' : ''} style="width:auto">
              <strong>Enabled</strong>
            </label>
          </div>
          <div class="separator"></div>

          <div class="form-group">
            <label class="form-label">API Token</label>
            <div style="display:flex;gap:8px">
              <input type="password" name="api_token" value="${h(cf.api_token || '')}" placeholder="Cloudflare API token" class="input-mono" style="flex:1" id="cf-api-token">
              <button type="button" class="btn btn-secondary btn-sm" onclick="OS.cfConnect()" id="cf-connect-btn">
                ${cf.api_token ? 'Reconnect' : 'Connect'}
              </button>
            </div>
            <p class="form-hint">Needs Zone:DNS:Edit and Account:Cloudflare Tunnel:Edit permissions. Enter token and click Connect to auto-populate fields below.</p>
            <div id="cf-connect-status" style="margin-top:6px"></div>
          </div>

          <div class="separator"></div>
          <p class="text-muted text-sm" style="margin-bottom:12px">These fields auto-populate when you Connect, or you can fill them manually.</p>

          <div class="form-group">
            <label class="form-label">Domain (Zone)</label>
            <div id="cf-zone-wrapper">
              <select name="zone_id" id="cf-zone-select" class="input-mono" onchange="OS.cfZoneChange()" style="display:none">
                <option value="">Select a domain...</option>
              </select>
              <input name="zone_id_manual" id="cf-zone-manual" value="${h(cf.zone_id || '')}" placeholder="Zone ID (auto-filled on Connect)" class="input-mono">
            </div>
            <input type="hidden" name="domain" id="cf-domain-input" value="${h(cf.domain || '')}">
            ${cf.domain ? `<p class="form-hint">Current: ${h(cf.domain)}</p>` : ''}
          </div>

          <div class="form-group">
            <label class="form-label">Account ID</label>
            <input name="account_id" id="cf-account-id" value="${h(cf.account_id || '')}" placeholder="32-character hex (auto-filled on Connect)" class="input-mono">
          </div>

          <div class="form-group">
            <label class="form-label">Tunnel</label>
            <div id="cf-tunnel-wrapper">
              <select name="tunnel_id" id="cf-tunnel-select" class="input-mono" style="display:none">
                <option value="">Select a tunnel...</option>
              </select>
              <input name="tunnel_id_manual" id="cf-tunnel-manual" value="${h(cf.tunnel_id || '')}" placeholder="Tunnel UUID (auto-filled on Connect)" class="input-mono">
            </div>
            ${cf.tunnel_name ? `<p class="form-hint">Current: ${h(cf.tunnel_name)}</p>` : ''}
          </div>

          <div class="form-group">
            <label class="form-label">Subdomain</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input name="hostname" value="${h(cf.hostname || '')}" placeholder="e.g. openhinge" class="input-mono" style="flex:1" id="cf-hostname-input">
              <span class="text-muted text-sm" id="cf-hostname-suffix">${cf.domain ? `.${h(cf.domain)}` : '.yourdomain.com'}</span>
            </div>
            <p class="form-hint">The subdomain that points to this gateway</p>
          </div>

          <div id="cf-existing-routes"></div>

          <div class="separator"></div>
          <button type="submit" class="btn btn-primary">Save Cloudflare Settings</button>
        </form>
      </div>
    `;
  };

  // -- Settings --
  loaders.settings = async () => {
    const { data } = await api('/admin/settings/general');
    const g = data || {};
    const el = document.getElementById('page-settings');

    el.innerHTML = `
      <div class="section-header"><div><h2>Settings</h2><p>General gateway configuration</p></div></div>
      <div class="card" style="max-width:600px">
        <form onsubmit="OS.saveSettings(event)">
          <div class="form-group">
            <label class="form-label">Gateway Name</label>
            <input name="name" value="${h(g.name || 'OpenHinge')}">
          </div>
          <div class="form-group">
            <label class="form-label">Timezone</label>
            <input name="timezone" value="${h(g.timezone || 'UTC')}" placeholder="Asia/Bangkok">
          </div>
          <div class="separator"></div>
          <button type="submit" class="btn btn-primary">Save Settings</button>
        </form>
      </div>

      <div class="card mt-4" style="max-width:600px">
        <div class="card-header"><h3>API Endpoints</h3></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div><span class="text-muted text-sm">Chat (OpenAI-compat)</span><div class="code-block">POST /v1/chat/completions</div></div>
          <div><span class="text-muted text-sm">Soul-specific</span><div class="code-block">POST /v1/souls/{slug}/chat/completions</div></div>
          <div><span class="text-muted text-sm">Models</span><div class="code-block">GET /v1/models</div></div>
          <div><span class="text-muted text-sm">Health</span><div class="code-block">GET /health</div></div>
        </div>
      </div>

      <div class="card mt-4" style="max-width:600px">
        <div class="card-header"><h3>Quick Test</h3></div>
        <p class="text-muted text-sm mb-4">Copy this to test your gateway:</p>
        <div class="code-block">curl ${window.location.origin}/v1/chat/completions \\
  -H "Authorization: Bearer ohk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello"}]}'</div>
      </div>
    `;
  };

  // -- Docs --
  loaders.docs = async () => {
    const el = document.getElementById('page-docs');
    const host = window.location.origin;
    el.innerHTML = `
      <div class="docs">
        <div class="docs-nav">
          <a href="#doc-overview" class="docs-link active" onclick="OS.scrollDoc(event,'doc-overview')">Overview</a>
          <a href="#doc-quickstart" class="docs-link" onclick="OS.scrollDoc(event,'doc-quickstart')">Quick Start</a>
          <a href="#doc-install" class="docs-link" onclick="OS.scrollDoc(event,'doc-install')">Installation</a>
          <a href="#doc-architecture" class="docs-link" onclick="OS.scrollDoc(event,'doc-architecture')">Architecture</a>
          <a href="#doc-providers" class="docs-link" onclick="OS.scrollDoc(event,'doc-providers')">Providers</a>
          <a href="#doc-auth" class="docs-link" onclick="OS.scrollDoc(event,'doc-auth')">Authentication</a>
          <a href="#doc-souls" class="docs-link" onclick="OS.scrollDoc(event,'doc-souls')">Souls</a>
          <a href="#doc-keys" class="docs-link" onclick="OS.scrollDoc(event,'doc-keys')">API Keys</a>
          <a href="#doc-api" class="docs-link" onclick="OS.scrollDoc(event,'doc-api')">API Reference</a>
          <a href="#doc-streaming" class="docs-link" onclick="OS.scrollDoc(event,'doc-streaming')">Streaming</a>
          <a href="#doc-logs" class="docs-link" onclick="OS.scrollDoc(event,'doc-logs')">Request Logs</a>
          <a href="#doc-cloudflare" class="docs-link" onclick="OS.scrollDoc(event,'doc-cloudflare')">Cloudflare Tunnel</a>
          <a href="#doc-cli" class="docs-link" onclick="OS.scrollDoc(event,'doc-cli')">CLI Reference</a>
          <a href="#doc-openclaw" class="docs-link" onclick="OS.scrollDoc(event,'doc-openclaw')">OpenClaw</a>
          <a href="#doc-sdk" class="docs-link" onclick="OS.scrollDoc(event,'doc-sdk')">SDK Examples</a>
          <a href="#doc-deploy" class="docs-link" onclick="OS.scrollDoc(event,'doc-deploy')">Deployment</a>
        </div>
        <div class="docs-content">

          <section id="doc-overview">
            <h2>Overview</h2>
            <p>OpenHinge is a self-hosted AI gateway that unifies multiple LLM providers behind a single OpenAI-compatible API. Run it on your own machine, use your own subscriptions and API keys, and control who can access what.</p>
            <div class="doc-card">
              <h4>Key Concepts</h4>
              <dl class="doc-dl">
                <dt>Providers</dt><dd>Connections to LLM services. Supports Claude, OpenAI, Gemini, and Ollama. Each can authenticate via OAuth (use your existing subscription) or API key. Multiple providers of the same type are supported.</dd>
                <dt>Souls</dt><dd>AI personas with system prompts. Each soul has its own endpoint, provider, model, and behavior rules. Examples: Translator, Blog Writer, Code Reviewer.</dd>
                <dt>API Keys</dt><dd>Access tokens (<code>ohk_</code> prefix) for consumers. Each key has rate limits, optional soul binding, and budget controls.</dd>
                <dt>Fallback Chain</dt><dd>If a provider is down, requests automatically route to the next healthy provider by priority.</dd>
              </dl>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-quickstart">
            <h2>Quick Start</h2>
            <p>From zero to a working AI endpoint in 4 steps:</p>

            <div class="doc-step">
              <span class="doc-step-num">1</span>
              <div>
                <h4>Add a provider</h4>
                <p>Go to <a href="#" onclick="OS.navigate('providers');return false" style="color:var(--primary)">Providers</a> and click "Add Provider". Choose your provider type and either log in with OAuth (uses your existing subscription) or enter an API key.</p>
              </div>
            </div>

            <div class="doc-step">
              <span class="doc-step-num">2</span>
              <div>
                <h4>Create a soul</h4>
                <p>Go to <a href="#" onclick="OS.navigate('souls');return false" style="color:var(--primary)">Souls</a> and click "Add Soul". Pick a provider and model, write a system prompt that defines how the AI should behave, and save.</p>
                <p class="form-hint">This creates the endpoint: <code>POST /v1/souls/{slug}/chat/completions</code></p>
              </div>
            </div>

            <div class="doc-step">
              <span class="doc-step-num">3</span>
              <div>
                <h4>Generate an API key</h4>
                <p>Go to <a href="#" onclick="OS.navigate('keys');return false" style="color:var(--primary)">API Keys</a> and click "Create Key". Select which souls the key can access, set a rate limit, and save. Copy the key immediately — it won't be shown again.</p>
              </div>
            </div>

            <div class="doc-step">
              <span class="doc-step-num">4</span>
              <div>
                <h4>Send a request</h4>
                <div class="code-block">curl ${host}/v1/souls/translator/chat/completions \\
  -H "Authorization: Bearer ohk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Translate to German: Hello"}]}'</div>
                <p class="form-hint">Responses use the OpenAI format. Any OpenAI SDK works out of the box.</p>
              </div>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-install">
            <h2>Installation</h2>
            <div class="doc-card">
              <h4>Requirements</h4>
              <p>Node.js 18+ and npm. No external databases — OpenHinge uses embedded SQLite.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>One-liner</h4>
              <div class="code-block">curl -fsSL https://openhinge.com/install.sh | bash</div>
              <p class="form-hint" style="margin-top:8px">Installs, builds, starts the server, and opens the dashboard automatically.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>Manual</h4>
              <div class="code-block">git clone https://github.com/openhinge/openhinge.git
cd openhinge
npm install
npm run build
npm start</div>
              <p class="form-hint" style="margin-top:8px">On first run, OpenHinge auto-generates your config and prints your admin token to the terminal. Open <code>http://localhost:3700</code> and paste the token to get started.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>Development</h4>
              <div class="code-block">npm run dev   # hot-reload with tsx watch</div>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-architecture">
            <h2>Architecture</h2>
            <div class="code-block">Your App / CMS / Service
    |
    |  HTTPS (Cloudflare Tunnel) or localhost:3700
    v
OpenHinge Gateway (Fastify + SQLite)
    |
    |  1. Authenticate API key (ohk_...)
    |  2. Rate limit + budget check
    |  3. Resolve soul -> system prompt + model
    |  4. Pick provider (priority + health + fallback)
    |  5. Forward to LLM (auto-refresh expired tokens)
    |  6. Stream response back
    |  7. Log usage + cost
    |
    v
LLM Providers
    |-- Claude (OAuth from subscription or API key)
    |-- OpenAI (OAuth from ChatGPT Plus or API key)
    |-- Gemini (OAuth from Google account or API key)
    |-- Ollama (local, no auth)</div>
          </section>

          <div class="separator"></div>

          <section id="doc-providers">
            <h2>Providers</h2>
            <p>Providers are connections to LLM services. You can add multiple providers of the same type (e.g., two Claude accounts).</p>

            <div class="doc-card">
              <h4>Claude</h4>
              <p><strong>OAuth (recommended):</strong> Click "Import from this computer" to auto-detect your Claude Code subscription from the macOS Keychain. Click "Login with another account" to sign in to additional Claude accounts via browser OAuth. You can add unlimited Claude accounts — they'll automatically fall back to each other.</p>
              <p><strong>API key:</strong> Enter your <code>sk-ant-api03-</code> key from console.anthropic.com. Pay-per-token pricing.</p>
              <p class="form-hint">Models: claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5, etc.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>OpenAI</h4>
              <p><strong>OAuth (recommended):</strong> Click "Login with OpenAI" — auto-detects your Codex CLI auth. Uses your ChatGPT Plus/Pro subscription via the Codex API.</p>
              <p><strong>API key:</strong> Enter your <code>sk-</code> key from platform.openai.com. Uses the standard Chat Completions API.</p>
              <p class="form-hint">OAuth models: gpt-5.4-mini, gpt-5.4, gpt-5-codex, etc. API key models: gpt-4o, gpt-4o-mini, gpt-4.1.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>Gemini</h4>
              <p><strong>OAuth:</strong> Click "Login with Gemini" — authenticates via Google and discovers your Cloud Code project automatically.</p>
              <p><strong>API key:</strong> Enter your key from aistudio.google.com.</p>
              <p class="form-hint">Models: gemini-2.5-flash, gemini-2.5-pro, etc.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>Ollama (Local)</h4>
              <p>Auto-detected when Ollama is running on localhost:11434. No credentials needed. Runs open-source models on your hardware.</p>
              <p class="form-hint">Models: llama3.3, qwen3, deepseek-r1, mistral, etc.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>Priority & Fallback</h4>
              <p>Each provider has a <strong>priority</strong> (higher = tried first). When a provider is down or returns an error, OpenHinge automatically tries the next healthy provider. Enable/disable providers without deleting them.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>Token Auto-Refresh</h4>
              <p>OAuth tokens are refreshed automatically when they expire (401). Claude re-reads from Keychain, OpenAI and Gemini use their refresh tokens. Updated credentials are persisted to the database.</p>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-auth">
            <h2>Authentication Modes</h2>
            <p>OpenHinge supports two ways to authenticate with each provider:</p>
            <div class="doc-card">
              <h4>OAuth Login (Subscription-based)</h4>
              <p>Click "Login with [Provider]" in the Add Provider dialog. This opens a browser-based OAuth flow that captures tokens automatically. For Claude and OpenAI, it can also auto-detect existing tokens from Claude Code or Codex CLI if they're installed.</p>
              <p>This mode uses your <strong>existing subscription</strong> (Claude Pro, ChatGPT Plus, Google account) so there's no separate API billing.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>API Key (Pay-per-token)</h4>
              <p>Click "Enter API Key" and paste a key from the provider's developer console. Standard pay-per-token pricing applies.</p>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-souls">
            <h2>Souls</h2>
            <p>Souls are AI personas that define how the model responds. Each soul gets its own dedicated endpoint.</p>
            <div class="doc-card">
              <dl class="doc-dl">
                <dt>Provider & Model</dt><dd>Which LLM handles this soul's requests</dd>
                <dt>System Prompt</dt><dd>Instructions for how the AI behaves — personality, rules, output format</dd>
                <dt>Temperature</dt><dd>0 = deterministic, 1 = creative (default: 0.7)</dd>
                <dt>Max Tokens</dt><dd>Maximum response length</dd>
                <dt>Endpoint</dt><dd><code>/v1/souls/{slug}/chat/completions</code></dd>
              </dl>
            </div>
            <div class="doc-card mt-4">
              <h4>Soul Resolution</h4>
              <p>The soul for a request is determined in this order:</p>
              <ol class="doc-ol">
                <li>URL path: <code>/v1/souls/:slug/chat/completions</code></li>
                <li>If the API key is bound to exactly one soul, it auto-resolves</li>
                <li><code>X-OpenHinge-Soul</code> header with the soul slug</li>
              </ol>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-keys">
            <h2>API Keys</h2>
            <p>Every API request must include a valid key. Keys are hashed — the raw key is only shown once at creation.</p>
            <div class="doc-card">
              <dl class="doc-dl">
                <dt>Format</dt><dd><code>ohk_</code> prefix + 32 random chars (base64url)</dd>
                <dt>Soul Binding</dt><dd>Restrict a key to specific souls (many-to-many), or allow access to all</dd>
                <dt>Rate Limit</dt><dd>Max requests per minute (default: 60, per key)</dd>
                <dt>Budget</dt><dd>Optional daily and monthly spend limits in cents</dd>
                <dt>Expiry</dt><dd>Optional expiration date</dd>
              </dl>
            </div>
            <div class="doc-card mt-4">
              <h4>Usage</h4>
              <div class="code-block">Authorization: Bearer ohk_YOUR_KEY</div>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-api">
            <h2>API Reference</h2>
            <div class="doc-card">
              <h4>POST /v1/chat/completions</h4>
              <p>OpenAI-compatible chat endpoint. Works with any OpenAI SDK.</p>
              <div class="code-block">{
  "model": "claude-sonnet-4-6",
  "messages": [{"role": "user", "content": "Hello!"}],
  "temperature": 0.7,
  "max_tokens": 4096,
  "stream": false
}</div>
              <p class="form-hint" style="margin-top:6px">If no model is specified, the soul's default model is used. If no soul is specified, the first available provider's default model is used.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>POST /v1/souls/:slug/chat/completions</h4>
              <p>Routes to a specific soul. The soul's system prompt is automatically prepended to the messages. Provider and model are determined by the soul's configuration.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>GET /v1/models</h4>
              <p>Lists all available models across all enabled providers. Returns OpenAI-compatible format.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>GET /health</h4>
              <p>Public health check. No auth required. Returns <code>{"status":"ok"}</code>.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>Response Headers</h4>
              <dl class="doc-dl">
                <dt>X-RateLimit-Limit</dt><dd>Max requests per minute for this key</dd>
                <dt>X-RateLimit-Remaining</dt><dd>Remaining requests in the current window</dd>
                <dt>X-RateLimit-Reset</dt><dd>Seconds until the rate limit window resets</dd>
              </dl>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-streaming">
            <h2>Streaming</h2>
            <p>Set <code>"stream": true</code> for Server-Sent Events. Fully compatible with OpenAI's streaming format — works with all OpenAI SDKs.</p>
            <div class="code-block">curl ${host}/v1/souls/translator/chat/completions \\
  -H "Authorization: Bearer ohk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":true}'</div>
            <p class="form-hint" style="margin-top:6px">Each SSE event contains a <code>choices[0].delta.content</code> field. The final event has <code>finish_reason: "stop"</code> and includes token usage.</p>
          </section>

          <div class="separator"></div>

          <section id="doc-logs">
            <h2>Request Logs</h2>
            <p>Every API request is logged with full details. View logs in the <a href="#" onclick="OS.navigate('logs');return false" style="color:var(--primary)">Request Logs</a> page.</p>
            <div class="doc-card">
              <h4>Logged Fields</h4>
              <dl class="doc-dl">
                <dt>request_id</dt><dd>Unique ID for each request</dd>
                <dt>api_key / soul / provider</dt><dd>Which key, soul, and provider handled the request</dd>
                <dt>model</dt><dd>The LLM model used</dd>
                <dt>input/output tokens</dt><dd>Token counts for cost tracking</dd>
                <dt>latency_ms</dt><dd>End-to-end request duration</dd>
                <dt>status</dt><dd>success, error, rate_limited, or budget_exceeded</dd>
              </dl>
            </div>
            <div class="doc-card mt-4">
              <h4>Filtering</h4>
              <p>Logs are searchable and filterable by soul, provider, status, and model. Supports sorting by any column and pagination.</p>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-cloudflare">
            <h2>Cloudflare Tunnel</h2>
            <p>Expose your gateway to the internet over HTTPS without opening ports or configuring firewalls.</p>
            <div class="doc-card">
              <h4>Setup</h4>
              <ol class="doc-ol">
                <li>Install <code>cloudflared</code>: <code>brew install cloudflared</code></li>
                <li>Authenticate: <code>cloudflared tunnel login</code></li>
                <li>Create a tunnel: <code>cloudflared tunnel create openhinge</code></li>
                <li>In the <a href="#" onclick="OS.navigate('cloudflare');return false" style="color:var(--primary)">Cloudflare</a> settings page, enter your API token and click Connect to auto-discover zones and tunnels</li>
                <li>Select your domain, tunnel, and subdomain, then save</li>
                <li>Add an ingress rule to your cloudflared config for the subdomain pointing to <code>http://localhost:3700</code></li>
                <li>Start the tunnel: <code>cloudflared tunnel run</code></li>
              </ol>
            </div>
            <div class="doc-card mt-4">
              <h4>API Token Permissions</h4>
              <p>Your Cloudflare API token needs: <strong>Zone:DNS:Edit</strong> and <strong>Account:Cloudflare Tunnel:Edit</strong>.</p>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-cli">
            <h2>CLI Reference</h2>
            <div class="code-block">npx tsx bin/openhinge.ts &lt;command&gt;</div>
            <div class="doc-card mt-4">
              <table><thead><tr><th>Command</th><th>Description</th></tr></thead><tbody>
                <tr><td><code>init</code></td><td>Generate config and run migrations (runs automatically on first <code>npm start</code>)</td></tr>
                <tr><td><code>migrate</code></td><td>Run pending database migrations</td></tr>
                <tr><td><code>status</code></td><td>Show providers, souls, keys, and request counts</td></tr>
                <tr><td><code>provider list</code></td><td>List all configured providers</td></tr>
                <tr><td><code>provider add</code></td><td>Add a new provider interactively</td></tr>
                <tr><td><code>provider health</code></td><td>Run health checks on all providers</td></tr>
                <tr><td><code>soul list</code></td><td>List all souls</td></tr>
                <tr><td><code>soul add</code></td><td>Create a new soul interactively</td></tr>
                <tr><td><code>key list</code></td><td>List API keys (prefix only)</td></tr>
                <tr><td><code>key create</code></td><td>Generate a new API key</td></tr>
                <tr><td><code>provider add-claude</code></td><td>Auto-import Claude subscription from macOS Keychain</td></tr>
                <tr><td><code>provider refresh-claude</code></td><td>Refresh Claude OAuth tokens from Keychain</td></tr>
                <tr><td><code>update</code></td><td>Pull latest, rebuild, migrate, and auto-restart server</td></tr>
                <tr><td><code>uninstall</code></td><td>Remove OpenHinge completely</td></tr>
              </tbody></table>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-openclaw">
            <h2>OpenClaw Integration</h2>
            <p>OpenHinge works as a provider backend for OpenClaw agents. Generate a key with auto-configured settings from the dashboard.</p>
            <div class="doc-card">
              <h4>Setup</h4>
              <ol class="doc-ol">
                <li>Go to <a href="#" onclick="OS.navigate('keys');return false" style="color:var(--primary)">API Keys</a> and click "Create Key"</li>
                <li>Choose "OpenClaw Key"</li>
                <li>Select the primary model your agents should use</li>
                <li>Click "Generate OpenClaw Key"</li>
                <li>Copy the config block and paste it into your <code>openclaw.json</code> under <code>models.providers</code></li>
                <li>Set your agent's primary model to <code>openhinge/model-id</code></li>
              </ol>
            </div>
            <div class="doc-card mt-4">
              <h4>How it works</h4>
              <p>OpenClaw sends requests to OpenHinge using the <code>openai-completions</code> API format. OpenHinge translates the request to the appropriate provider (Claude, OpenAI, Gemini, etc.) and streams the response back in OpenAI format.</p>
              <p class="form-hint">This means your OpenClaw agents can use Claude, Gemini, or any provider through a single OpenAI-compatible endpoint — with automatic fallback, rate limiting, and usage logging.</p>
            </div>
            <div class="doc-card mt-4">
              <h4>Multi-account stacking</h4>
              <p>Add multiple accounts of the same provider (e.g., 10 Claude subscriptions) and OpenHinge will automatically fall back to the next account if one hits rate limits or goes down. Your OpenClaw agents get uninterrupted access across all accounts.</p>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-sdk">
            <h2>SDK Examples</h2>
            <p>OpenHinge is fully OpenAI-compatible. Point any OpenAI SDK at your gateway URL.</p>

            <div class="doc-card">
              <h4>Python</h4>
              <div class="code-block">from openai import OpenAI

client = OpenAI(
    base_url="${host}/v1",
    api_key="ohk_YOUR_KEY"
)

# Use a soul endpoint directly
response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello!"}],
    extra_headers={"X-OpenHinge-Soul": "translator"}
)
print(response.choices[0].message.content)</div>
            </div>

            <div class="doc-card mt-4">
              <h4>Node.js / TypeScript</h4>
              <div class="code-block">import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${host}/v1',
  apiKey: 'ohk_YOUR_KEY',
});

const stream = await client.chat.completions.create({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
}, {
  headers: { 'X-OpenHinge-Soul': 'translator' },
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}</div>
            </div>

            <div class="doc-card mt-4">
              <h4>curl</h4>
              <div class="code-block"># Via soul endpoint (recommended)
curl ${host}/v1/souls/translator/chat/completions \\
  -H "Authorization: Bearer ohk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'

# Via generic endpoint with soul header
curl ${host}/v1/chat/completions \\
  -H "Authorization: Bearer ohk_YOUR_KEY" \\
  -H "X-OpenHinge-Soul: translator" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'</div>
            </div>
          </section>

          <div class="separator"></div>

          <section id="doc-deploy">
            <h2>Deployment</h2>
            <div class="doc-card">
              <h4>macOS LaunchAgent (Auto-Start)</h4>
              <p>Run OpenHinge as a background service that starts on login:</p>
              <div class="code-block"># Edit the plist to match your node path and openhinge directory
# Then install:
cp deploy/com.openhinge.gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openhinge.gateway.plist

# Check status
launchctl list | grep openhinge

# View logs
tail -f data/stdout.log</div>
            </div>
            <div class="doc-card mt-4">
              <h4>systemd (Linux)</h4>
              <div class="code-block">[Unit]
Description=OpenHinge AI Gateway
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/path/to/openhinge
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target</div>
            </div>
            <div class="doc-card mt-4">
              <h4>Docker</h4>
              <div class="code-block">docker build -t openhinge .
docker run -d -p 3700:3700 -v ./data:/app/data -v ./config:/app/config openhinge</div>
            </div>
            <div class="doc-card mt-4">
              <h4>Environment Variables</h4>
              <dl class="doc-dl">
                <dt>OPENHINGE_PORT</dt><dd>Server port (default: 3700)</dd>
                <dt>OPENHINGE_HOST</dt><dd>Bind address (default: 127.0.0.1)</dd>
                <dt>OPENHINGE_ADMIN_TOKEN</dt><dd>Admin dashboard token</dd>
                <dt>OPENHINGE_ENCRYPTION_KEY</dt><dd>32+ char key for encrypting provider credentials</dd>
                <dt>OPENHINGE_DB_PATH</dt><dd>SQLite database path (default: ./data/openhinge.db)</dd>
                <dt>OPENHINGE_LOG_LEVEL</dt><dd>Log level: trace, debug, info, warn, error</dd>
              </dl>
            </div>
          </section>

        </div>
      </div>
    `;
  };

  function scrollDoc(e, id) {
    e.preventDefault();
    document.querySelectorAll('.docs-link').forEach(l => l.classList.remove('active'));
    e.target.classList.add('active');
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function emptyState(title, desc) {
    return `<div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="10"/><path d="M8 15h8M9 9h.01M15 9h.01"/></svg>
      <p style="font-weight:500;color:var(--text-secondary)">${title}</p>
      <p>${desc}</p>
    </div>`;
  }

  // ===== Actions =====

  // Provider
  async function addProviderModal() {
    const providers = [
      { type: 'claude', name: 'Claude', desc: 'Anthropic', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>` },
      { type: 'openai', name: 'OpenAI', desc: 'GPT-4o, o1, o3', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 12V2"/><path d="M12 12l7-7"/></svg>` },
      { type: 'gemini', name: 'Gemini', desc: 'Google AI', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l4 8 8 1-6 5 2 8-8-5-8 5 2-8-6-5 8-1z"/></svg>` },
      { type: 'ollama', name: 'Ollama', desc: 'Local models', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>` },
    ];

    const grid = providers.map(p => `
      <button class="option-card" onclick="OS.addProviderStep2('${p.type}')">
        <div class="option-card-icon">${p.icon}</div>
        <div class="option-card-text">
          <div class="option-card-title">${p.name}</div>
          <div class="option-card-desc">${p.desc}</div>
        </div>
      </button>
    `).join('');

    openModal('Add Provider', `
      <div class="option-list">${grid}</div>
    `);
  }

  function addProviderStep2(type) {
    const names = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama' };
    const icons = { claude: '🟣', openai: '🟢', gemini: '🔵', ollama: '⚫' };

    // Ollama has no auth options
    if (type === 'ollama') {
      openModal('Add Ollama', `
        <div class="option-list" style="margin-bottom:16px">
          <button class="option-card option-primary" onclick="OS.quickAdd('ollama')">
            <div class="option-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/><polyline points="21 3 21 12 12 12"/></svg></div>
            <div class="option-card-text">
              <div class="option-card-title">Auto-detect Local Ollama</div>
              <div class="option-card-desc">Connect to Ollama running on this machine</div>
            </div>
          </button>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:16px">
          <p class="text-muted" style="margin-bottom:12px;font-size:12px;font-weight:500">Or configure manually</p>
          <form onsubmit="OS.saveProvider(event)" id="provider-form">
            <input type="hidden" name="type" value="ollama">
            <div class="form-group"><label class="form-label">Name</label><input name="name" value="Ollama" placeholder="e.g. Ollama Remote"></div>
            <div class="form-row">
              <div class="form-group" style="flex:2"><label class="form-label">Base URL</label><input name="base_url" value="http://127.0.0.1:11434" class="input-mono"></div>
              <div class="form-group" style="flex:1"><label class="form-label">Priority</label><input name="priority" type="number" value="30"></div>
            </div>
            <button type="submit" class="btn btn-secondary" style="width:100%;margin-top:4px">Add Manually</button>
          </form>
        </div>
      `);
      return;
    }

    if (type === 'claude') {
      openModal('Add Claude', `
        <div class="option-list">
          <button class="option-card option-primary" onclick="OS.quickAdd('claude')">
            <div class="option-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg></div>
            <div class="option-card-text">
              <div class="option-card-title">Import from this computer</div>
              <div class="option-card-desc">Auto-detect Claude Code subscription</div>
            </div>
          </button>
          <button class="option-card" onclick="OS.claudeOAuthLogin()">
            <div class="option-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg></div>
            <div class="option-card-text">
              <div class="option-card-title">Login with another account</div>
              <div class="option-card-desc">Opens claude.ai — sign in with a different account</div>
            </div>
          </button>
          <button class="option-card" onclick="OS.showClaudeOauthForm()">
            <div class="option-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>
            <div class="option-card-text">
              <div class="option-card-title">Paste OAuth Token</div>
              <div class="option-card-desc">Enter a token from another machine</div>
            </div>
          </button>
          <button class="option-card" onclick="OS.showApiKeyForm('claude')">
            <div class="option-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg></div>
            <div class="option-card-text">
              <div class="option-card-title">Enter API Key</div>
              <div class="option-card-desc">Paste an Anthropic API key</div>
            </div>
          </button>
        </div>
      `);
      return;
    }

    openModal(`Add ${names[type]}`, `
      <div class="option-list">
        <button class="option-card option-primary" onclick="OS.quickAdd('${type}')">
          <div class="option-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg></div>
          <div class="option-card-text">
            <div class="option-card-title">Login with ${names[type]}</div>
            <div class="option-card-desc">Use your subscription via OAuth</div>
          </div>
        </button>
        <button class="option-card" onclick="OS.showApiKeyForm('${type}')">
          <div class="option-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg></div>
          <div class="option-card-text">
            <div class="option-card-title">Enter API Key</div>
            <div class="option-card-desc">Paste an API key manually</div>
          </div>
        </button>
      </div>
    `);
  }

  function showApiKeyForm(type) {
    const names = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini' };
    const icons = { claude: '🟣', openai: '🟢', gemini: '🔵' };
    const placeholders = { claude: 'sk-ant-api03-...', openai: 'sk-...', gemini: 'AIza...' };
    const hints = {
      claude: 'Get a key at console.anthropic.com/settings/keys',
      openai: 'Get a key at platform.openai.com/api-keys',
      gemini: 'Get a key at aistudio.google.com/app/apikey',
    };

    openModal(`${icons[type]} Add ${names[type]} — API Key`, `
      <form onsubmit="OS.saveProvider(event)" id="provider-form">
        <input type="hidden" name="type" value="${type}">
        <div class="form-group"><label class="form-label">Name</label><input name="name" value="${names[type]}" placeholder="e.g. ${names[type]} Production"></div>
        <div class="form-group">
          <label class="form-label">API Key</label>
          <input type="password" name="api_key" class="input-mono" placeholder="${placeholders[type]}" id="provider-api-key" required>
          <p class="form-hint">${hints[type]}</p>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex:2"><label class="form-label">Base URL</label><input name="base_url" placeholder="Leave empty for default" class="input-mono"></div>
          <div class="form-group" style="flex:1"><label class="form-label">Priority</label><input name="priority" type="number" value="50"></div>
        </div>
        <div class="form-group">
          <div class="flex items-center justify-between" style="margin-bottom:6px">
            <label class="form-label" style="margin-bottom:0">Default Model</label>
            <button type="button" class="btn btn-secondary btn-sm" onclick="OS.fetchModels()" id="fetch-models-btn">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/><polyline points="21 3 21 12 12 12"/></svg>
              Fetch Models
            </button>
          </div>
          <div id="model-select-wrapper" style="display:none">
            <select name="model" id="model-select" class="input-mono"><option value="">Select a model...</option></select>
          </div>
          <div id="model-input-wrapper">
            <input name="model_manual" id="model-manual" placeholder="Click 'Fetch Models' or type manually" class="input-mono">
          </div>
          <div id="probe-status" style="margin-top:6px"></div>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Add Provider</button>
      </form>
    `);
  }

  async function claudeOAuthLogin() {
    const btn = event?.target?.closest?.('button');
    if (btn) { btn.disabled = true; btn.querySelector('div:first-child').textContent = 'Opening browser...'; }

    // Call auth/start with method=oauth to skip keychain and trigger browser OAuth
    const res = await api('/admin/providers/auth/start', { method: 'POST', body: { type: 'claude', method: 'oauth' } });

    if (res.error) {
      toast(res.error, 'error');
      if (btn) { btn.disabled = false; btn.querySelector('div:first-child').textContent = 'Login with another Claude account'; }
      return;
    }

    if (res.status === 'complete') {
      const p = res.provider;
      toast(`Connected ${p.name}` + (p.model ? ` (${p.model})` : ''), 'success');
      closeModal();
      loadProviders();
      return;
    }

    if (res.status === 'auth_started') {
      toast('Sign in to Claude in the browser window...', 'success');
      closeModal();

      // Poll for completion
      const pollInterval = setInterval(async () => {
        const status = await api('/admin/providers/auth/status');
        if (status.status === 'complete') {
          clearInterval(pollInterval);
          const p = status.provider;
          toast(`Connected ${p.name}` + (p.model ? ` (${p.model})` : ''), 'success');
          loadProviders();
        } else if (status.status === 'error') {
          clearInterval(pollInterval);
          toast(status.error || 'Auth failed', 'error');
        }
      }, 1500);

      setTimeout(() => clearInterval(pollInterval), 300000);
    }
  }

  function showClaudeOauthForm() {
    openModal('🟣 Add Claude — OAuth Token', `
      <form onsubmit="OS.saveClaudeOauth(event)" id="claude-oauth-form">
        <p class="text-muted" style="margin-bottom:12px;font-size:13px">
          Add a different Claude account by pasting its OAuth token.<br>
          Get it from another machine's keychain or Claude Code credentials.
        </p>
        <div class="form-group"><label class="form-label">Name</label><input name="name" value="Claude (Account 2)" placeholder="e.g. Claude (Work)"></div>
        <div class="form-group">
          <label class="form-label">OAuth Token</label>
          <input type="password" name="oauth_token" class="input-mono" placeholder="sk-ant-oat01-..." required>
          <p class="form-hint">The access token from Claude Code credentials</p>
        </div>
        <div class="form-group">
          <label class="form-label">Refresh Token <span class="text-muted">(optional)</span></label>
          <input type="password" name="refresh_token" class="input-mono" placeholder="ant-rt01-...">
          <p class="form-hint">Enables auto-refresh when the access token expires</p>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Add Claude Account</button>
      </form>
    `);
  }

  async function saveClaudeOauth(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }

    const res = await api('/admin/providers/claude-oauth', { method: 'POST', body: {
      oauth_token: f.get('oauth_token'),
      refresh_token: f.get('refresh_token') || undefined,
      name: f.get('name') || undefined,
    }});

    if (res.error) {
      toast(res.error, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Add Claude Account'; }
      return;
    }

    closeModal();
    toast(`Connected ${res.provider?.name || 'Claude'}`, 'success');
    loadProviders();
  }

  function onProviderTypeChange() {
    const type = document.querySelector('#provider-form [name="type"]')?.value;
    const keyGroup = document.getElementById('api-key-group');
    const keyInput = document.getElementById('provider-api-key');
    if (type === 'ollama') {
      keyGroup.style.display = 'none';
      if (keyInput) keyInput.value = '';
    } else {
      keyGroup.style.display = '';
    }
  }

  async function fetchModels() {
    const form = document.getElementById('provider-form');
    if (!form) return;
    const type = form.querySelector('[name="type"]').value;
    const apiKey = form.querySelector('[name="api_key"]')?.value || '';
    const baseUrl = form.querySelector('[name="base_url"]')?.value || '';
    const btn = document.getElementById('fetch-models-btn');
    const status = document.getElementById('probe-status');

    btn.disabled = true;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Connecting...';
    status.innerHTML = '';

    const res = await api('/admin/providers/probe', { method: 'POST', body: { type, api_key: apiKey, base_url: baseUrl || undefined } });

    btn.disabled = false;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/><polyline points="21 3 21 12 12 12"/></svg> Fetch Models';

    if (res.health) {
      const hc = res.health;
      if (hc.status === 'healthy') {
        status.innerHTML = '<span class="badge badge-success"><span class="badge-dot"></span>Connected (' + hc.latency_ms + 'ms)</span>';
      } else {
        status.innerHTML = '<span class="badge badge-danger"><span class="badge-dot"></span>' + h(hc.status) + ': ' + h(hc.message || '') + '</span>';
      }
    }

    if (res.models && res.models.length > 0) {
      const select = document.getElementById('model-select');
      const selectWrapper = document.getElementById('model-select-wrapper');
      const inputWrapper = document.getElementById('model-input-wrapper');

      select.innerHTML = '<option value="">Select a model...</option>' + res.models.map(m =>
        '<option value="' + h(m) + '">' + h(m) + '</option>'
      ).join('');

      selectWrapper.style.display = '';
      inputWrapper.style.display = 'none';
    } else {
      toast('No models found — type manually', 'error');
    }
  }

  // Store fetched models per provider for soul creation
  let _providerModels = {};

  async function fetchModelsForProvider(providerId) {
    if (_providerModels[providerId]) return _providerModels[providerId];

    const provider = _providers.find(p => p.id === providerId);
    if (!provider) return [];

    const res = await api('/admin/providers/probe', {
      method: 'POST',
      body: { type: provider.type, base_url: provider.base_url || undefined }
    });

    const models = res.models || [];
    _providerModels[providerId] = models;
    return models;
  }

  async function quickAdd(type) {
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting...'; }

    // Use the new auth flow
    const res = await api('/admin/providers/auth/start', { method: 'POST', body: { type } });

    if (res.error) {
      toast(res.error, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
      return;
    }

    if (res.status === 'complete') {
      // Instant auth (Claude keychain, Ollama local)
      const p = res.provider;
      toast(`Connected ${p.name}` + (p.model ? ` (${p.model})` : ''), 'success');
      if (res.method === 'keychain_oauth') {
        toast(`Using ${res.subscription} subscription via OAuth`, 'success');
      }
      closeModal();
      loadProviders();
      return;
    }

    if (res.status === 'auth_started') {
      // Browser opened to provider's login page — poll auth status
      toast(res.message, 'success');
      closeModal();

      const pollInterval = setInterval(async () => {
        const status = await api('/admin/providers/auth/status');
        if (status.status === 'complete') {
          clearInterval(pollInterval);
          const p = status.provider;
          toast(`Connected ${p.name}` + (p.model ? ` (${p.model})` : ''), 'success');
          loadProviders();
        } else if (status.status === 'error') {
          clearInterval(pollInterval);
          toast(status.error || 'Auth failed', 'error');
        }
        // status === 'waiting' — keep polling
      }, 1500);

      // Stop polling after 5 min
      setTimeout(() => clearInterval(pollInterval), 300000);
      return;
    }
  }

  async function openApiPage(type) {
    // Use the auth flow — opens browser with a nice auth page
    await quickAdd(type);
  }

  async function saveProvider(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const key = f.get('api_key');
    const credKey = key && key.startsWith('sk-ant-oat01-') ? 'oauth_token' : 'api_key';
    const model = f.get('model') || f.get('model_manual') || '';
    await api('/admin/providers', { method: 'POST', body: {
      name: f.get('name'), type: f.get('type'), base_url: f.get('base_url') || undefined,
      credentials: key ? { [credKey]: key } : {},
      provider_config: model ? { default_model: model } : {},
      priority: parseInt(f.get('priority')) || 0,
    }});
    closeModal(); toast('Provider added', 'success'); loaders.providers();
  }

  async function editProviderModal(id) {
    const p = _providers.find(p => p.id === id);
    if (!p) return;
    const config = typeof p.config === 'string' ? JSON.parse(p.config) : (p.config || {});

    openModal('Edit Provider', `
      <form onsubmit="OS.updateProvider(event, '${id}')">
        <div class="form-group"><label class="form-label">Name</label><input name="name" value="${h(p.name)}" required></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Type</label><input value="${h(p.type)}" disabled class="input-mono"></div>
          <div class="form-group"><label class="form-label">Priority</label><input name="priority" type="number" value="${p.priority}"><p class="form-hint">Higher = preferred</p></div>
        </div>
        <div class="form-group"><label class="form-label">Base URL</label><input name="base_url" value="${h(p.base_url || '')}" placeholder="Leave empty for default" class="input-mono"></div>
        <div class="form-group">
          <label class="form-label">API Key / OAuth Token</label>
          <input type="password" name="api_key" placeholder="Leave empty to keep current" class="input-mono">
          <p class="form-hint">Only fill if you want to change the credentials</p>
        </div>
        <div class="form-group">
          <label class="form-label">Default Model</label>
          <input name="model" value="${h(config.default_model || '')}" placeholder="e.g. claude-sonnet-4-6-20250514" class="input-mono">
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="checkbox" name="is_enabled" ${p.is_enabled !== 0 ? 'checked' : ''} style="width:auto">
            Enabled
          </label>
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Save Changes</button>
      </form>
    `);
  }

  async function updateProvider(e, id) {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      name: f.get('name'),
      base_url: f.get('base_url') || undefined,
      priority: parseInt(f.get('priority')) || 0,
      is_enabled: f.has('is_enabled'),
    };
    const model = f.get('model');
    if (model) body.provider_config = { default_model: model };
    const key = f.get('api_key');
    if (key) {
      const credKey = key.startsWith('sk-ant-oat01-') ? 'oauth_token' : 'api_key';
      body.credentials = { [credKey]: key };
    }
    await api(`/admin/providers/${id}`, { method: 'PUT', body });
    closeModal(); toast('Provider updated', 'success'); loaders.providers();
  }

  async function deleteProvider(id) {
    if (!confirm('Delete this provider?')) return;
    await api(`/admin/providers/${id}`, { method: 'DELETE' });
    toast('Provider deleted'); loaders.providers();
  }

  async function healthCheckOne(id) {
    const p = _providers.find(p => p.id === id);
    toast(`Checking ${p?.name || id}...`);
    const { data } = await api('/admin/providers/health', { method: 'POST', body: {} });
    if (data) {
      const r = data.find(r => r.id === id);
      if (r) toast(`${p?.name || id}: ${r.status} (${r.latency_ms}ms)${r.message ? ' — ' + r.message : ''}`, r.status === 'healthy' ? 'success' : 'error');
    }
    loaders.providers();
  }

  async function healthCheck() {
    toast('Running health checks...');
    const { data } = await api('/admin/providers/health', { method: 'POST', body: {} });
    if (data) { data.forEach(r => toast(`${r.id}: ${r.status} (${r.latency_ms}ms)${r.message ? ' — ' + r.message : ''}`, r.status === 'healthy' ? 'success' : 'error')); }
    loaders.providers();
  }

  // Soul
  async function addSoulModal() {
    await loadProvidersList();
    const providerOpts = _providers.map(p =>
      `<option value="${h(p.id)}">${h(p.name)} (${p.type})</option>`
    ).join('');

    openModal('Add Soul', `
      <form onsubmit="OS.saveSoul(event)" id="soul-form">
        <div class="form-row">
          <div class="form-group" style="flex:2"><label class="form-label">Name</label><input name="name" required placeholder="e.g. Translator"></div>
          <div class="form-group" style="flex:1"><label class="form-label">Slug</label><input name="slug" placeholder="Auto from name" class="input-mono"></div>
        </div>

        <div class="form-group">
          <label class="form-label">Provider</label>
          <select name="provider_id" id="soul-provider" onchange="OS.onSoulProviderChange()">
            <option value="">Use default (highest priority)</option>
            ${providerOpts}
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Model</label>
          <div id="soul-model-wrapper">
            <select name="model" id="soul-model-select" class="input-mono" style="display:none">
              <option value="">Loading models...</option>
            </select>
            <input name="model_manual" id="soul-model-input" placeholder="Select a provider to load models" class="input-mono">
          </div>
          <div id="soul-model-status" style="margin-top:4px"></div>
        </div>

        <div class="form-group">
          <label class="form-label">Soul Instructions</label>
          <p class="form-hint" style="margin-bottom:6px">Tell the AI how to behave. This is the system prompt injected before every message.</p>
          <textarea name="system_prompt" rows="6" required placeholder="You are a professional translator. Translate the given content accurately. Preserve HTML structure, tone, and proper nouns. Return only the translation."></textarea>
        </div>

        <div class="form-row">
          <div class="form-group"><label class="form-label">Temperature</label><input name="temperature" type="number" step="0.1" value="0.7" min="0" max="2"><p class="form-hint">0 = precise, 1 = creative</p></div>
          <div class="form-group"><label class="form-label">Max Tokens</label><input name="max_tokens" type="number" value="4096"></div>
        </div>

        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Create Soul</button>
      </form>
    `);
  }

  async function onSoulProviderChange() {
    const providerId = document.getElementById('soul-provider')?.value;
    const modelSelect = document.getElementById('soul-model-select');
    const modelInput = document.getElementById('soul-model-input');
    const statusEl = document.getElementById('soul-model-status');

    if (!providerId) {
      modelSelect.style.display = 'none';
      modelInput.style.display = '';
      modelInput.placeholder = 'Select a provider to load models';
      statusEl.innerHTML = '';
      return;
    }

    statusEl.innerHTML = '<span class="text-muted text-sm">Loading models...</span>';
    modelInput.style.display = 'none';

    const provider = _providers.find(p => p.id === providerId);
    const res = await api('/admin/providers/probe', {
      method: 'POST',
      body: {
        type: provider?.type,
        api_key: '', // probe without key to get model list
        base_url: provider?.base_url || undefined,
      }
    });

    const models = res.models || [];
    if (models.length > 0) {
      modelSelect.innerHTML = '<option value="">Use provider default</option>' +
        models.map(m => `<option value="${h(m)}">${h(m)}</option>`).join('');
      modelSelect.style.display = '';
      statusEl.innerHTML = `<span class="text-muted text-sm">${models.length} models available</span>`;
    } else {
      modelSelect.style.display = 'none';
      modelInput.style.display = '';
      modelInput.placeholder = 'Type model name manually';
      statusEl.innerHTML = '<span class="text-muted text-sm">Could not fetch models — type manually</span>';
    }
  }

  async function saveSoul(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const model = f.get('model') || f.get('model_manual') || '';
    const body = {
      name: f.get('name'),
      system_prompt: f.get('system_prompt'),
      temperature: parseFloat(f.get('temperature')) || 0.7,
      max_tokens: parseInt(f.get('max_tokens')) || 4096,
    };
    if (f.get('slug')) body.slug = f.get('slug');
    if (model) body.model = model;
    if (f.get('provider_id')) body.provider_id = f.get('provider_id');

    if (f.get('id')) {
      await api(`/admin/souls/${f.get('id')}`, { method: 'PUT', body });
    } else {
      await api('/admin/souls', { method: 'POST', body });
    }
    closeModal(); toast('Soul saved', 'success'); loaders.souls();
  }

  async function editSoulModal(id) {
    const [{ data }, _] = await Promise.all([api(`/admin/souls/${id}`), loadProvidersList()]);
    if (!data) return;

    const providerOpts = _providers.map(p =>
      `<option value="${h(p.id)}" ${data.provider_id === p.id ? 'selected' : ''}>${h(p.name)} (${p.type})</option>`
    ).join('');

    openModal('Edit Soul', `
      <form onsubmit="OS.saveSoul(event)" id="soul-form">
        <input type="hidden" name="id" value="${data.id}">
        <div class="form-group"><label class="form-label">Name</label><input name="name" value="${h(data.name)}" required></div>

        <div class="form-group">
          <label class="form-label">Provider</label>
          <select name="provider_id" id="soul-provider" onchange="OS.onSoulProviderChange()">
            <option value="">Use default (highest priority)</option>
            ${providerOpts}
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Model</label>
          <div id="soul-model-wrapper">
            <select name="model" id="soul-model-select" class="input-mono" style="display:none">
              <option value="">Loading models...</option>
            </select>
            <input name="model_manual" id="soul-model-input" value="${h(data.model || '')}" placeholder="Select a provider to load models" class="input-mono">
          </div>
          <div id="soul-model-status" style="margin-top:4px"></div>
        </div>

        <div class="form-group">
          <label class="form-label">Soul Instructions</label>
          <textarea name="system_prompt" rows="6" required>${h(data.system_prompt)}</textarea>
        </div>

        <div class="form-row">
          <div class="form-group"><label class="form-label">Temperature</label><input name="temperature" type="number" step="0.1" value="${data.temperature}" min="0" max="2"></div>
          <div class="form-group"><label class="form-label">Max Tokens</label><input name="max_tokens" type="number" value="${data.max_tokens}"></div>
        </div>

        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Save Changes</button>
      </form>
    `);

    // Auto-load models if provider is selected
    if (data.provider_id) {
      setTimeout(async () => {
        await onSoulProviderChange();
        // Re-select the current model
        const select = document.getElementById('soul-model-select');
        if (select && data.model) {
          const opt = select.querySelector(`option[value="${CSS.escape(data.model)}"]`);
          if (opt) opt.selected = true;
        }
      }, 100);
    }
  }

  async function deleteSoul(id) {
    if (!confirm('Delete this soul?')) return;
    await api(`/admin/souls/${id}`, { method: 'DELETE' });
    toast('Soul deleted'); loaders.souls();
  }

  // Keys
  async function createKeyModal() {
    openModal('Create Key', `
      <div class="option-list">
        <button class="option-card option-primary" onclick="OS.createApiKeyForm()">
          <div class="option-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg></div>
          <div class="option-card-text">
            <div class="option-card-title">API Key</div>
            <div class="option-card-desc">Standard OpenAI-compatible key for any app</div>
          </div>
        </button>
        <button class="option-card" onclick="OS.createOpenClawKeyForm()">
          <div class="option-card-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg></div>
          <div class="option-card-text">
            <div class="option-card-title">OpenClaw Key</div>
            <div class="option-card-desc">Key + ready-to-paste openclaw.json config</div>
          </div>
        </button>
      </div>
    `);
  }

  async function createApiKeyForm() {
    await loadSoulsList();

    const soulCheckboxes = _souls.length > 0 ? `
      <div class="form-group">
        <label class="form-label">Soul Access</label>
        <div style="margin-bottom:6px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="checkbox" id="key-all-souls" onchange="OS.toggleAllSouls(this.checked)" checked style="width:auto">
            <strong>All Souls</strong>
          </label>
        </div>
        <div id="key-soul-list" style="display:none;max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;display:flex;flex-direction:column;gap:4px">
          ${_souls.map(s => `
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;padding:4px 0">
              <input type="checkbox" name="soul_ids" value="${h(s.id)}" style="width:auto" class="soul-checkbox">
              ${h(s.name)} <span class="text-muted text-sm">(${h(s.slug)})</span>
            </label>
          `).join('')}
        </div>
        <p class="form-hint">Select which souls this key can access</p>
      </div>
    ` : '';

    openModal('Create API Key', `
      <form onsubmit="OS.saveKey(event)" id="key-form">
        <div class="form-group"><label class="form-label">Name</label><input name="name" required placeholder="e.g. my-assistant"></div>
        ${soulCheckboxes}
        <div class="form-group">
          <label class="form-label">Rate Limit (per min)</label>
          <input name="rpm" type="number" value="60">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Generate Key</button>
      </form>
    `);

    // Hide soul list initially since "All" is checked
    const soulList = document.getElementById('key-soul-list');
    if (soulList) soulList.style.display = 'none';
  }

  async function createOpenClawKeyForm() {
    await loadSoulsList();

    // Get available models from providers
    const models = [];
    for (const p of _providers) {
      if (p.is_enabled) {
        const cfg = typeof p.config === 'string' ? JSON.parse(p.config || '{}') : (p.config || {});
        const model = cfg.default_model || p.type;
        models.push({ id: model, name: `${p.name} — ${model}` });
      }
    }

    const modelOpts = models.map(m =>
      `<option value="${h(m.id)}">${h(m.name)}</option>`
    ).join('');

    openModal('Create OpenClaw Key', `
      <form onsubmit="OS.saveOpenClawKey(event)" id="openclaw-key-form">
        <div class="form-group"><label class="form-label">Name</label><input name="name" value="openclaw" required placeholder="e.g. openclaw-main"></div>
        <div class="form-group">
          <label class="form-label">Primary Model</label>
          <select name="model" class="input-mono">${modelOpts}</select>
          <p class="form-hint">The model OpenClaw will request via OpenHinge</p>
        </div>
        <div class="form-group">
          <label class="form-label">Rate Limit (per min)</label>
          <input name="rpm" type="number" value="120">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:8px">Generate OpenClaw Key</button>
      </form>
    `);
  }

  async function saveOpenClawKey(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const model = f.get('model') || 'claude-sonnet-4-6';

    const { data } = await api('/admin/keys', { method: 'POST', body: {
      name: f.get('name'),
      rate_limit_rpm: parseInt(f.get('rpm')) || 120,
    }});

    if (data?.key) {
      const host = window.location.hostname || 'localhost';
      const port = window.location.port || '3700';
      const baseUrl = `http://${host}:${port}/v1`;

      const configSnippet = JSON.stringify({
        openhinge: {
          baseUrl: baseUrl,
          apiKey: data.key,
          api: 'openai-completions',
          models: [{
            id: model,
            name: `OpenHinge — ${model}`,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 16384,
          }],
        },
      }, null, 2);

      closeModal();
      openModal('OpenClaw Key Created', `
        <p style="margin-bottom:12px;font-size:13px;color:var(--text-secondary)">Save this key now. It will not be shown again.</p>
        <div class="code-block" style="word-break:break-all;margin-bottom:12px">${data.key}</div>
        <p style="margin-bottom:8px;font-size:13px;font-weight:600">Add to openclaw.json → models.providers:</p>
        <div class="code-block" style="font-size:11px;max-height:240px;overflow:auto;white-space:pre;margin-bottom:12px">${h(configSnippet)}</div>
        <p style="margin-bottom:8px;font-size:13px;font-weight:600">Then set as primary model:</p>
        <div class="code-block" style="font-size:11px;white-space:pre;margin-bottom:12px">"primary": "openhinge/${h(model)}"</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" style="flex:1" onclick="navigator.clipboard.writeText('${data.key}');OS.toast('Key copied!','success')">Copy Key</button>
          <button class="btn btn-primary" style="flex:1" onclick="navigator.clipboard.writeText(${h(JSON.stringify(configSnippet))});OS.toast('Config copied!','success')">Copy Config</button>
        </div>
      `);
    }
    loaders.keys();
  }

  function toggleAllSouls(checked) {
    const list = document.getElementById('key-soul-list');
    if (!list) return;
    list.style.display = checked ? 'none' : 'flex';
    if (checked) {
      list.querySelectorAll('.soul-checkbox').forEach(cb => cb.checked = false);
    }
  }

  async function saveKey(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const allSouls = document.getElementById('key-all-souls')?.checked ?? true;
    const soulIds = allSouls ? [] : Array.from(document.querySelectorAll('.soul-checkbox:checked')).map(cb => cb.value);

    const { data } = await api('/admin/keys', { method: 'POST', body: {
      name: f.get('name'),
      soul_ids: soulIds.length > 0 ? soulIds : undefined,
      rate_limit_rpm: parseInt(f.get('rpm')) || 60,
    }});
    if (data?.key) {
      closeModal();
      openModal('Key Created', `
        <p style="margin-bottom:12px;font-size:13px;color:var(--text-secondary)">Save this key now. It will not be shown again.</p>
        <div class="code-block" style="word-break:break-all">${data.key}</div>
        <button class="btn btn-secondary" style="width:100%;margin-top:16px" onclick="navigator.clipboard.writeText('${data.key}');OS.toast('Copied!','success')">Copy to Clipboard</button>
      `);
    }
    loaders.keys();
  }

  async function revokeKey(id) {
    if (!confirm('Revoke this key? It will stop working immediately.')) return;
    await api(`/admin/keys/${id}/revoke`, { method: 'POST' });
    toast('Key revoked', 'success'); loaders.keys();
  }

  async function deleteKey(id) {
    if (!confirm('Delete this key permanently?')) return;
    await api(`/admin/keys/${id}`, { method: 'DELETE' });
    toast('Key deleted'); loaders.keys();
  }

  // Cloudflare
  async function cfConnect() {
    const tokenInput = document.getElementById('cf-api-token');
    const btn = document.getElementById('cf-connect-btn');
    const status = document.getElementById('cf-connect-status');
    const cfToken = tokenInput?.value;

    if (!cfToken) { toast('Enter API token first', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Connecting...';
    status.innerHTML = '';

    const res = await api('/admin/cloudflare/zones', { method: 'POST', body: { api_token: cfToken } });

    btn.disabled = false;
    btn.textContent = 'Reconnect';

    if (res.error) {
      status.innerHTML = `<span class="badge badge-danger"><span class="badge-dot"></span>${h(res.error)}</span>`;
      return;
    }

    const zones = res.data || [];
    if (zones.length === 0) {
      status.innerHTML = '<span class="badge badge-warning"><span class="badge-dot"></span>No zones found</span>';
      return;
    }

    status.innerHTML = `<span class="badge badge-success"><span class="badge-dot"></span>Connected — ${zones.length} zone(s) found</span>`;
    window._cfToken = cfToken;

    // Show zone dropdown, hide manual input
    const zoneSelect = document.getElementById('cf-zone-select');
    const zoneManual = document.getElementById('cf-zone-manual');

    const currentZoneId = zoneManual?.value || '';
    zoneSelect.innerHTML = '<option value="">Select a domain...</option>' +
      zones.map(z => `<option value="${h(z.id)}" data-domain="${h(z.name)}" data-account="${h(z.account_id)}" ${z.id === currentZoneId ? 'selected' : ''}>${h(z.name)} (${h(z.id.slice(0,8))}...)</option>`).join('');

    zoneSelect.style.display = '';
    zoneManual.style.display = 'none';

    // If a zone was already selected, trigger change to load tunnels
    if (zoneSelect.value) {
      cfZoneChange();
    }
  }

  async function cfZoneChange() {
    const zoneSelect = document.getElementById('cf-zone-select');
    const opt = zoneSelect.selectedOptions[0];
    if (!opt?.value) return;

    const domain = opt.dataset.domain;
    const accountId = opt.dataset.account;

    // Update hidden/visible fields
    document.getElementById('cf-domain-input').value = domain;
    document.getElementById('cf-account-id').value = accountId;
    document.getElementById('cf-zone-manual').value = opt.value;
    document.getElementById('cf-hostname-suffix').textContent = `.${domain}`;

    // Fetch tunnels
    const cfToken = window._cfToken || document.getElementById('cf-api-token').value;
    if (!cfToken) return;

    const res = await api('/admin/cloudflare/tunnels', { method: 'POST', body: { api_token: cfToken, account_id: accountId } });
    const tunnels = res.data || [];

    if (tunnels.length > 0) {
      const tunnelSelect = document.getElementById('cf-tunnel-select');
      const tunnelManual = document.getElementById('cf-tunnel-manual');
      const currentTunnelId = tunnelManual?.value || '';

      tunnelSelect.innerHTML = '<option value="">Select a tunnel...</option>' +
        tunnels.map(t => `<option value="${h(t.id)}" ${t.id === currentTunnelId ? 'selected' : ''}>${h(t.name)} — ${t.status || '?'}${t.connections > 0 ? ' (' + t.connections + ' conns)' : ''}</option>`).join('');

      tunnelSelect.style.display = '';
      tunnelManual.style.display = 'none';

      // If a tunnel was selected, update manual field
      if (tunnelSelect.value) {
        tunnelManual.value = tunnelSelect.value;
      }

      tunnelSelect.onchange = () => {
        tunnelManual.value = tunnelSelect.value;
      };
    }

    // Fetch existing DNS records
    const dnsRes = await api('/admin/cloudflare/dns', { method: 'POST', body: { api_token: cfToken, zone_id: opt.value } });
    const records = dnsRes.data || [];

    const routesEl = document.getElementById('cf-existing-routes');
    if (records.length > 0) {
      routesEl.innerHTML = `
        <div style="margin-top:8px;margin-bottom:8px">
          <label class="form-label">Existing CNAME Records on ${h(domain)}</label>
          <div style="max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;font-size:12px;font-family:var(--font-mono)">
            ${records.map(r => `<div style="padding:3px 0;color:var(--text-secondary)">${h(r.name)} -> ${h(r.content)}${r.proxied ? ' <span class="badge badge-success" style="font-size:10px;padding:1px 4px">proxied</span>' : ''}</div>`).join('')}
          </div>
        </div>
      `;
    } else {
      routesEl.innerHTML = '';
    }
  }

  async function saveCloudflare(e) {
    e.preventDefault();
    const f = new FormData(e.target);

    // Use select value if visible, otherwise manual input
    const zoneSelect = document.getElementById('cf-zone-select');
    const zoneId = (zoneSelect?.style.display !== 'none' && zoneSelect?.value) ? zoneSelect.value : f.get('zone_id_manual');
    const tunnelSelect = document.getElementById('cf-tunnel-select');
    const tunnelId = (tunnelSelect?.style.display !== 'none' && tunnelSelect?.value) ? tunnelSelect.value : f.get('tunnel_id_manual');

    // Get tunnel name from selected option
    const tunnelOpt = tunnelSelect?.selectedOptions?.[0];
    const tunnelName = tunnelOpt?.value ? tunnelOpt.textContent.split(' — ')[0].trim() : '';

    // Get domain from zone select or hidden input
    const domain = f.get('domain') || '';

    await api('/admin/settings/cloudflare', { method: 'PUT', body: {
      enabled: f.has('enabled'),
      api_token: f.get('api_token'),
      account_id: f.get('account_id'),
      zone_id: zoneId || '',
      tunnel_id: tunnelId || '',
      tunnel_name: tunnelName,
      domain: domain,
      hostname: f.get('hostname'),
    }});
    toast('Cloudflare settings saved', 'success');
    loaders.cloudflare();
  }

  // Settings
  async function saveSettings(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/admin/settings/general', { method: 'PUT', body: {
      name: f.get('name'), timezone: f.get('timezone'),
    }});
    toast('Settings saved', 'success');
  }

  // ===== Init =====
  async function init() {
    // Check server health
    try {
      const res = await fetch('/health');
      const data = await res.json();
      if (data.status === 'ok') {
        document.querySelector('.status-dot').classList.add('online');
        document.querySelector('.status-text').textContent = 'Online';
      }
    } catch {
      document.querySelector('.status-dot').classList.add('offline');
      document.querySelector('.status-text').textContent = 'Offline';
    }
    document.getElementById('endpoint-url').textContent = window.location.host;

    // If no stored token, show welcome screen
    if (!token) {
      showWelcome();
      return;
    }

    // Validate stored token is still valid
    try {
      const res = await fetch('/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        token = '';
        localStorage.removeItem('oh_token');
        showWelcome();
        return;
      }
    } catch {
      // Server unreachable, proceed anyway (might come back)
    }

    const startPage = window.location.hash.replace('#', '') || 'dashboard';
    navigate(titles[startPage] ? startPage : 'dashboard', false);
  }

  // -- Provider filter/select/bulk helpers --
  function provFilter(key, value) {
    _provFilter[key] = value;
    loaders.providers();
  }
  function provClearFilters() {
    _provFilter = { search: '', type: '', health: '', enabled: '' };
    loaders.providers();
  }
  function provToggle(id, checked) {
    if (checked) _provSelected.add(id); else _provSelected.delete(id);
    loaders.providers();
  }
  function provSelectAll(checked) {
    if (checked) {
      // Select all currently visible
      let data = _providers;
      if (_provFilter.search) { const q = _provFilter.search.toLowerCase(); data = data.filter(p => p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q)); }
      if (_provFilter.type) data = data.filter(p => p.type === _provFilter.type);
      if (_provFilter.health) data = data.filter(p => p.health_status === _provFilter.health);
      if (_provFilter.enabled === '1') data = data.filter(p => p.is_enabled);
      if (_provFilter.enabled === '0') data = data.filter(p => !p.is_enabled);
      data.forEach(p => _provSelected.add(p.id));
    } else {
      _provSelected.clear();
    }
    loaders.providers();
  }
  function provSelectNone() { _provSelected.clear(); loaders.providers(); }
  async function provBulk(action) {
    const ids = [..._provSelected];
    if (ids.length === 0) return;
    if (action === 'delete' && !confirm(`Delete ${ids.length} provider${ids.length > 1 ? 's' : ''}?`)) return;
    if (action === 'health') {
      toast(`Checking ${ids.length} providers...`);
      await api('/admin/providers/health', { method: 'POST', body: {} });
      _provSelected.clear();
      loaders.providers();
      toast('Health checks complete', 'success');
      return;
    }
    const { ok, affected } = await api('/admin/providers/bulk', { method: 'POST', body: { action, ids } });
    if (ok) {
      _provSelected.clear();
      toast(`${action === 'delete' ? 'Deleted' : action === 'enable' ? 'Enabled' : 'Disabled'} ${affected} provider${affected !== 1 ? 's' : ''}`, 'success');
      loaders.providers();
    }
  }

  // -- Log filter/sort/pagination helpers --
  function logFilter(key, value) {
    _logFilters[key] = key === 'per_page' ? parseInt(value) : value;
    if (key !== 'page') _logFilters.page = 1; // reset to page 1 on filter change
    loaders.logs();
  }
  function logSort(col) {
    if (_logFilters.sort === col) {
      _logFilters.order = _logFilters.order === 'desc' ? 'asc' : 'desc';
    } else {
      _logFilters.sort = col;
      _logFilters.order = 'desc';
    }
    _logFilters.page = 1;
    loaders.logs();
  }
  function logPage(p) {
    _logFilters.page = p;
    loaders.logs();
  }
  function logClearFilters() {
    _logFilters = { page: 1, per_page: _logFilters.per_page, soul_id: '', provider_id: '', status: '', model: '', search: '', sort: 'created_at', order: 'desc' };
    loaders.logs();
  }
  function logDetail(requestId) {
    // Show log detail in modal — not critical, just nice to have
    if (!requestId) return;
    // Could fetch detail here, for now just show the request ID
    toast(`Request: ${requestId}`);
  }

  init();

  return {
    closeModal, toast, navigate, welcomeLogin, welcomeGo,
    addProviderModal, addProviderStep2, showApiKeyForm, showClaudeOauthForm, saveClaudeOauth, claudeOAuthLogin, saveProvider, editProviderModal, updateProvider, deleteProvider, healthCheck, healthCheckOne, fetchModels, onProviderTypeChange, quickAdd, openApiPage,
    addSoulModal, saveSoul, editSoulModal, deleteSoul, onSoulProviderChange,
    createKeyModal, createApiKeyForm, createOpenClawKeyForm, saveOpenClawKey, saveKey, revokeKey, deleteKey, toggleAllSouls,
    saveCloudflare, saveSettings, scrollDoc,
    cfConnect, cfZoneChange,
    provFilter, provClearFilters, provToggle, provSelectAll, provSelectNone, provBulk,
    logFilter, logSort, logPage, logClearFilters, logDetail,
  };
})();
