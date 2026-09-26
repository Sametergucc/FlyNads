export interface BtcCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BtcMarketSnapshot {
  status: "connecting" | "live" | "stale" | "offline";
  productId: "BTC-USD";
  exchange: string;
  price: number | null;
  open24h: number | null;
  change24hPercent: number | null;
  updatedAt: number | null;
  candles: BtcCandle[];
}

export interface FlyTradeSnapshot {
  side: "long" | "short" | null;
  entryPrice: number | null;
  entryAt: number | null;
  closeAt?: number | null;
  exitPrice: number | null;
  exitAt: number | null;
  exitSource?: "ticker" | "candle";
  grossPnlPercent?: number;
  costPercent?: number;
  pnlPercent: number | null;
  status: "waiting" | "open" | "closed" | "legacy";
}
