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

    const MCTS_ROLLOUTS = 15;
    const MCTS_ROUNDS_BY_DIFF = { easy:7, medium:10, hard:15 };
    function useMCTS(pi) { return MCTS_ROUNDS_BY_DIFF[aiPlayers[pi]] > 0; }
    function mctsRounds(pi) { return MCTS_ROUNDS_BY_DIFF[aiPlayers[pi]] || 7; }

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

    // ─── Input builder (118 inputs — matches Python get_nn_inputs) ────────────

    const PROPERTY_IDS  = [1,3,5,6,8,9,11,12,13,14,15,16,18,19,21,23,24,25,26,27,28,29,31,32,34,35,37,39];
    const BUILDABLE_IDS = [1,3,6,8,9,11,13,14,16,18,19,21,23,24,26,27,29,31,32,34,37,39];

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
                inputs.push(Math.min(1.0, (p.getOutOfJailFreeCards?.length || 0) / 2.0));
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

        // 22 buildable × 1 = 22 (houses/hotel level)
        for (const pid of BUILDABLE_IDS) {
            const own = gameState.ownedProperties[pid];
            if (own && own.ownerId === player.id) {
                inputs.push((own.hasHotel ? 5 : (own.houses || 0)) / 5.0);
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
            buyProperty:     outputs[0],
            bidRatio:        outputs[1],
            buildHouse:      outputs[2],
            sellHouse:       outputs[3],
            mortgage:        outputs[4],
            unmortgage:      outputs[5],
            tradeAggression: outputs[6],
            jailDecision:    outputs[7],
        };
    }

    // ─── NEAT value evaluator for MCTS ────────────────────────────────────────

    function neatEvaluator(playerIndex) {
        return function(simState, pid) {
            const player = simState.players[pid];
            const allPlayers = [player, ...simState.players.filter(p=>p.id!==pid)];
            const inputs = [];
            for (let i=0;i<4;i++) {
                const p = allPlayers[i];
                if (p) { inputs.push(p.pos/40, Math.min(1,p.cash/2000), Math.min(1,p.gojf/2)); }
                else   { inputs.push(0,0,0); }
            }
            const PROP_IDS=[1,3,5,6,8,9,11,12,13,14,15,16,18,19,21,23,24,25,26,27,28,29,31,32,34,35,37,39];
            const BUILD_IDS=[1,3,6,8,9,11,13,14,16,18,19,21,23,24,26,27,29,31,32,34,37,39];
            for (const propId of PROP_IDS) {
                const own = simState.owned[propId];
                if (!own) { inputs.push(0,0); }
                else {
                    inputs.push(own.owner===pid ? 1 : Math.max(-1,-(own.owner+1)/3));
                    inputs.push(own.mortgaged?1:0);
                }
            }
            for (const propId of BUILD_IDS) {
                const own = simState.owned[propId];
                inputs.push((own&&own.owner===pid)?(own.hotel?1:(own.houses||0)/5):0);
            }
            for (const propId of PROP_IDS) {
                const own = simState.owned[propId];
                const price = (SPACES[propId]&&SPACES[propId].price)||0;
                inputs.push((!own && simState.players[pid].cash>=price)?1:0);
            }
            const clamped = inputs.map(x=>Math.max(-1,Math.min(1,x)));
            const model = models[aiPlayers[playerIndex]];
            if (!model) return MonopolySim.evaluate(simState, pid, null);
            const outputs = NEATRunner.activate(model, clamped);
            const nw = MonopolySim.evaluate(simState, pid, null);
            return nw * 0.7 + (outputs[0] > 0.5 ? 0.3 : 0.0);
        };
    }

    function mctsBuyDecision(playerIndex, propId) {
        const sp = SPACES[propId];
        const player = gameState.players[playerIndex];
        if (!sp || player.cash < sp.price) return false;
        const simState = MonopolySim.fromGameState(gameState, playerIndex);
        const best = MonopolySim.mctsDecide(simState, playerIndex, [
            { label:'buy',  applyFn:(s,pid)=>{ s.players[pid].cash-=sp.price; s.players[pid].props.push(propId); s.owned[propId]={owner:pid,houses:0,hotel:false,mortgaged:false}; } },
            { label:'pass', applyFn:(s,pid)=>{} }
        ], { rounds:mctsRounds(playerIndex), rollouts:MCTS_ROLLOUTS, neatEval:neatEvaluator(playerIndex) });
        return best === 'buy';
    }

    function mctsBidAmount(playerIndex) {
        const player = gameState.players[playerIndex];
        const propId = gameState.auction?.propertyId;
        const sp = propId != null ? SPACES[propId] : null;
        if (!sp) return 0;
        const minBid = (gameState.auction.currentBid || 0) + 1;
        const candidates = [...new Set([minBid, Math.floor(sp.price*0.7), sp.price, Math.floor(sp.price*1.2)])].filter(b=>b>=minBid&&b<=player.cash);
        if (!candidates.length) return 0;
        const simState = MonopolySim.fromGameState(gameState, playerIndex);
        const actions = [
            { label:'pass', applyFn:(s,pid)=>{} },
            ...candidates.map(bid=>({ label:`bid_${bid}`, applyFn:(s,pid)=>{ s.players[pid].cash-=bid; s.players[pid].props.push(propId); s.owned[propId]={owner:pid,houses:0,hotel:false,mortgaged:false}; } }))
        ];
        const best = MonopolySim.mctsDecide(simState, playerIndex, actions, { rounds:mctsRounds(playerIndex), rollouts:MCTS_ROLLOUTS, neatEval:neatEvaluator(playerIndex) });
        if (best==='pass') return 0;
        return parseInt(best.replace('bid_',''));
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

    // ─── Auction ──────────────────────────────────────────────────────────────

    function handleAuctionTurn(playerIndex) {
        const player = gameState.players[playerIndex];
        const minBid = (gameState.auction.currentBid||0)+1;
        const bidAmount = mctsBidAmount(playerIndex);
        if (bidAmount >= minBid && bidAmount <= player.cash) {
            const input = document.getElementById('auctionBidInput');
            if (input) input.value = bidAmount;
            setTimeout(() => { placeBid(); aiActing = false; }, THINK_DELAY);
        } else {
            setTimeout(() => { passAuction(); aiActing = false; }, THINK_DELAY);
        }
    }

    // ─── Main turn logic ──────────────────────────────────────────────────────

    function takeTurn() {
        aiActing = true;

        // Handle auction first — currentPlayerIndex may be a human during AI auction
        if (gameState.auction && gameState.auction.active) {
            handleAuctionPhase();
            return;
        }

        const idx = gameState.currentPlayerIndex;

        if (!(idx in aiPlayers) || !gameState.players[idx] || gameState.players[idx].isBankrupt) {
            aiActing = false;
            return;
        }

        const phase = gameState.phase;

        if (phase === 'ROLL_DICE') {
            setTimeout(() => {
                console.log(`[AI] Player ${idx} (${aiPlayers[idx]}) rolling dice`);
                rollDice();
                // Do NOT release aiActing here — rollDice is async.
                // The polling loop's lastPhase check will release it
                // once the phase changes away from ROLL_DICE.
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

                const player = gameState.players[idx];
                const shouldBuy = player.cash >= (space.price || 0) && mctsBuyDecision(idx, gameState.pendingProperty);
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

    // ─── Trade logic ──────────────────────────────────────────────────────────

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

        const p1Props = tradeState.player1SelectedProps || [];
        const p2Props = tradeState.player2SelectedProps || [];
        const cashOffer = tradeState.pendingCashOffer || 0;
        const cashRequest = tradeState.pendingCashRequest || 0;
        const senderIndex = gameState.players.findIndex(p => p.id === tradeState.pendingP1?.id);
        const simState = MonopolySim.fromGameState(gameState, recipientIndex);

        const best = MonopolySim.mctsDecide(simState, recipientIndex, [
            {
                label: 'accept',
                applyFn: (s, pid) => {
                    s.players[pid].cash += cashOffer - cashRequest;
                    if (senderIndex >= 0) s.players[senderIndex].cash += cashRequest - cashOffer;
                    p2Props.forEach(propId => {
                        s.players[pid].props = s.players[pid].props.filter(p=>p!==propId);
                        if (senderIndex>=0) { s.players[senderIndex].props.push(propId); if(s.owned[propId]) s.owned[propId].owner=senderIndex; }
                    });
                    p1Props.forEach(propId => {
                        if (senderIndex>=0) s.players[senderIndex].props = s.players[senderIndex].props.filter(p=>p!==propId);
                        s.players[pid].props.push(propId);
                        if (s.owned[propId]) s.owned[propId].owner = pid;
                    });
                }
            },
            { label:'reject', applyFn:(s,pid)=>{} }
        ], { rounds:mctsRounds(recipientIndex), rollouts:10, neatEval:neatEvaluator(recipientIndex) });

        console.log(`[AI] Player ${recipientIndex} ${best}s incoming trade`);
        setTimeout(() => {
            best === 'accept' ? acceptTrade() : rejectTrade();
            handlingTradeProposal = false;
        }, THINK_DELAY);
    }

    function tryInitiateTrade(playerIndex) {
        const decision = getDecision(playerIndex);
        if (!decision || decision.tradeAggression <= 0.5) return;
        const player = gameState.players[playerIndex];
        if (player.properties.length === 0) return;
        const partners = gameState.players.filter(p=>!p.isBankrupt&&p.id!==player.id&&p.properties.length>0);
        if (!partners.length) return;
        const partner = partners[Math.floor(Math.random()*partners.length)];
        const partnerIndex = gameState.players.indexOf(partner);
        if (!partner.properties.length || !player.properties.length) return;
        const ourProp = player.properties[Math.floor(Math.random()*player.properties.length)];
        const theirProp = partner.properties[Math.floor(Math.random()*partner.properties.length)];
        const ourOwn = gameState.ownedProperties[ourProp];
        const theirOwn = gameState.ownedProperties[theirProp];
        if (!ourOwn||!theirOwn||ourOwn.houses>0||ourOwn.hasHotel||theirOwn.houses>0||theirOwn.hasHotel) return;

        const simState = MonopolySim.fromGameState(gameState, playerIndex);
        const best = MonopolySim.mctsDecide(simState, playerIndex, [
            { label:'trade', applyFn:(s,pid)=>{ const pi=gameState.players.findIndex(p=>p.id===partner.id); s.players[pid].props=s.players[pid].props.filter(p=>p!==ourProp); s.players[pi].props.push(ourProp); if(s.owned[ourProp])s.owned[ourProp].owner=pi; s.players[pi].props=s.players[pi].props.filter(p=>p!==theirProp); s.players[pid].props.push(theirProp); if(s.owned[theirProp])s.owned[theirProp].owner=pid; } },
            { label:'skip', applyFn:(s,pid)=>{} }
        ], { rounds:mctsRounds(playerIndex), rollouts:10, neatEval:neatEvaluator(playerIndex) });
        if (best !== 'trade') return;

        const partnerIsAI = partnerIndex in aiPlayers;
        if (partnerIsAI) {
            // Evaluate from partner's perspective too
            const pSim = MonopolySim.fromGameState(gameState, partnerIndex);
            const pBest = MonopolySim.mctsDecide(pSim, partnerIndex, [
                { label:'accept', applyFn:(s,pid)=>{ const oi=gameState.players.findIndex(p=>p.id===player.id); s.players[pid].props=s.players[pid].props.filter(p=>p!==theirProp); s.players[oi].props.push(theirProp); if(s.owned[theirProp])s.owned[theirProp].owner=oi; s.players[oi].props=s.players[oi].props.filter(p=>p!==ourProp); s.players[pid].props.push(ourProp); if(s.owned[ourProp])s.owned[ourProp].owner=pid; } },
                { label:'reject', applyFn:(s,pid)=>{} }
            ], { rounds:mctsRounds(partnerIndex), rollouts:10, neatEval:neatEvaluator(partnerIndex) });
            if (pBest === 'accept') {
                tradeState.player1SelectedProps=[ourProp]; tradeState.player2SelectedProps=[theirProp];
                tradeState.player1SelectedGoojf=[]; tradeState.player2SelectedGoojf=[];
                tradeState.pendingP1=player; tradeState.pendingP2=partner;
                tradeState.pendingCashOffer=0; tradeState.pendingCashRequest=0;
                executeTrade(player, partner, 0, 0);
                console.log(`[AI] Trade executed between AI ${playerIndex} and AI ${partnerIndex}`);
            }
        } else {
            tradeState.player1SelectedProps=[ourProp]; tradeState.player2SelectedProps=[theirProp];
            tradeState.player1SelectedGoojf=[]; tradeState.player2SelectedGoojf=[];
            tradeState.pendingP1=player; tradeState.pendingP2=partner;
            tradeState.pendingCashOffer=0; tradeState.pendingCashRequest=0;
            const tradeDesc = buildTradeDescription(player, partner, 0, 0);
            document.getElementById('tradeConfirmDesc').textContent = `${partner.name}, do you accept this trade?\n\n` + tradeDesc;
            document.getElementById('tradeConfirmModal').classList.add('active');
        }
    }

    // ─── Polling loop ─────────────────────────────────────────────────────────

    let lastPhase = null;

    function startPolling() {
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(() => {
            const currentPhase = gameState?.phase;

            // Release lock if we were waiting for rollDice and phase changed
            if (aiActing && lastPhase === 'ROLL_DICE' && currentPhase !== 'ROLL_DICE') {
                aiActing = false;
            }
            lastPhase = currentPhase;

            if (aiActing) return;
            if (!gameState || !gameState.players || gameState.players.length === 0) return;

            const activePlayers = gameState.players.filter(p => !p.isBankrupt);
            if (activePlayers.length <= 1) return;

            // Auction check
            if (gameState.auction && gameState.auction.active) {
                const auction = gameState.auction;
                const activeBidders = auction.participatingPlayers.filter(id => !auction.passedPlayers.includes(id));
                if (activeBidders.length > 0) {
                    const currentId = activeBidders[auction.currentAuctionIndex % activeBidders.length];
                    const playerIndex = gameState.players.findIndex(p => p.id === currentId);
                    if (playerIndex in aiPlayers) takeTurn();
                }
                return;
            }

            const idx = gameState.currentPlayerIndex;

            // On human's turn: only check for incoming trade proposals
            if (!(idx in aiPlayers)) {
                handleIncomingTradeProposal();
                return;
            }

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
