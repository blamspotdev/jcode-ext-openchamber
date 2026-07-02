// JCode host shim for the OpenChamber VS Code webview bundle.
// Plays the role of the VS Code extension host: answers the bundle's bridge messages
// (acquireVsCodeApi().postMessage) and pushes host events, while agent traffic goes straight to a
// local opencode server. IDE/runtime access rides the JCode Extension API (JCodeNative.request).
(function () {
  'use strict';

  var OC_PORT = 4463;
  var OC_BASE = 'http://127.0.0.1:' + OC_PORT;
  var SETTINGS_KEY = 'jcode.openchamber.settings';

  // ---- JCode Extension API v1 client -------------------------------------------------------
  var pending = {};
  var seq = 0;
  window.JCode = {
    request: function (type, payload) {
      return new Promise(function (resolve) {
        var id = 'q' + seq++;
        pending[id] = resolve;
        try {
          window.JCodeNative.request(id, JSON.stringify({ type: type, payload: payload || {} }));
        } catch (e) {
          delete pending[id];
          resolve({ ok: false, error: 'bridge unavailable: ' + e });
        }
      });
    },
    _onResult: function (id, payload) {
      var cb = pending[id];
      if (!cb) return;
      delete pending[id];
      var r;
      try { r = JSON.parse(payload); } catch (e) { r = { ok: false, error: String(payload) }; }
      cb(r);
    },
    _onEvent: function (name, json) {
      if (name !== 'activeFile') return;
      var p = null;
      try { p = JSON.parse(json); } catch (e) { p = null; }
      var payload = p && p.path ? {
        filePath: p.path,
        fileName: p.name || '',
        relativePath: (p.path || '').replace(/^\/workspace\//, ''),
        fileSize: null,
        selection: null,
      } : null;
      window.postMessage({ type: 'command', command: 'activeEditorFile', payload: payload }, '*');
    },
  };

  function sh(command, timeoutMs) {
    return JCode.request('exec.run', { command: command, timeoutMs: timeoutMs || 30000 })
      .then(function (r) { return r.ok ? r.data : { error: r.error }; });
  }

  // ---- settings (persisted in the WebView's localStorage) ----------------------------------
  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { s = {}; }
    if (!s.messageStreamTransport) s.messageStreamTransport = 'sse'; // opencode has no WS endpoint
    if (!s.lastDirectory) s.lastDirectory = '/workspace';
    return s;
  }
  function saveSettings(changes) {
    var merged = loadSettings();
    var keys = Object.keys(changes || {});
    for (var i = 0; i < keys.length; i++) merged[keys[i]] = changes[keys[i]];
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  }

  // ---- opencode HTTP helpers ----------------------------------------------------------------
  function cleanHeaders(h) {
    var out = {};
    var enc = false;
    Object.keys(h || {}).forEach(function (k) {
      var lk = k.toLowerCase();
      if (lk === 'content-length' || lk === 'host' || lk === 'connection') return;
      if (lk === 'x-opencode-directory-encoding') { enc = (h[k] === 'uri'); return; }
      out[k] = h[k];
    });
    if (enc && out['x-opencode-directory']) {
      try { out['x-opencode-directory'] = decodeURIComponent(out['x-opencode-directory']); } catch (e) { /* keep raw */ }
    }
    return out;
  }
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function ocPath(p) { return (p || '/').replace(/^\/api(?=\/|$)/, '') || '/'; }

  function proxyToOpencode(payload) {
    var init = {
      method: payload.method || 'GET',
      headers: cleanHeaders(payload.headers),
    };
    if (payload.bodyBase64) init.body = b64ToBytes(payload.bodyBase64);
    else if (typeof payload.bodyText === 'string') init.body = payload.bodyText;
    return fetch(OC_BASE + ocPath(payload.path), init).then(function (res) {
      return res.text().then(function (text) {
        var headers = {};
        res.headers.forEach(function (v, k) { headers[k] = v; });
        return { status: res.status, headers: headers, bodyText: text };
      });
    });
  }

  // ---- SSE proxy over bridge frames ----------------------------------------------------------
  var sseStreams = {};
  var sseSeq = 0;
  function startSse(payload) {
    var streamId = 'sse' + (++sseSeq) + '_' + seq;
    var controller = new AbortController();
    sseStreams[streamId] = controller;
    fetch(OC_BASE + ocPath(payload.path || '/event'), {
      headers: Object.assign({ Accept: 'text/event-stream' }, cleanHeaders(payload.headers)),
      signal: controller.signal,
    }).then(function (res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      function pump() {
        reader.read().then(function (r) {
          if (r.done) {
            delete sseStreams[streamId];
            window.postMessage({ type: 'api:sse:end', streamId: streamId }, '*');
            return;
          }
          window.postMessage({ type: 'api:sse:chunk', streamId: streamId, chunk: decoder.decode(r.value, { stream: true }) }, '*');
          pump();
        }).catch(function (e) {
          delete sseStreams[streamId];
          window.postMessage({ type: 'api:sse:end', streamId: streamId, error: String(e) }, '*');
        });
      }
      pump();
    }).catch(function (e) {
      delete sseStreams[streamId];
      window.postMessage({ type: 'api:sse:end', streamId: streamId, error: String(e) }, '*');
    });
    return { status: 200, headers: {}, streamId: streamId };
  }

  // ---- fs family over the JCode Extension API -------------------------------------------------
  function fsList(payload) {
    var dir = (payload && (payload.path || payload.directory)) || '/workspace';
    return JCode.request('fs.list', { path: dir }).then(function (r) {
      if (!r.ok) throw new Error(r.error);
      var entries = (r.data.entries || []).map(function (e) {
        return {
          name: e.name,
          path: (dir.replace(/\/$/, '')) + '/' + e.name,
          isDirectory: !!e.dir,
          isFile: !e.dir,
          isSymbolicLink: false,
          size: e.size,
        };
      });
      return { directory: dir, entries: entries };
    });
  }

  // ---- bridge dispatch -------------------------------------------------------------------------
  function reply(req, success, data, error) {
    var msg = { id: req.id, type: req.type, success: success };
    if (data !== undefined) msg.data = data;
    if (error) msg.error = error;
    window.postMessage(msg, '*');
  }

  function handle(req) {
    var t = req.type;
    var p = req.payload || {};
    var done = function (data) { reply(req, true, data); };
    var fail = function (e) { reply(req, false, undefined, (e && e.message) || String(e)); };
    try {
      if (t === 'api:proxy' || t === 'api:session:message') return proxyToOpencode(p).then(done, fail);
      if (t === 'api:sse:start') return done(startSse(p));
      if (t === 'api:sse:stop') {
        if (sseStreams[p.streamId]) sseStreams[p.streamId].abort();
        delete sseStreams[p.streamId];
        return done({ stopped: true });
      }
      if (t === 'api:proxy:abort') return done({});
      if (t === 'api:config/settings:get') return done(loadSettings());
      if (t === 'api:config/settings:save') return done(saveSettings(p && (p.settings || p.changes || p)));
      if (t === 'api:config/reload') return done({ restarted: false });
      if (t === 'api:behavior/agents-md:get') {
        return sh('cat "$HOME/.config/opencode/AGENTS.md" 2>/dev/null').then(function (r) {
          var content = (r && r.stdout) || '';
          done({ content: content, exists: content.length > 0 });
        }, fail);
      }
      if (t === 'api:behavior/agents-md:save') {
        var body = (p && p.content) || '';
        var cmd = 'mkdir -p "$HOME/.config/opencode" && cat > "$HOME/.config/opencode/AGENTS.md" <<\'JCODE_EOF\'\n' + body + '\nJCODE_EOF';
        return sh(cmd, 20000).then(function () { done({ success: true }); }, fail);
      }
      if (t === 'editor:openFile') {
        return JCode.request('workbench.openFile', { path: p.path, line: p.line, column: p.column })
          .then(function () { done({}); }, fail);
      }
      if (t === 'editor:openDiff') return done({}); // no diff surface in JCode yet; no-op keeps UI quiet
      if (t === 'vscode:openExternalUrl') {
        return JCode.request('workbench.openUrl', { url: p.url }).then(function () { done({}); }, fail);
      }
      if (t === 'api:fs:list') return fsList(p).then(done, fail);
      if (t === 'api:fs/home') return done({ home: '/workspace' });
      if (t === 'api:fs:read') {
        return JCode.request('fs.read', { path: p.path }).then(function (r) {
          if (!r.ok) return fail(r.error);
          done({ content: r.data.content, path: p.path });
        });
      }
      if (t === 'api:fs:write') {
        return JCode.request('fs.write', { path: p.path, content: p.content || '' }).then(function (r) {
          r.ok ? done({ success: true, path: p.path }) : fail(r.error);
        });
      }
      if (t === 'api:fs:mkdir') {
        return sh('mkdir -p ' + JSON.stringify(p.path || '')).then(function () { done({ success: true, path: p.path }); }, fail);
      }
      if (t === 'api:fs:stat') {
        return sh('stat -c "%F %s" ' + JSON.stringify(p.path || '') + ' 2>/dev/null').then(function (r) {
          var out = (r && r.stdout) || '';
          if (!out) return fail('no such file');
          done({ path: p.path, isFile: out.indexOf('regular') >= 0, size: parseInt(out.replace(/[^0-9]/g, ''), 10) || 0 });
        }, fail);
      }
      if (t === 'api:fs:search') return done([]);
      if (t === 'api:git/check') return done(false);           // hide git chrome for now
      if (t.indexOf('api:git/') === 0) return fail('Git integration is not available in JCode yet.');
      if (t.indexOf('api:github/') === 0) return fail('GitHub integration is not available in JCode.');
      if (t === 'api:models/metadata') return done({});
      if (t === 'api:zen:models') return done({ models: [] });
      if (t === 'api:quota:providers') return done({ providers: [] });
      if (t === 'api:session-activity:get') return done({});
      if (t === 'api:notifications/auto-accept') return done({ success: true });
      if (t === 'api:notifications:claim') return done({ claimed: true });
      if (t === 'api:opencode/version') return done({ version: null });
      if (t === 'api:opencode/directory') return done({ success: true, restarted: false, path: p.path });
      if (t === 'api:openchamber:update-check') return done({ available: false });
      if (t === 'api:magic-prompts:get' || t === 'api:magic-prompts:save' ||
          t === 'api:magic-prompts:reset' || t === 'api:magic-prompts:reset-all') {
        return done({ version: 1, overrides: {} });
      }
      if (t === 'api:provider/source:get') return done({});
      if (t === 'api:config/opencode-resolution:get') return done({});
      if (t === 'api:config/agents' || t === 'api:config/commands' || t === 'api:config/mcp' ||
          t === 'api:config/snippets' || t === 'api:config/skills' || t === 'api:config/plugins') {
        return done([]);
      }
      return fail('Not supported in JCode: ' + t);
    } catch (e) {
      return fail(e);
    }
  }

  // acquireVsCodeApi polyfill — must exist before the bundle's lazy first call.
  var webviewState = null;
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (msg && msg.type === 'bridge:ack') return;
        if (msg && msg.id && msg.type) handle(msg);
      },
      getState: function () { return webviewState; },
      setState: function (s) { webviewState = s; },
    };
  };

  // ---- opencode lifecycle ---------------------------------------------------------------------
  function setStatus(text) {
    var el = document.getElementById('loading-status');
    if (el) el.textContent = text;
  }
  function postConn(status, error) {
    window.postMessage({ type: 'connectionStatus', status: status, error: error }, '*');
  }
  function health() {
    return fetch(OC_BASE + '/global/health').then(function (r) { return r.ok; }, function () { return false; });
  }
  function bootOpencode() {
    postConn('connecting');
    health().then(function (up) {
      if (up) { postConn('connected'); return; }
      setStatus('Starting the opencode agent…');
      var start = [
        'export PATH="$PATH:$HOME/.opencode/bin"',
        'if ! command -v opencode >/dev/null 2>&1; then echo MISSING; exit 1; fi',
        'mkdir -p /opt/openchamber',
        'cd /workspace 2>/dev/null || cd /',
        'nohup opencode serve --hostname 127.0.0.1 --port ' + OC_PORT + ' >/opt/openchamber/opencode.log 2>&1 &',
        'sleep 1; echo started',
      ].join('\n');
      sh(start, 30000).then(function (r) {
        if (r && r.stdout && r.stdout.indexOf('MISSING') >= 0) {
          setStatus('opencode is not installed — install it from Tools → Toolchains (AI).');
          postConn('error', 'opencode is not installed. Install "opencode AI agent" in Tools → Toolchains.');
          return;
        }
        var tries = 0;
        var timer = setInterval(function () {
          tries++;
          health().then(function (ok) {
            if (ok) { clearInterval(timer); postConn('connected'); }
            else if (tries > 45) {
              clearInterval(timer);
              setStatus('The agent did not start; check /opt/openchamber/opencode.log');
              postConn('error', 'opencode did not start in time (see /opt/openchamber/opencode.log).');
            }
          });
        }, 1000);
      });
    });
  }

  window.addEventListener('DOMContentLoaded', function () {
    window.postMessage({ type: 'themeChange', theme: 'dark' }, '*');
    bootOpencode();
    // Seed the context chip with the currently focused file.
    JCode.request('workbench.activeFile', {}).then(function (r) {
      if (r.ok) JCode._onEvent('activeFile', JSON.stringify(r.data || {}));
    });
  });
})();
