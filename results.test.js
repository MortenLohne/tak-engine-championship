import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATE_CP,
  buildResultsModel,
  centipawns,
  symlog,
  symlogInverse,
  isMatchOver,
  findResult,
  fullMoves,
  isNewMatch,
  matchInfo,
  ptnClock,
  ptnResult,
  resultWinner,
} from "./results.js";

const engines = ["syntaks", "takzero"];
const row = (roundNumber, whiteEngine, blackEngine, result, plies = 40) => ({
  roundNumber,
  whiteEngine,
  blackEngine,
  result,
  plies,
});

test("resultWinner", () => {
  for (const r of ["R-0", "F-0", "1-0"]) assert.equal(resultWinner(r), "white");
  for (const r of ["0-R", "0-F", "0-1"]) assert.equal(resultWinner(r), "black");
  for (const r of ["1/2-1/2", "*"]) assert.equal(resultWinner(r), "draw");
});

test("fullMoves", () => {
  assert.equal(fullMoves(0), 0);
  assert.equal(fullMoves(1), 1);
  assert.equal(fullMoves(2), 1);
  assert.equal(fullMoves(41), 21);
});

test("counts wins and draws", () => {
  const m = buildResultsModel({
    engines,
    results: [
      row(1, 0, 1, "R-0"),
      row(2, 1, 0, "0-R"),
      row(3, 0, 1, "1/2-1/2"),
      row(4, 1, 0, "F-0"),
      row(5, 0, 1, "*"),
    ],
    live: null,
  });
  assert.deepEqual(m.wins, [2, 1]);
  assert.equal(m.draws, 2);
  assert.equal(m.twoEngines, true);
  assert.deepEqual(m.names, ["syntaks", "takzero"]);
});

test("dots show the winning side's colour", () => {
  const m = buildResultsModel({
    engines,
    results: [
      row(1, 1, 0, "0-R"),
      row(2, 1, 0, "R-0"),
      row(3, 0, 1, "1/2-1/2"),
    ],
    live: null,
  });
  assert.deepEqual(
    m.games.map((g) => g.dot),
    ["black", "white", "draw"],
  );
  assert.equal(m.games[0].white, "takzero");
  assert.equal(m.games[0].black, "syntaks");
  assert.equal(m.games[0].winner, "black");
  assert.equal(m.games[0].live, false);
  // Still counted per engine: syntaks won game 1 as Black, takzero game 2 as White
  assert.deepEqual(m.wins, [1, 1]);
});

test("live row last", () => {
  const m = buildResultsModel({
    engines,
    results: [row(5, 0, 1, "R-0", 41)],
    live: {
      roundNumber: 6,
      whitePlayer: "takzero",
      blackPlayer: "syntaks",
      plies: 9,
    },
  });
  const last = m.games.at(-1);
  assert.equal(last.live, true);
  assert.equal(last.result, "--");
  assert.equal(last.dot, "live");
  assert.equal(last.winner, null);
  assert.equal(last.round, 6);
  assert.equal(last.white, "takzero");
  assert.equal(last.moves, 5);
  assert.equal(m.games[0].moves, 21);
});

test("live game already finished", () => {
  const m = buildResultsModel({
    engines,
    results: [row(1, 0, 1, "R-0"), row(2, 1, 0, "0-R")],
    live: {
      roundNumber: 2,
      whitePlayer: "takzero",
      blackPlayer: "syntaks",
      plies: 40,
    },
  });
  assert.equal(m.games.length, 2);
  assert.ok(m.games.every((g) => !g.live));
  assert.equal(m.label, "Game 2");
});

test("sorts by round without mutating input", () => {
  const results = [
    row(3, 0, 1, "R-0"),
    row(1, 0, 1, "R-0"),
    row(2, 0, 1, "R-0"),
  ];
  const m = buildResultsModel({ engines, results, live: null });
  assert.deepEqual(
    m.games.map((g) => g.round),
    [1, 2, 3],
  );
  assert.deepEqual(
    results.map((r) => r.roundNumber),
    [3, 1, 2],
  );
});

