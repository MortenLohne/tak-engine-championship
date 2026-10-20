import { applyPatch } from "https://esm.sh/fast-json-patch@3.1.1";
import Chart from "https://esm.sh/chart.js@4.5.0/auto";
import {
  buildResultsModel,
  findResult,
  durationMs,
  isNewMatch,
  matchInfo,
  ptnClock,
  ptnResult,
} from "./results.js";
import { createResultsPanel } from "./results-panel.js";

const urlParams = new URLSearchParams(window.location.search);

// `?server=<url>` points the viewer at another Racetrack server
function serverUrl() {
  const fallback = "https://racetrack.mortenlohne.no";
  const param = urlParams.get("server");
  if (!param) {
    return fallback;
  }
  try {
    const url = new URL(param.trim());
    if (url.protocol === "http:" || url.protocol === "https:") {
      return param.trim().replace(/\/+$/, "");
    }
  } catch {}
  return fallback;
}
const SERVER_URL = serverUrl();

let gameState = null;
let viewedGame = null; // The finished game shown in place of the live one
const finishedGames = new Map(); // Finished games by round number
let finishedGamesGeneration = 0; // Bumped when the cache is cleared
let lastMatch = null; // matchInfo() of the last state, kept across reconnects
let reconnected = false; // Whether the stream reconnected since the last state
let finishedGameRequest = 0; // Latest showFinishedGame call, to drop stale loads
let roundNumber = 0;
let moveCount = 0;
// Whether PTN Ninja has the live game as it was played, plies appended to it
// (also while staying on it after it ended), rather than a loaded finished game
let ninjaHasLiveGame = false;
// The round of each APPEND_PLY sent, until PTN Ninja reports appending it
let sentAppends = [];
// The round of the ply PTN Ninja last reported appending, if it was one of
// ours: what a GAME_END that follows is about
let lastAppendedRound = null;
// Whether PTN Ninja hasn't yet reported going to the last ply of the game
// last loaded, so its game state may still be of an earlier game
let awaitingNinjaLast = false;
const endNotifiedRounds = new Set(); // Rounds with a "Game N ended" notification
// "Game N ended" notifications waiting for PTN Ninja's GET_URL reply, in order
const pendingEndNotifications = [];
// A copy of the live state from before the round last changed: the game that
// just ended, until Racetrack's record of it is loaded
let previousLiveState = null;
let savedNotePlies = new Set(); // Track plies with final notes saved

let ninjaGameState = null;
let theme = null;

const ninja = document.getElementById("ninja").contentWindow;

function sendToNinja(action, value) {
  ninja.postMessage({ action, value }, "*");
}

//#region PTN Ninja settings

const ninjaSettingsToSave = [
  "axisLabels",
  "axisLabelsSmall",
  "boardEvalBar",
  "showAnalysisBoard",
  "showEval",
  "showMove",
  "showPTN",
  "showRoads",
  "showToolbarAnalysis",
  "stackCounts",
  "themeID",
];
const defaultNinjaSettings = {
  boardEvalBar: true,
  showAnalysisBoard: true,
  showEval: true,
  showToolbarAnalysis: true,
  showMove: false,
};
const ninjaSettingsStorageKey = "ninjaSettings";
let ninjaSettings = localStorage.getItem(ninjaSettingsStorageKey);
if (ninjaSettings) {
  ninjaSettings = JSON.parse(ninjaSettings);
}
function updateNinjaSettings(settings) {
  if ("themeID" in settings) {
    sendToNinja("GET_THEME");
  }
  let hasChanged = false;
  ninjaSettingsToSave.forEach((key) => {
    if (key in settings) {
      if (!ninjaSettings) {
        ninjaSettings = { [key]: settings[key] };
        hasChanged = true;
      } else if (ninjaSettings[key] !== settings[key]) {
        ninjaSettings[key] = settings[key];
        hasChanged = true;
      }
    }
  });
  if (hasChanged) {
    localStorage.setItem(
      ninjaSettingsStorageKey,
      JSON.stringify(ninjaSettings),
    );
  }
}

//#region Chart settings

const chartSettingsStorageKey = "chartSettings";
let chartSettings = localStorage.getItem(chartSettingsStorageKey);
if (chartSettings) {
  chartSettings = JSON.parse(chartSettings);
} else {
  chartSettings = {
    fixYAxis: false,
  };
}
function setChartSettings(key, value) {
  chartSettings[key] = value;
  localStorage.setItem(chartSettingsStorageKey, JSON.stringify(chartSettings));
  const scale = chartSettings.fixYAxis ? 100 : 10;
  chart.config.options.scales.y.suggestedMax = scale;
  chart.config.options.scales.y.suggestedMin = -scale;
  chart.update();
}

//#region Chart initialization

const chartContainer = document.getElementById("chart-area");

