#!/usr/bin/env python3
"""Fetch WSE (Warsaw) quotes from Stooq and write assets/wse.json.

Runs server-side (locally or in GitHub Actions) where there is no CORS
restriction, producing a same-origin JSON the static site can read. This
gives the Polish holdings near-real-time prices for $0 — Stooq has no
browser CORS headers, so the site cannot call it directly.
"""
import csv, io, json, os, sys, datetime, urllib.request

# Stooq symbol -> ticker shown in the app
SYMBOLS = {
    "pkn": "PKN", "cdr": "CDR", "pzu": "PZU", "kgh": "KGH",
    "wig20": "WIG20",  # benchmark index
}

STOOQ = ("https://stooq.com/q/l/?s=" + "+".join(SYMBOLS)
         + "&f=sd2t2ohlcv&h&e=csv")


def fetch_csv(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "unified-quotes/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def main():
    text = fetch_csv(STOOQ)
    quotes = {}
    for row in csv.DictReader(io.StringIO(text)):
        sym = (row.get("Symbol") or "").strip().upper()
        ticker = SYMBOLS.get(sym.lower(), sym)
        try:
            close = float(row["Close"]); openp = float(row["Open"])
        except (KeyError, ValueError, TypeError):
            continue
        if close <= 0:
            continue
        day = round((close - openp) / openp * 100, 2) if openp else 0.0
        quotes[ticker] = {"price": close, "day": day, "ccy": "PLN",
                          "asof": f"{row.get('Date','')} {row.get('Time','')}".strip()}

    if not quotes:
        print("No quotes parsed — leaving existing file untouched", file=sys.stderr)
        sys.exit(1)

    path = os.path.join(os.path.dirname(__file__), "..", "assets", "wse.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)

    # Skip rewriting when prices are unchanged (e.g. market closed) so we don't
    # churn commits / Pages rebuilds. Compare only the quote values, not the
    # timestamp.
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                if json.load(f).get("quotes") == quotes:
                    print("Quotes unchanged — skipping write")
                    return
        except (ValueError, OSError):
            pass

    out = {
        "updated": datetime.datetime.now(datetime.timezone.utc)
                   .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Stooq (WSE)",
        "quotes": quotes,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote {len(quotes)} quotes to assets/wse.json")


if __name__ == "__main__":
    main()