test("many engines", () => {
  const m = buildResultsModel({
    engines: ["a", "b", "c"],
    results: [
      row(1, 0, 1, "R-0"),
      row(2, 2, 1, "0-R"),
      row(3, 0, 2, "1/2-1/2"),
    ],
    live: null,
  });
  assert.equal(m.twoEngines, false);
  assert.equal(m.names, null);
  assert.deepEqual(m.wins, [0, 0]);
  assert.deepEqual(
    m.games.map((g) => g.dot),
    ["white", "black", "draw"],
  );
  assert.equal(m.games[0].white, "a");
});

test("label with total", () => {
  const live = { roundNumber: 6, whitePlayer: "x", blackPlayer: "y", plies: 0 };
  assert.equal(
    buildResultsModel({ engines, results: [], totalRounds: 20, live }).label,
    "Game 6 of 20",
  );
  assert.equal(
    buildResultsModel({ engines, results: [], live }).label,
    "Game 6",
  );
});

test("label falls back to last finished round; omits round-0 live", () => {
  const m = buildResultsModel({
    engines,
    results: [row(1, 0, 1, "R-0"), row(2, 0, 1, "R-0")],
    totalRounds: 4,
    live: { roundNumber: 0, whitePlayer: "x", blackPlayer: "y", plies: 0 },
  });
  assert.equal(m.label, "Game 2 of 4");
  assert.equal(m.games.length, 2);
});

test("no results", () => {
  assert.equal(
    buildResultsModel({ engines, results: undefined, live: null }),
    null,
  );
});

test("trims engine names like the live row", () => {
  const m = buildResultsModel({
    engines: [" syntaks ", "takzero\n"],
    results: [row(1, 0, 1, "R-0"), row(2, 1, 0, "0-R")],
    live: null,
  });
  assert.deepEqual(m.names, ["syntaks", "takzero"]);
  assert.equal(m.games[0].white, "syntaks");
  assert.equal(m.games[0].black, "takzero");
  assert.equal(m.games[1].white, "takzero");
});

test("matchInfo copies the engines", () => {
  const state = { engines: ["a", "b"], results: [row(1, 0, 1, "R-0")] };
  const info = matchInfo(state);
  state.engines[0] = "c";
  state.results.push(row(2, 1, 0, "0-R"));
  assert.deepEqual(info, { engines: ["a", "b"], resultCount: 1 });
  assert.deepEqual(matchInfo({}), { engines: null, resultCount: null });
});

test("isNewMatch", () => {
  const info = (engines, n) =>
    matchInfo({
      engines,
      results: Array.from({ length: n }, (_, i) => row(i + 1, 0, 1, "R-0")),
    });
  assert.equal(isNewMatch(null, info(engines, 0)), false);
  assert.equal(isNewMatch(info(engines, 2), info(engines, 2)), false);
  assert.equal(isNewMatch(info(engines, 2), info(engines, 3)), false);
  // Results got shorter: a restart with the same engines
  assert.equal(isNewMatch(info(engines, 3), info(engines, 1)), true);
  assert.equal(isNewMatch(info(engines, 3), info(["a", "b"], 3)), true);
  assert.equal(
    isNewMatch(info(engines, 1), info([...engines].reverse(), 1)),
    true,
  );
  // A server without results or engines
  assert.equal(isNewMatch(matchInfo({}), matchInfo({})), false);
});

test("findResult and ptnResult", () => {
  const results = [row(1, 0, 1, "R-0"), row(2, 1, 0, "0-F")];
  assert.equal(findResult(results, 2).result, "0-F");
  assert.equal(findResult(results, 3), null);
  assert.equal(findResult(undefined, 1), null);
  for (const r of ["R-0", "0-F", "1-0", "1/2-1/2"])
    assert.equal(ptnResult(r), r);
  for (const r of ["*", "", null, undefined]) assert.equal(ptnResult(r), null);
});