const verticalLinePlugin = {
  getLinePosition(chart, pointIndex) {
    const meta = chart.getDatasetMeta(0); // first dataset is used to discover X coordinate of a point
    const data = meta.data;
    return data[pointIndex]?.x;
  },

  renderVerticalLine(chartInstance, pointIndex) {
    const lineLeftOffset = this.getLinePosition(chartInstance, pointIndex);
    if (lineLeftOffset === null || lineLeftOffset === undefined) {
      return;
    }
    const scale = chartInstance.scales.y;
    const context = chartInstance.ctx;
    // render vertical line
    context.beginPath();
    const themeColors = theme && theme.colors ? theme.colors : null;
    context.strokeStyle =
      (themeColors && themeColors.primary) || Chart.defaults.color;
    context.moveTo(lineLeftOffset, scale.top);
    context.lineTo(lineLeftOffset, scale.bottom);
    context.stroke();
  },

  beforeDatasetsDraw(chart) {
    if (chart.config._config.lineAtIndex !== null) {
      this.renderVerticalLine(chart, chart.config._config.lineAtIndex);
    }
  },
};

const chart = new Chart(document.getElementById("chart"), {
  type: "line",
  data: {
    labels: [],
    datasets: [],
  },
  lineAtIndex: null,
  plugins: [verticalLinePlugin],
  options: {
    animations: false,
    maintainAspectRatio: false,
    onClick: ({ x }) => {
      // Get the data index from the click position, clamped to valid range
      const rawIndex = Math.round(chart.scales.x.getValueForPixel(x));
      const labelsLength = chart.data.labels.length;
      const dataIndex = Math.max(0, Math.min(rawIndex, labelsLength - 1));
      // data[i] shows analysis BEFORE move i was made (the position the engine analyzed)
      // So clicking data[0] should go to plyID=0, isDone=false (before first move)
      // For the last data point, use LAST to go to end of main branch
      const isLastNode = dataIndex >= labelsLength - 1;
      if (isLastNode) {
        sendToNinja("LAST");
      } else {
        const plyID = dataIndex + shownGame().openingMoves.length;
        sendToNinja("GO_TO_PLY", { plyID, isDone: false });
      }
      ninja.focus();
    },
    plugins: {
      legend: {
        onClick: () => {
          setChartSettings("fixYAxis", !chartSettings.fixYAxis);
        },
      },
    },
    tension: 0.3,
    pointRadius: 2,
    pointBorderWidth: 2,
    pointHoverBorderWidth: 5,
    scales: {
      x: {
        ticks: {
          color: () => {
            return theme?.secondaryDark
              ? theme?.colors?.textLight || Chart.defaults.color
              : theme?.colors?.textDark || Chart.defaults.color;
          },
        },
        grid: {
          color: () => {
            return theme?.colors?.bg || Chart.defaults.borderColor;
          },
        },
      },
      y: {
        suggestedMin: chartSettings.fixYAxis ? -100 : -10,
        suggestedMax: chartSettings.fixYAxis ? 100 : 10,
        ticks: {
          color: () => {
            return theme?.secondaryDark
              ? theme?.colors?.textLight || Chart.defaults.color
              : theme?.colors?.textDark || Chart.defaults.color;
          },
        },
        grid: {
          color: () => {
            return theme?.colors?.bg || Chart.defaults.borderColor;
          },
        },
      },
    },
  },
});

const player1LineColor = () => theme?.colors?.player1 || "white";
const player2LineColor = () => theme?.colors?.player2 || "black";
const player1FillColor = () =>
  (theme?.colors?.player1clear || "white").replace(/00$/, "33");
const player2FillColor = () =>
  (theme?.colors?.player2clear || "black").replace(/00$/, "33");

//#region Chart sync

function updateChart() {
  const game = shownGame();
  if (!game) {
    return;
  }

  let scores = game.moves.map((move, i) => {
    return {
      ply: i + game.openingMoves.length,
      score: winningProbability(move.uciInfo),
    };
  });

  if (game.currentMoveUciInfo) {
    scores.push({
      ply: scores.length + game.openingMoves.length,
      score: winningProbability(game.currentMoveUciInfo),
    });
  }

  chart.data = {
    labels: scores.map((row) => 1 + row.ply / 2),
    datasets: [
      {
        label: `${formatName(game.whitePlayer)}'s evaluation`,
        data: scores.map(({ ply, score }) => (ply % 2 === 0 ? score : null)),
        spanGaps: true,
        borderColor: player1LineColor,
        backgroundColor: player1FillColor,
        fill: {
          target: "origin",
          above: player1FillColor,
          below: player2FillColor,
        },
      },
      {
        label: `${formatName(game.blackPlayer)}'s evaluation`,
        data: scores.map(({ ply, score }) => (ply % 2 === 1 ? -score : null)),
        spanGaps: true,
        borderColor: player2LineColor,
        backgroundColor: player2FillColor,
        fill: {
          target: "origin",
          above: player1FillColor,
          below: player2FillColor,
        },
      },
    ],
  };
  chart.update();
}

function resizeChart() {
  chart.resize(chartContainer.offsetWidth, chartContainer.offsetHeight);
}
resizeChart();
// Also follows the results list opening and closing above the chart
new ResizeObserver(resizeChart).observe(chartContainer);

