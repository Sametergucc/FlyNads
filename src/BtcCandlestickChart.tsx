import type { BtcMarketSnapshot, FlyTradeSnapshot } from "./market-types";

interface Props { market: BtcMarketSnapshot | null; trade: FlyTradeSnapshot | null }

const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BtcCandlestickChart({ market, trade }: Props) {
  const candles = market?.candles.slice(-72) ?? [];
  const chartWidth = 900, chartHeight = 260;
  const left = 18, right = 28, top = 18, bottom = 66;
  const plotWidth = chartWidth - left - right, plotHeight = chartHeight - top - bottom;
  const values = candles.flatMap((candle) => [candle.low, candle.high]);
  const current = market?.price;
  if (current && Number.isFinite(current)) values.push(current);
  const rawMin = values.length ? Math.min(...values) : 0;
  const rawMax = values.length ? Math.max(...values) : 1;
  const pad = Math.max((rawMax - rawMin) * 0.12, (current ?? 1) * 0.0004);
  const min = rawMin - pad, max = rawMax + pad;
  const y = (price: number) => top + ((max - price) / Math.max(max - min, 0.000001)) * plotHeight;
  const prices = candles.map((candle) => candle.close);
  if (current && Number.isFinite(current) && (!prices.length || prices[prices.length - 1] !== current)) prices.push(current);
  const x = (index: number) => left + (prices.length <= 1 ? plotWidth : (plotWidth * index) / (prices.length - 1));
  const linePath = prices.map((price, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(price).toFixed(2)}`).join(" ");
  const baseline = chartHeight - 34;
  const areaPath = prices.length ? `${linePath} L${x(prices.length - 1).toFixed(2)},${baseline} L${x(0).toFixed(2)},${baseline} Z` : "";
  const volumeSlot = plotWidth / Math.max(candles.length, 1);
  const maxVolume = Math.max(1, ...candles.map((candle) => candle.volume));
  const status = market?.status ?? "offline";

  return <div className="btc-chart-wrap">
    <div className="btc-chart-meta">
      <div className="btc-market-title"><span className={`btc-live-dot btc-${status}`} /><span>BTC / USD</span></div>
      <div className="btc-price-group"><b>{current ? money(current) : "—"}</b><small aria-label="24 saatlik değişim" className={market?.change24hPercent != null && market.change24hPercent < 0 ? "btc-down" : "btc-up"}>{market?.change24hPercent != null ? `${market.change24hPercent >= 0 ? "+" : ""}${market.change24hPercent.toFixed(2)}%` : ""}</small></div>
    </div>
    <svg className="btc-candles btc-line-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" role="img" aria-label="BTC USD real-time price line with volume">
      <defs><linearGradient id="btc-area-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#72dfcc" stopOpacity=".20"/><stop offset="100%" stopColor="#72dfcc" stopOpacity="0"/></linearGradient></defs>
      {[0, 1, 2, 3].map((step) => {
        const value = max - ((max - min) * step) / 3;
        const yy = y(value);
        return <line key={step} x1={left} x2={chartWidth - right} y1={yy} y2={yy} className="btc-gridline"/>;
      })}
      {candles.map((candle, index) => {
        const barX = left + volumeSlot * index + volumeSlot * .2;
        const volumeHeight = (candle.volume / maxVolume) * 24;
        const color = index > 0 && candle.close < candles[index - 1].close ? "#8ba09d" : "#72dfcc";
        return <rect key={candle.time} x={barX} y={baseline - volumeHeight} width={Math.max(1, volumeSlot * .6)} height={volumeHeight} fill={color} opacity=".30" />;
      })}
      {areaPath && <path d={areaPath} fill="url(#btc-area-fill)" />}
      {linePath && <path d={linePath} className="btc-price-line" />}
      {current && <g><line x1={left} x2={chartWidth - right} y1={y(current)} y2={y(current)} className="btc-last-line"/><circle cx={x(prices.length - 1)} cy={y(current)} r="3" className="btc-last-dot"/></g>}
      {trade?.status === "open" && trade.entryPrice && <g><line x1={left} x2={chartWidth - right} y1={y(trade.entryPrice)} y2={y(trade.entryPrice)} className="btc-entry-line"/><text x={left + 7} y={y(trade.entryPrice) - 5} className="btc-entry-label">GİRİŞ {money(trade.entryPrice)}</text></g>}
      {trade?.status === "closed" && trade.exitPrice && <g><line x1={left} x2={chartWidth - right} y1={y(trade.exitPrice)} y2={y(trade.exitPrice)} className="btc-exit-line"/><text x={left + 7} y={y(trade.exitPrice) - 5} className="btc-entry-label">ÇIKIŞ {money(trade.exitPrice)}</text></g>}
      {candles.length > 0 && [0, Math.floor(candles.length / 3), Math.floor((candles.length * 2) / 3), candles.length - 1].map((index, tick) => <text key={`${index}-${tick}`} x={x(index)} y={chartHeight - 7} textAnchor={index === 0 ? "start" : index === candles.length - 1 ? "end" : "middle"} className="btc-axis-label">{new Date(candles[index].time).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</text>)}
    </svg>
    {status !== "live" && <div className={`btc-chart-state btc-state-${status}`}>{status === "connecting" ? "Coinbase piyasa akışı bağlanıyor…" : status === "stale" ? "BTC/USD verisi gecikti · güncelleme bekleniyor" : "Piyasa verisi çevrimdışı"}</div>}
  </div>;
}
