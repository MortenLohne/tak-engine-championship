// Pure view model for the match results strip. No DOM, no imports.

export function resultWinner(result) {
  const r = String(result ?? "");
  if (r.endsWith("-0")) return "white";
  if (r.startsWith("0-")) return "black";
  return "draw";
}

export function fullMoves(plies) {
  return Math.ceil(plies / 2);
}

// Engine names as shown elsewhere on the page
function formatName(name) {
  return typeof name === "string" ? name.trim() : "";
}

// What identifies the match a game state belongs to, copied so that later
// patches to the state don't change it
export function matchInfo(state) {
  return {
    engines: Array.isArray(state?.engines) ? [...state.engines] : null,
    resultCount: Array.isArray(state?.results) ? state.results.length : null,
  };
}

// Whether `next` (from matchInfo) is a different match from `previous`, as
// after Racetrack restarts with another match: the engines changed, or the
// results list got shorter
export function isNewMatch(previous, next) {
  if (!previous || !next) return false;
  if (JSON.stringify(previous.engines) !== JSON.stringify(next.engines))
    return true;
  return (
    previous.resultCount !== null &&
    next.resultCount !== null &&
    next.resultCount < previous.resultCount
  );
}

// The results entry for `round`, if any
export function findResult(results, round) {
  if (!Array.isArray(results)) return null;
  return results.find((g) => g.roundNumber === round) ?? null;
}

// The PTN `[Result]` value for a finished game's result, or null for an
// unfinished one (`*`) or a missing result
export function ptnResult(result) {
  const r = String(result ?? "").trim();
  return r && r !== "*" ? r : null;
}

export function buildResultsModel({ engines, results, totalRounds, live }) {
  if (!Array.isArray(results)) return null;
  const names = Array.isArray(engines) ? engines.map(formatName) : [];
  const twoEngines = names.length === 2;
  const sorted = [...results].sort((x, y) => x.roundNumber - y.roundNumber);

  const wins = [0, 0];
  let draws = 0;
  const games = sorted.map((g) => {
    const winner = resultWinner(g.result);
    if (winner === "draw") {
      draws++;
    } else if (twoEngines) {
      const winnerEngine = winner === "white" ? g.whiteEngine : g.blackEngine;
      wins[winnerEngine === 0 ? 0 : 1]++;
    }
    return {
      round: g.roundNumber,
      white: names[g.whiteEngine],
      black: names[g.blackEngine],
      result: g.result,
      moves: fullMoves(g.plies),
      winner,
      // The winning side's colour, not the engine's: engines swap sides
      dot: winner,
      live: false,
    };
  });

  if (
    live &&
    live.roundNumber &&
    !sorted.some((g) => g.roundNumber === live.roundNumber)
  ) {
    games.push({
      round: live.roundNumber,
      white: live.whitePlayer,
      black: live.blackPlayer,
      result: "--",
      moves: fullMoves(live.plies),
      winner: null,
      dot: "live",
      live: true,
    });
  }

  const current = games.length ? games[games.length - 1].round : null;
  const liveRound = live && live.roundNumber ? live.roundNumber : null;
  const n = liveRound ?? current;
  let label = "";
  if (n != null)
    label = totalRounds ? `Game ${n} of ${totalRounds}` : `Game ${n}`;

  return {
    twoEngines,
    names: twoEngines ? [names[0], names[1]] : null,
    wins: twoEngines ? wins : [0, 0],
    draws,
    games,
    label,
  };
}
