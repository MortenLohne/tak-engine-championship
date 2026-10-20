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

export function buildResultsModel({ engines, results, totalRounds, live }) {
  if (!Array.isArray(results)) return null;
  const names = Array.isArray(engines) ? engines : [];
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
