import { applyPatch } from "https://esm.sh/fast-json-patch@3.1.1";
import Chart from "https://esm.sh/chart.js@4.5.0/auto";
import { buildResultsModel } from "./results.js";
import { createResultsPanel } from "./results-panel.js";

const urlParams = new URLSearchParams(window.location.search);

// const SERVER_URL = "http://192.168.1.2:23456";
// `?server=<url>` overrides it, for local testing
const SERVER_URL = (
  urlParams.get("server") || "https://racetrack.mortenlohne.no"
).replace(/\/+$/, "");

let gameState = null;
let viewedGame = null; // The finished game shown in place of the live one
const finishedGames = new Map(); // Finished games by round number
let finishedGameRequest = 0; // Latest showFinishedGame call, to drop stale loads
let roundNumber = 0;
let moveCount = 0;
let previousGame = null;
let savedNotePlies = new Set(); // Track plies with final notes saved
let livePv = { ply: null, pv: [] }; // Last complete PV seen for the ply being searched
let finalPvs = new Map(); // Completed plies' final PVs, continued where truncated
let livePvRound = null; // The live game livePv and finalPvs belong to

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

  document.body.style.background = themeColors.bg || "";
  document.getElementById("chart-wrapper").style.background =
    themeColors.panel || "";
  const resultsColors = {
    "--results-bg": themeColors.bg,
    "--results-panel": themeColors.panel,
    "--results-text": textColor,
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
if (urlParams.has("debug")) {
  window.__resultsPanel = resultsPanel;
  window.showFinishedGame = showFinishedGame;
  window.showLiveGame = showLiveGame;
}

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

// Convert a serde-serialized std::time::Duration ({ secs, nanos }) to ms
function durationToMs(duration) {
  if (!duration || typeof duration !== "object") {
    return null;
  }
  const secs = Number(duration.secs);
  const nanos = Number(duration.nanos);
  if (!Number.isFinite(secs) || !Number.isFinite(nanos)) {
    return null;
  }
  return secs * 1000 + Math.round(nanos / 1e6);
}

function sendClocks(isLive) {
  const game = shownGame();
  if (!game) {
    return;
  }
  const time1 = durationToMs(game.whiteTimeLeft);
  const time2 = durationToMs(game.blackTimeLeft);
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

// Syntaks reports aspiration-window fail-high/low results with a truncated PV
// (often just the root move), and Racetrack doesn't forward the bound flag.
// While the reported PV is a prefix of the last complete one, keep the latter.
function pvWithContinuation(pv, ply) {
  pv = toPvArray(pv);
  if (
    livePv.ply === ply &&
    pv.length < livePv.pv.length &&
    pv.every((move, i) => move === livePv.pv[i])
  ) {
    return livePv.pv;
  }
  return pv;
}

function trackLivePv() {
  const uciInfo = gameState.currentMoveUciInfo;
  if (!uciInfo) {
    return;
  }
  const ply = gameState.openingMoves.length + gameState.moves.length;
  livePv = { ply, pv: pvWithContinuation(uciInfo.pv, ply) };
}

// Keeps each newly completed ply's final PV, before livePv moves on
function trackFinalPvs() {
  const openingMoveCount = gameState.openingMoves.length;
  gameState.moves.forEach((move, i) => {
    const ply = i + openingMoveCount;
    if (move.uciInfo && !finalPvs.has(ply)) {
      finalPvs.set(ply, pvWithContinuation(move.uciInfo.pv, ply));
    }
  });
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
    gameState = applyPatch(gameState, patch).newDocument;
    if (gameState !== null) {
      updateGameState();
    }
  };

  evtSource.onerror = (error) => {
    document.getElementById("loading").style.display = "";
    document.getElementById("loading-text").innerHTML =
      "Lost connection to the server, reconnecting...";
    console.error("Connection error: ", error);
    gameState = null;
    sendToNinja("SET_TIMER_LIVE", false);
    evtSource.close();
    window.setTimeout(fetchLoop, 2000);
  };
}

function shownGame() {
  return viewedGame ?? gameState;
}

// Shows `game` in PTN Ninja from its start, with its notes and clocks
function loadGameIntoNinja(game, { live }) {
  let ptn = `[TPS "${game.openingTps}"]`;
  ptn += `\n[Player1 "${formatName(game.whitePlayer)}"]`;
  ptn += `\n[Player2 "${formatName(game.blackPlayer)}"]`;
  ptn += `\n[Size "${game.size}"]`;
  ptn += `\n[Site "Racetrack"]`;
  ptn += `\n[Round "${game.roundNumber}"]`;
  ptn += `\n[Komi "${Number(game.halfKomi) / 2}"]`;
  ptn +=
    " " +
    game.openingMoves.concat(game.moves.map(({ move }) => move)).join(" ");

  sendToNinja("SET_NAME", `Tak Engine Championship: Game ${game.roundNumber}`);
  sendToNinja("SET_CURRENT_PTN", ptn);
  sendToNinja("LAST");
  savedNotePlies.clear();
  saveAnalysisToNotes();
  sendClocks(live);
}

function updateGameState() {
  // PV tracking follows the live game even while a finished one is shown,
  // and survives reloading the same game when returning to it
  if (
    livePvRound !== gameState.roundNumber ||
    finalPvs.size > gameState.moves.length
  ) {
    livePvRound = gameState.roundNumber;
    livePv = { ply: null, pv: [] };
    finalPvs = new Map();
  }
  trackFinalPvs();

  if (viewedGame) {
    // Viewing a finished game: keep the live game's progress for later
    trackLivePv();
    updateResults();
    return;
  }

  if (
    roundNumber !== gameState.roundNumber ||
    moveCount > gameState.moves.length
  ) {
    // New game
    roundNumber = gameState.roundNumber;
    moveCount = 0;
    loadGameIntoNinja(gameState, { live: true });
    trackLivePv();
    moveCount = gameState.moves.length;
  } else if (moveCount < gameState.moves.length) {
    // New move(s)
    gameState.moves.slice(moveCount).forEach((move) => {
      sendToNinja("APPEND_PLY", move.move);
    });
    saveAnalysisToNotes();
    trackLivePv();
    sendClocks(true);
    moveCount = gameState.moves.length;
  } else {
    // New analysis
    trackLivePv();
    setCurrentAnalysis();
  }

  // Update the eval chart
  updateChart();

  updateResults();
}

const viewingNotificationId = "viewing-finished-game";

async function showFinishedGame(round) {
  const request = ++finishedGameRequest;
  let game = finishedGames.get(round);
  if (!game) {
    try {
      const response = await fetch(`${SERVER_URL}/games/${round}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      game = await response.json();
    } catch (error) {
      console.warn(`Couldn't load game ${round}:`, error);
      if (request === finishedGameRequest) {
        sendToNinja("NOTIFY_ERROR", `Couldn't load game ${round}`);
      }
      return;
    }
    finishedGames.set(round, game);
  }
  if (request !== finishedGameRequest) {
    // Another game, or the live one, was chosen in the meantime
    return;
  }

  viewedGame = game;
  loadGameIntoNinja(game, { live: false });
  updateChart();
  sendToNinja("NOTIFY", {
    id: viewingNotificationId,
    // Production PTN Ninja ignores `id`; `group` makes it replace the last one
    group: viewingNotificationId,
    message: `Viewing game ${game.roundNumber}`,
    position: "top-right",
    timeout: 0,
    actions: [
      { color: "primary", label: "Back to live", action: "BACK_TO_LIVE" },
      { icon: "close" },
    ],
  });
  updateResults();
}

function showLiveGame() {
  finishedGameRequest++; // Drop any finished game still loading
  const wasViewing = viewedGame !== null;
  viewedGame = null;
  if (!wasViewing) {
    return;
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
    const uciInfo = { ...game.currentMoveUciInfo, pv: livePv.pv };
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
  const isLive = viewedGame === null;
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

    // The final info line may itself be a truncated bound result
    // (only the live game's search was tracked)
    const uciInfo =
      move.uciInfo && isLive
        ? {
            ...move.uciInfo,
            pv: finalPvs.get(ply) ?? pvWithContinuation(move.uciInfo.pv, ply),
          }
        : move.uciInfo;
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
      case "GAME_END":
        if (viewedGame !== null) {
          // A finished game was loaded, not the live one ending
          break;
        }
        previousGame = {
          roundNumber,
          result: value.result,
        };
        sendToNinja("SET_TIMER_LIVE", false);
        sendToNinja("GET_URL");
        break;
      case "GET_URL":
        sendToNinja("NOTIFY", {
          icon: "result",
          message: `Game ${previousGame.roundNumber} ended ${previousGame.result.player1}-${previousGame.result.player2}`,
          position: "top-right",
          actions: [
            {
              color: "primary",
              label: "View",
              icon: "open_in_new",
              action: "VIEW_FINISHED_GAME",
              value,
            },
            {
              icon: "close",
            },
          ],
        });
        break;
      case "BACK_TO_LIVE":
        showLiveGame();
        break;
      case "VIEW_FINISHED_GAME":
        window.open(value, "_blank");
        break;
    }
  },
  false,
);
