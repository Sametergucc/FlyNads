# FlyOrDie hackathon MVP: start plan

## Scope for the first demo

1. **Round/pool contract (started):** open a round, accept native testnet MON bets on Liquidated or Epic Gains, lock the pool, publish the outcome, and let winners claim a proportional payout.
2. **Game engine and fly character (started):** the decision module is in `src/game-engine.ts`; the animated SVG fly is in `src/LiveFly.tsx`. The model is a clearly labeled connectome-inspired placeholder, not a whole-brain simulation.
3. **Frontend integration:** when the game screen code arrives, connect its fly view, buttons, countdown, pool totals, and transaction feed to the engine and contract events.
4. **Demo hardening:** add error/loading states, deploy to Monad testnet, connect a wallet, and run through a complete public demo round.

## Contract interface for the future frontend

- `openRound(uint64 closesAt)` — operator creates a betting window.
- `placeBet(uint256 roundId, bool gains)` payable — `false` = Liquidated, `true` = Epic Gains.
- `lockRound(uint256 roundId)` — operator locks betting after `closesAt`.
- `resolveRound(uint256 roundId, bool gainsWon)` — operator reports the observed result.
- `claim(uint256 roundId)` — winners claim stake plus a pro-rata share of the losing pool.
- `rounds(roundId)` and the `BetPlaced` / `RoundResolved` events — read pool state and show activity.

## Frontend integration notes

`LiveFly` accepts `motion="hover" | "dodge" | "dive" | "gains" | "liquidated"`; it animates the wings and hover continuously and plays a short action animation when that prop changes. Its implementation is a standalone React/TypeScript component with inline SVG and CSS, so it does not need image assets, Tailwind classes, shadcn, or third-party animation packages. The workspace does not yet contain a React app scaffold; when the screen code arrives, match its framework and add the required app setup then.

## Current trust model and limits

The operator controls opening, locking, and reporting the outcome. This keeps the hackathon MVP small, but means the result is not independently verified. Bets use testnet MON only. Before real-value use, the result source, operator controls, dispute/recovery path, contract security, and applicable rules need a separate design and review.

## Current implementation status

- Vite + React + TypeScript app scaffold and responsive three-column game screen are in place.
- The game screen has a local simulation mode, a live SVG fly, countdown, hidden/reflected brain activity, prediction pools, chat input, and activity feed.
- A shared Node game server now owns the demo round timer, common fly result, demo pool, chat, and activity feed. All demo participants must connect to that single server instance.
- Monad testnet wallet connection, pool reads, bet submission, payout claiming, and `BetPlaced` log subscription are wired when `.env.local` contains a deployed contract address and round id.
- Hardhat deploy and operator scripts plus setup instructions are included. Contract deployment still requires the user's testnet wallet/funds and an active operator key in the shell; secrets are not stored in the app.

## Remaining before a public testnet demo

- Install dependencies and build in the user's environment.
- Start one shared Node server for all players, or deploy a single shared server with the web app.
- Deploy the contract, open a round, and configure the active round id.
- Run one complete wallet bet → lock → resolve → claim demo round.
- Replace the browser demo decision source with a committed backend result before presenting it as independently fair.
