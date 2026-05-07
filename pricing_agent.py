#!/usr/bin/env python3
"""
StarHangar CCU Pricing Agent

Reads your CCU inventory from CSV, browses StarHangar.com for matching listings,
and recommends competitive prices using Claude as the analysis engine.

Usage:
    python pricing_agent.py ccus_20260507.csv

Requirements:
    pip install anthropic playwright
    playwright install chromium   # or connect your Chrome (see README)

Environment:
    ANTHROPIC_API_KEY   - required
    CHROME_CDP_URL      - optional, connect to existing Chrome (default: http://localhost:9222)
                          To use your Chrome: launch it with --remote-debugging-port=9222
"""

import csv
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import anthropic
from playwright.sync_api import sync_playwright, Page, Browser, BrowserContext

# ── constants ────────────────────────────────────────────────────────────────

MODEL = "claude-sonnet-4-6"
STARHANGAR_BASE = "https://www.starhangar.com"
SCREENSHOT_DIR = Path("screenshots")
REPORT_PATH = Path("pricing_report.md")

# How long to pause between CCU searches (be polite to the server)
CRAWL_DELAY_S = 2.0

# ── data models ──────────────────────────────────────────────────────────────

@dataclass
class CCUItem:
    from_ship: str
    to_ship: str
    count: int
    from_msrp: float
    to_msrp: float
    pledge: float
    saving: float
    insurance: str
    title: str

@dataclass
class MarketListing:
    price: float
    seller: str = ""
    insurance: str = ""
    note: str = ""

@dataclass
class CCUMarketData:
    from_ship: str
    to_ship: str
    count_owned: int
    from_msrp: float
    to_msrp: float
    pledge: float
    saving: float
    insurance: str
    listings: list[MarketListing] = field(default_factory=list)

    @property
    def msrp_diff(self) -> float:
        return self.to_msrp - self.from_msrp

    @property
    def prices(self) -> list[float]:
        return [l.price for l in self.listings]

    @property
    def min_price(self) -> Optional[float]:
        return min(self.prices) if self.prices else None

    @property
    def max_price(self) -> Optional[float]:
        return max(self.prices) if self.prices else None

    @property
    def avg_price(self) -> Optional[float]:
        p = self.prices
        return sum(p) / len(p) if p else None

# ── CSV parsing ───────────────────────────────────────────────────────────────

def parse_csv(filepath: str) -> list[CCUItem]:
    items = []
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                items.append(CCUItem(
                    from_ship=row["from"].strip(),
                    to_ship=row["to"].strip(),
                    count=int(row.get("count", 1)),
                    from_msrp=float(row["fromMsrp"]) if row.get("fromMsrp") else 0.0,
                    to_msrp=float(row["toMsrp"]) if row.get("toMsrp") else 0.0,
                    pledge=float(row["pledge"]) if row.get("pledge") else 0.0,
                    saving=float(row["saving"]) if row.get("saving") else 0.0,
                    insurance=row.get("insurance", "").strip(),
                    title=row.get("title", "").strip(),
                ))
            except (ValueError, KeyError) as e:
                print(f"  Warning: skipping malformed row — {e}")
    return items


def aggregate_inventory(items: list[CCUItem]) -> list[CCUMarketData]:
    """Deduplicate and sum counts for each unique from→to pair."""
    seen: dict[tuple[str, str], CCUMarketData] = {}
    for item in items:
        key = (item.from_ship, item.to_ship)
        if key not in seen:
            seen[key] = CCUMarketData(
                from_ship=item.from_ship,
                to_ship=item.to_ship,
                count_owned=item.count,
                from_msrp=item.from_msrp,
                to_msrp=item.to_msrp,
                pledge=item.pledge,
                saving=item.saving,
                insurance=item.insurance,
            )
        else:
            seen[key].count_owned += item.count
    return list(seen.values())

# ── Playwright browser tools ──────────────────────────────────────────────────