function updateChartVerticalLine(plyID = null, plyIsDone = true) {
  const game = shownGame();
  let lineAtIndex = null;
  if (game && plyID !== null) {
    // plyID from PTN Ninja: position in the game
    // Chart data[i] corresponds to gameState.moves[i]
    // When plyIsDone=true: we're viewing the result of move plyID, so lineAtIndex = plyID - openingMoves.length + 1
    // When plyIsDone=false: we're before the move, so lineAtIndex = plyID - openingMoves.length
    lineAtIndex = plyID - game.openingMoves.length + (plyIsDone ? 1 : 0);
    if (lineAtIndex < 0) {
      lineAtIndex = 0;
    }
  }
  chart.config._config.lineAtIndex = lineAtIndex;
  chart.update();
}

function updateTheme(newTheme) {
  theme = newTheme;
  const themeColors = theme?.colors || {};

  const textColor = theme
    ? theme.secondaryDark
      ? themeColors.textLight
      : themeColors.textDark
    : "";

  // PTN Ninja's header and toolbars: the `ui` colour, with light text when
  // it's dark (`isDark` is computed from `ui`)
  const headerTextColor = theme
    ? theme.isDark
      ? themeColors.textLight
      : themeColors.textDark
    : "";

  document.body.style.background = themeColors.bg || "";
  document.getElementById("chart-wrapper").style.background =
    themeColors.panel || "";
  const resultsColors = {
    "--results-bg": themeColors.bg,
    "--results-panel": themeColors.panel,
    "--results-text": textColor,
    "--results-header-bg": themeColors.ui,
    "--results-header-text": headerTextColor,
    "--results-p1": themeColors.player1,
    "--results-p2": themeColors.player2,
    "--results-accent": themeColors.primary,
  };
  Object.entries(resultsColors).forEach(([name, value]) => {
    if (value) {
      document.documentElement.style.setProperty(name, value);
    } else {
      document.documentElement.style.removeProperty(name);
    }
  });
  Chart.defaults.color = textColor;
  chart.update();
}

//#region Match results

const resultsPanel = createResultsPanel(document.getElementById("results"), {
  onSelect: (round) => {
    if (round === null) {
      showLiveGame();
    } else {
      showFinishedGame(round);
    }
  },
});

function updateResults() {
  if (!gameState) {
    return;
  }
  resultsPanel.update(
    buildResultsModel({
      engines: gameState.engines,
      results: gameState.results,
      totalRounds: gameState.totalRounds,
      live: {
        roundNumber: gameState.roundNumber,
        whitePlayer: formatName(gameState.whitePlayer),
        blackPlayer: formatName(gameState.blackPlayer),
        plies: gameState.openingMoves.length + gameState.moves.length,
      },
    }),
    viewedGame?.roundNumber ?? null,
  );
}

//#region Clock sync

function sendClocks(isLive) {
  const game = shownGame();
  if (!game) {
    return;
  }
  const time1 = durationMs(game.whiteTimeLeft);
  const time2 = durationMs(game.blackTimeLeft);
  if (time1 === null || time2 === null) {
    return;
  }
  const ply = game.openingMoves.length + game.moves.length;
  const timerTurn = ply % 2 === 0 ? 1 : 2;
  sendToNinja("SET_GAME_TIME", {
    time1,
    time2,
    timerTurn,
    lastTimeUpdateWall: Date.now(),
  });
  sendToNinja("SET_TIMER_LIVE", Boolean(isLive));
}

//#region Formatting helpers

function formatName(name) {
  if (typeof name !== "string") {
    return "";
  }
  return name.trim();
}

function toPvArray(pv) {
  if (typeof pv === "string") {
    return pv.trim() ? pv.trim().split(/\s+/) : [];
  }
  if (!Array.isArray(pv)) {
    return [];
  }
  return pv
    .flatMap((token) => {
      if (typeof token !== "string") {
        return [];
      }
      return token.trim() ? token.trim().split(/\s+/) : [];
    })
    .filter(Boolean);
}

function formatWdl(wdl, currentPlayer) {
  if (!wdl) {
    return null;
  }

  if (Array.isArray(wdl)) {
    const [win, draw, loss] = wdl.map((value) => Number(value));
    if ([win, draw, loss].some(Number.isNaN)) {
      return null;
    }
    return currentPlayer === 2
      ? { player1: loss, draw, player2: win }
      : { player1: win, draw, player2: loss };
  }

  if (typeof wdl === "object") {
    if (
      "player1" in wdl &&
      "draw" in wdl &&
      "player2" in wdl &&
      ![wdl.player1, wdl.draw, wdl.player2].some((value) =>
        Number.isNaN(Number(value)),
      )
    ) {
      return {
        player1: Number(wdl.player1),
        draw: Number(wdl.draw),
        player2: Number(wdl.player2),
      };
    }

    if (
      "win" in wdl &&
      "draw" in wdl &&
      "loss" in wdl &&
      ![wdl.win, wdl.draw, wdl.loss].some((value) =>
        Number.isNaN(Number(value)),
      )
    ) {
      const win = Number(wdl.win);
      const draw = Number(wdl.draw);
      const loss = Number(wdl.loss);
      return currentPlayer === 2
        ? { player1: loss, draw, player2: win }
        : { player1: win, draw, player2: loss };
    }
  }

  return null;
}

