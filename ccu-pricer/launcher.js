#!/usr/bin/env node
// Doc's Ship Shop — Local Launcher
// Double-click launcher.bat to start

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 4444;
const WIN = process.platform === "win32";
const APP_DIR = __dirname;
const REPO_DIR = path.resolve(__dirname, "..");
const NPM = WIN ? "npm.cmd" : "npm";

let devServer = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function openUrl(url) {
  const args = WIN ? ["", url] : [url];
  const proc = spawn(WIN ? "start" : "open", args, { shell: WIN, detached: true, stdio: "ignore" });
  proc.on("error", () => {}); // ignore — openUrl is best-effort
  proc.unref();
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  };
}

function streamProc(res, proc, onReady) {
  res.writeHead(200, sseHeaders());
  const send = (text, err = false) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ text, err })}\n\n`);
  };
  const done = (code) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true, ok: code === 0 })}\n\n`);
      res.end();
    }
  };
  proc.stdout.on("data", (d) => { const t = d.toString(); send(t); if (onReady) onReady(t); });
  proc.stderr.on("data", (d) => send(d.toString(), true));
  proc.on("close", done);
  proc.on("error", (e) => { send(`Error: ${e.message}\n`, true); done(1); });
}

function chromePath() {
  if (!WIN) return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

// ── Request handler ───────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Dashboard
  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(DASHBOARD_HTML);
    return;
  }

  // Launch Chrome with remote debug port
  if (pathname === "/api/chrome") {
    const cp = chromePath();
    const userDir = path.join(os.tmpdir(), "chrome-ccu-pricer");
    spawn(WIN ? `"${cp}"` : cp, [
      "--remote-debugging-port=9222",
      `--user-data-dir=${userDir}`,
    ], { shell: WIN, detached: true, stdio: "ignore" }).unref();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Open Star Hangar login (in whatever browser is default — user should click the debug Chrome)
  if (pathname === "/api/starhangar") {
    openUrl("https://star-hangar.com/customer/account/login/");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // git pull
  if (pathname === "/api/pull") {
    const proc = spawn("git", ["pull", "origin", "main"], {
      cwd: REPO_DIR, shell: WIN,
    });
    streamProc(res, proc);
    return;
  }

  // npm install
  if (pathname === "/api/install") {
    const proc = spawn(NPM, ["install"], { cwd: APP_DIR, shell: WIN });
    streamProc(res, proc);
    return;
  }

  // Start dev server (long-running — streams output until killed)
  if (pathname === "/api/dev") {
    if (devServer) { devServer.kill(); devServer = null; }
    devServer = spawn(NPM, ["run", "dev"], { cwd: APP_DIR, shell: WIN });
    let opened = false;
    streamProc(res, devServer, (text) => {
      if (!opened && (text.includes("Ready") || text.includes("Local:"))) {
        opened = true;
        const m = text.match(/localhost:(\d+)/);
        openUrl(`http://localhost:${m ? m[1] : "3000"}`);
      }
    });
    devServer.on("close", () => { devServer = null; });
    return;
  }

  // Stop dev server
  if (pathname === "/api/stop") {
    if (devServer) { devServer.kill(); devServer = null; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Doc's Ship Shop Launcher\n  → http://localhost:${PORT}\n`);
  openUrl(`http://localhost:${PORT}`);
});

// ── Dashboard HTML ────────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Doc's Ship Shop</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #030712; color: #e5e7eb; min-height: 100vh; padding: 32px 24px; }
  h1   { font-size: 1.6rem; font-weight: 700; color: #f59e0b; letter-spacing: .5px; }
  .sub { color: #6b7280; font-size: .875rem; margin-top: 4px; }

  .steps { display: flex; flex-direction: column; gap: 12px; margin: 28px 0 0; }

  .step {
    background: #111827; border: 1px solid #1f2937; border-radius: 14px;
    padding: 20px 22px; display: flex; align-items: flex-start; gap: 18px;
  }
  .step.running { border-color: #f59e0b; }
  .step.done    { border-color: #16a34a; }
  .step.err     { border-color: #dc2626; }

  .num {
    flex-shrink: 0; width: 34px; height: 34px; border-radius: 50%;
    background: #1f2937; color: #9ca3af; font-weight: 700; font-size: .9rem;
    display: flex; align-items: center; justify-content: center;
  }
  .step.done .num   { background: #14532d; color: #4ade80; }
  .step.running .num{ background: #78350f; color: #fcd34d; }

  .body { flex: 1; }
  .title  { font-weight: 600; font-size: 1rem; color: #f3f4f6; }
  .desc   { font-size: .8rem; color: #6b7280; margin-top: 3px; line-height: 1.5; }
  .btns   { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }

  button {
    padding: 8px 18px; border: none; border-radius: 8px; cursor: pointer;
    font-size: .82rem; font-weight: 600; transition: background .15s;
  }
  .btn-amber { background: #d97706; color: #000; }
  .btn-amber:hover { background: #f59e0b; }
  .btn-gray  { background: #374151; color: #d1d5db; }
  .btn-gray:hover { background: #4b5563; }
  .btn-green { background: #15803d; color: #fff; }
  .btn-green:hover { background: #16a34a; }
  button:disabled { opacity: .4; cursor: not-allowed; }

  .note {
    margin-top: 10px; font-size: .78rem; color: #92400e;
    background: #1c1008; border: 1px solid #78350f; border-radius: 6px;
    padding: 8px 12px; line-height: 1.5;
  }
  .status-badge {
    display: inline-block; font-size: .72rem; font-weight: 600; border-radius: 99px;
    padding: 2px 10px; margin-top: 10px;
  }
  .badge-running { background:#78350f; color:#fde68a; }
  .badge-done    { background:#14532d; color:#86efac; }
  .badge-err     { background:#7f1d1d; color:#fca5a5; }

  .console-wrap {
    margin-top: 24px; background: #0a0f1a; border: 1px solid #1f2937;
    border-radius: 14px; overflow: hidden;
  }
  .console-hdr {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; background: #111827; border-bottom: 1px solid #1f2937;
    font-size: .78rem; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .5px;
  }
  pre#out {
    padding: 16px; font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
    font-size: .78rem; line-height: 1.6; color: #86efac; max-height: 340px;
    overflow-y: auto; white-space: pre-wrap; word-break: break-all;
  }
  .err-line { color: #f87171; }
</style>
</head>
<body>

<h1>Doc's Ship Shop</h1>
<p class="sub">CCU Pricing &amp; Listing Launcher — click through the steps below</p>

<div class="steps">

  <!-- Step 1 -->
  <div class="step" id="s1">
    <div class="num">1</div>
    <div class="body">
      <div class="title">Launch Chrome (debug mode)</div>
      <div class="desc">Opens a separate Chrome window with remote debugging enabled so the posting automation can control it.</div>
      <div class="btns">
        <button class="btn-amber" onclick="launchChrome()">Launch Chrome</button>
      </div>
      <div id="s1-status"></div>
    </div>
  </div>

  <!-- Step 2 -->
  <div class="step" id="s2">
    <div class="num">2</div>
    <div class="body">
      <div class="title">Log in to Star Hangar</div>
      <div class="desc">Click to open the Star Hangar login page. <strong>Make sure to click on the Chrome window that opened in Step 1</strong> before logging in — that's the controlled session the automation uses.</div>
      <div class="btns">
        <button class="btn-gray" onclick="openStarHangar()">Open Star Hangar Login</button>
      </div>
      <div class="note">⚠ Log in inside the Step 1 Chrome window, not your regular browser.</div>
    </div>
  </div>

  <!-- Step 3 -->
  <div class="step" id="s3">
    <div class="num">3</div>
    <div class="body">
      <div class="title">Update &amp; Start App</div>
      <div class="desc">Pulls the latest code, installs any new dependencies, then starts the app. Your browser opens automatically when it's ready.</div>
      <div class="btns">
        <button class="btn-green" id="start-btn" onclick="updateAndStart()">Update &amp; Start</button>
        <button class="btn-gray" id="quick-btn" onclick="quickStart()">Quick Start (skip update)</button>
        <button class="btn-gray" id="stop-btn" onclick="stopDev()" style="display:none">Stop Server</button>
      </div>
      <div id="s3-status"></div>
    </div>
  </div>

</div>

<!-- Console -->
<div class="console-wrap">
  <div class="console-hdr">
    <span>Output</span>
    <button class="btn-gray" style="padding:3px 10px;font-size:.72rem" onclick="clearConsole()">Clear</button>
  </div>
  <pre id="out">Ready. Complete the steps above to get started.</pre>
</div>

<script>
const out = document.getElementById('out');

function log(text, isErr = false) {
  const span = document.createElement('span');
  if (isErr) span.className = 'err-line';
  span.textContent = text;
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}

function clearConsole() {
  out.textContent = '';
}

function setStep(id, state) {
  const el = document.getElementById(id);
  el.className = 'step ' + (state || '');
}

function setBadge(id, text, cls) {
  const el = document.getElementById(id + '-status');
  if (!el) return;
  el.innerHTML = text
    ? '<span class="status-badge ' + cls + '">' + text + '</span>'
    : '';
}

async function launchChrome() {
  log('\\nLaunching Chrome with remote debugging on port 9222…\\n');
  const r = await fetch('/api/chrome');
  if (r.ok) {
    setStep('s1', 'done');
    setBadge('s1', '✓ Chrome launched', 'badge-done');
    log('Chrome launched. A new window should appear.\\n');
  } else {
    setStep('s1', 'err');
    log('Failed to launch Chrome. Check the path in launcher.js.\\n', true);
  }
}

function openStarHangar() {
  fetch('/api/starhangar');
  log('\\nOpening Star Hangar login…\\n');
  setStep('s2', 'done');
  setBadge('s2', 'Log in then continue', 'badge-running');
}

async function streamTo(url, stepId, onDone) {
  setStep(stepId, 'running');
  const es = new EventSource(url);
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.text) log(d.text, d.err);
    if (d.done) {
      es.close();
      if (onDone) onDone(d.ok !== false);
    }
  };
  es.onerror = () => {
    es.close();
    setStep(stepId, 'err');
    log('Connection lost.\\n', true);
    if (onDone) onDone(false);
  };
}

async function updateAndStart() {
  document.getElementById('start-btn').disabled = true;
  document.getElementById('quick-btn').disabled = true;
  clearConsole();
  log('Pulling latest code…\\n');
  setStep('s3', 'running');
  setBadge('s3', 'Pulling…', 'badge-running');

  streamTo('/api/pull', 's3', (ok) => {
    if (!ok) { setStep('s3', 'err'); setBadge('s3', '✗ Pull failed', 'badge-err'); return; }
    log('\\nInstalling dependencies…\\n');
    setBadge('s3', 'Installing…', 'badge-running');
    streamTo('/api/install', 's3', (ok2) => {
      if (!ok2) { setStep('s3', 'err'); setBadge('s3', '✗ Install failed', 'badge-err'); return; }
      startDevServer();
    });
  });
}

function quickStart() {
  document.getElementById('start-btn').disabled = true;
  document.getElementById('quick-btn').disabled = true;
  clearConsole();
  startDevServer();
}

function startDevServer() {
  log('\\nStarting dev server…\\n');
  setBadge('s3', 'Starting…', 'badge-running');
  document.getElementById('stop-btn').style.display = '';

  const es = new EventSource('/api/dev');
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.text) {
      log(d.text, d.err);
      if (d.text.includes('Ready') || d.text.includes('Local:')) {
        setStep('s3', 'done');
        setBadge('s3', '✓ Running — browser opened', 'badge-done');
      }
    }
    if (d.done) {
      es.close();
      setStep('s3', '');
      setBadge('s3', 'Server stopped', 'badge-err');
      document.getElementById('start-btn').disabled = false;
      document.getElementById('quick-btn').disabled = false;
      document.getElementById('stop-btn').style.display = 'none';
    }
  };
  es.onerror = () => es.close();
}

async function stopDev() {
  await fetch('/api/stop');
  log('\\nDev server stopped.\\n');
  document.getElementById('stop-btn').style.display = 'none';
  document.getElementById('start-btn').disabled = false;
  document.getElementById('quick-btn').disabled = false;
}
</script>
</body>
</html>`;