class Browser:
    """Thin wrapper around a Playwright page exposing tools for the Claude agent."""

    def __init__(self, page: Page):
        self.page = page
        self._screenshot_counter = 0

    def navigate(self, url: str) -> str:
        try:
            self.page.goto(url, timeout=30_000, wait_until="domcontentloaded")
            time.sleep(1.5)  # let JS render
            return f"Navigated to {url}. Title: {self.page.title()}"
        except Exception as e:
            return f"Navigation error: {e}"

    def get_text(self, selector: str = "body") -> str:
        try:
            el = self.page.query_selector(selector)
            if el:
                text = el.inner_text()
                return text[:8000]  # cap to avoid huge context
            return f"No element found for selector: {selector}"
        except Exception as e:
            return f"get_text error: {e}"

    def get_html(self, selector: str = "body") -> str:
        try:
            el = self.page.query_selector(selector)
            if el:
                html = el.inner_html()
                return html[:6000]
            return f"No element found for selector: {selector}"
        except Exception as e:
            return f"get_html error: {e}"

    def click(self, selector: str) -> str:
        try:
            self.page.click(selector, timeout=8_000)
            time.sleep(0.8)
            return f"Clicked: {selector}"
        except Exception as e:
            # Try clicking by text if selector fails
            try:
                self.page.get_by_text(selector, exact=False).first.click(timeout=5_000)
                time.sleep(0.8)
                return f"Clicked by text: {selector}"
            except Exception:
                return f"click error: {e}"

    def fill(self, selector: str, text: str) -> str:
        try:
            self.page.fill(selector, text, timeout=8_000)
            return f"Filled '{selector}' with '{text}'"
        except Exception as e:
            return f"fill error: {e}"

    def press_enter(self, selector: str) -> str:
        try:
            self.page.press(selector, "Enter")
            time.sleep(1.5)
            return "Pressed Enter"
        except Exception as e:
            return f"press_enter error: {e}"

    def select_option(self, selector: str, value: str) -> str:
        try:
            self.page.select_option(selector, label=value, timeout=5_000)
            time.sleep(0.5)
            return f"Selected '{value}' in '{selector}'"
        except Exception:
            try:
                self.page.select_option(selector, value=value, timeout=5_000)
                time.sleep(0.5)
                return f"Selected value '{value}' in '{selector}'"
            except Exception as e:
                return f"select_option error: {e}"

    def get_links(self) -> str:
        try:
            links = self.page.eval_on_selector_all(
                "a[href]",
                "els => els.map(e => ({text: e.innerText.trim().slice(0,80), href: e.href})).filter(l => l.text)"
            )
            return json.dumps(links[:50], indent=2)
        except Exception as e:
            return f"get_links error: {e}"

    def screenshot(self, name: str = "") -> str:
        SCREENSHOT_DIR.mkdir(exist_ok=True)
        self._screenshot_counter += 1
        fname = f"{self._screenshot_counter:03d}_{name or 'page'}.png"
        path = SCREENSHOT_DIR / fname
        try:
            self.page.screenshot(path=str(path), full_page=False)
            return f"Screenshot saved: {path}"
        except Exception as e:
            return f"screenshot error: {e}"

    def wait(self, seconds: float) -> str:
        time.sleep(seconds)
        return f"Waited {seconds}s"

    def current_url(self) -> str:
        return self.page.url

    def scroll_down(self) -> str:
        self.page.evaluate("window.scrollBy(0, window.innerHeight)")
        time.sleep(0.5)
        return "Scrolled down one viewport"

# ── Tool definitions for Claude ───────────────────────────────────────────────