function extractRawSuggestions(uciInfo) {
  if (!uciInfo) {
    return [];
  }

  if (Array.isArray(uciInfo.suggestions) && uciInfo.suggestions.length) {
    return uciInfo.suggestions;
  }

  if (Array.isArray(uciInfo.multiPv) && uciInfo.multiPv.length) {
    return uciInfo.multiPv;
  }

  if (Array.isArray(uciInfo.multipv) && uciInfo.multipv.length) {
    return uciInfo.multipv;
  }

  if (Array.isArray(uciInfo.pvs) && uciInfo.pvs.length) {
    return uciInfo.pvs.map((pv) =>
      typeof pv === "object" && pv !== null ? pv : { pv },
    );
  }

  if (
    Array.isArray(uciInfo.pv) &&
    uciInfo.pv.length > 0 &&
    uciInfo.pv.some((pv) => typeof pv === "string" && /\s/.test(pv))
  ) {
    return uciInfo.pv.map((pv) => ({ pv }));
  }

  if (
    Array.isArray(uciInfo.pv) &&
    uciInfo.pv.length > 0 &&
    Array.isArray(uciInfo.pv[0])
  ) {
    return uciInfo.pv.map((pv) => ({ pv }));
  }

  return [uciInfo];
}

// Moves to a forced result as reported by the engine (`score mate N`),
// positive when the engine wins
function mateScore(uciInfo) {
  if (uciInfo?.mate === null || uciInfo?.mate === undefined) {
    return null;
  }
  const mate = Number(uciInfo.mate);
  return Number.isFinite(mate) ? mate : null;
}

// The engine's own score, from player 1's perspective like PTN Ninja's:
// the reported cp, or "W<moves>" for mate scores. PTN Ninja places the label
// on the winning side by the evaluation's sign, and UCI mate scores don't say
// whether the win is by road or flats, so the label carries neither.
function formatScore(uciInfo, currentPlayer) {
  const sign = currentPlayer === 2 ? -1 : 1;
  const mate = mateScore(uciInfo);
  if (mate !== null) {
    return {
      rawCp: null,
      scoreText: `W${Math.abs(mate)}`,
    };
  }
  const cp = Number(uciInfo?.cpScore);
  return {
    rawCp: uciInfo?.cpScore != null && Number.isFinite(cp) ? cp * sign : null,
    scoreText: null,
  };
}

function formatSuggestion(uciInfo, currentPlayer, botName = null) {
  const { depth, hashfull, nodes, nps, pv, seldepth, time } = uciInfo;

  let evaluation = winningProbability(uciInfo);

  if (currentPlayer === 2) {
    evaluation = -evaluation;
  }

  return {
    evaluation,
    wdl: formatWdl(uciInfo?.wdl, currentPlayer),
    ...formatScore(uciInfo, currentPlayer),
    depth,
    hashfull,
    nodes,
    nps,
    pv: toPvArray(pv),
    seldepth,
    time,
    botName,
  };
}

function formatAnalysis(uciInfo, currentPlayer, tps = null, botName = null) {
  const suggestions = extractRawSuggestions(uciInfo)
    .map((suggestion) => formatSuggestion(suggestion, currentPlayer, botName))
    .filter((suggestion) => suggestion.pv.length > 0);

  const primarySuggestion =
    suggestions[0] || formatSuggestion(uciInfo, currentPlayer, botName);

  return {
    tps,
    ...primarySuggestion,
    suggestions,
  };
}

function formatEval(uciInfo, currentPlayer) {
  if (!uciInfo) {
    return null;
  }
  const evaluation =
    winningProbability(uciInfo) * (currentPlayer === 1 ? 1 : -1);
  const wdl = formatWdl(uciInfo.wdl, currentPlayer);
  return wdl ? { evaluation, wdl } : evaluation;
}

function formatEngineNote(suggestion, name) {
  let { evaluation, wdl, rawCp, scoreText, depth, nodes, nps, pv, time } =
    suggestion;
  evaluation = Math.round(10 * evaluation) / 1000;
  if (evaluation >= 0) {
    evaluation = `+${evaluation}`;
  }
  if (depth) {
    depth = `/${depth}`;
  }

  // Format with new PTN Ninja syntax:
  // name:"engine" wdl:p1,d,p2 cp:N score:WN eval/depth nodes time pv
  const scores = [
    wdl && `wdl:${wdl.player1},${wdl.draw},${wdl.player2}`,
    rawCp !== null && rawCp !== undefined && `cp:${rawCp}`,
    scoreText && `score:${scoreText}`,
  ]
    .filter(Boolean)
    .map((token) => `${token} `)
    .join("");
  return `name:"${name.replace(/"/g, "")}" ${scores}${evaluation}${depth || ""} ${nodes || 0} nodes ${time || 0}ms ${nps || 0}nps pv> ${(pv || []).join(" ")}`;
}

