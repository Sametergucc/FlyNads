// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Testnet MVP pool for short FlyOrDie prediction rounds.
/// @dev The round operator supplies the outcome. This is intentionally a
///      transparent demo contract, not a trustless oracle or production wagering system.
contract FlyOrDiePool {
    enum Status {
        None,
        Open,
        Locked,
        Resolved
    }

    struct Round {
        uint64 closesAt;
        uint128 liquidatedPool;
        uint128 gainsPool;
        Status status;
        bool gainsWon;
    }

    address public immutable operator;
    uint256 public nextRoundId = 1;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public liquidatedBets;
    mapping(uint256 => mapping(address => uint256)) public gainsBets;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event RoundOpened(uint256 indexed roundId, uint64 closesAt);
    event BetPlaced(uint256 indexed roundId, address indexed bettor, bool gains, uint256 amount);
    event BetsLocked(uint256 indexed roundId);
    event RoundResolved(uint256 indexed roundId, bool gainsWon);
    event PayoutClaimed(uint256 indexed roundId, address indexed bettor, uint256 amount);

    error Unauthorized();
    error InvalidRound();
    error InvalidTiming();
    error BettingClosed();
    error BettingStillOpen();
    error RoundNotLocked();
    error AlreadyClaimed();
    error NoPayout();
    error TransferFailed();
    error AmountTooLarge();

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(address operator_) {
        if (operator_ == address(0)) revert Unauthorized();
        operator = operator_;
    }

    /// @notice Open a betting window. The first round id is 1.
    function openRound(uint64 closesAt) external onlyOperator returns (uint256 roundId) {
        if (closesAt <= block.timestamp) revert InvalidTiming();
        roundId = nextRoundId++;
        rounds[roundId].closesAt = closesAt;
        rounds[roundId].status = Status.Open;
        emit RoundOpened(roundId, closesAt);
    }

    /// @notice Bet with native testnet MON. `gains=true` selects EPIC GAINS.
    function placeBet(uint256 roundId, bool gains) external payable {
        Round storage round = rounds[roundId];
        if (round.status != Status.Open) revert InvalidRound();
        if (block.timestamp >= round.closesAt) revert BettingClosed();
        if (msg.value == 0) revert InvalidTiming();

        if (gains) {
            uint256 updated = uint256(round.gainsPool) + msg.value;
            if (updated > type(uint128).max) revert AmountTooLarge();
            round.gainsPool = uint128(updated);
            gainsBets[roundId][msg.sender] += msg.value;
        } else {
            uint256 updated = uint256(round.liquidatedPool) + msg.value;
            if (updated > type(uint128).max) revert AmountTooLarge();
            round.liquidatedPool = uint128(updated);
            liquidatedBets[roundId][msg.sender] += msg.value;
        }
        emit BetPlaced(roundId, msg.sender, gains, msg.value);
    }

    /// @notice Lock the pool after the betting deadline.
    function lockRound(uint256 roundId) external onlyOperator {
        Round storage round = rounds[roundId];
        if (round.status != Status.Open) revert InvalidRound();
        if (block.timestamp < round.closesAt) revert BettingStillOpen();
        round.status = Status.Locked;
        emit BetsLocked(roundId);
    }

    /// @notice Publish the observed outcome after the round is locked.
    function resolveRound(uint256 roundId, bool gainsWon) external onlyOperator {
        Round storage round = rounds[roundId];
        if (round.status != Status.Locked) revert RoundNotLocked();
        round.gainsWon = gainsWon;
        round.status = Status.Resolved;
        emit RoundResolved(roundId, gainsWon);
    }

    /// @notice Winners claim their stake plus a proportional share of the losing pool.
    /// @dev If nobody backed the winning outcome, every participant can reclaim their stake.
    function claim(uint256 roundId) external {
        uint256 payout = _claimableFor(msg.sender, roundId);
        (bool ok,) = payable(msg.sender).call{value: payout}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Claim several resolved rounds in one wallet transaction.
    /// @dev The player signs once; the contract transfers the combined payout once.
    function claimMany(uint256[] calldata roundIds) external {
        if (roundIds.length == 0 || roundIds.length > 50) revert InvalidTiming();
        uint256 totalPayout;
        for (uint256 i; i < roundIds.length; ++i) {
            totalPayout += _claimableFor(msg.sender, roundIds[i]);
        }
        (bool ok,) = payable(msg.sender).call{value: totalPayout}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Operator auto-claims on behalf of a bettor after resolving a round.
    /// @dev Payout is sent directly to the bettor's address.
    function claimFor(uint256 roundId, address bettor) external onlyOperator {
        uint256 payout = _claimableFor(bettor, roundId);
        (bool ok,) = payable(bettor).call{value: payout}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Operator batch auto-claims for all bettors in a resolved round.
    function claimForBatch(uint256 roundId, address[] calldata bettors) external onlyOperator {
        for (uint256 i; i < bettors.length; ++i) {
            // Skip silently if bettor has no payout or already claimed.
            uint256 payout = _tryClaimableFor(bettors[i], roundId);
            if (payout > 0) {
                (bool ok,) = payable(bettors[i]).call{value: payout}("");
                if (!ok) revert TransferFailed();
            }
        }
    }

    /// @dev Non-reverting version: returns 0 instead of reverting for already-claimed or no-payout.
    function _tryClaimableFor(address bettor, uint256 roundId) private returns (uint256 payout) {
        Round storage round = rounds[roundId];
        if (round.status != Status.Resolved) return 0;
        if (claimed[roundId][bettor]) return 0;
        claimed[roundId][bettor] = true;

        uint256 gainsStake = gainsBets[roundId][bettor];
        uint256 liquidatedStake = liquidatedBets[roundId][bettor];
        uint256 winningPool = round.gainsWon ? round.gainsPool : round.liquidatedPool;
        uint256 losingPool = round.gainsWon ? round.liquidatedPool : round.gainsPool;
        uint256 winnerStake = round.gainsWon ? gainsStake : liquidatedStake;
        if (winningPool == 0) {
            payout = gainsStake + liquidatedStake;
        } else if (winnerStake != 0) {
            payout = winnerStake + (winnerStake * losingPool) / winningPool;
        }
        if (payout == 0) {
            claimed[roundId][bettor] = false;
            return 0;
        }
        emit PayoutClaimed(roundId, bettor, payout);
    }

    function _claimableFor(address bettor, uint256 roundId) private returns (uint256 payout) {
        Round storage round = rounds[roundId];
        if (round.status != Status.Resolved) revert InvalidRound();
        if (claimed[roundId][bettor]) revert AlreadyClaimed();
        claimed[roundId][bettor] = true;

        uint256 gainsStake = gainsBets[roundId][bettor];
        uint256 liquidatedStake = liquidatedBets[roundId][bettor];
        uint256 winningPool = round.gainsWon ? round.gainsPool : round.liquidatedPool;
        uint256 losingPool = round.gainsWon ? round.liquidatedPool : round.gainsPool;
        uint256 winnerStake = round.gainsWon ? gainsStake : liquidatedStake;
        if (winningPool == 0) {
            // No one predicted the result: refund both sides.
            payout = gainsStake + liquidatedStake;
        } else if (winnerStake != 0) {
            payout = winnerStake + (winnerStake * losingPool) / winningPool;
        }

        if (payout == 0) revert NoPayout();
        emit PayoutClaimed(roundId, bettor, payout);
    }
}
