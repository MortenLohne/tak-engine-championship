import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResultsModel, fullMoves, resultWinner } from "./results.js";

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