BROWSER_TOOLS = [
    {
        "name": "navigate",
        "description": "Navigate the browser to a URL. Returns the page title.",
        "input_schema": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "Full URL to navigate to"}},
            "required": ["url"],
        },
    },
    {
        "name": "get_text",
        "description": "Get the visible text of the page or a CSS-selected element (max 8000 chars). Use selector='body' for full page.",
        "input_schema": {
            "type": "object",
            "properties": {"selector": {"type": "string", "description": "CSS selector (default: body)", "default": "body"}},
            "required": [],
        },
    },
    {
        "name": "get_html",
        "description": "Get the inner HTML of a CSS-selected element (max 6000 chars). Useful for understanding page structure.",
        "input_schema": {
            "type": "object",
            "properties": {"selector": {"type": "string", "description": "CSS selector (default: body)", "default": "body"}},
            "required": [],
        },
    },
    {
        "name": "click",
        "description": "Click an element by CSS selector or visible text.",
        "input_schema": {
            "type": "object",
            "properties": {"selector": {"type": "string", "description": "CSS selector or visible button/link text"}},
            "required": ["selector"],
        },
    },
    {
        "name": "fill",
        "description": "Type text into an input field (clears existing content first).",
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector for the input"},
                "text": {"type": "string", "description": "Text to type"},
            },
            "required": ["selector", "text"],
        },
    },
    {
        "name": "press_enter",
        "description": "Press Enter in an input field (to submit a search form).",
        "input_schema": {
            "type": "object",
            "properties": {"selector": {"type": "string", "description": "CSS selector for the input"}},
            "required": ["selector"],
        },
    },
    {
        "name": "select_option",
        "description": "Select an option from a <select> dropdown.",
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector for the <select>"},
                "value": {"type": "string", "description": "Option label or value to select"},
            },
            "required": ["selector", "value"],
        },
    },
    {
        "name": "get_links",
        "description": "Get all links (text + href) on the current page — useful to discover navigation structure.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "scroll_down",
        "description": "Scroll down one viewport to load more listings.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "screenshot",
        "description": "Take a screenshot of the current page (saved to ./screenshots/).",
        "input_schema": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "Short descriptive name for the file"}},
            "required": [],
        },
    },
    {
        "name": "wait",
        "description": "Wait N seconds for content to load.",
        "input_schema": {
            "type": "object",
            "properties": {"seconds": {"type": "number", "description": "Seconds to wait (max 10)"}},
            "required": ["seconds"],
        },
    },
    {
        "name": "report_listings",
        "description": (
            "Call this when you have found all available listings for the current CCU. "
            "Pass the from_ship, to_ship, and a list of price/seller objects. "
            "This ends the search for this CCU."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "from_ship": {"type": "string"},
                "to_ship": {"type": "string"},
                "listings": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "price": {"type": "number", "description": "Price in USD"},
                            "seller": {"type": "string"},
                            "insurance": {"type": "string", "description": "e.g. 120-month, Warbond, LTI"},
                            "note": {"type": "string"},
                        },
                        "required": ["price"],
                    },
                },
                "no_listings_found": {
                    "type": "boolean",
                    "description": "Set true if you searched but found zero listings for this CCU",
                },
            },
            "required": ["from_ship", "to_ship"],
        },
    },
]

# ── Tool dispatcher ───────────────────────────────────────────────────────────

def dispatch_tool(browser: Browser, tool_name: str, tool_input: dict) -> tuple[str, Optional[list[MarketListing]]]:
    """
    Execute a browser tool call. Returns (result_text, listings_or_None).
    listings is non-None only when the agent calls report_listings.
    """
    if tool_name == "navigate":
        return browser.navigate(tool_input["url"]), None
    elif tool_name == "get_text":
        return browser.get_text(tool_input.get("selector", "body")), None
    elif tool_name == "get_html":
        return browser.get_html(tool_input.get("selector", "body")), None
    elif tool_name == "click":
        return browser.click(tool_input["selector"]), None
    elif tool_name == "fill":
        return browser.fill(tool_input["selector"], tool_input["text"]), None
    elif tool_name == "press_enter":
        return browser.press_enter(tool_input["selector"]), None
    elif tool_name == "select_option":
        return browser.select_option(tool_input["selector"], tool_input["value"]), None
    elif tool_name == "get_links":
        return browser.get_links(), None
    elif tool_name == "scroll_down":
        return browser.scroll_down(), None
    elif tool_name == "screenshot":
        return browser.screenshot(tool_input.get("name", "")), None
    elif tool_name == "wait":
        return browser.wait(min(float(tool_input.get("seconds", 2)), 10)), None
    elif tool_name == "report_listings":
        raw = tool_input.get("listings", [])
        listings = [
            MarketListing(
                price=float(item["price"]),
                seller=item.get("seller", ""),
                insurance=item.get("insurance", ""),
                note=item.get("note", ""),
            )
            for item in raw
            if item.get("price")
        ]
        msg = (
            f"No listings found for {tool_input['from_ship']} → {tool_input['to_ship']}"
            if tool_input.get("no_listings_found") or not listings
            else f"Recorded {len(listings)} listings for {tool_input['from_ship']} → {tool_input['to_ship']}"
        )
        return msg, listings
    else:
        return f"Unknown tool: {tool_name}", None

