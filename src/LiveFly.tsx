import * as React from "react";

export type FlyMotion = "hover" | "dodge" | "dive" | "gains" | "liquidated";

export interface LiveFlyProps {
  /** Current fly action/outcome. Use the same values returned by game-engine.ts. */
  motion?: FlyMotion;
  /** Show a short label below the character. */
  label?: string;
  className?: string;
  title?: string;
}

/** Animated, image-free SVG fly for the FlyOrDie simulation view. */
export function LiveFly({
  motion = "hover",
  label,
  className = "",
  title = "FlyOrDie fruit fly",
}: LiveFlyProps) {
  const id = React.useId().replace(/[^a-zA-Z0-9]/g, "");

  return (
    <div className={`fly-stage ${className}`} data-motion={motion}>
      <style>{`
        .fly-stage { --fly-neon: #b7ff4a; position: relative; display: grid; justify-items: center; align-content: center; min-width: 180px; min-height: 180px; isolation: isolate; }
        .fly-stage::before { content: ""; position: absolute; z-index: -1; width: 76%; aspect-ratio: 1; border-radius: 50%; background: radial-gradient(circle, rgba(137,255,45,.16), rgba(137,255,45,.035) 48%, transparent 72%); filter: blur(8px); }
        .fly-art { width: min(100%, 340px); overflow: visible; animation: fly-hover 2.2s ease-in-out infinite; transform-origin: 50% 55%; }
        .fly-body { transform-origin: 160px 128px; animation: fly-attitude 2.2s ease-in-out infinite; }
        .fly-wing { transform-box: fill-box; transform-origin: 78% 76%; animation: fly-wing 105ms ease-in-out infinite alternate; }
        .fly-wing-rear { animation-delay: -55ms; }
        .fly-leg { stroke-dasharray: 5 3; animation: fly-legs 700ms ease-in-out infinite alternate; }
        .fly-eye-glint { animation: fly-glint 3.6s ease-in-out infinite; }
        .fly-stage[data-motion="dodge"] .fly-art { animation: fly-dodge 620ms cubic-bezier(.2,.8,.25,1) both; }
        .fly-stage[data-motion="dodge"] .fly-body { animation: fly-tilt-dodge 620ms ease-out both; }
        .fly-stage[data-motion="dive"] .fly-art { animation: fly-dive 780ms cubic-bezier(.35,.05,.8,.35) both; }
        .fly-stage[data-motion="dive"] .fly-body { animation: fly-tilt-dive 780ms ease-in both; }
        .fly-stage[data-motion="gains"] .fly-art { animation: fly-gains 1.2s ease-out both; }
        .fly-stage[data-motion="liquidated"] .fly-art { animation: fly-rekt 950ms ease-in both; }
        .fly-stage[data-motion="liquidated"] .fly-wing { animation-duration: 65ms; }
        .fly-caption { margin-top: -8px; color: rgba(215,255,178,.74); font: 600 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .2em; text-transform: uppercase; }
        @keyframes fly-hover { 0%,100% { transform: translateY(0) rotate(-1deg); } 50% { transform: translateY(-9px) rotate(1deg); } }
        @keyframes fly-wing { from { transform: rotate(-18deg) scaleY(.78); } to { transform: rotate(15deg) scaleY(1.08); } }
        @keyframes fly-legs { from { opacity: .72; } to { opacity: 1; } }
        @keyframes fly-glint { 0%,82%,100% { opacity: .9; } 86% { opacity: .15; } 90% { opacity: .9; } }
        @keyframes fly-attitude { 0%,100% { transform: rotate(-2deg); } 50% { transform: rotate(2deg); } }
        @keyframes fly-dodge { 0% { transform: translate(0,0) rotate(0); } 22% { transform: translate(0,12px) rotate(-12deg); } 70% { transform: translate(-74px,-22px) rotate(-22deg); } 100% { transform: translate(-46px,-4px) rotate(-8deg); } }
        @keyframes fly-tilt-dodge { 0%,100% { transform: rotate(0); } 35% { transform: rotate(-16deg); } }
        @keyframes fly-dive { 0% { transform: translate(0,0) rotate(0); } 35% { transform: translate(10px,-22px) rotate(13deg); } 100% { transform: translate(62px,42px) rotate(28deg); } }
        @keyframes fly-tilt-dive { from { transform: rotate(0); } to { transform: rotate(20deg); } }
        @keyframes fly-gains { 0% { transform: translateY(0) scale(1); } 35% { transform: translateY(-34px) scale(1.08); } 65% { transform: translateY(-20px) scale(1.04); } 100% { transform: translateY(-28px) scale(1.06); } }
        @keyframes fly-rekt { 0% { transform: translateY(0) rotate(0); opacity: 1; } 24% { transform: translateY(-12px) rotate(-18deg); } 100% { transform: translateY(165px) rotate(100deg); opacity: .15; } }
        @media (prefers-reduced-motion: reduce) { .fly-art, .fly-body, .fly-wing, .fly-leg, .fly-eye-glint { animation-duration: 1ms !important; animation-iteration-count: 1 !important; } }
      `}</style>

      <svg
        className="fly-art"
        viewBox="0 0 320 250"
        role="img"
        aria-label={title}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id={`${id}-abdomen`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#78835b" />
            <stop offset=".42" stopColor="#343d31" />
            <stop offset="1" stopColor="#141b19" />
          </linearGradient>
          <linearGradient id={`${id}-thorax`} x1="0" x2=".8" y1="0" y2="1">
            <stop stopColor="#d4e18c" />
            <stop offset=".45" stopColor="#65734b" />
            <stop offset="1" stopColor="#283128" />
          </linearGradient>
          <linearGradient id={`${id}-wing`} x1="0" x2="1" y1="0" y2="1">
            <stop stopColor="#effff0" stopOpacity=".82" />
            <stop offset="1" stopColor="#83d6c4" stopOpacity=".12" />
          </linearGradient>
          <radialGradient id={`${id}-eye`} cx="35%" cy="28%">
            <stop stopColor="#ff8ca0" />
            <stop offset=".36" stopColor="#e43c57" />
            <stop offset="1" stopColor="#5a142c" />
          </radialGradient>
          <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Wing membranes */}
        <g fill={`url(#${id}-wing)`} stroke="#caffef" strokeOpacity=".76" strokeWidth="1.2">
          <g className="fly-wing fly-wing-rear">
            <path d="M145 107C111 52 86 42 66 51c-8 28 20 66 73 79 8-3 11-12 6-23Z" />
            <path d="m77 58 63 62M94 55l48 61M68 71l75 58" fill="none" strokeOpacity=".35" />
          </g>
          <g className="fly-wing">
            <path d="M158 108c8-62 32-91 55-82 14 24 2 67-42 98-7 2-13-6-13-16Z" />
            <path d="m208 34-43 78m31-73-34 76m51-58-48 64" fill="none" strokeOpacity=".35" />
          </g>
        </g>

        <g className="fly-body">
          {/* Antennae */}
          <g fill="none" stroke="#bac58d" strokeWidth="3" strokeLinecap="round">
            <path d="M142 88c-7-18-17-26-30-26" /><path d="M159 84c0-21 6-31 18-38" />
          </g>
          <g fill="#d8ee9d"><circle cx="110" cy="61" r="4" /><circle cx="178" cy="44" r="4" /></g>

          {/* Six articulated legs */}
          <g className="fly-leg" fill="none" stroke="#b2bd83" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="m139 128-31 20-21 31-18 4m79-50-16 29-4 28-13 8m27-62 3 30 15 24 1 9" />
            <path d="m174 126 30 14 20 28 19 3m-68-40 18 25 7 28 14 7m-39-60-1 30-14 23-1 9" />
          </g>

          {/* Tapered abdomen with segmented bands */}
          <path d="M169 119c22-12 55-8 75 9 14 12 13 29-2 42-19 17-52 21-74 7-19-12-20-43 1-58Z" fill={`url(#${id}-abdomen)`} stroke="#b8c788" strokeOpacity=".65" strokeWidth="2" />
          <path d="M183 118c-7 12-9 43 1 59m16-62c-7 14-7 48 2 59m16-53c-5 13-4 38 3 48" fill="none" stroke="#d0d59b" strokeOpacity=".46" strokeWidth="3" />
          <path d="M177 127c24-10 49-3 66 8m-72 17c24-10 53-5 71 7m-64 13c20-7 41-4 57 4" fill="none" stroke="#0d1513" strokeOpacity=".7" strokeWidth="4" />

          {/* Thorax and head */}
          <ellipse cx="146" cy="122" rx="33" ry="27" fill={`url(#${id}-thorax)`} stroke="#d1e59a" strokeOpacity=".65" strokeWidth="2" />
          <path d="M125 107c12-11 34-11 46 1" fill="none" stroke="#f0ffba" strokeOpacity=".55" strokeWidth="4" strokeLinecap="round" />
          <ellipse cx="112" cy="107" rx="29" ry="25" fill="#465045" stroke="#b8c788" strokeWidth="2" />

          {/* Compound eyes */}
          <ellipse cx="97" cy="102" rx="15" ry="19" fill={`url(#${id}-eye)`} stroke="#ff8590" strokeWidth="1.5" />
          <ellipse cx="126" cy="95" rx="14" ry="17" fill={`url(#${id}-eye)`} stroke="#ff8590" strokeWidth="1.5" />
          <g fill="#ffb4b2" opacity=".7">
            <circle cx="92" cy="96" r="1.4"/><circle cx="100" cy="91" r="1.2"/><circle cx="104" cy="101" r="1.1"/><circle cx="94" cy="108" r="1.2"/>
            <circle cx="122" cy="89" r="1.2"/><circle cx="130" cy="91" r="1.2"/><circle cx="120" cy="100" r="1.2"/><circle cx="129" cy="103" r="1.1"/>
          </g>
          <ellipse className="fly-eye-glint" cx="93" cy="95" rx="4" ry="6" fill="#fff2db" opacity=".86" />
          <ellipse className="fly-eye-glint" cx="122" cy="88" rx="3.5" ry="5" fill="#fff2db" opacity=".86" />
          <path d="M104 126c7 5 14 6 21 2" fill="none" stroke="#d2bd8e" strokeWidth="2" strokeLinecap="round" />
        </g>

        {/* Subtle ground shadow */}
        <ellipse cx="158" cy="211" rx="63" ry="8" fill="#8fff48" opacity=".1" filter={`url(#${id}-glow)`} />
      </svg>
      {label ? <span className="fly-caption">{label}</span> : null}
    </div>
  );
}

export default LiveFly;
