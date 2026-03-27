/**
 * ai-player.js
 * Integrates NEAT AI into game.html via polling.
 *
 * Depends on: neat-runner.js
 * Depends on: game.html globals — gameState, SPACES, rollDice(), buyProperty(),
 *             passProperty(), endTurn(), placeBid(), passAuction(), buildHouse()
 */

const AIPlayer = (() => {

    const models = {};
    let aiPlayers = {};

    let aiActing = false;  // Re-entrancy guard
    let pollInterval = null;

    const ACTION_DELAY = 1200;  // ms between actions (watchable pace)
    const THINK_DELAY  = 800;   // ms "thinking" before acting
    const POLL_MS      = 500;   // polling interval — must be > ACTION_DELAY to avoid double-fire

    const COLOR_GROUP_ORDER = [
        'brown', 'light-blue', 'pink', 'orange', 'red',
        'yellow', 'green', 'dark-blue', 'railroad', 'utility',
    ];

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

    // ─── Input builder ────────────────────────────────────────────────────────

    function buildInputs(playerIndex) {
        const player = gameState.players[playerIndex];
        const activePlayers = gameState.players.filter(p => !p.isBankrupt);

        let totalNW = 0;
        activePlayers.forEach(p => {
            totalNW += p.cash;
            p.properties.forEach(pid => {
                const space = SPACES[pid];
                if (!space) return;
                totalNW += space.price || 0;
                const o = gameState.ownedProperties[pid];
                if (o) {
                    totalNW += (o.houses || 0) * (space.houseCost || 0);
                    if (o.hasHotel) totalNW += (space.houseCost || 0);
                }
            });
        });
        totalNW = Math.max(1, totalNW);

        let playerNW = player.cash;
        player.properties.forEach(pid => {
            const space = SPACES[pid];
            if (!space) return;
            playerNW += space.price || 0;
            const o = gameState.ownedProperties[pid];
            if (o) {
                playerNW += (o.houses || 0) * (space.houseCost || 0);
                if (o.hasHotel) playerNW += (space.houseCost || 0);
            }
        });

        const inputs = [];
        inputs.push(Math.min(1.0, player.cash / 2000.0));
        inputs.push(player.position / 40.0);
        inputs.push(player.inJail ? 1.0 : 0.0);
        inputs.push((player.jailTurns || 0) / 3.0);
        inputs.push(Math.min(1.0, (player.getOutOfJailFreeCards || 0) / 2.0));
        inputs.push(playerNW / totalNW);
        inputs.push(player.properties.length / 28.0);
        inputs.push(Math.min(1.0, Object.keys(gameState.ownedProperties).length / 28.0));

        for (const color of COLOR_GROUP_ORDER) {
            const group = COLOR_GROUP_PROPS[color];
            const owned = group.filter(pid => {
                const o = gameState.ownedProperties[pid];
                return o && o.ownerId === player.id;
            }).length;
            inputs.push(owned / group.length);
            const hasMonopoly = group.every(pid => {
                const o = gameState.ownedProperties[pid];
                return o && o.ownerId === player.id;
            });
            inputs.push(hasMonopoly ? 1.0 : 0.0);
        }

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

        const opponents = activePlayers.filter(p => p.id !== player.id).slice(0, 3);
        for (let i = 0; i < 3; i++) {
            if (i < opponents.length) {
                const opp = opponents[i];
                let oppNW = opp.cash;
                opp.properties.forEach(pid => {
                    const space = SPACES[pid];
                    if (!space) return;
                    oppNW += space.price || 0;
                    const o = gameState.ownedProperties[pid];
                    if (o) {
                        oppNW += (o.houses || 0) * (space.houseCost || 0);
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

        if (inputs.length !== 47) {
            console.error(`[AI] Input vector length ${inputs.length}, expected 47`);
        }
        return inputs;
    }

    // ─── Decision ─────────────────────────────────────────────────────────────

    function getDecision(playerIndex) {
        const difficulty = aiPlayers[playerIndex];
        const model = models[difficulty];
        if (!model) return null;
        const inputs = buildInputs(playerIndex);
        const outputs = NEATRunner.activate(model, inputs);
        return {
            buyProperty:          outputs[0],
            auctionBidRatio:      outputs[1],
            buildHouse:           outputs[2],
            tradeAggression:      outputs[3],
            acceptTradeThreshold: outputs[4],
        };
    }

    // ─── House building ───────────────────────────────────────────────────────

    function tryBuildHouses(playerIndex) {
        const decision = getDecision(playerIndex);
        if (!decision || decision.buildHouse <= 0.5) return;
        const player = gameState.players[playerIndex];
        for (const color of COLOR_GROUP_ORDER) {
            if (color === 'railroad' || color === 'utility') continue;
            const group = COLOR_GROUP_PROPS[color];
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


    // ─── Trade logic ──────────────────────────────────────────────────────────

    function tryInitiateTrade(playerIndex) {
        const decision = getDecision(playerIndex);
        if (!decision || decision.tradeAggression <= 0.5) return;

        const player = gameState.players[playerIndex];
        if (player.properties.length === 0) return;

        // Find best trade partner — prefer players with properties we want
        const partners = gameState.players.filter(p => !p.isBankrupt && p.id !== player.id && p.properties.length > 0);
        if (partners.length === 0) return;

        // Pick a random partner weighted by their property count
        const partner = partners[Math.floor(Math.random() * partners.length)];
        const partnerIndex = gameState.players.indexOf(partner);

        // Use MCTS to evaluate whether a trade is beneficial
        // Try offering one of our properties for one of theirs
        if (partner.properties.length === 0 || player.properties.length === 0) return;

        const ourProp = player.properties[Math.floor(Math.random() * player.properties.length)];
        const theirProp = partner.properties[Math.floor(Math.random() * partner.properties.length)];

        // Skip if either property has houses — too complex
        const ourOwn = gameState.ownedProperties[ourProp];
        const theirOwn = gameState.ownedProperties[theirProp];
        if (!ourOwn || !theirOwn) return;
        if (ourOwn.houses > 0 || ourOwn.hasHotel) return;
        if (theirOwn.houses > 0 || theirOwn.hasHotel) return;

        // Evaluate trade via MCTS
        const simState = MonopolySim.fromGameState(gameState, playerIndex);
        const ourPropSim = SPACES[ourProp];
        const theirPropSim = SPACES[theirProp];

        const best = MonopolySim.mctsDecide(simState, playerIndex, [
            {
                label: 'trade',
                applyFn: (s, pid) => {
                    const partnerSimIdx = gameState.players.findIndex(p => p.id === partner.id);
                    // Remove ourProp from us, give to partner
                    s.players[pid].props = s.players[pid].props.filter(p => p !== ourProp);
                    s.players[partnerSimIdx].props.push(ourProp);
                    if (s.owned[ourProp]) s.owned[ourProp].owner = partnerSimIdx;
                    // Remove theirProp from partner, give to us
                    s.players[partnerSimIdx].props = s.players[partnerSimIdx].props.filter(p => p !== theirProp);
                    s.players[pid].props.push(theirProp);
                    if (s.owned[theirProp]) s.owned[theirProp].owner = pid;
                }
            },
            { label: 'skip', applyFn: (s, pid) => {} }
        ], { rounds: mctsRounds(playerIndex), rollouts: 10, neatEval: neatEvaluator(playerIndex) });

        if (best !== 'trade') return;

        // Execute trade via the trade modal programmatically
        console.log(`[AI] Player ${playerIndex} initiating trade: ${SPACES[ourProp].name} for ${SPACES[theirProp].name}`);

        // Set up trade state directly and propose
        tradeState.player1SelectedProps = [ourProp];
        tradeState.player2SelectedProps = [theirProp];
        tradeState.player1SelectedGoojf = [];
        tradeState.player2SelectedGoojf = [];
        tradeState.partnerId = partner.id;

        // Set the partner select value
        const partnerSelect = document.getElementById('tradePartnerSelect');
        if (partnerSelect) partnerSelect.value = partner.id;

        document.getElementById('tradePlayer1CashOffer').value = 0;
        document.getElementById('tradePlayer2CashRequest').value = 0;

        // Auto-accept for AI partner, show confirm for human partner
        const partnerIsAI = partnerIndex in aiPlayers;
        if (partnerIsAI) {
            // AI partner: evaluate from their perspective too
            const partnerSimState = MonopolySim.fromGameState(gameState, partnerIndex);
            const partnerBest = MonopolySim.mctsDecide(partnerSimState, partnerIndex, [
                {
                    label: 'accept',
                    applyFn: (s, pid) => {
                        const ourSimIdx = gameState.players.findIndex(p => p.id === player.id);
                        s.players[pid].props = s.players[pid].props.filter(p => p !== theirProp);
                        s.players[ourSimIdx].props.push(theirProp);
                        if (s.owned[theirProp]) s.owned[theirProp].owner = ourSimIdx;
                        s.players[ourSimIdx].props = s.players[ourSimIdx].props.filter(p => p !== ourProp);
                        s.players[pid].props.push(ourProp);
                        if (s.owned[ourProp]) s.owned[ourProp].owner = pid;
                    }
                },
                { label: 'reject', applyFn: (s, pid) => {} }
            ], { rounds: mctsRounds(partnerIndex), rollouts: 10, neatEval: neatEvaluator(partnerIndex) });

            if (partnerBest === 'accept') {
                // Both AI players agree — execute directly
                tradeState.pendingP1 = player;
                tradeState.pendingP2 = partner;
                tradeState.pendingCashOffer = 0;
                tradeState.pendingCashRequest = 0;
                executeTrade(player, partner, 0, 0);
                console.log(`[AI] Trade auto-accepted by AI partner ${partnerIndex}`);
            } else {
                console.log(`[AI] Trade rejected by AI partner ${partnerIndex}`);
            }
        } else {
            // Human partner: show the confirm modal
            tradeState.pendingP1 = player;
            tradeState.pendingP2 = partner;
            tradeState.pendingCashOffer = 0;
            tradeState.pendingCashRequest = 0;

            const tradeDesc = buildTradeDescription(player, partner, 0, 0);
            document.getElementById('tradeConfirmDesc').textContent =
                `${partner.name}, do you accept this trade?\n\n` + tradeDesc;
            document.getElementById('tradeConfirmModal').classList.add('active');
        }
    }

    // Handle AI response to incoming trade proposals (human proposes to AI)
    let handlingTradeProposal = false;
    function handleIncomingTradeProposal() {
        if (handlingTradeProposal) return;
        const confirmModal = document.getElementById('tradeConfirmModal');
        if (!confirmModal || !confirmModal.classList.contains('active')) return;
        if (!tradeState.pendingP2) return;

        const recipientId = tradeState.pendingP2.id;
        const recipientIndex = gameState.players.findIndex(p => p.id === recipientId);
        if (!(recipientIndex in aiPlayers)) return;

        handlingTradeProposal = true;

        // AI evaluates the trade
        const simState = MonopolySim.fromGameState(gameState, recipientIndex);
        const p1Props = tradeState.player1SelectedProps || [];
        const p2Props = tradeState.player2SelectedProps || [];
        const cashOffer = tradeState.pendingCashOffer || 0;
        const cashRequest = tradeState.pendingCashRequest || 0;
        const senderIndex = gameState.players.findIndex(p => p.id === tradeState.pendingP1?.id);

        const best = MonopolySim.mctsDecide(simState, recipientIndex, [
            {
                label: 'accept',
                applyFn: (s, pid) => {
                    s.players[pid].cash += cashOffer - cashRequest;
                    if (senderIndex >= 0) s.players[senderIndex].cash += cashRequest - cashOffer;
                    p2Props.forEach(propId => {
                        s.players[pid].props = s.players[pid].props.filter(p => p !== propId);
                        if (senderIndex >= 0) { s.players[senderIndex].props.push(propId); if(s.owned[propId]) s.owned[propId].owner = senderIndex; }
                    });
                    p1Props.forEach(propId => {
                        if (senderIndex >= 0) s.players[senderIndex].props = s.players[senderIndex].props.filter(p => p !== propId);
                        s.players[pid].props.push(propId);
                        if (s.owned[propId]) s.owned[propId].owner = pid;
                    });
                }
            },
            { label: 'reject', applyFn: (s, pid) => {} }
        ], { rounds: mctsRounds(recipientIndex), rollouts: 10, neatEval: neatEvaluator(recipientIndex) });

        console.log(`[AI] Player ${recipientIndex} ${best}s incoming trade`);
        setTimeout(() => {
            if (best === 'accept') {
                acceptTrade();
            } else {
                rejectTrade();
            }
            handlingTradeProposal = false;
        }, THINK_DELAY);
    }

    // ─── Auction ──────────────────────────────────────────────────────────────

    function handleAuctionTurn(playerIndex) {
        const decision = getDecision(playerIndex);
        const player = gameState.players[playerIndex];

        // No model or can't afford minimum — pass
        if (!decision) {
            passAuction();
            aiActing = false;
            return;
        }

        const maxBid = Math.floor(player.cash * Math.max(0.1, decision.auctionBidRatio));
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
        // Set acting flag SYNCHRONOUSLY before any setTimeout
        // This prevents the poll from firing again before the action runs
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
                // Re-validate — state may have changed during think delay
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
                tryInitiateTrade(idx);
                setTimeout(() => {
                    // Re-validate before ending turn
                    if (gameState.phase === 'END_TURN') {
                        console.log(`[AI] Player ${idx} ending turn`);
                        endTurn();
                    }
                    aiActing = false;
                }, 400);
            }, THINK_DELAY);

        } else {
            // PAY_RENT or other phases handled automatically by game — just release lock
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

            // Check for incoming trade proposals directed at an AI player
            handleIncomingTradeProposal();

            const activePlayers = gameState.players.filter(p => !p.isBankrupt);
            if (activePlayers.length <= 1) return;

            // Auction check
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