# ── Per-CCU agent loop ─────────────────────────────────────────────────────────

SEARCH_SYSTEM_PROMPT = """\
You are a browser automation agent. Your job is to find all active CCU (Cross-Chassis Upgrade) listings on StarHangar.com for a specific upgrade path.

StarHangar.com is a Star Citizen marketplace. CCUs let players upgrade from one ship to another.
Listings show a price, the from-ship, the to-ship, and sometimes insurance type.

Strategy:
1. Start at https://www.starhangar.com — look at navigation for an "Upgrades" or "CCU" section.
2. Use site search or filters to find listings for the specific from→to pair you are given.
3. Extract every listing's price (USD). Note insurance type if shown (120-month, LTI, Warbond, etc.).
4. If there are multiple pages of results, scroll/paginate through all of them.
5. When done, call report_listings with all prices you found. If zero results, set no_listings_found=true.

Be efficient — don't re-navigate to pages you've already seen. Stop as soon as you have all listings.
"""

def search_ccu_on_starhangar(
    client: anthropic.Anthropic,
    browser: Browser,
    ccu: CCUMarketData,
) -> list[MarketListing]:
    """Run a Claude agent loop to find listings for one CCU on StarHangar."""

    user_message = (
        f"Find all StarHangar.com listings for this CCU upgrade:\n"
        f"  From ship : {ccu.from_ship}\n"
        f"  To ship   : {ccu.to_ship}\n"
        f"  MSRP diff : ${ccu.msrp_diff:.0f} (${ccu.from_msrp:.0f} → ${ccu.to_msrp:.0f})\n\n"
        f"Navigate the site, search or filter for this specific CCU, and call report_listings when done."
    )

    messages = [{"role": "user", "content": user_message}]
    MAX_TURNS = 25

    for turn in range(MAX_TURNS):
        response = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=SEARCH_SYSTEM_PROMPT,
            tools=BROWSER_TOOLS,
            messages=messages,
        )

        # Append assistant response to history
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            # Agent finished without calling report_listings
            print(f"    Agent ended without report_listings — assuming no data.")
            return []

        if response.stop_reason != "tool_use":
            break

        # Process tool calls
        tool_results = []
        final_listings = None

        for block in response.content:
            if block.type != "tool_use":
                continue

            result_text, listings = dispatch_tool(browser, block.name, block.input)

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": result_text,
            })

            if block.name == "report_listings":
                final_listings = listings if listings is not None else []

        messages.append({"role": "user", "content": tool_results})

        if final_listings is not None:
            return final_listings

    print(f"    Agent hit max turns ({MAX_TURNS}) without completing.")
    return []

# ── Pricing analysis with Claude ──────────────────────────────────────────────

ANALYSIS_SYSTEM_PROMPT = """\
You are a Star Citizen marketplace pricing expert. Your task is to recommend competitive
selling prices for a seller's CCU (Cross-Chassis Upgrade) inventory on StarHangar.com.

CCUs let players upgrade from one ship to another. Sellers on StarHangar typically price them
based on:
- Active market listings (supply/demand)
- MSRP difference between ships (cost floor reference)
- Insurance type: Warbond/120-month CCUs are more valuable than standard ones
- Rarity and demand for the specific upgrade path

Pricing philosophy:
- If market data exists: suggest a price at or just below the lowest listing to sell quickly,
  or at the median if the seller wants to maximize profit per unit.
- If no market data: estimate based on MSRP difference × 1.1–1.3 for popular paths,
  or flag as "no data — price TBD" for obscure ones.
- Highlight any CCUs where savings (pledge cost vs MSRP diff) make them especially attractive.
"""

