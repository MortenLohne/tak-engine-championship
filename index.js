let ptnNinjaHasLoaded = false;
let jumpToLast = true;
let gameState = null;
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
    try {
        const result = await fetch("https://dodo-healthy-eft.ngrok-free.app/0", { headers: { "ngrok-skip-browser-warning": "true" } });
        gameState = await result.json();
    } catch (error) {
        document.getElementById("no-game-message").style.display = "block";
        window.setTimeout(fetchLoop, 2000);
        return;
    }

    document.getElementById("no-game-message").style.display = "none";
    setGameState(gameState);
    window.setTimeout(fetchLoop, 500);
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

    const currentNps = 1000 * lastMoveInfo?.nodes / (lastMoveInfo?.time + 1);
    const lastNps = 1000 * newGameState.currentMoveUciInfo?.nodes / (newGameState.currentMoveUciInfo?.time + 1);

    currentNpsDiv.textContent = `${currentNps > 100000 ? Math.floor(currentNps / 1000) + " knps" : Math.floor(currentNps) + " nps"}`;
    lastNpsDiv.textContent = `${lastNps > 100000 ? Math.floor(lastNps / 1000) + " knps" : Math.floor(lastNps) + " nps"}`;

    const whiteTimeDiv = document.getElementById("white-time");
    const blackTimeDiv = document.getElementById("black-time");

    const whiteSecsLeft = newGameState.whiteTimeLeft.secs;
    const blackSecsLeft = newGameState.blackTimeLeft.secs;
    whiteTimeDiv.textContent = `${Math.floor(whiteSecsLeft / 60)}:${(whiteSecsLeft % 60 + "").padStart(2, "0")} `;
    blackTimeDiv.textContent = `${Math.floor(blackSecsLeft / 60)}:${(blackSecsLeft % 60 + "").padStart(2, "0")} `;

    console.log("Setting new PTN:", newPtn);
    ninja.contentWindow.postMessage({ action: "SET_CURRENT_PTN", value: newPtn }, "*");
    if (jumpToLast) {
        ninja.contentWindow.postMessage({ action: "LAST", value: "" }, "*");
    }
}
