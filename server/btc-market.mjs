const FEED_URL = "wss://ws-feed.exchange.coinbase.com";
const HISTORY_URL = "https://api.exchange.coinbase.com/products/BTC-USD/candles";
const CANDLE_MS = 60_000;
const MAX_CANDLES = 120;
const MAX_TICKS = 4_000;

/** Public Coinbase BTC-USD spot tape, shared by all game clients. */
export function createBtcMarketFeed() {
  const candles = [];
  const ticks = [];
  const market = {
    status: "connecting",
    productId: "BTC-USD",
    exchange: "Coinbase spot",
    price: null,
    open24h: null,
    change24hPercent: null,
    updatedAt: null,
    candles,
  };
  let socket = null;
  let reconnectTimer = null;
  let disposed = false;
  let lastRecoveryMinute = null;
  let lastRecoveryAt = 0;
  let recoveredClosingCandle = null;

  function mergeHistory(rows) {
    const historical = rows.map(([time, low, high, open, close, volume]) => ({
      time: Number(time) * 1000,
      open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume),
    })).filter((candle) => Object.values(candle).every(Number.isFinite));
    const byTime = new Map(historical.map((candle) => [candle.time, candle]));
    for (const live of candles) byTime.set(live.time, live);
    candles.splice(0, candles.length, ...[...byTime.values()].sort((a, b) => a.time - b.time).slice(-MAX_CANDLES));
  }

  async function loadHistory() {
    try {
      const end = Date.now();
      const start = end - MAX_CANDLES * CANDLE_MS;
      const url = new URL(HISTORY_URL);
      url.searchParams.set("granularity", "60");
      url.searchParams.set("start", new Date(start).toISOString());
      url.searchParams.set("end", new Date(end).toISOString());
      const response = await fetch(url, { signal: AbortSignal.timeout(7000), headers: { "User-Agent": "FlyOrDie-Market-Chart/1.0" } });
      if (!response.ok) throw new Error(`history HTTP ${response.status}`);
      const rows = await response.json();
      if (Array.isArray(rows)) mergeHistory(rows);
    } catch (error) {
      console.warn("BTC-USD candle history unavailable:", error instanceof Error ? error.message : "request failed");
    }
  }

  function addTicker(message) {
    if (message.type !== "ticker" || message.product_id !== "BTC-USD") return;
    const price = Number(message.price);
    const time = Date.parse(message.time);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) return;
    if (ticks.length && time < ticks[ticks.length - 1].time) return;
    const tick = { time, price };
    ticks.push(tick);
    if (ticks.length > MAX_TICKS) ticks.splice(0, ticks.length - MAX_TICKS);

    const candleTime = Math.floor(time / CANDLE_MS) * CANDLE_MS;
    const latest = candles[candles.length - 1];
    if (!latest || candleTime > latest.time) {
      const previousClose = latest?.close ?? price;
      candles.push({ time: candleTime, open: previousClose, high: Math.max(previousClose, price), low: Math.min(previousClose, price), close: price, volume: 0 });
      if (candles.length > MAX_CANDLES) candles.shift();
    } else if (candleTime === latest.time) {
      latest.high = Math.max(latest.high, price);
      latest.low = Math.min(latest.low, price);
      latest.close = price;
    }
    const size = Number(message.last_size);
    if (Number.isFinite(size) && size > 0 && candles[candles.length - 1]?.time === candleTime) candles[candles.length - 1].volume += size;

    const open24h = Number(message.open_24h);
    market.price = price;
    if (Number.isFinite(open24h) && open24h > 0) {
      market.open24h = open24h;
      market.change24hPercent = ((price - open24h) / open24h) * 100;
    }
    market.updatedAt = time;
    market.status = "live";
  }

  function connect() {
    if (disposed) return;
    try {
      socket = new WebSocket(FEED_URL);
      socket.addEventListener("open", () => {
        market.status = "connecting";
        socket?.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker", "heartbeat"] }));
      });
      socket.addEventListener("message", (event) => {
        try { addTicker(JSON.parse(String(event.data))); } catch { /* Ignore malformed or unsupported market messages. */ }
      });
      socket.addEventListener("error", () => { market.status = market.updatedAt ? "stale" : "offline"; });
      socket.addEventListener("close", () => {
        market.status = market.updatedAt ? "stale" : "offline";
        socket = null;
        if (!disposed) reconnectTimer = setTimeout(connect, 3000);
      });
    } catch {
      market.status = market.updatedAt ? "stale" : "offline";
      reconnectTimer = setTimeout(connect, 3000);
    }
  }

  function snapshot() {
    if (market.updatedAt && Date.now() - market.updatedAt > 12_000) market.status = "stale";
    return { ...market, candles: candles.map((candle) => ({ ...candle })) };
  }

  function priceAt(timestamp) {
    // Settlement runs only after the Monad round is locked, so using the first
    // Coinbase trade at/after the close cannot leak a price to active bettors.
    // Prefer that closing tick, then fall back to a recent pre-close trade for
    // quiet periods. Without this look-forward, a quiet market could leave a
    // locked round waiting forever for a tick exactly at its deadline.
    const maxAge = 60_000;
    for (const tick of ticks) {
      if (tick.time >= timestamp) {
        if (tick.time - timestamp <= maxAge) return { ...tick };
        break;
      }
    }
    for (let index = ticks.length - 1; index >= 0; index--) {
      const tick = ticks[index];
      if (tick.time <= timestamp) return timestamp - tick.time <= maxAge ? { ...tick } : null;
    }
    return null;
  }

  async function recoverPriceAt(timestamp) {
    const liveTick = priceAt(timestamp);
    if (liveTick) return liveTick;
    const minute = Math.floor(timestamp / CANDLE_MS) * CANDLE_MS;
    // Wait until the minute containing the close has completed before using its
    // historical candle. That also lets a restarted operator recover a round
    // whose in-memory websocket ticks were lost.
    if (Date.now() < minute + CANDLE_MS) return null;
    if (lastRecoveryMinute === minute && Date.now() - lastRecoveryAt < 5000) return recoveredClosingCandle;
    lastRecoveryMinute = minute;
    lastRecoveryAt = Date.now();
    recoveredClosingCandle = null;
    try {
      const url = new URL(HISTORY_URL);
      url.searchParams.set("granularity", "60");
      url.searchParams.set("start", new Date(minute).toISOString());
      url.searchParams.set("end", new Date(minute + CANDLE_MS).toISOString());
      const response = await fetch(url, { signal: AbortSignal.timeout(7000), headers: { "User-Agent": "FlyOrDie-Market-Settlement/1.0" } });
      if (!response.ok) throw new Error(`candle HTTP ${response.status}`);
      const rows = await response.json();
      const row = Array.isArray(rows) ? rows.find((item) => Number(item[0]) * 1000 === minute) : null;
      const close = Number(row?.[4]);
      if (Number.isFinite(close) && close > 0) {
        recoveredClosingCandle = { time: minute + CANDLE_MS, price: close, source: "candle" };
        return recoveredClosingCandle;
      }
    } catch (error) {
      console.warn("Could not recover the BTC-USD closing candle:", error instanceof Error ? error.message : "request failed");
    }
    return null;
  }

  function directionFor(price, timestamp = Date.now()) {
    const eligible = candles.filter((candle) => candle.time <= timestamp).slice(-3);
    const reference = eligible.length > 1 ? eligible[0].open : eligible[0]?.open;
    if (!Number.isFinite(reference) || reference === price) {
      const before = ticks.find((tick) => tick.time >= timestamp - 60_000 && tick.time < timestamp);
      return before && price < before.price ? "short" : "long";
    }
    return price > reference ? "long" : "short";
  }

  function prepareTrade() {
    const latest = ticks[ticks.length - 1];
    if (!latest || Date.now() - latest.time > 12_000) return null;
    return { side: directionFor(latest.price, latest.time), entryPrice: latest.price, entryAt: latest.time, exitPrice: null, exitAt: null, pnlPercent: null, status: "open" };
  }

  function dispose() {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  }

  void loadHistory();
  connect();
  return { snapshot, priceAt, recoverPriceAt, directionFor, prepareTrade, dispose };
}
