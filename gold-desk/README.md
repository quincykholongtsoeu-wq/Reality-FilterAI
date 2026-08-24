# GOLD DESK V0.3 — PHONE FIRST

No Replit. No broker automation. No fake live labels.

## What is live now
- COMEX Gold Futures market proxy via Yahoo Finance chart endpoint
- DXY via Yahoo Finance chart endpoint
- US 2Y, US 10Y, 10Y real yield via public FRED CSV feeds
- Deterministic macro read: LONG BIAS / SHORT BIAS / WAIT

## AI
The page can optionally send the current snapshot to OpenAI. The API key is entered on the user's phone and passed per request to the server. The server does not persist the key in application code or database.

## Important limitations
- GC=F is a futures proxy, not broker spot XAUUSD.
- FRED yields are official observations but not tick-by-tick.
- Event-calendar actual/forecast/previous is not yet connected in V0.3.
- Research only; no broker execution.