function formatEngineNotes(uciInfo, turn, name) {
  const { suggestions } = formatAnalysis(uciInfo, turn, null, name);
  if (!suggestions.length) {
    return [formatEngineNote(formatSuggestion(uciInfo, turn, name), name)];
  }
  return suggestions.map((suggestion) => formatEngineNote(suggestion, name));
}

// Extract winning probability, as a number between -100 and 100
function winningProbability(uciInfo) {
  if (!uciInfo) {
    return 0;
  }

  const evaluation = Number(uciInfo.evaluation);
  if (Number.isFinite(evaluation)) {
    return evaluation;
  }

  const mate = mateScore(uciInfo);
  if (mate !== null) {
    return mate < 0 ? -100 : 100;
  }

  if (Array.isArray(uciInfo.wdl)) {
    const [win, draw] = uciInfo.wdl.map((value) => Number(value));
    if (Number.isFinite(win) && Number.isFinite(draw)) {
      return win / 5 + draw / 10 - 100;
    }
  }

  if (
    uciInfo.wdl &&
    typeof uciInfo.wdl === "object" &&
    "win" in uciInfo.wdl &&
    "draw" in uciInfo.wdl
  ) {
    const win = Number(uciInfo.wdl.win);
    const draw = Number(uciInfo.wdl.draw);
    if (Number.isFinite(win) && Number.isFinite(draw)) {
      return win / 5 + draw / 10 - 100;
    }
  }

  if (
    uciInfo.wdl &&
    typeof uciInfo.wdl === "object" &&
    "player1" in uciInfo.wdl &&
    "draw" in uciInfo.wdl
  ) {
    const win = Number(uciInfo.wdl.player1);
    const draw = Number(uciInfo.wdl.draw);
    if (Number.isFinite(win) && Number.isFinite(draw)) {
      return win / 5 + draw / 10 - 100;
    }
  }

  const cpScore = Number(uciInfo.cpScore);
  if (Number.isFinite(cpScore)) {
    return cpScore;
  }

  const rawCp = Number(uciInfo.rawCp);
  if (Number.isFinite(rawCp)) {
    return rawCp;
  }

  return 0;
}

//#region Server sync

async function fetchLoop() {
  // Note: Opening an EventSource will not throw, even if the server cannot be reached
  const evtSource = new EventSource(SERVER_URL + "/0/sse");

  evtSource.onopen = () => {
    document.getElementById("loading-text").innerHTML = "Loading games...";
  };

  evtSource.onmessage = (event) => {
    document.getElementById("loading").style.display = "none";
    const patch = JSON.parse(event.data);
    if (
      gameState &&
      patch.some((op) => op.path === "" || op.path === "/roundNumber")
    ) {
      // applyPatch changes the state in place
      previousLiveState = structuredClone(gameState);
    }
    gameState = applyPatch(gameState, patch).newDocument;
    if (gameState === null) {
      return;
    }
    const match = matchInfo(gameState);
    const newMatch = isNewMatch(lastMatch, match);
    const checkViewed = newMatch || reconnected;
    lastMatch = match;
    reconnected = false;
    if (newMatch) {
      // Same round numbers, different games
      clearFinishedGames();
      endNotifiedRounds.clear();
      previousLiveState = null; // Don't stay on a game from the old match
      roundNumber = 0; // Nor notify that the old match's game ended
    }
    if (
      viewedGame &&
      checkViewed &&
      (newMatch || !findResult(gameState.results, viewedGame.roundNumber))
    ) {
      // The viewed game is from another match, or no longer listed
      showLiveGame(); // Also updates from the new state
      return;
    }
    updateGameState();
  };

  evtSource.onerror = (error) => {
    document.getElementById("loading").style.display = "";
    document.getElementById("loading-text").innerHTML =
      "Lost connection to the server, reconnecting...";
    console.error("Connection error: ", error);
    gameState = null;
    // Racetrack may have restarted with another match
    reconnected = true;
    clearFinishedGames();
    endNotifiedRounds.clear();
    sendToNinja("SET_TIMER_LIVE", false);
    evtSource.close();
    window.setTimeout(fetchLoop, 2000);
  };
}

function clearFinishedGames() {
  finishedGames.clear();
  finishedGamesGeneration++;
}

function shownGame() {
  return viewedGame ?? gameState;
}

