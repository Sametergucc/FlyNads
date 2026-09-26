import type { BtcMarketSnapshot, FlyTradeSnapshot } from "./market-types";

interface Props { market: BtcMarketSnapshot | null; trade: FlyTradeSnapshot | null }

const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BtcCandlestickChart({ market, trade }: Props) {
  const candles = market?.candles.slice(-72) ?? [];
  const chartWidth = 900, chartHeight = 260;
  const left = 18, right = 74, top = 18, bottom = 36;
  const plotWidth = chartWidth - left - right, plotHeight = chartHeight - top - bottom;
  const values = candles.flatMap((candle) => [candle.low, candle.high]);
  const current = market?.price;
  if (current && Number.isFinite(current)) values.push(current);
  const rawMin = values.length ? Math.min(...values) : 0;
  const rawMax = values.length ? Math.max(...values) : 1;
  const pad = Math.max((rawMax - rawMin) * 0.12, (current ?? 1) * 0.0004);
  const min = rawMin - pad, max = rawMax + pad;
  const y = (price: number) => top + ((max - price) / Math.max(max - min, 0.000001)) * plotHeight;
  const slot = plotWidth / Math.max(candles.length, 1);
  const bodyWidth = Math.max(2, Math.min(10, slot * 0.62));
  const maxVolume = Math.max(1, ...candles.map((candle) => candle.volume));
  const status = market?.status ?? "offline";

  return <div className="btc-chart-wrap">
    <div className="btc-chart-meta">
      <div className="btc-market-title"><span className={`btc-live-dot btc-${status}`} /><span>BTC / USD</span><small>{market?.exchange ?? "Coinbase spot"} · 1m</small></div>
      <div className="btc-price-group"><b>{current ? money(current) : "Bağlanıyor…"}</b><small className={market?.change24hPercent != null && market.change24hPercent < 0 ? "btc-down" : "btc-up"}>{market?.change24hPercent != null ? `${market.change24hPercent >= 0 ? "+" : ""}${market.change24hPercent.toFixed(2)}% · 24s` : "ANLIK PİYASA"}</small></div>
    </div>
    <svg className="btc-candles" viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" role="img" aria-label="Coinbase BTC USD gerçek zamanlı bir dakikalık mum grafiği">
      {[0, 1, 2, 3].map((step) => {
        const value = max - ((max - min) * step) / 3;
        const yy = y(value);
        return <g key={step}><line x1={left} x2={chartWidth - right} y1={yy} y2={yy} className="btc-gridline"/><text x={chartWidth - right + 8} y={yy + 3} className="btc-axis-label">{money(value)}</text></g>;
      })}
      {candles.map((candle, index) => {
        const x = left + slot * index + slot / 2;
        const rising = candle.close >= candle.open;
        const openY = y(candle.open), closeY = y(candle.close);
        const height = Math.max(1.2, Math.abs(closeY - openY));
        const volumeHeight = (candle.volume / maxVolume) * 25;
        const color = rising ? "#5be0bd" : "#ff6c82";
        return <g key={candle.time}>
          <rect x={x - bodyWidth / 2} y={chartHeight - 29 - volumeHeight} width={bodyWidth} height={volumeHeight} fill={color} opacity=".2" />
          <line x1={x} x2={x} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth="1.2" />
          <rect x={x - bodyWidth / 2} y={Math.min(openY, closeY)} width={bodyWidth} height={height} rx=".7" fill={color} />
        </g>;
      })}
      {current && <g><line x1={left} x2={chartWidth - right} y1={y(current)} y2={y(current)} className="btc-last-line"/><circle cx={chartWidth - right} cy={y(current)} r="3" className="btc-last-dot"/></g>}
      {trade?.status === "open" && trade.entryPrice && <g><line x1={left} x2={chartWidth - right} y1={y(trade.entryPrice)} y2={y(trade.entryPrice)} className="btc-entry-line"/><text x={left + 7} y={y(trade.entryPrice) - 5} className="btc-entry-label">GİRİŞ {money(trade.entryPrice)}</text></g>}
      {trade?.status === "closed" && trade.exitPrice && <g><line x1={left} x2={chartWidth - right} y1={y(trade.exitPrice)} y2={y(trade.exitPrice)} className="btc-exit-line"/><text x={left + 7} y={y(trade.exitPrice) - 5} className="btc-entry-label">ÇIKIŞ {money(trade.exitPrice)}</text></g>}
      {candles.length > 0 && [0, Math.floor(candles.length / 3), Math.floor((candles.length * 2) / 3), candles.length - 1].map((index, tick) => <text key={`${index}-${tick}`} x={left + slot * index} y={chartHeight - 7} className="btc-axis-label">{new Date(candles[index].time).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</text>)}
    </svg>
    {status !== "live" && <div className={`btc-chart-state btc-state-${status}`}>{status === "connecting" ? "Coinbase piyasa akışı bağlanıyor…" : status === "stale" ? "BTC/USD verisi gecikti · güncelleme bekleniyor" : "Piyasa verisi çevrimdışı"}</div>}
  </div>;
}
