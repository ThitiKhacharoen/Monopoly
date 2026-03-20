/**
 * ai-player.js
 * Integrates NEAT AI into game.html.
 *
 * Depends on: neat-runner.js (must be loaded first)
 * Depends on: game.html globals — gameState, SPACES, rollDice(), buyProperty(),
 *             passProperty(), endTurn(), placeBid(), passAuction()
 *
 * Usage: After including both scripts in game.html, call:
 *   AIPlayer.init(['easy', null, 'hard', null])
 *   // Array index = player index, value = difficulty or null for human
 */

const AIPlayer = (() => {

    // Loaded models keyed by difficulty
    const models = {};

    // Which player indices are AI, and what difficulty
    // e.g. { 1: 'easy', 2: 'hard' }
    let aiPlayers = {};

    // Delay in ms between AI actions (makes it watchable)
    const ACTION_DELAY = 800;
    const THINK_DELAY = 400;

    // Color group order must match Python COLOR_GROUPS iteration order
    // From monopoly_engine.py COLOR_GROUPS (dict insertion order, Python 3.7+)
    const COLOR_GROUP_ORDER = [
        'brown',
        'light-blue',
        'pink',
        'orange',
        'red',
        'yellow',
        'green',
        'dark-blue',
        'railroad',
        'utility',
    ];

    // Map color name → property IDs (matches SPACES in game.html)
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

    /**
     * Build the 47-input vector for the current player, matching Python get_nn_inputs().
     */
    function buildInputs(playerIndex) {
        const player = gameState.players[playerIndex];
        const activePlayers = gameState.players.filter(p => !p.isBankrupt);

        // Total net worth across all active players
        let totalNW = 0;
        activePlayers.forEach(p => {
            totalNW += p.cash;
            p.properties.forEach(pid => {
                const space = SPACES[pid];
                totalNW += space.price;
                const ownership = gameState.ownedProperties[pid];
                if (ownership) {
                    totalNW += ownership.houses * (space.houseCost || 0);
                    if (ownership.hasHotel) totalNW += (space.houseCost || 0);
                }
            });
        });
        totalNW = Math.max(1, totalNW);

        // Player net worth
        let playerNW = player.cash;
        player.properties.forEach(pid => {
            const space = SPACES[pid];
            playerNW += space.price;
            const ownership = gameState.ownedProperties[pid];
            if (ownership) {
                playerNW += ownership.houses * (space.houseCost || 0);
                if (ownership.hasHotel) playerNW += (space.houseCost || 0);
            }
        });

        const inputs = [];

        // --- Player state (8 inputs) ---
        inputs.push(Math.min(1.0, player.cash / 2000.0));                          // cash normalized
        inputs.push(player.position / 40.0);                                        // board position
        inputs.push(player.inJail ? 1.0 : 0.0);                                    // in jail
        inputs.push((player.jailTurns || 0) / 3.0);                               // jail turns
        inputs.push(Math.min(1.0, (player.getOutOfJailFreeCards || 0) / 2.0));    // gojf cards
        inputs.push(playerNW / totalNW);                                            // wealth ratio
        inputs.push(player.properties.length / 28.0);                              // properties owned ratio

        // game progress — use a rough estimate from turn count
        // gameState doesn't track turns directly, use properties on board as proxy
        const totalPropsOwned = Object.keys(gameState.ownedProperties).length;
        inputs.push(Math.min(1.0, totalPropsOwned / 28.0));                        // game progress proxy

        // --- Property ownership per color group (10 groups × 2 = 20 inputs) ---
        for (const color of COLOR_GROUP_ORDER) {
            const group = COLOR_GROUP_PROPS[color];
            const owned = group.filter(pid => {
                const o = gameState.ownedProperties[pid];
                return o && o.ownerId === player.id;
            }).length;
            inputs.push(owned / group.length);  // my ownership ratio

            // monopoly flag
            const hasMonopoly = group.every(pid => {
                const o = gameState.ownedProperties[pid];
                return o && o.ownerId === player.id;
            });
            inputs.push(hasMonopoly ? 1.0 : 0.0);
        }

        // --- Buildings (10 groups × 1 = 10 inputs, railroad/utility = 0) ---
        for (const color of COLOR_GROUP_ORDER) {
            if (color === 'railroad' || color === 'utility') {
                inputs.push(0.0);
                continue;
            }
            const group = COLOR_GROUP_PROPS[color];
            const myProps = group.filter(pid => {
                const o = gameState.ownedProperties[pid];
                return o && o.ownerId === player.id;
            });
            let avgHouses = 0.0;
            if (myProps.length > 0) {
                const totalHouses = myProps.reduce((sum, pid) => {
                    const o = gameState.ownedProperties[pid];
                    if (!o) return sum;
                    return sum + (o.hasHotel ? 5 : (o.houses || 0));
                }, 0);
                avgHouses = totalHouses / (myProps.length * 5.0);
            }
            inputs.push(avgHouses);
        }

        // --- Opponents aggregate (up to 3 × 3 = 9 inputs) ---
        const opponents = activePlayers.filter(p => p.id !== player.id).slice(0, 3);
        for (let i = 0; i < 3; i++) {
            if (i < opponents.length) {
                const opp = opponents[i];
                let oppNW = opp.cash;
                opp.properties.forEach(pid => {
                    const space = SPACES[pid];
                    oppNW += space.price;
                    const o = gameState.ownedProperties[pid];
                    if (o) {
                        oppNW += o.houses * (space.houseCost || 0);
                        if (o.hasHotel) oppNW += (space.houseCost || 0);
                    }
                });
                inputs.push(Math.min(1.0, opp.cash / 2000.0));
                inputs.push(oppNW / totalNW);
                inputs.push(opp.properties.length / 28.0);
            } else {
                inputs.push(0.0, 0.0, 0.0);
            }
        }

        // Should be exactly 47
        if (inputs.length !== 47) {
            console.error(`AI input vector length is ${inputs.length}, expected 47`);
        }

        return inputs;
    }

    /**
     * Get AI decision outputs for the current player.
     * Returns { buyProperty, auctionBidRatio, buildHouse, tradeAggression, acceptTradeThreshold }
     */
    function getDecision(playerIndex) {
        const player = gameState.players[playerIndex];
        const difficulty = aiPlayers[playerIndex];
        const model = models[difficulty];

        if (!model) {
            console.warn(`No model loaded for difficulty: ${difficulty}`);
            return null;
        }

        const inputs = buildInputs(playerIndex);
        const outputs = NEATRunner.activate(model, inputs);

        return {
            buyProperty: outputs[0],          // >0.5 = buy
            auctionBidRatio: outputs[1],      // 0-1, multiply by cash for bid
            buildHouse: outputs[2],            // >0.5 = build
            tradeAggression: outputs[3],
            acceptTradeThreshold: outputs[4],
        };
    }

    /**
     * Main AI turn handler. Called after updateUI() detects it's an AI turn.
     */
    function takeTurn() {
        const idx = gameState.currentPlayerIndex;
        if (!(idx in aiPlayers)) return; // Not an AI player
        if (gameState.players[idx].isBankrupt) return;

        const phase = gameState.phase;

        if (phase === 'ROLL_DICE') {
            setTimeout(() => {
                rollDice();
                // After rolling, check again (might open a modal)
                setTimeout(takeTurn, ACTION_DELAY);
            }, THINK_DELAY);

        } else if (phase === 'PROPERTY_DECISION') {
            setTimeout(() => {
                const decision = getDecision(idx);
                const space = SPACES[gameState.pendingProperty];
                const player = gameState.players[idx];

                // Also check affordability — don't buy if can't afford
                const shouldBuy = decision && decision.buyProperty > 0.5 && player.cash >= space.price;

                if (shouldBuy) {
                    buyProperty();
                } else {
                    passProperty();
                }
                setTimeout(takeTurn, ACTION_DELAY);
            }, THINK_DELAY);

        } else if (phase === 'END_TURN') {
            // Optionally build houses before ending turn
            setTimeout(() => {
                tryBuildHouses(idx);
                setTimeout(() => {
                    endTurn();
                }, THINK_DELAY);
            }, THINK_DELAY);

        }
        // PAY_RENT is resolved automatically by game.html — no AI action needed
    }

    /**
     * Try to build houses if AI has monopoly and decision says to build.
     */
    function tryBuildHouses(playerIndex) {
        const decision = getDecision(playerIndex);
        if (!decision || decision.buildHouse <= 0.5) return;

        const player = gameState.players[playerIndex];

        for (const color of COLOR_GROUP_ORDER) {
            if (color === 'railroad' || color === 'utility') continue;

            const group = COLOR_GROUP_PROPS[color];
            const hasAllProps = group.every(pid => {
                const o = gameState.ownedProperties[pid];
                return o && o.ownerId === player.id;
            });

            if (!hasAllProps) continue;

            // Find a property in this group that can have a house built
            for (const pid of group) {
                const o = gameState.ownedProperties[pid];
                const space = SPACES[pid];
                if (!o || o.isMortgaged || o.hasHotel || o.houses >= 4) continue;
                if (player.cash < space.houseCost) continue;

                buildHouse(pid);
                return; // Build one at a time, let game update
            }
        }
    }

    /**
     * Handle AI auction bidding. Called when auction modal is active and it's AI's turn.
     */
    function handleAuctionTurn(playerIndex) {
        if (!(playerIndex in aiPlayers)) return;

        const decision = getDecision(playerIndex);
        const player = gameState.players[playerIndex];

        if (!decision) {
            passAuction();
            return;
        }

        const space = SPACES[gameState.auction.propertyId];
        const maxBid = Math.floor(player.cash * Math.max(0.1, decision.auctionBidRatio));
        const minBid = gameState.auction.currentBid + 1;

        if (maxBid >= minBid && maxBid <= player.cash) {
            // Place bid
            document.getElementById('auctionBidInput').value = maxBid;
            setTimeout(() => placeBid(), THINK_DELAY);
        } else {
            setTimeout(() => passAuction(), THINK_DELAY);
        }
    }

    /**
     * Initialize AI players.
     * @param {Array} config - Array indexed by player index, value = 'easy'|'medium'|'hard'|null
     * @param {string} modelBasePath - Base path to model JSON files (default: 'models/')
     */
    async function init(config, modelBasePath = 'models/') {
        aiPlayers = {};
        const difficultiesToLoad = new Set();

        config.forEach((difficulty, playerIndex) => {
            if (difficulty) {
                aiPlayers[playerIndex] = difficulty;
                difficultiesToLoad.add(difficulty);
            }
        });

        // Load required models
        const loadPromises = [...difficultiesToLoad].map(async diff => {
            try {
                models[diff] = await NEATRunner.loadModel(`${modelBasePath}${diff}.json`);
                console.log(`✅ Loaded AI model: ${diff} (fitness: ${models[diff].fitness.toFixed(0)})`);
            } catch (e) {
                console.error(`❌ Failed to load model: ${diff}`, e);
            }
        });

        await Promise.all(loadPromises);
        console.log(`🤖 AI ready. Players:`, aiPlayers);

        // Patch updateUI to trigger AI turns
        patchGame();
    }

    /**
     * Patch game.html functions to trigger AI turns automatically.
     */
    function patchGame() {
        // Patch updateUI to check if it's an AI's turn after every state update
        const originalUpdateUI = window.updateUI;
        window.updateUI = function() {
            originalUpdateUI.apply(this, arguments);
            checkAITurn();
        };

        // Patch updateAuctionUI to handle AI auction turns
        const originalUpdateAuctionUI = window.updateAuctionUI;
        window.updateAuctionUI = function() {
            originalUpdateAuctionUI.apply(this, arguments);
            checkAIAuctionTurn();
        };
    }

    /**
     * Check if current player is AI and trigger their turn.
     */
    function checkAITurn() {
        const idx = gameState.currentPlayerIndex;
        if (!(idx in aiPlayers)) return;
        if (gameState.players[idx].isBankrupt) return;

        // Don't trigger during auction (handled separately)
        if (gameState.auction && gameState.auction.active) return;

        // Only trigger on actionable phases
        const actionablePhases = ['ROLL_DICE', 'PROPERTY_DECISION', 'END_TURN'];
        if (actionablePhases.includes(gameState.phase)) {
            takeTurn();
        }
    }

    /**
     * Check if current auction bidder is AI and handle their bid.
     */
    function checkAIAuctionTurn() {
        if (!gameState.auction || !gameState.auction.active) return;

        const activePlayers = gameState.auction.participatingPlayers.filter(
            id => !gameState.auction.passedPlayers.includes(id)
        );

        if (activePlayers.length === 0) return;
        if (activePlayers.length === 1 && gameState.auction.currentBid > 0) return;

        const currentPlayerId = activePlayers[gameState.auction.currentAuctionIndex % activePlayers.length];
        const playerIndex = gameState.players.findIndex(p => p.id === currentPlayerId);

        if (playerIndex in aiPlayers) {
            setTimeout(() => handleAuctionTurn(playerIndex), ACTION_DELAY);
        }
    }

    /**
     * Check if a given player index is an AI.
     */
    function isAI(playerIndex) {
        return playerIndex in aiPlayers;
    }

    return { init, isAI, getDecision, buildInputs };
})();
