#!/usr/bin/env node
'use strict';

require('dotenv').config();
const puppeteer = require('puppeteer');
const { parse } = require('csv-parse/sync');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const DRY_RUN    = process.env.DRY_RUN    !== 'false'; // default true — set DRY_RUN=false to submit
const LIMIT      = parseInt(process.env.LIMIT      || '0', 10); // 0 = no limit
const START_FROM = parseInt(process.env.START_FROM || '1', 10); // 1-based row index
const HEADLESS   = false;
const BASE_URL   = 'https://star-hangar.com';
const ADD_URL    = `${BASE_URL}/marketplace/product/add/set/11/type/product_type_star_citizen/`;
const DELAY      = 1500; // ms between listings
// ──────────────────────────────────────────────────────────────────────────────

const PROGRESS_FILE   = 'autofill_progress.json';
const CACHE_FILE      = 'ship_options_cache.json';
const SCREENSHOTS_DIR = 'screenshots';

// insurance_months → StarHangar select value
const INS_MAP = { '120': '255', '12': '249', '0': '4', '': '4' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Fuzzy ship-name matching ──────────────────────────────────────────────────
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(str) {
  return new Set(normalize(str).split(' ').filter(w => w.length > 1));
}
function jaccardScore(query, candidate) {
  const q = tokenize(query);
  const c = tokenize(candidate);
  if (!q.size || !c.size) return 0;
  let hits = 0;
  for (const t of q) { if (c.has(t)) hits++; }
  return hits / new Set([...q, ...c]).size;
}
function bestMatch(query, options, threshold = 0.3) {
  let top = null, topScore = 0;
  for (const opt of options) {
    const s = jaccardScore(query, opt.text);
    if (s > topScore) { topScore = s; top = opt; }
  }
  return topScore >= threshold ? { ...top, score: topScore } : null;
}

// ── Progress tracking ─────────────────────────────────────────────────────────
function loadProgress() {
  return fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'))
    : { completed: [], failed: [] };
}
function saveProgress(p) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); }

