(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const chat = $('chat'), input = $('input'), sendBtn = $('send'), stopBtn = $('stop'), suggest = $('suggest');
  const msgEls = new Map(); // model message id -> element (streaming)
  const files = new Map(); // path -> {reason, reads: []}
  const toolEls = new Map();
  let running = false;

  function add(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  }
  function renderFiles() {
    const box = $('files');
    box.textContent = '';
    box.className = files.size ? '' : 'empty';
    if (!files.size) { box.textContent = 'Nothing yet. The agent lists the context it picked here.'; return; }
    for (const [p, f] of files) {
      const d = document.createElement('div');
      d.className = 'file';
      const c = document.createElement('code'); c.textContent = p; d.appendChild(c);
      if (f.reason) { const w = document.createElement('span'); w.className = 'why'; w.textContent = 'why: ' + f.reason; d.appendChild(w); }
      if (f.reads.length) { const r = document.createElement('span'); r.className = 'why'; r.textContent = 'read: ' + f.reads.join(', '); d.appendChild(r); }
      box.appendChild(d);
    }
  }
  function noteFile(path, patch) {
    const f = files.get(path) || { reason: '', reads: [] };
    if (patch.reason) f.reason = patch.reason;
    if (patch.read && !f.reads.includes(patch.read)) f.reads.push(patch.read);
    files.set(path, f);
    renderFiles();
  }
  function setRunning(r) {
    running = r;
    $('state').textContent = r ? 'running' : 'idle';
    $('state').className = r ? 'running' : 'idle';
    sendBtn.disabled = r; stopBtn.disabled = !r;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'user': add('msg user', m.text); break;
      case 'state': setRunning(m.running); break;
      case 'text': {
        let el = msgEls.get(m.id);
        if (!el) { el = add('msg agent', ''); msgEls.set(m.id, el); }
        el.textContent += m.delta; chat.scrollTop = chat.scrollHeight; break;
      }
      case 'tool': {
        const d = document.createElement('div'); d.className = 'tool';
        const n = document.createElement('span'); n.className = 'n'; n.textContent = m.name;
        d.appendChild(n); d.appendChild(document.createTextNode('  ' + (m.summary || '')));
        $('tools').appendChild(d); toolEls.set(m.id, d);
        const a = m.args || {};
        if ((m.name === 'read_file' || m.name === 'propose_edit' || m.name === 'propose_write') && a.path) noteFile(a.path, { read: m.name === 'read_file' ? (a.start_line ? a.start_line + '-' + (a.end_line || '') : '1-200') : null });
        if (m.name === 'read_symbol' && a.file) noteFile(a.file, { read: a.name });
        break;
      }
      case 'toolresult': { const d = toolEls.get(m.id); if (d) { const r = document.createElement('span'); r.className = 'r'; r.textContent = m.preview; d.appendChild(r); } break; }
      case 'context': for (const f of m.files) noteFile(f.path, { reason: f.reason }); break;
      case 'attached': {
        const box = $('attached'); box.textContent = ''; box.className = '';
        for (const it of m.items) { const d = document.createElement('div'); d.className = 'file'; d.textContent = '@' + it.kind + ' ' + it.ref + (it.ok ? ' (' + it.chars + ' chars' + (it.truncated ? ', truncated to budget' : '') + ')' : ' (not found or over budget)'); box.appendChild(d); }
        break;
      }
      case 'note': add('note', m.text); break;
      case 'review': add('ok', 'Review: ' + m.path + ' - applied ' + m.accepted + '/' + m.total + ' hunk(s)' + (m.note ? ' (' + m.note + ')' : '')); break;
      case 'done': add('ok', 'Done.'); break;
      case 'stopped': add('note', 'Stopped. Nothing was left half-applied.'); setRunning(false); break;
      case 'error': add('err', m.text); setRunning(false); break;
      case 'mention-results': showSuggest(m.items); break;
    }
  });

  // ---- @mention autocomplete
  let sel = 0, items = [];
  function currentToken() {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = /(^|\s)@([^\s]*)$/.exec(before);
    return m ? { start: pos - m[2].length - 1, q: m[2] } : null;
  }
  function showSuggest(list) {
    items = list; sel = 0;
    suggest.textContent = '';
    if (!list.length) { suggest.hidden = true; return; }
    list.forEach((it, i) => { const d = document.createElement('div'); d.textContent = (it.kind === 'file' ? '📄 ' : 'ƒ ') + it.value; if (i === 0) d.className = 'sel'; d.onmousedown = (ev) => { ev.preventDefault(); pick(i); }; suggest.appendChild(d); });
    suggest.hidden = false;
  }
  function pick(i) {
    const t = currentToken(); if (!t) return;
    const it = items[i];
    const ins = '@' + (it.kind === 'file' ? 'file:' : 'symbol:') + it.value + ' ';
    input.value = input.value.slice(0, t.start) + ins + input.value.slice(input.selectionStart);
    const np = t.start + ins.length; input.setSelectionRange(np, np);
    suggest.hidden = true;
  }
  input.addEventListener('input', () => { const t = currentToken(); if (t && t.q.length >= 1) vscode.postMessage({ type: 'mention-query', q: t.q }); else suggest.hidden = true; });
  input.addEventListener('keydown', (e) => {
    if (!suggest.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; [...suggest.children].forEach((c, i) => (c.className = i === sel ? 'sel' : '')); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(sel); return; }
      if (e.key === 'Escape') { suggest.hidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    files.clear(); renderFiles(); $('tools').textContent = ''; $('attached').className = 'empty'; $('attached').textContent = 'None. Type @ in the box to mention a file or symbol.';
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  }
  sendBtn.onclick = send;
  stopBtn.onclick = () => vscode.postMessage({ type: 'stop' });
  $('undo').onclick = () => vscode.postMessage({ type: 'undo' });
})();