// Shows `game` in PTN Ninja from its start, with its notes and clocks
function loadGameIntoNinja(game, { live, result = null }) {
  let ptn = `[TPS "${game.openingTps}"]`;
  ptn += `\n[Player1 "${formatName(game.whitePlayer)}"]`;
  ptn += `\n[Player2 "${formatName(game.blackPlayer)}"]`;
  ptn += `\n[Size "${game.size}"]`;
  ptn += `\n[Site "Racetrack"]`;
  ptn += `\n[Round "${game.roundNumber}"]`;
  ptn += `\n[Komi "${Number(game.halfKomi) / 2}"]`;
  const clock = ptnClock(game);
  if (clock) {
    ptn += `\n[Clock "${clock}"]`;
  }
  if (result) {
    ptn += `\n[Result "${result}"]`;
  }
  ptn +=
    " " +
    game.openingMoves.concat(game.moves.map(({ move }) => move)).join(" ");
  if (result) {
    // Also after the last move, as PTN has it: PTN Ninja only shows a result
    // there, and can't tell time or forfeit wins from the position
    ptn += ` ${result}`;
  }

  sendToNinja("SET_NAME", `Tak Engine Championship: Game ${game.roundNumber}`);
  sendToNinja("SET_CURRENT_PTN", ptn);
  ninjaHasLiveGame = live;
  awaitingNinjaLast = true;
  // Plies sent before this aren't in the new game
  sentAppends = [];
  lastAppendedRound = null;
  sendToNinja("LAST");
  savedNotePlies.clear();
  saveAnalysisToNotes();
  sendClocks(live);
}

function updateGameState() {
  if (viewedGame) {
    // Viewing a finished game: the live game keeps updating in the background
    updateResults();
    return;
  }

  if (
    roundNumber !== gameState.roundNumber ||
    moveCount > gameState.moves.length
  ) {
    if (roundNumber !== 0 && roundNumber !== gameState.roundNumber) {
      // Before loading the next game, while PTN Ninja still has this one
      notifyRoundEnded(roundNumber);
    }
    if (shouldStayOnEndedGame()) {
      stayOnEndedGame();
      return;
    }
    // New game
    roundNumber = gameState.roundNumber;
    moveCount = 0;
    loadGameIntoNinja(gameState, { live: true });
    moveCount = gameState.moves.length;
  } else if (moveCount < gameState.moves.length) {
    // New move(s)
    gameState.moves.slice(moveCount).forEach((move) => {
      appendPly(roundNumber, move.move);
    });
    saveAnalysisToNotes();
    sendClocks(true);
    moveCount = gameState.moves.length;
  } else {
    // New analysis
    setCurrentAnalysis();
  }

  // Update the eval chart
  updateChart();

  updateResults();
}

const viewingNotificationId = "viewing-finished-game";

// The finished game `round` from the cache, or else from Racetrack
async function fetchFinishedGame(round) {
  const cached = finishedGames.get(round);
  if (cached) {
    return cached;
  }
  const generation = finishedGamesGeneration;
  const response = await fetch(`${SERVER_URL}/games/${round}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const game = await response.json();
  if (generation === finishedGamesGeneration) {
    finishedGames.set(round, game);
  }
  return game;
}

async function showFinishedGame(round) {
  const request = ++finishedGameRequest; // Also drops any other game loading
  if (viewedGame?.roundNumber === round) {
    // Already shown: don't reload it, but retry loading Racetrack's record
    // of a game that was stayed on when it ended
    if (!finishedGames.has(round)) {
      refreshEndedGame(round, request, { reportErrors: true });
    }
    updateResults();
    return;
  }
  let game;
  try {
    game = await fetchFinishedGame(round);
  } catch (error) {
    console.warn(`Couldn't load game ${round}:`, error);
    if (request === finishedGameRequest) {
      sendToNinja("NOTIFY_ERROR", `Couldn't load game ${round}`);
    }
    return;
  }
  if (request !== finishedGameRequest) {
    // Another game, or the live one, was chosen in the meantime
    return;
  }

  viewedGame = game;
  loadGameIntoNinja(game, {
    live: false,
    // Time and forfeit wins can't be told from the moves
    result: ptnResult(findResult(gameState?.results, round)?.result),
  });
  updateChart();
  notifyViewing(game.roundNumber);
  updateResults();
}

function notifyViewing(round) {
  sendToNinja("NOTIFY", {
    id: viewingNotificationId,
    // Production PTN Ninja ignores `id`; `group` makes it replace the last one
    group: viewingNotificationId,
    message: `Viewing game ${round}`,
    position: "top-right",
    timeout: 0,
    actions: [
      { color: "primary", label: "Back to live", action: "BACK_TO_LIVE" },
      { icon: "close" },
    ],
  });
}

// Whether the live game just ended (the round changed) while the viewer had
// stepped back in it, so they should stay on it instead of following the new
// game
function shouldStayOnEndedGame() {
  return (
    viewedGame === null &&
    roundNumber !== 0 &&
    roundNumber !== gameState.roundNumber &&
    previousLiveState?.roundNumber === roundNumber &&
    ninjaGameState !== null &&
    !awaitingNinjaLast &&
    !ninjaGameState.isAtEndOfMainBranch
  );
}

