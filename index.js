import * as jsonpatch from 'https://esm.sh/fast-json-patch@3.1.1';
import { applyOperation, applyPatch } from 'https://esm.sh/fast-json-patch@3.1.1';
import Chart from 'https://esm.sh/chart.js@4.5.0/auto';

let ptnNinjaHasLoaded = false;
let jumpToLast = true;
let gameState = null;
let ptn = "";
let chart = new Chart(
    document.getElementById('acquisitions'),
    {
        type: 'line',
        data: {
            labels: [],
            datasets: [
            ]
        }
    }
);
const ninja = document.getElementById("ninja");

window.addEventListener(
    "message",
    (event) => {
        if (event.source !== ninja.contentWindow) {
            return
        }

        if (!ptnNinjaHasLoaded) {
            if (event.data.action === "GAME_STATE") {
                ptnNinjaHasLoaded = true;
                console.log("ptn.ninja loaded");
                fetchLoop();
            } else {
                return; // Ignore other messages until ptn.ninja is fully loaded
            }
        }
        if (event.data.action === "LAST") {
            jumpToLast = true;
        }
        if (["PREV", "NEXT", "FIRST"].includes(event.data.action)) {
            jumpToLast = false;
        }
    },
    false
);

const fetchLoop = async () => {
    const evtSource = new EventSource("https://racetrack.mortenlohne.no/0/sse");

    evtSource.onmessage = (event) => {
        document.getElementById("no-game-message").style.display = "none";
        const patch = JSON.parse(event.data);
        gameState = applyPatch(gameState, patch).newDocument;
        if (gameState !== null) {
            setGameState(gameState);
        }
    }

    evtSource.onerror = (error) => {
        console.error("Error in SSE connection:", error);
        document.getElementById("no-game-message").style.display = "block";
        gameState = null;
        evtSource.close();
        window.setTimeout(fetchLoop, 2000);
    }
}

const setGameState = (newGameState) => {
    let newPtn = `[TPS "${newGameState.openingTps}"]`;
    newPtn += `\n[Player1 "${newGameState.whitePlayer}"]`;
    newPtn += `\n[Player2 "${newGameState.blackPlayer}"]`;
    newPtn += `\n[Komi "${Number(newGameState.halfKomi) / 2}"]`;

    const whiteNameDiv = document.getElementById("white-name");
    const blackNameDiv = document.getElementById("black-name");

    whiteNameDiv.textContent = newGameState.whitePlayer;
    blackNameDiv.textContent = newGameState.blackPlayer;

    for (const move of newGameState.openingMoves) {
        newPtn += ` ${move} `;
    }
    for (const move of newGameState.moves) {
        newPtn += ` ${move.move} `;
    }

    const currentPly = newGameState.moves.length + newGameState.openingMoves.length;

    const lastMoveInfo = newGameState.moves[newGameState.moves.length - 1]?.uciInfo;

    const currentMoveEvalDiv = currentPly % 2 === 1 ? document.getElementById("white-eval") : document.getElementById("black-eval");
    const lastMoveEvalDiv = currentPly % 2 === 0 ? document.getElementById("white-eval") : document.getElementById("black-eval");

    currentMoveEvalDiv.textContent = currentPly % 2 === 1 ? lastMoveInfo?.cpScore : 0 - lastMoveInfo?.cpScore;
    lastMoveEvalDiv.textContent = currentPly % 2 === 0 ? newGameState.currentMoveUciInfo?.cpScore : 0 - newGameState.currentMoveUciInfo?.cpScore;

    const currentPvDiv = currentPly % 2 === 1 ? document.getElementById("white-pv") : document.getElementById("black-pv");
    const lastPvDiv = currentPly % 2 === 0 ? document.getElementById("white-pv") : document.getElementById("black-pv");

    currentPvDiv.textContent = lastMoveInfo?.pv.join(" ");
    lastPvDiv.textContent = (newGameState.currentMoveUciInfo?.pv || []).join(" ");

    const currentNpsDiv = currentPly % 2 === 1 ? document.getElementById("white-nps") : document.getElementById("black-nps");
    const lastNpsDiv = currentPly % 2 === 0 ? document.getElementById("white-nps") : document.getElementById("black-nps");

    const currentNps = lastMoveInfo?.nps;
    const lastNps = newGameState.currentMoveUciInfo?.nps;

    currentNpsDiv.textContent = `${currentNps > 100000 ? Math.floor(currentNps / 1000) + " knps" : Math.floor(currentNps) + " nps"}`;
    lastNpsDiv.textContent = `${lastNps > 100000 ? Math.floor(lastNps / 1000) + " knps" : Math.floor(lastNps) + " nps"}`;

    const whiteTimeDiv = document.getElementById("white-time");
    const blackTimeDiv = document.getElementById("black-time");

    const whiteSecsLeft = newGameState.whiteTimeLeft.secs;
    const blackSecsLeft = newGameState.blackTimeLeft.secs;
    whiteTimeDiv.textContent = `${Math.floor(whiteSecsLeft / 60)}:${(whiteSecsLeft % 60 + "").padStart(2, "0")} `;
    blackTimeDiv.textContent = `${Math.floor(blackSecsLeft / 60)}:${(blackSecsLeft % 60 + "").padStart(2, "0")} `;

    // Only update the ptn.ninja window if the PTN actually changed
    if (ptn !== newPtn) {
        ptn = newPtn;
        console.log("Setting new PTN:", newPtn);
        ninja.contentWindow.postMessage({ action: "SET_CURRENT_PTN", value: newPtn }, "*");
        if (jumpToLast) {
            ninja.contentWindow.postMessage({ action: "LAST", value: "" }, "*");
        }

        let scores = [];
        let ply = 0;
        for (const move of newGameState.openingMoves) {
            scores.push({ ply, score: null });
            ply += 1;
        }

        for (const move of newGameState.moves) {
            scores.push({ ply, score: move.uciInfo?.cpScore });
            ply += 1;
        }

        chart.data = {
            labels: scores.map(row => (row.ply + 1) / 2),
            datasets: [
                {
                    label: 'White eval',
                    data: scores.map(({ ply, score }) => ply % 2 === 0 ? score : null),
                    spanGaps: true,
                    backgroundColor: "darkgray",
                    borderColor: "darkgray",
                    borderDash: [2, 2],
                },
                {
                    label: 'Black eval',
                    data: scores.map(({ ply, score }) => ply % 2 === 1 ? 0.0 - score : null),
                    spanGaps: true,
                    backgroundColor: "black",
                    borderColor: "black",

                }
            ]
        }
        chart.update("none");
    }

}
