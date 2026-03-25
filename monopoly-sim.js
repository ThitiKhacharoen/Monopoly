/**
 * monopoly-sim.js — Fast headless Monopoly engine for MCTS rollouts.
 * No DOM, no UI. Pure state machine.
 */
const MonopolySim = (() => {

const SPACES = [
    {id:0,type:'corner'},
    {id:1,type:'property',color:'brown',price:60,rent:[2,10,30,90,160,250],houseCost:50},
    {id:2,type:'chest'},{id:3,type:'property',color:'brown',price:60,rent:[4,20,60,180,320,450],houseCost:50},
    {id:4,type:'tax',amount:200},
    {id:5,type:'railroad',price:200,rent:[25,50,100,200]},
    {id:6,type:'property',color:'light-blue',price:100,rent:[6,30,90,270,400,550],houseCost:50},
    {id:7,type:'chance'},
    {id:8,type:'property',color:'light-blue',price:100,rent:[6,30,90,270,400,550],houseCost:50},
    {id:9,type:'property',color:'light-blue',price:120,rent:[8,40,100,300,450,600],houseCost:50},
    {id:10,type:'corner'},
    {id:11,type:'property',color:'pink',price:140,rent:[10,50,150,450,625,750],houseCost:100},
    {id:12,type:'utility',price:150},
    {id:13,type:'property',color:'pink',price:140,rent:[10,50,150,450,625,750],houseCost:100},
    {id:14,type:'property',color:'pink',price:160,rent:[12,60,180,500,700,900],houseCost:100},
    {id:15,type:'railroad',price:200,rent:[25,50,100,200]},
    {id:16,type:'property',color:'orange',price:180,rent:[14,70,200,550,750,950],houseCost:100},
    {id:17,type:'chest'},
    {id:18,type:'property',color:'orange',price:180,rent:[14,70,200,550,750,950],houseCost:100},
    {id:19,type:'property',color:'orange',price:200,rent:[16,80,220,600,800,1000],houseCost:100},
    {id:20,type:'corner'},
    {id:21,type:'property',color:'red',price:220,rent:[18,90,250,700,875,1050],houseCost:150},
    {id:22,type:'chance'},
    {id:23,type:'property',color:'red',price:220,rent:[18,90,250,700,875,1050],houseCost:150},
    {id:24,type:'property',color:'red',price:240,rent:[20,100,300,750,925,1100],houseCost:150},
    {id:25,type:'railroad',price:200,rent:[25,50,100,200]},
    {id:26,type:'property',color:'yellow',price:260,rent:[22,110,330,800,975,1150],houseCost:150},
    {id:27,type:'property',color:'yellow',price:260,rent:[22,110,330,800,975,1150],houseCost:150},
    {id:28,type:'utility',price:150},
    {id:29,type:'property',color:'yellow',price:280,rent:[24,120,360,850,1025,1200],houseCost:150},
    {id:30,type:'corner'},
    {id:31,type:'property',color:'green',price:300,rent:[26,130,390,900,1100,1275],houseCost:200},
    {id:32,type:'property',color:'green',price:300,rent:[26,130,390,900,1100,1275],houseCost:200},
    {id:33,type:'chest'},
    {id:34,type:'property',color:'green',price:320,rent:[28,150,450,1000,1200,1400],houseCost:200},
    {id:35,type:'railroad',price:200,rent:[25,50,100,200]},
    {id:36,type:'chance'},
    {id:37,type:'property',color:'dark-blue',price:350,rent:[35,175,500,1100,1300,1500],houseCost:200},
    {id:38,type:'tax',amount:100},
    {id:39,type:'property',color:'dark-blue',price:400,rent:[50,200,600,1400,1700,2000],houseCost:200},
];

const COLOR_GROUPS = {
    brown:[1,3],'light-blue':[6,8,9],pink:[11,13,14],orange:[16,18,19],
    red:[21,23,24],yellow:[26,27,29],green:[31,32,34],'dark-blue':[37,39],
    railroad:[5,15,25,35],utility:[12,28],
};

function die() { return Math.floor(Math.random()*6)+1; }

// ── State ─────────────────────────────────────────────────────────────────────
function createState(nPlayers) {
    return {
        players: Array.from({length:nPlayers},(_,i)=>({
            id:i, cash:1500, pos:0, bankrupt:false,
            inJail:false, jailTurns:0, gojf:0, props:[],
        })),
        owned: {},  // propId -> {owner,houses,hotel,mortgaged}
        currentIdx: 0,
        doublesCount: 0,
        turn: 0,
        gameOver: false,
        winnerId: null,
    };
}

function clone(state) {
    return {
        players: state.players.map(p=>({...p, props:[...p.props]})),
        owned: Object.fromEntries(Object.entries(state.owned).map(([k,v])=>[k,{...v}])),
        currentIdx: state.currentIdx,
        doublesCount: state.doublesCount,
        turn: state.turn,
        gameOver: state.gameOver,
        winnerId: state.winnerId,
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function activePlayers(state) {
    return state.players.filter(p=>!p.bankrupt);
}

function hasMonopoly(state, ownerId, color) {
    const group = COLOR_GROUPS[color] || [];
    return group.every(pid => state.owned[pid]?.owner === ownerId);
}

function countOwned(state, ownerId, color) {
    return (COLOR_GROUPS[color]||[]).filter(pid=>state.owned[pid]?.owner===ownerId).length;
}

function calcRent(state, propId, diceTotal) {
    const sp = SPACES[propId];
    const own = state.owned[propId];
    if (!own || own.mortgaged) return 0;
    const oid = own.owner;
    if (sp.type==='property') {
        if (own.hotel) return sp.rent[5];
        if (own.houses>0) return sp.rent[own.houses];
        if (hasMonopoly(state,oid,sp.color)) return sp.rent[0]*2;
        return sp.rent[0];
    }
    if (sp.type==='railroad') {
        const cnt = countOwned(state,oid,'railroad');
        return sp.rent[cnt-1] || 0;
    }
    if (sp.type==='utility') {
        const cnt = countOwned(state,oid,'utility');
        return diceTotal * (cnt===2 ? 10 : 4);
    }
    return 0;
}

function playerNW(state, pid) {
    const p = state.players[pid];
    let nw = p.cash;
    for (const propId of p.props) {
        const sp = SPACES[propId];
        const own = state.owned[propId];
        if (!own?.mortgaged) nw += (sp.price||0)/2;
        if (sp.type==='property') {
            nw += (own?.houses||0)*(sp.houseCost||0)/2;
            if (own?.hotel) nw += (sp.houseCost||0)/2;
        }
    }
    return Math.max(0, nw);
}

function tryRaiseCash(state, pid, needed) {
    const p = state.players[pid];
    for (const propId of [...p.props]) {
        if (p.cash >= needed) break;
        const own = state.owned[propId];
        if (own && !own.mortgaged && own.houses===0 && !own.hotel) {
            own.mortgaged = true;
            p.cash += SPACES[propId].price/2;
        }
    }
}

function doPay(state, payerId, recipientId, amount) {
    const payer = state.players[payerId];
    if (payer.cash < amount) tryRaiseCash(state, payerId, amount);
    if (payer.cash >= amount) {
        payer.cash -= amount;
        if (recipientId !== null) state.players[recipientId].cash += amount;
    } else {
        // Bankrupt
        if (recipientId !== null) state.players[recipientId].cash += payer.cash;
        for (const propId of payer.props) {
            if (recipientId !== null) {
                state.players[recipientId].props.push(propId);
                state.owned[propId].owner = recipientId;
            } else {
                delete state.owned[propId];
            }
        }
        payer.props = [];
        payer.cash = 0;
        payer.bankrupt = true;
        const alive = activePlayers(state);
        if (alive.length === 1) {
            state.gameOver = true;
            state.winnerId = alive[0].id;
        }
    }
}

function nearestRR(pos) {
    const rrs = [5,15,25,35];
    return rrs.find(r=>r>pos) || 5;
}
function nearestUT(pos) {
    const uts = [12,28];
    return uts.find(u=>u>pos) || 12;
}

// ── Card effects (simplified) ─────────────────────────────────────────────────
function applyChanceCard(state, pid, diceTotal) {
    const p = state.players[pid];
    const n = Math.floor(Math.random()*14);
    switch(n) {
        case 0: moveTo(state,pid,0,true); break;
        case 1: moveTo(state,pid,24,true); break;
        case 2: moveTo(state,pid,11,true); break;
        case 3: case 4: moveTo(state,pid,nearestRR(p.pos),true); break;
        case 5: moveTo(state,pid,nearestUT(p.pos),true); break;
        case 6: { const np=(p.pos-3+40)%40; p.pos=np; resolveSpace(state,pid,diceTotal); break; }
        case 7: sendToJail(state,pid); break;
        case 8: p.cash+=50; break;
        case 9: p.cash+=150; break;
        case 10: doPay(state,pid,null,15); break;
        case 11: { let cost=0; for(const pr of p.props){const o=state.owned[pr];cost+=o?.hotel?100:(o?.houses||0)*25;} doPay(state,pid,null,cost); break; }
        case 12: { const alive=activePlayers(state); for(const op of alive){if(op.id!==pid){doPay(state,pid,op.id,50);}} break; }
        case 13: p.gojf++; break;
    }
}

function applyChestCard(state, pid) {
    const p = state.players[pid];
    const n = Math.floor(Math.random()*16);
    switch(n) {
        case 0: moveTo(state,pid,0,true); break;
        case 1: sendToJail(state,pid); break;
        case 2: p.cash+=200; break;
        case 3: doPay(state,pid,null,50); break;
        case 4: p.cash+=50; break;
        case 5: p.cash+=100; break;
        case 6: p.cash+=20; break;
        case 7: p.cash+=100; break;
        case 8: doPay(state,pid,null,100); break;
        case 9: doPay(state,pid,null,150); break;
        case 10: p.cash+=25; break;
        case 11: { let cost=0; for(const pr of p.props){const o=state.owned[pr];cost+=o?.hotel?115:(o?.houses||0)*40;} doPay(state,pid,null,cost); break; }
        case 12: p.cash+=10; break;
        case 13: { const alive=activePlayers(state); for(const op of alive){if(op.id!==pid){doPay(state,op.id,pid,10);}} break; }
        case 14: { const alive=activePlayers(state); for(const op of alive){if(op.id!==pid){doPay(state,op.id,pid,50);}} break; }
        case 15: p.gojf++; break;
    }
}

function sendToJail(state, pid) {
    const p = state.players[pid];
    p.pos = 10; p.inJail = true; p.jailTurns = 0;
    state.doublesCount = 0;
}

function moveTo(state, pid, target, checkGo) {
    const p = state.players[pid];
    if (checkGo && target <= p.pos && target !== p.pos) p.cash += 200;
    p.pos = target;
    resolveSpace(state, pid, 7); // use avg dice for rent
}

// ── Space resolution ──────────────────────────────────────────────────────────
function resolveSpace(state, pid, diceTotal) {
    if (state.gameOver) return;
    const p = state.players[pid];
    const sp = SPACES[p.pos];
    if (!sp) return;

    if (sp.type==='property'||sp.type==='railroad'||sp.type==='utility') {
        const own = state.owned[p.pos];
        if (!own) {
            // Random decision: buy if can afford
            if (p.cash >= (sp.price||0) && Math.random() > 0.3) {
                p.cash -= sp.price;
                p.props.push(p.pos);
                state.owned[p.pos] = {owner:pid, houses:0, hotel:false, mortgaged:false};
            }
            // else auction — simplified: just skip
        } else if (own.owner !== pid) {
            const rent = calcRent(state, p.pos, diceTotal);
            if (rent > 0) doPay(state, pid, own.owner, rent);
        }
    } else if (sp.type==='tax') {
        doPay(state, pid, null, sp.amount);
    } else if (sp.type==='chance') {
        applyChanceCard(state, pid, diceTotal);
    } else if (sp.type==='chest') {
        applyChestCard(state, pid);
    } else if (sp.id===30) {
        sendToJail(state, pid);
    }
}

// ── Turn ──────────────────────────────────────────────────────────────────────
function doTurn(state, pid, decisionFn) {
    if (state.gameOver) return;
    const p = state.players[pid];
    if (p.bankrupt) return;

    // Jail
    if (p.inJail) {
        if (p.gojf > 0) { p.gojf--; p.inJail=false; p.jailTurns=0; }
        else {
            p.jailTurns++;
            const d1=die(), d2=die();
            if (d1===d2) { p.inJail=false; p.jailTurns=0; p.pos=(10+d1+d2)%40; resolveSpace(state,pid,d1+d2); }
            else if (p.jailTurns>=3) { doPay(state,pid,null,50); p.inJail=false; p.jailTurns=0; p.pos=(10+d1+d2)%40; resolveSpace(state,pid,d1+d2); }
            return;
        }
    }

    const d1=die(), d2=die(), total=d1+d2, doubles=d1===d2;

    if (doubles) {
        state.doublesCount++;
        if (state.doublesCount>=3) { sendToJail(state,pid); return; }
    } else {
        state.doublesCount=0;
    }

    const old = p.pos;
    p.pos = (old+total)%40;
    if (p.pos < old) p.cash += 200;

    // Decision point — use decisionFn for the active player
    if (decisionFn && pid===decisionFn.playerId) {
        const sp = SPACES[p.pos];
        if ((sp.type==='property'||sp.type==='railroad'||sp.type==='utility') && !state.owned[p.pos]) {
            const shouldBuy = decisionFn.buy(state, pid, p.pos);
            if (shouldBuy && p.cash >= sp.price) {
                p.cash -= sp.price;
                p.props.push(p.pos);
                state.owned[p.pos] = {owner:pid, houses:0, hotel:false, mortgaged:false};
            }
        } else {
            resolveSpace(state, pid, total);
        }
    } else {
        resolveSpace(state, pid, total);
    }

    // Simple building: if monopoly owned, randomly build
    if (!state.gameOver && p.cash > 400) {
        for (const [color, group] of Object.entries(COLOR_GROUPS)) {
            if (['railroad','utility'].includes(color)) continue;
            if (!hasMonopoly(state, pid, color)) continue;
            for (const propId of group) {
                const own = state.owned[propId];
                const sp = SPACES[propId];
                if (!own||own.mortgaged||own.hotel||own.houses>=4) continue;
                if (p.cash >= sp.houseCost+200 && Math.random()>0.5) {
                    p.cash -= sp.houseCost;
                    own.houses++;
                    break;
                }
            }
        }
    }

    if (doubles && !p.inJail && !state.gameOver) doTurn(state, pid, decisionFn);
}

// ── Run N rounds for all players ──────────────────────────────────────────────
function runRounds(state, nRounds, decisionFn) {
    const alive = () => state.players.filter(p=>!p.bankrupt);
    for (let r=0; r<nRounds && !state.gameOver; r++) {
        const players = alive();
        for (const p of players) {
            if (state.gameOver) break;
            state.doublesCount = 0;
            doTurn(state, p.id, decisionFn);
            state.turn++;
        }
    }
}

// ── Value function: score state for player pid ─────────────────────────────────
function evaluate(state, pid, neatEval) {
    const alive = state.players.filter(p=>!p.bankrupt);
    if (state.gameOver) {
        return state.winnerId === pid ? 1.0 : 0.0;
    }
    if (state.players[pid].bankrupt) return 0.0;

    // Use NEAT if provided, otherwise use net worth ratio
    if (neatEval) return neatEval(state, pid);

    const myNW = playerNW(state, pid);
    const totalNW = state.players.reduce((s,p)=>s+playerNW(state,p.id),0);
    return totalNW > 0 ? myNW/totalNW : 0.25;
}

// ── MCTS: pick best action ────────────────────────────────────────────────────
/**
 * Evaluate a decision using Monte Carlo rollouts.
 * @param {object} currentState - Current game state (will be cloned)
 * @param {number} playerId - Which player is deciding
 * @param {Array} actions - Array of {label, applyFn} objects
 * @param {object} opts - {rounds:5, rollouts:20, neatEval:fn}
 * @returns {string} label of best action
 */
function mctsDecide(currentState, playerId, actions, opts={}) {
    const rounds   = opts.rounds   || 5;
    const rollouts = opts.rollouts || 20;
    const neatEval = opts.neatEval || null;

    const scores = {};
    for (const action of actions) {
        let total = 0;
        for (let i=0; i<rollouts; i++) {
            const s = clone(currentState);
            action.applyFn(s, playerId);  // apply the action
            runRounds(s, rounds, null);    // random rollout
            total += evaluate(s, playerId, neatEval);
        }
        scores[action.label] = total / rollouts;
    }

    // Return label with highest score
    return actions.reduce((best, a) => scores[a.label] > scores[best.label] ? a : best, actions[0]).label;
}

// ── State builder from game.html gameState ────────────────────────────────────
function fromGameState(gameState, playerIndex) {
    const nPlayers = gameState.players.length;
    const state = {
        players: gameState.players.map((p,i) => ({
            id: i,
            cash: p.cash,
            pos: p.position,
            bankrupt: p.isBankrupt || false,
            inJail: p.inJail || false,
            jailTurns: p.jailTurns || 0,
            gojf: (p.getOutOfJailFreeCards?.length || p.getOutOfJailFreeCards || 0),
            props: [...(p.properties || [])],
        })),
        owned: {},
        currentIdx: gameState.currentPlayerIndex,
        doublesCount: gameState.doublesCount || 0,
        turn: 0,
        gameOver: false,
        winnerId: null,
    };
    // Copy owned properties
    for (const [pidStr, own] of Object.entries(gameState.ownedProperties || {})) {
        const pid = parseInt(pidStr);
        const ownerIdx = gameState.players.findIndex(p=>p.id===own.ownerId);
        state.owned[pid] = {
            owner: ownerIdx,
            houses: own.houses || 0,
            hotel: own.hasHotel || false,
            mortgaged: own.isMortgaged || false,
        };
    }
    return state;
}

return { createState, clone, fromGameState, runRounds, mctsDecide, evaluate, playerNW };
})();