// ── Ship-options cache (scraped once, reused on subsequent runs) ───────────────
async function getShipOptions(page) {
  if (fs.existsSync(CACHE_FILE)) {
    console.log(`Using cached ship options (${CACHE_FILE})`);
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  }
  console.log('Scraping ship dropdown options (one-time cache)...');
  await page.goto(ADD_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  const opts = await page.evaluate(() => {
    const getOpts = sel => {
      const el = document.querySelector(sel);
      if (!el) return [];
      return Array.from(el.options).filter(o => o.value).map(o => ({ value: o.value, text: o.text.trim() }));
    };
    return {
      source: getOpts('select[name="product[starcitizen_upgrade_source]"]'),
      target: getOpts('select[name="product[starcitizen_upgrade_target]"]'),
    };
  });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(opts, null, 2));
  console.log(`Cached ${opts.source.length} source options, ${opts.target.length} target options.\n`);
  return opts;
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(page) {
  const { SH_EMAIL: email, SH_PASSWORD: pwd } = process.env;
  if (!email || !pwd) throw new Error('SH_EMAIL and SH_PASSWORD must be set in .env');
  await page.goto(`${BASE_URL}/customer/account/login/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.type('#email', email);
  await page.type('#password', pwd);
  await page.click('.action.login.primary');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
  if (page.url().includes('/login/')) throw new Error('Login failed — check SH_EMAIL / SH_PASSWORD in .env');
  console.log('Logged in.\n');
}

// ── Fill one listing ──────────────────────────────────────────────────────────
async function fillListing(page, row, shipOpts, index) {
  await page.goto(ADD_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Product name
  await page.$eval('input#name', el => { el.value = ''; });
  await page.type('input#name', row.product_name);

  // Description (plain textarea — no TinyMCE on this form)
  await page.$eval('textarea#description', (el, v) => { el.value = v; }, row.description);

  // Short description
  await page.$eval('textarea#short_description', (el, v) => { el.value = v; }, row.short_description);

  // Price
  await page.$eval('input#price', el => { el.value = ''; });
  await page.type('input#price', String(row.recommended_price));

  // Stock quantity
  await page.$eval('input#qty', el => { el.value = ''; });
  await page.type('input#qty', String(row.stock));

  // In stock
  await page.select('select[name="product[quantity_and_stock_status][is_in_stock]"]', '1');

  // Package type = Upgrade (14)
  await page.select('select[name="product[starcitizen_package]"]', '14');

  // Insurance
  const insVal = INS_MAP[String(row.insurance_months)] ?? '4';
  await page.select('select[name="product[starcitizen_insurance]"]', insVal);

  // Upgrade source — "regular" uses the known value 5917; warbond fuzzy-matches "warbond" in options
  const isWarbond = row.upgrade_source_type === 'warbond';
  if (isWarbond) {
    const wbMatch = bestMatch('warbond', shipOpts.source, 0.2);
    if (wbMatch) {
      await page.select('select[name="product[starcitizen_upgrade_source]"]', wbMatch.value);
    } else {
      console.warn(`  ⚠ No warbond source option found — source field left at default`);
    }
  } else {
    await page.select('select[name="product[starcitizen_upgrade_source]"]', '5917').catch(async () => {
      // 5917 not present — fall back to fuzzy match on "regular"
      const fallback = bestMatch('regular', shipOpts.source, 0.2);
      if (fallback) await page.select('select[name="product[starcitizen_upgrade_source]"]', fallback.value);
    });
  }

  // Upgrade target — fuzzy match to_ship name
  const targetMatch = bestMatch(row.to_ship, shipOpts.target);
  if (targetMatch) {
    await page.select('select[name="product[starcitizen_upgrade_target]"]', targetMatch.value);
    if (targetMatch.score < 0.5) {
      console.warn(`  ⚠ Low-confidence target: "${row.to_ship}" → "${targetMatch.text}" (score ${targetMatch.score.toFixed(2)})`);
    }
  } else {
    console.warn(`  ⚠ No target match for: ${row.to_ship} — field left at default`);
  }

  // Package state = CCU'ed Product (6319)
  await page.select('select[name="product[starcitizen_package_state]"]', '6319');

  // Screenshot before submitting
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const safe   = row.product_name.replace(/[^a-z0-9]/gi, '_').slice(0, 50);
  const ssPath = path.join(SCREENSHOTS_DIR, `${String(index).padStart(3, '0')}_${safe}.png`);
  await page.screenshot({ path: ssPath });
  console.log(`  Screenshot → ${ssPath}`);

  if (!DRY_RUN) {
    const btn = await page.$('button#save-button, button[data-ui-id="save-button"], .action.save.primary');
    if (!btn) throw new Error('Submit button not found on form');
    await btn.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    console.log(`  ✅ Submitted`);
  } else {
    console.log(`  [DRY RUN] Not submitted.`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Find latest pricing CSV
  const csvFiles = fs.readdirSync('.')
    .filter(f => f.startsWith('pricing_') && f.endsWith('.csv'))
    .sort().reverse();
  if (!csvFiles.length) {
    console.error('No pricing_*.csv found. Run agent.js first.');
    process.exit(1);
  }
  const csvPath = csvFiles[0];
  console.log(`\nLoading: ${csvPath}`);

  const allRows = parse(fs.readFileSync(csvPath, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true })
    .filter(r => r.recommended_price !== 'SET MANUALLY' && r.recommended_price !== '');
  console.log(`${allRows.length} priceable rows.`);

  const progress = loadProgress();
  const done = new Set(progress.completed);

  let queue = allRows.slice(START_FROM - 1).filter(r => !done.has(r.product_name));
  if (LIMIT > 0) queue = queue.slice(0, LIMIT);

  console.log(`Queue: ${queue.length} rows  |  Already done: ${done.size}`);
  if (DRY_RUN) {
    console.log('Mode: DRY RUN — forms filled, screenshots taken, NOT submitted.');
    console.log('      Set DRY_RUN=false in .env (or env var) when ready to go live.\n');
  } else {
    console.log('Mode: LIVE — forms WILL be submitted.\n');
  }
  if (!queue.length) { console.log('Nothing to do.'); return; }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized', '--disable-blink-features=AutomationControlled'],
    defaultViewport: null,
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  let filled = 0, failed = 0;
  try {
    await login(page);
    const shipOpts = await getShipOptions(page);

    for (let i = 0; i < queue.length; i++) {
      const row = queue[i];
      const globalIdx = allRows.indexOf(row) + 1;
      console.log(`\n[${i + 1}/${queue.length}] ${row.product_name}`);
      try {
        await fillListing(page, row, shipOpts, globalIdx);
        progress.completed.push(row.product_name);
        saveProgress(progress);
        filled++;
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
        progress.failed.push({ name: row.product_name, error: err.message, ts: new Date().toISOString() });
        saveProgress(progress);
        failed++;
      }
      if (i < queue.length - 1) await sleep(DELAY);
    }
  } finally {
    await browser.close();
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Processed : ${filled + failed}`);
  console.log(`  Filled    : ${filled}`);
  console.log(`  Failed    : ${failed}`);
  console.log(`  Mode      : ${DRY_RUN ? 'DRY RUN' : 'LIVE SUBMIT'}`);
  if (failed) console.log(`  Details   : ${PROGRESS_FILE}`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
