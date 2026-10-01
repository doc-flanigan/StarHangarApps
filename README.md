# StarHangar CCU Pricing Agent

Reads your CCU inventory CSV, browses StarHangar.com for matching listings,
and uses Claude to recommend competitive prices.

## Setup

```bash
pip install -r requirements.txt
playwright install chromium
```

Copy `.env.example` → `.env`, add your `ANTHROPIC_API_KEY`, then:

```bash
source .env
python pricing_agent.py ccus_20260507.csv
```

## Using your existing Chrome (recommended)

Launch Chrome with remote debugging enabled **before** running the agent:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --user-data-dir=$env:TEMP\chrome-debug

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

Then set `CHROME_CDP_URL=http://localhost:9222` in `.env`.

The agent will use your existing Chrome session (including any cookies/login).

## Output

- Console: live progress per CCU, then the full report
- `pricing_report.md`: Markdown table with recommended prices
- `screenshots/`: screenshots taken during browsing (for debugging)

## How it works

1. Parses your CSV and deduplicates CCU types
2. For each CCU, a Claude agent browses StarHangar.com and finds all matching listings
3. Claude analyzes the market data and recommends a competitive price for each CCU
