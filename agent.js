#!/usr/bin/env node
'use strict';

const puppeteer  = require('puppeteer');
const { parse }  = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const fs         = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const UNDERCUT_AMOUNT = 1.00;   // undercut cheapest listing by this much
const REQUEST_DELAY  = 2000;    // ms between searches
const HEADLESS       = false;   // show browser to avoid bot detection
const BASE_URL       = 'https://star-hangar.com';
// ──────────────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CSV helpers ───────────────────────────────────────────────────────────────
function loadInventory(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function formatInsurance(val) {
  if (!val || val === '' || val === '0') return 'no ins.';
  const n = parseInt(val, 10);
  if (n >= 120) return '120 months';
  if (n === 12)  return '12 months';
  return `${n} months`;
}

function isWarbond(title) {
  return /warbond/i.test(title);
}

function buildDescription(from, to, insurance, warbond) {
  const insLine = insurance && insurance !== '' && insurance !== '0'
    ? `${insurance}-Month Insurance`
    : 'No Insurance';
  const typeNote = warbond
    ? 'Warbond Edition — purchased directly with real money (not store credit)'
    : 'Standard Edition';
  return [
    `Cross-Chassis Upgrade (CCU) | ${from} → ${to}`,
    '',
    `Type: ${typeNote}`,
    `Insurance: ${insLine}`,
    `Condition: Unapplied — ready to gift`,
    `Transfer: Safe, instant gift on Star Hangar after payment confirmation`,
    '',
    `This CCU converts your pledged ${from} into a ${to} without losing your existing insurance or perks.`,
    `All sales are final. Gift sent within minutes of confirmed payment.`,
  ].join('\n');
}

function buildShortDesc(from, to, insurance) {
  const ins = insurance && insurance !== '' ? ` | ${insurance}-mo ins.` : '';
  return `CCU: ${from} → ${to}${ins} | Unapplied, instant gift after payment.`;
}

// Build search URL: use BASE_URL (no www), + for spaces, sort by price asc
function searchUrl(fromShip, toShip) {
  const q = `${fromShip} to ${toShip}`.replace(/ /g, '+');
  return `${BASE_URL}/catalogsearch/result/?q=${q}&product_list_order=price&product_list_dir=asc`;
}

// ── Star Hangar scraper ───────────────────────────────────────────────────────
async function fetchListings(page, fromShip, toShip) {
  const url = searchUrl(fromShip, toShip);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait up to 8s for either product items or a no-results message
  await page.waitForFunction(() => {
    return document.querySelectorAll('.product-item').length > 0 ||
           document.querySelector('.message.notice, .search.results dl.block') !== null;
  }, { timeout: 8000 }).catch(() => {});

  const pageUrl = page.url();

  // If we got redirected away from search results, bail early
  if (!pageUrl.includes('catalogsearch')) {
    return { listings: [], redirected: true, pageUrl };
  }

  const { listings, debugInfo } = await page.evaluate(({ fromShip, toShip }) => {
    const fromL = fromShip.toLowerCase();
    const toL   = toShip.toLowerCase();

    // Snapshot element counts for debugging
    const debugInfo = {};
    for (const s of ['.product-item', '.product-item-name', '.price', '.price-box', '[data-price-amount]', '.message.notice']) {
      debugInfo[s] = document.querySelectorAll(s).length;
    }

    const items = Array.from(document.querySelectorAll('.product-item'));
    const results = [];

    for (const item of items) {
      // Name — try several Magento 2 patterns
      const nameEl = item.querySelector('.product-item-name a, .product-item-link, strong.product-item-name a');
      if (!nameEl) continue;
      const name = nameEl.textContent.trim();

      // Must contain both ship names (case-insensitive)
      const nameLow = name.toLowerCase();
      if (!nameLow.includes(fromL) || !nameLow.includes(toL)) continue;

      // Price — prefer data-price-amount attribute (numeric, no formatting)
      let price = NaN;
      const priceAmountEl = item.querySelector('[data-price-amount]');
      if (priceAmountEl) {
        price = parseFloat(priceAmountEl.getAttribute('data-price-amount'));
      }
      if (isNaN(price) || price <= 0) {
        const priceEl = item.querySelector('.price-box .price, .price');
        if (priceEl) price = parseFloat(priceEl.textContent.replace(/[^0-9.]/g, ''));
      }
      if (isNaN(price) || price <= 0) continue;

      // Seller — extract first clean line only (avoids nested tooltip HTML)
      const sellerEl = item.querySelector('.seller-name, [class*="seller"], [class*="shop-name"], .product-item-sku');
      let seller = '';
      if (sellerEl) {
        const lines = sellerEl.textContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        seller = (lines[0] || '').replace(/^Seller:\s*/i, '');
      }

      results.push({ name, price, seller });
    }

    return { listings: results, debugInfo };
  }, { fromShip, toShip });

  return { listings, redirected: false, pageUrl, debugInfo };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Find inventory CSV (skip any output files we already created)
  const csvFiles = fs.readdirSync('.')
    .filter(f => f.endsWith('.csv') && !f.startsWith('pricing_'));
  if (!csvFiles.length) {
    console.error('Error: no inventory CSV found in current directory.');
    process.exit(1);
  }
  const csvPath = csvFiles[0];
  console.log(`\nLoading inventory: ${csvPath}`);

  const rows = loadInventory(csvPath);
  console.log(`${rows.length} CCU rows loaded.`);

  // Deduplicate by (from, to) for the search loop
  const pairsMap = new Map();
  for (const row of rows) {
    const key = `${row.from}|||${row.to}`;
    if (!pairsMap.has(key)) pairsMap.set(key, []);
    pairsMap.get(key).push(row);
  }
  console.log(`${pairsMap.size} unique (from → to) pairs to price.\n`);

  // Launch browser
  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Load homepage first to establish a session and cookies before searching
  console.log('Warming up session on star-hangar.com...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1000);
  console.log('Session ready. Starting searches...\n');

  // Price cache: key -> { lowest, seller, count }
  const priceCache = new Map();
  let searchIndex = 0;
  let firstSearch = true;

  for (const [key, entries] of pairsMap) {
    searchIndex++;
    const { from, to } = entries[0];
    process.stdout.write(`[${searchIndex}/${pairsMap.size}] ${from} → ${to} ... `);

    try {
      const result = await fetchListings(page, from, to);

      // On the first search, print debug info so we can verify selectors are working
      if (firstSearch) {
        firstSearch = false;
        console.log(`\n  [debug] landed on: ${result.pageUrl}`);
        if (result.debugInfo) console.log(`  [debug] element counts: ${JSON.stringify(result.debugInfo)}`);
      }

      if (result.redirected) {
        priceCache.set(key, { lowest: null, seller: null, count: 0 });
        console.log(`redirected (bot detection?) → ${result.pageUrl}`);
        await sleep(3000); // longer pause if we hit a block
        continue;
      }

      const { listings } = result;
      if (listings.length > 0) {
        // Already sorted by site (price asc) but sort locally too as safety
        listings.sort((a, b) => a.price - b.price);
        const cheapest = listings[0];
        priceCache.set(key, { lowest: cheapest.price, seller: cheapest.seller, count: listings.length });
        console.log(`$${cheapest.price.toFixed(2)} (${listings.length} on page, seller: ${cheapest.seller || 'unknown'})`);
      } else {
        priceCache.set(key, { lowest: null, seller: null, count: 0 });
        console.log('no matching listings on page 1');
      }
    } catch (err) {
      priceCache.set(key, { lowest: null, seller: null, count: 0 });
      console.log(`ERROR: ${err.message}`);
    }

    if (searchIndex < pairsMap.size) await sleep(REQUEST_DELAY);
  }

  await browser.close();
  console.log('\nBrowser closed.\n');

  // ── Build output ────────────────────────────────────────────────────────────
  const output = [];
  for (const row of rows) {
    const key    = `${row.from}|||${row.to}`;
    const market = priceCache.get(key) || { lowest: null, seller: null, count: 0 };
    const ourCost = parseFloat(row.pledge) || 0;
    const wb      = isWarbond(row.title);

    let recommendedPrice = '';
    if (market.lowest !== null) {
      const rec = parseFloat((market.lowest - UNDERCUT_AMOUNT).toFixed(2));
      // Never price below cost + $1 minimum margin
      recommendedPrice = Math.max(rec, ourCost + 1).toFixed(2);
    }

    const marginUsd = recommendedPrice
      ? (parseFloat(recommendedPrice) - ourCost).toFixed(2)
      : '';

    output.push({
      // ── StarHangar form columns (in form field order) ──────────────
      product_name:           row.title,
      short_description:      buildShortDesc(row.from, row.to, row.insurance),
      description:            buildDescription(row.from, row.to, row.insurance, wb),
      recommended_price:      recommendedPrice || 'SET MANUALLY',
      stock:                  row.count,
      insurance_label:        formatInsurance(row.insurance),
      upgrade_source_type:    wb ? 'warbond' : 'regular',
      upgrade_target:         row.to,
      // ── Market reference data ──────────────────────────────────────
      market_lowest_usd:      market.lowest !== null ? market.lowest.toFixed(2) : 'none',
      market_listing_count:   market.count,
      cheapest_seller:        market.seller || '',
      our_cost_usd:           ourCost.toFixed(2),
      margin_usd:             marginUsd,
      // ── Source inventory reference ─────────────────────────────────
      from_ship:              row.from,
      to_ship:                row.to,
      insurance_months:       row.insurance || '0',
      from_msrp:              row.fromMsrp,
      to_msrp:                row.toMsrp,
    });
  }

  // Sort: SET MANUALLY rows last
  output.sort((a, b) => {
    const aManual = a.recommended_price === 'SET MANUALLY' ? 1 : 0;
    const bManual = b.recommended_price === 'SET MANUALLY' ? 1 : 0;
    return aManual - bManual;
  });

  const outFile = `pricing_${new Date().toISOString().slice(0, 10)}.csv`;
  fs.writeFileSync(outFile, stringify(output, { header: true }));

  const priced    = output.filter(r => r.recommended_price !== 'SET MANUALLY').length;
  const manual    = output.length - priced;
  const totalRev  = output
    .filter(r => r.recommended_price !== 'SET MANUALLY')
    .reduce((sum, r) => sum + parseFloat(r.recommended_price) * parseInt(r.stock, 10), 0);
  const totalCost = output.reduce((sum, r) => sum + parseFloat(r.our_cost_usd) * parseInt(r.stock, 10), 0);

  console.log('═══════════════════════════════════════════');
  console.log(`  Output file : ${outFile}`);
  console.log(`  Rows total  : ${output.length}`);
  console.log(`  Priced      : ${priced}  (from market data)`);
  console.log(`  Set manually: ${manual}  (no listings found)`);
  if (priced > 0) {
    console.log(`  Est. revenue: $${totalRev.toFixed(2)}  (if all sell)`);
    console.log(`  Total cost  : $${totalCost.toFixed(2)}`);
    console.log(`  Est. profit : $${(totalRev - totalCost).toFixed(2)}`);
  }
  console.log('═══════════════════════════════════════════\n');
  console.log(`Open ${outFile} to review pricing, then fill StarHangar listings.`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
