/**
 * ai-player.js
 * Integrates NEAT AI (118 inputs, 8 outputs) into game.html via polling.
 *
 * Depends on: neat-runner.js
 * Depends on: game.html globals — gameState, SPACES, rollDice(), buyProperty(),
 *             passProperty(), endTurn(), placeBid(), passAuction(), buildHouse()
 */

const AIPlayer = (() => {

    const models = {};
    let aiPlayers = {};

    let aiActing = false;
    let pollInterval = null;

    const ACTION_DELAY = 1200;
    const THINK_DELAY  = 800;
    const POLL_MS      = 500;

    // Property IDs in the same order as the Python engine
    const PROPERTY_IDS = [1,3,5,6,8,9,11,12,13,14,15,16,18,19,21,23,24,25,26,27,28,29,31,32,34,35,37,39];
    const BUILDABLE_IDS = [1,3,6,8,9,11,13,14,16,18,19,21,23,24,26,27,29,31,32,34,37,39];

    const COLOR_GROUP_PROPS = {
        'brown':      [1, 3],
        'light-blue': [6, 8, 9],
        'pink':       [11, 13, 14],
        'orange':     [16, 18, 19],
        'red':        [21, 23, 24],
        'yellow':     [26, 27, 29],
        'green':      [31, 32, 34],
        'dark-blue':  [37, 39],
        'railroad':   [5, 15, 25, 35],
        'utility':    [12, 28],
    };

    // ─── Input builder (118 inputs — matches Python get_nn_inputs) ────────────

    function buildInputs(playerIndex) {
        const player = gameState.players[playerIndex];
        const allPlayers = [player, ...gameState.players.filter(p => p.id !== player.id)];

        const inputs = [];

        // 4 players × 3 = 12
        for (let i = 0; i < 4; i++) {
            if (i < allPlayers.length) {
                const p = allPlayers[i];
                inputs.push(p.position / 40.0);
                inputs.push(Math.min(1.0, p.cash / 2000.0));
                inputs.push(Math.min(1.0, (p.getOutOfJailFreeCards || 0) / 2.0));
            } else {
                inputs.push(0.0, 0.0, 0.0);
            }
        }

        // 28 properties × 2 = 56 (owner_encoded, mortgaged)
        for (const pid of PROPERTY_IDS) {
            const own = gameState.ownedProperties[pid];
            if (!own) {
                inputs.push(0.0, 0.0);
            } else {
                if (own.ownerId === player.id) {
                    inputs.push(1.0);
                } else {
                    const oppIdx = gameState.players.findIndex(p => p.id === own.ownerId) + 1;
                    inputs.push(Math.max(-1.0, -oppIdx / 3.0));
                }
                inputs.push(own.isMortgaged ? 1.0 : 0.0);
            }
        }

        // 22 buildable properties × 1 = 22 (houses/hotel)
        for (const pid of BUILDABLE_IDS) {
            const own = gameState.ownedProperties[pid];
            if (own && own.ownerId === player.id) {
                const val = own.hasHotel ? 5 : (own.houses || 0);
                inputs.push(val / 5.0);
            } else {
                inputs.push(0.0);
            }
        }

        // 28 context × 1 = 28 (can afford and unowned?)
        for (const pid of PROPERTY_IDS) {
            const own = gameState.ownedProperties[pid];
            const price = (SPACES[pid] && SPACES[pid].price) || 0;
            inputs.push((!own && player.cash >= price) ? 1.0 : 0.0);
        }

        // Clamp all to [-1, 1]
        for (let i = 0; i < inputs.length; i++) {
            inputs[i] = Math.max(-1.0, Math.min(1.0, inputs[i]));
        }

        if (inputs.length !== 118) {
            console.error(`[AI] Input vector length ${inputs.length}, expected 118`);
        }
        return inputs;
    }

    // ─── Decision (8 outputs) ─────────────────────────────────────────────────

    function getDecision(playerIndex) {
        const difficulty = aiPlayers[playerIndex];
        const model = models[difficulty];
        if (!model) return null;
        const inputs = buildInputs(playerIndex);
        const outputs = NEATRunner.activate(model, inputs);
        return {
            buyProperty:          outputs[0],  // >0.5 = buy
            bidRatio:             outputs[1],  // fraction of cash to bid
            buildHouse:           outputs[2],  // >0.5 = build
            sellHouse:            outputs[3],  // >0.5 = sell
            mortgage:             outputs[4],  // >0.5 = mortgage
            unmortgage:           outputs[5],  // >0.5 = unmortgage
            tradeAggression:      outputs[6],  // 0-1
            jailDecision:         outputs[7],  // >0.5 = pay fine
        };
    }

    // ─── House building ───────────────────────────────────────────────────────

    function tryBuildHouses(playerIndex) {
        const decision = getDecision(playerIndex);
        if (!decision || decision.buildHouse <= 0.5) return;
        const player = gameState.players[playerIndex];
        for (const [color, group] of Object.entries(COLOR_GROUP_PROPS)) {
            if (color === 'railroad' || color === 'utility') continue;
            const hasAll = group.every(pid => {
                const o = gameState.ownedProperties[pid];
                return o && o.ownerId === player.id;
            });
            if (!hasAll) continue;
            for (const pid of group) {
                const o = gameState.ownedProperties[pid];
                const space = SPACES[pid];
                if (!o || o.isMortgaged || o.hasHotel || (o.houses || 0) >= 4) continue;
                if (player.cash < (space.houseCost || 9999)) continue;
                buildHouse(pid);
                return;
            }
        }
    }

    // ─── Auction ──────────────────────────────────────────────────────────────

    function handleAuctionTurn(playerIndex) {
        const decision = getDecision(playerIndex);
        const player = gameState.players[playerIndex];

        if (!decision) {
            passAuction();
            aiActing = false;
            return;
        }

        const maxBid = Math.floor(player.cash * Math.max(0.1, decision.bidRatio));
        const minBid = (gameState.auction.currentBid || 0) + 1;

        if (maxBid >= minBid && maxBid <= player.cash) {
            const input = document.getElementById('auctionBidInput');
            if (input) input.value = maxBid;
            setTimeout(() => {
                placeBid();
                aiActing = false;
            }, THINK_DELAY);
        } else {
            setTimeout(() => {
                passAuction();
                aiActing = false;
            }, THINK_DELAY);
        }
    }

    // ─── Main turn logic ──────────────────────────────────────────────────────

    function takeTurn() {
        aiActing = true;

        const idx = gameState.currentPlayerIndex;

        if (!(idx in aiPlayers) || !gameState.players[idx] || gameState.players[idx].isBankrupt) {
            aiActing = false;
            return;
        }

        if (gameState.auction && gameState.auction.active) {
            handleAuctionPhase();
            return;
        }

        const phase = gameState.phase;

        if (phase === 'ROLL_DICE') {
            setTimeout(() => {
                console.log(`[AI] Player ${idx} (${aiPlayers[idx]}) rolling dice`);
                rollDice();
                aiActing = false;
            }, THINK_DELAY);

        } else if (phase === 'PROPERTY_DECISION') {
            setTimeout(() => {
                if (gameState.phase !== 'PROPERTY_DECISION' || gameState.pendingProperty == null) {
                    aiActing = false;
                    return;
                }
                const space = SPACES[gameState.pendingProperty];
                if (!space) { aiActing = false; return; }

                const decision = getDecision(idx);
                const player = gameState.players[idx];
                const shouldBuy = decision && decision.buyProperty > 0.5 && player.cash >= (space.price || 0);
                console.log(`[AI] Player ${idx} ${shouldBuy ? 'BUYING' : 'PASSING'} ${space.name}`);
                if (shouldBuy) {
                    buyProperty();
                } else {
                    passProperty();
                }
                aiActing = false;
            }, THINK_DELAY);

        } else if (phase === 'END_TURN') {
            setTimeout(() => {
                tryBuildHouses(idx);
                setTimeout(() => {
                    if (gameState.phase === 'END_TURN') {
                        console.log(`[AI] Player ${idx} ending turn`);
                        endTurn();
                    }
                    aiActing = false;
                }, 400);
            }, THINK_DELAY);

        } else {
            aiActing = false;
        }
    }

    function handleAuctionPhase() {
        const auction = gameState.auction;
        if (!auction || !auction.active) { aiActing = false; return; }

        const activeBidders = auction.participatingPlayers.filter(
            id => !auction.passedPlayers.includes(id)
        );
        if (activeBidders.length === 0) { aiActing = false; return; }
        if (activeBidders.length === 1 && auction.currentBid > 0) { aiActing = false; return; }

        const currentId = activeBidders[auction.currentAuctionIndex % activeBidders.length];
        const playerIndex = gameState.players.findIndex(p => p.id === currentId);

        if (!(playerIndex in aiPlayers)) { aiActing = false; return; }

        console.log(`[AI] Player ${playerIndex} bidding in auction`);
        setTimeout(() => handleAuctionTurn(playerIndex), THINK_DELAY);
    }

    // ─── Polling loop ─────────────────────────────────────────────────────────

    function startPolling() {
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(() => {
            if (aiActing) return;
            if (!gameState || !gameState.players || gameState.players.length === 0) return;

            const activePlayers = gameState.players.filter(p => !p.isBankrupt);
            if (activePlayers.length <= 1) return;

            if (gameState.auction && gameState.auction.active) {
                const auction = gameState.auction;
                const activeBidders = auction.participatingPlayers.filter(
                    id => !auction.passedPlayers.includes(id)
                );
                if (activeBidders.length > 0) {
                    const currentId = activeBidders[auction.currentAuctionIndex % activeBidders.length];
                    const playerIndex = gameState.players.findIndex(p => p.id === currentId);
                    if (playerIndex in aiPlayers) {
                        takeTurn();
                    }
                }
                return;
            }

            const idx = gameState.currentPlayerIndex;
            if (!(idx in aiPlayers)) return;
            if (gameState.players[idx].isBankrupt) return;

            const actionablePhases = ['ROLL_DICE', 'PROPERTY_DECISION', 'END_TURN'];
            if (actionablePhases.includes(gameState.phase)) {
                takeTurn();
            }
        }, POLL_MS);
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    async function init(config, modelBasePath = 'models/') {
        aiPlayers = {};
        aiActing = false;
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }

        const difficultiesToLoad = new Set();
        config.forEach((difficulty, playerIndex) => {
            if (difficulty) {
                aiPlayers[playerIndex] = difficulty;
                difficultiesToLoad.add(difficulty);
            }
        });

        if (difficultiesToLoad.size === 0) {
            console.log('[AI] No AI players configured.');
            return;
        }

        const loadPromises = [...difficultiesToLoad].map(async diff => {
            try {
                models[diff] = await NEATRunner.loadModel(`${modelBasePath}${diff}.json`);
                console.log(`[AI] ✅ Loaded model: ${diff} (fitness: ${models[diff].fitness.toFixed(0)})`);
            } catch (e) {
                console.error(`[AI] ❌ Failed to load model: ${diff}`, e);
            }
        });

        await Promise.all(loadPromises);
        console.log('[AI] 🤖 Ready. Players:', aiPlayers);
        startPolling();
    }

    function isAI(playerIndex) {
        return playerIndex in aiPlayers;
    }

    return { init, isAI, getDecision, buildInputs };
})();