test("ptnClock", () => {
  const tc = (time, increment, black = { time, increment }) => ({
    whiteTime: time,
    whiteIncrement: increment,
    blackTime: black.time,
    blackIncrement: black.increment,
  });
  assert.equal(
    ptnClock(tc({ secs: 600, nanos: 0 }, { secs: 5, nanos: 0 })),
    "10:00 +5",
  );
  assert.equal(ptnClock(tc({ secs: 10 }, { nanos: 100000000 })), "0:10 +0.1");
  assert.equal(ptnClock(tc({ secs: 3600 }, { secs: 0 })), "60:00 +0");
  assert.equal(ptnClock(tc({ secs: 65 }, { secs: 2 })), "1:05 +2");
  assert.equal(
    ptnClock(tc({ secs: 10, nanos: 500000000 }, { secs: 0, nanos: 250000000 })),
    "0:10.5 +0.25",
  );
  assert.equal(
    ptnClock(tc({ secs: 59, nanos: 999999999 }, { secs: 1 })),
    "1:00 +1",
  );
  // Absent (older Racetrack), partial, invalid or zero
  assert.equal(ptnClock({}), null);
  assert.equal(ptnClock(null), null);
  assert.equal(
    ptnClock({ whiteTime: { secs: 600 }, whiteIncrement: { secs: 5 } }),
    null,
  );
  assert.equal(ptnClock(tc({}, { secs: 5 })), null);
  assert.equal(ptnClock(tc({ secs: "x" }, { secs: 5 })), null);
  assert.equal(ptnClock(tc({ secs: 0 }, { secs: 5 })), null);
  // Different time controls
  assert.equal(
    ptnClock(
      tc(
        { secs: 600 },
        { secs: 5 },
        { time: { secs: 300 }, increment: { secs: 5 } },
      ),
    ),
    null,
  );
  assert.equal(
    ptnClock(
      tc(
        { secs: 600 },
        { secs: 5 },
        { time: { secs: 600 }, increment: { secs: 3 } },
      ),
    ),
    null,
  );
});

test("isMatchOver once every scheduled game has a result", () => {
  const results = [{ roundNumber: 1 }, { roundNumber: 2 }];
  assert.equal(isMatchOver({ results, totalRounds: 2 }), true);
  assert.equal(isMatchOver({ results, totalRounds: 3 }), false);
  // Unknown length (SPRT) or an older server: never over
  assert.equal(isMatchOver({ results, totalRounds: undefined }), false);
  assert.equal(isMatchOver({ results: undefined, totalRounds: 2 }), false);
  assert.equal(isMatchOver({}), false);
});

test("centipawns from the engine's report", () => {
  assert.equal(centipawns({ cpScore: 37 }), 37);
  assert.equal(centipawns({ cpScore: -120, wdl: [1, 2, 997] }), -120);
  // Mate scores have no comparable cp value: pinned to the cap
  assert.equal(centipawns({ mate: 3 }), MATE_CP);
  assert.equal(centipawns({ mate: -2, cpScore: -100 }), -MATE_CP);
  // Absurd values are clamped to the cap
  assert.equal(centipawns({ cpScore: 999999 }), MATE_CP);
  assert.equal(centipawns({}), null);
  assert.equal(centipawns(null), null);
});

test("symlog is odd, monotonic, and inverted by symlogInverse", () => {
  assert.equal(symlog(0), 0);
  assert.equal(symlog(-300), -symlog(300));
  assert.ok(symlog(100) < symlog(1000) && symlog(1000) < symlog(MATE_CP));
  for (const cp of [-20000, -350, -1, 0, 1, 99, 1000]) {
    assert.ok(Math.abs(symlogInverse(symlog(cp)) - cp) < 1e-6, String(cp));
  }
});