// Keep showing the game that just ended, as a finished game, where the viewer
// is in it: PTN Ninja already has it, so it isn't reloaded
function stayOnEndedGame() {
  const round = roundNumber;
  const request = ++finishedGameRequest;
  viewedGame = finishedGames.get(round);
  if (!viewedGame) {
    viewedGame = previousLiveState;
    // Its live analysis is of a position that's no longer being searched
    viewedGame.currentMoveUciInfo = null;
  }
  previousLiveState = null;
  appendMissingMoves();
  sendClocks(false);
  notifyViewing(round);
  updateChart();
  updateResults();
  if (!finishedGames.has(round)) {
    refreshEndedGame(round, request);
  }
}

// Load Racetrack's record of the stayed-on game `round`, which has any final
// moves and the result the live state missed
function refreshEndedGame(round, request, { reportErrors = false } = {}) {
  fetchFinishedGame(round)
    .then((game) => {
      if (
        request !== finishedGameRequest ||
        viewedGame?.roundNumber !== round
      ) {
        return;
      }
      viewedGame = game;
      appendMissingMoves();
      sendClocks(false);
      notifyRoundEnded(round);
      updateChart();
      updateResults();
    })
    .catch((error) => {
      // Keep the copy of the live state; showing the game again retries
      console.warn(`Couldn't load game ${round}:`, error);
      if (reportErrors && request === finishedGameRequest) {
        sendToNinja("NOTIFY_ERROR", `Couldn't load game ${round}`);
      }
    });
}

function appendPly(round, ply) {
  sentAppends.push(round);
  sendToNinja("APPEND_PLY", ply);
}

// Append the viewed game's moves that PTN Ninja doesn't have yet, if it's
// still showing that game as it was played live
function appendMissingMoves() {
  if (!ninjaHasLiveGame || viewedGame.moves.length <= moveCount) {
    return;
  }
  viewedGame.moves.slice(moveCount).forEach((move) => {
    appendPly(viewedGame.roundNumber, move.move);
  });
  moveCount = viewedGame.moves.length;
  saveAnalysisToNotes();
}

// Notify that `round` ended, with its result from Racetrack, unless it was
// already notified or Racetrack has no result for it yet. PTN Ninja's GAME_END
// misses some endings: time and forfeit wins, a final move that arrives with
// the next game, or a viewer who isn't at the last move.
function notifyRoundEnded(round) {
  const result = ptnResult(findResult(gameState?.results, round)?.result);
  if (result) {
    notifyGameEnded(round, result, null);
  }
}

// Notify once per game. `url` is the game's PTN Ninja link, or null to ask
// PTN Ninja for the link of the game it has now, which must be `round`.
function notifyGameEnded(round, result, url) {
  if (endNotifiedRounds.has(round)) {
    return;
  }
  endNotifiedRounds.add(round);
  const ended = { round, result };
  if (url) {
    sendGameEndedNotification(ended, url);
  } else {
    pendingEndNotifications.push(ended);
    sendToNinja("GET_URL");
  }
}

function sendGameEndedNotification({ round, result }, url) {
  sendToNinja("NOTIFY", {
    // The latest replaces the previous: by `id` where PTN Ninja
    // supports it, by `group` (and position) on production
    id: "game-ended",
    group: "game-ended",
    icon: "result",
    message: `Game ${round} ended ${result}`,
    position: "top-right",
    actions: [
      {
        color: "primary",
        label: "View",
        icon: "open_in_new",
        action: "VIEW_FINISHED_GAME",
        value: url,
      },
      {
        icon: "close",
      },
    ],
  });
}

// `fromNotification`: the viewing notification's own "Back to live" button was
// clicked, which already closed it
function showLiveGame({ fromNotification = false } = {}) {
  finishedGameRequest++; // Drop any finished game still loading
  const wasViewing = viewedGame !== null;
  viewedGame = null;
  if (!wasViewing) {
    return;
  }
  if (!fromNotification) {
    // Production PTN Ninja doesn't support DISMISS_NOTIFY yet, so first
    // replace the viewing notification (same group and position) with one
    // that closes itself almost at once. Builds that do support it then find
    // nothing left to dismiss.
    sendToNinja("NOTIFY", {
      group: viewingNotificationId,
      message: "Back to live",
      position: "top-right",
      timeout: 1,
    });
  }
  sendToNinja("DISMISS_NOTIFY", { id: viewingNotificationId });
  // Reload the live game from scratch on the next update
  roundNumber = 0;
  if (gameState) {
    updateGameState();
  }
}

//#region PTN Ninja sync