def generate_pricing_report(
    client: anthropic.Anthropic,
    market_data: list[CCUMarketData],
) -> str:
    payload = []
    for d in market_data:
        payload.append({
            "from_ship": d.from_ship,
            "to_ship": d.to_ship,
            "count_owned": d.count_owned,
            "from_msrp_usd": d.from_msrp,
            "to_msrp_usd": d.to_msrp,
            "msrp_difference_usd": round(d.msrp_diff, 2),
            "pledge_cost_usd": d.pledge,
            "your_saving_usd": d.saving,
            "insurance": d.insurance or "standard",
            "starhangar_listing_count": len(d.listings),
            "starhangar_min_price_usd": d.min_price,
            "starhangar_max_price_usd": d.max_price,
            "starhangar_avg_price_usd": round(d.avg_price, 2) if d.avg_price else None,
            "all_observed_prices_usd": d.prices,
        })

    prompt = (
        "Here is my CCU inventory with StarHangar market data. "
        "Please produce a pricing report as a Markdown table with these columns:\n\n"
        "| CCU (From → To) | Qty | MSRP Diff | Insurance | Market Listings | Mkt Min | Mkt Avg | **Recommended Price** | Notes |\n\n"
        "After the table, add a short bullet-point summary of key observations and pricing strategy.\n\n"
        "Inventory + market data:\n\n"
        f"```json\n{json.dumps(payload, indent=2)}\n```"
    )

    response = client.messages.create(
        model=MODEL,
        max_tokens=8096,
        system=ANALYSIS_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )

    return response.content[0].text

# ── Browser setup ──────────────────────────────────────────────────────────────

def create_browser_and_context(playwright):
    """
    Try to connect to an existing Chrome via CDP (if CHROME_CDP_URL is set or default port is open).
    Falls back to launching a new visible Chromium instance.
    """
    cdp_url = os.environ.get("CHROME_CDP_URL", "http://localhost:9222")
    try:
        browser = playwright.chromium.connect_over_cdp(cdp_url)
        contexts = browser.contexts
        context = contexts[0] if contexts else browser.new_context()
        print(f"Connected to existing Chrome at {cdp_url}")
        return browser, context, False  # False = we didn't launch it
    except Exception:
        print("No Chrome found on CDP port — launching new Chromium browser...")
        browser = playwright.chromium.launch(
            headless=False,
            args=["--start-maximized"],
        )
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        return browser, context, True  # True = we launched it

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # ── resolve CSV path
    if len(sys.argv) >= 2:
        csv_path = sys.argv[1]
    else:
        csv_files = sorted(Path(".").glob("*.csv"))
        if not csv_files:
            print("Usage: python pricing_agent.py <path/to/ccus.csv>")
            sys.exit(1)
        csv_path = str(csv_files[0])
        print(f"Auto-detected CSV: {csv_path}")

    # ── check API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY is not set.")
        print("  export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    # ── parse inventory
    print(f"\nParsing inventory from: {csv_path}")
    items = parse_csv(csv_path)
    market_data = aggregate_inventory(items)
    print(f"  {len(items)} rows → {len(market_data)} unique CCU types")

    client = anthropic.Anthropic(api_key=api_key)

    # ── scrape StarHangar
    print(f"\nSearching StarHangar.com for {len(market_data)} CCUs...")
    print("  (A browser window will open — don't close it)\n")

    with sync_playwright() as playwright:
        browser_obj, context, we_launched = create_browser_and_context(playwright)
        page = context.new_page()
        bw = Browser(page)

        for i, ccu in enumerate(market_data, 1):
            print(f"  [{i:>2}/{len(market_data)}] {ccu.from_ship} → {ccu.to_ship} ...")
            listings = search_ccu_on_starhangar(client, bw, ccu)
            ccu.listings = listings

            if listings:
                prices = ccu.prices
                print(f"          {len(listings)} listings  |  ${min(prices):.0f} – ${max(prices):.0f}  |  avg ${ccu.avg_price:.0f}")
            else:
                print(f"          no listings found")

            if i < len(market_data):
                time.sleep(CRAWL_DELAY_S)

        if we_launched:
            browser_obj.close()

    # ── generate report
    print("\nGenerating pricing recommendations with Claude...")
    report = generate_pricing_report(client, market_data)

    # ── save & display
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("# StarHangar CCU Pricing Report\n\n")
        f.write(report)

    print("\n" + "=" * 72)
    print(report)
    print("=" * 72)
    print(f"\nReport saved to: {REPORT_PATH.resolve()}")


if __name__ == "__main__":
    main()