function setCurrentAnalysis() {
  const game = shownGame();
  if (!game || !ninjaGameState) {
    return;
  }

  if (ninjaGameState.isAtEndOfMainBranch && game.currentMoveUciInfo) {
    // At the end of the game - show real-time analysis
    const turn = ninjaGameState.turn;
    const botName =
      turn === 1 ? formatName(game.whitePlayer) : formatName(game.blackPlayer);
    const uciInfo = game.currentMoveUciInfo;
    sendToNinja("SET_ANALYSIS", formatAnalysis(uciInfo, turn, null, botName));
    sendToNinja("SET_EVAL", formatEval(uciInfo, turn));
  } else {
    // Historical position - show saved analysis from moves
    const openingMoveCount = game.openingMoves.length;
    // plyID = moveIndex + openingMoveCount - 1, so moveIndex = plyID - openingMoveCount + 1
    const moveIndex =
      ninjaGameState.plyID -
      openingMoveCount +
      (ninjaGameState.plyIsDone ? 1 : 0);

    if (moveIndex >= 0 && moveIndex < game.moves.length) {
      const move = game.moves[moveIndex];
      if (move && move.uciInfo) {
        const turn = ninjaGameState.turn;
        const botName =
          turn === 1
            ? formatName(game.whitePlayer)
            : formatName(game.blackPlayer);
        sendToNinja(
          "SET_ANALYSIS",
          formatAnalysis(move.uciInfo, turn, null, botName),
        );
        sendToNinja("SET_EVAL", formatEval(move.uciInfo, turn));
      }
    } else {
      // Clear analysis if no data for this position
      sendToNinja("SET_ANALYSIS", null);
      sendToNinja("SET_EVAL", null);
    }
  }
}

function saveAnalysisToNotes() {
  const game = shownGame();
  const notes = {};
  const openingMoveCount = game.openingMoves.length;

  // Save analysis for completed moves (only those not already saved)
  game.moves.forEach((move, i) => {
    const plyID = i + openingMoveCount - 1;

    // Skip if already saved
    if (savedNotePlies.has(plyID)) {
      return;
    }

    // In standard Tak, white always moves first: ply 0,2,4...=white (turn=1), ply 1,3,5...=black (turn=2)
    const ply = i + openingMoveCount;
    const turn = ply % 2 === 0 ? 1 : 2;
    const name =
      turn === 1 ? formatName(game.whitePlayer) : formatName(game.blackPlayer);

    const uciInfo = move.uciInfo;
    notes[plyID] = formatEngineNotes(uciInfo, turn, name);
    savedNotePlies.add(plyID);
  });

  // Send finalized notes
  if (Object.keys(notes).length) {
    sendToNinja("ADD_NOTES", notes);
  }
}

window.addEventListener(
  "message",
  (event) => {
    if (event.source !== ninja) {
      return;
    }

    const { action, value } = event.data;

    switch (action) {
      case "GAME_STATE":
        if (!ninjaGameState) {
          // Initiate connection to server
          fetchLoop();

          // Defaults first, then saved settings override them so that
          // user-toggled prefs survive a reload.
          const mergedNinjaSettings = {
            ...defaultNinjaSettings,
            ...(ninjaSettings || {}),
          };
          sendToNinja("SET_UI", mergedNinjaSettings);
          if (
            !ninjaSettings ||
            Object.keys(defaultNinjaSettings).some(
              (key) => ninjaSettings[key] !== mergedNinjaSettings[key],
            )
          ) {
            ninjaSettings = mergedNinjaSettings;
            localStorage.setItem(
              ninjaSettingsStorageKey,
              JSON.stringify(ninjaSettings),
            );
          }
          if (!("themeID" in mergedNinjaSettings)) {
            // Request theme info
            sendToNinja("GET_THEME");
          }
        }
        ninjaGameState = value;
        // Show analysis for current position if possible
        setCurrentAnalysis();

        // Update vertical line
        updateChartVerticalLine(
          ninjaGameState.isAtEndOfMainBranch ? null : ninjaGameState.plyID,
          ninjaGameState.plyIsDone,
        );
        break;
      case "GET_THEME":
        updateTheme(value);
        break;
      case "SET_UI":
        updateNinjaSettings(value);
        break;
      case "LAST":
        awaitingNinjaLast = false;
        break;
      case "APPEND_PLY":
        // PTN Ninja reports each ply appended, ours in the order sent; any
        // other is the viewer's own
        lastAppendedRound = sentAppends.length ? sentAppends.shift() : null;
        break;
      case "INSERT_PLY":
      case "INSERT_PLIES":
        lastAppendedRound = null;
        break;
      case "GAME_END": {
        // Follows the report of the ply that ended the game: only trust it
        // for one of ours, and name that ply's round, even if a newer game
        // was loaded since
        const round = lastAppendedRound;
        lastAppendedRound = null;
        if (round === null) {
          break;
        }
        if (round === roundNumber) {
          sendToNinja("SET_TIMER_LIVE", false);
        }
        notifyGameEnded(
          round,
          `${value.result.player1}-${value.result.player2}`,
          value.url || null,
        );
        break;
      }
      case "GET_URL": {
        if (typeof value !== "string") {
          break;
        }
        const ended = pendingEndNotifications.shift();
        if (ended) {
          sendGameEndedNotification(ended, value);
        }
        break;
      }
      case "BACK_TO_LIVE":
        showLiveGame({ fromNotification: true });
        break;
      case "VIEW_FINISHED_GAME":
        window.open(value, "_blank");
        break;
    }
  },
  false,
);
