// ==UserScript==
// @name         MonstersGame - Comparador de Highscore
// @namespace    http://tampermonkey.net/
// @version      4.2.5
// @description  Comparador de Highscore com histórico IndexedDB, painel, álbum, snapshots e UI responsiva
// @match        *://*.monstersgame.moonid.net/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const CFG = {
        DB_NAME: 'MG_HIGHSCORE_HISTORY',
        DB_VERSION: 2,
        STORE: 'snapshots',
        MAX_PER_RANGE: 60,
        MIN_INTERVAL_MS: 55 * 60 * 1000,
        PANEL_ID: 'mg-highscore-changes',
        TOOLS_ID: 'mg-highscore-tools',
        MODAL_ID: 'mg-highscore-modal',
        BACK_BUTTON_ID: 'mg-highscore-back-button',
        WORKER_URL: 'https://monstersgame-highscore.ricardolourenco055.workers.dev',
        SETTINGS_KEY: 'mg_highscore_ui_settings_v4',
        SNAPSHOT_SCALE: 3,
        COMPARISON_W: 2800,
        PANEL_W: 2400,
        PANEL_H: 2000
    };

    const INDICATOR_HELP = {
        preciosidades: 'Preciosidades — Itens raros / joias coletadas. Quanto maior, mais valioso o inventário do jogador.',
        ouro: 'Ouro ganho — Quantidade total de ouro acumulado através de batalhas, missões e atividades.',
        ancestrais: 'Ancestrais — Pontuação relacionada ao site ancestral (nível 20+). Indica progresso e poder ancestral.',
        vitorias: 'Vitórias — Número de combates vencidos contra outros jogadores.',
        derrotas: 'Derrotas — Número de combates perdidos. Ajuda a medir a agressividade e exposição do jogador.'
    };

    let dbPromise = null;
    let currentState = null;
    let modalTab = 'comparison';
    let isUploading = false;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function parseNum(txt) {
        const cleaned = String(txt || '').replace(/\./g, '').replace(/[^\d-]/g, '');
        const n = parseInt(cleaned, 10);
        return Number.isNaN(n) ? 0 : n;
    }

    function fmtNumber(n) {
        return Number(n || 0).toLocaleString('pt-PT');
    }

    function fmtSigned(n) {
        n = Number(n || 0);
        return n > 0 ? '+' + fmtNumber(n) : fmtNumber(n);
    }

    function fmtElapsed(ms) {
        const min = Math.max(0, Math.round(ms / 60000));
        if (min < 60) return `${min} min`;
        const h = Math.floor(min / 60);
        const m = min % 60;
        return `${h}h${m ? m + 'min' : ''}`;
    }

    function fmtDateTime(ts) {
        return new Intl.DateTimeFormat('pt-PT', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        }).format(new Date(ts));
    }

    function getSettings() {
        try {
            return Object.assign(
                { minimized: false, toolsPosition: 'initial' },
                JSON.parse(localStorage.getItem(CFG.SETTINGS_KEY) || '{}')
            );
        } catch (e) {
            return { minimized: false, toolsPosition: 'initial' };
        }
    }

    function saveSettings(settings) {
        localStorage.setItem(CFG.SETTINGS_KEY, JSON.stringify(settings));
    }

    function findTable() {
        const marker = document.querySelector('.tdn_highscore');
        return marker ? marker.closest('table') : null;
    }

    function getPlayerAvatar(row) {
        const image = row.querySelector('img');
        return image ? (image.getAttribute('src') || '') : '';
    }

    function parseHighscoreTable(table) {
        const map = new Map();
        table.querySelectorAll('tr').forEach(row => {
            if (row.classList.contains('bghighscore')) return;
            const cells = row.querySelectorAll('td');
            if (cells.length < 10) return;
            const posText = cells[0].textContent.trim();
            if (!/^\d+\.$/.test(posText)) return;
            const nameLink = cells[2].querySelector('a');
            if (!nameLink) return;
            const href = nameLink.getAttribute('href') || '';
            const idMatch = href.match(/showuserid=(\d+)/);
            const userid = idMatch ? idMatch[1] : nameLink.textContent.trim();
            map.set(String(userid), {
                pos: parseInt(posText, 10),
                userid: String(userid),
                name: nameLink.textContent.trim(),
                level: parseNum(cells[3].textContent),
                preciosidades: parseNum(cells[4].textContent),
                vitima: parseNum(cells[5].textContent),
                v: parseNum(cells[6].textContent),
                d: parseNum(cells[7].textContent),
                ancestrais: parseNum(cells[8].textContent),
                ouro: parseNum(cells[9].textContent),
                avatar: getPlayerAvatar(row)
            });
        });
        return Array.from(map.values()).sort((a, b) => a.pos - b.pos);
    }

    function rangeKeyFor(records) {
        if (!records.length) return 'unknown';
        return `${records[0].pos}-${records[records.length - 1].pos}`;
    }

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(CFG.DB_NAME, CFG.DB_VERSION);
            request.onupgradeneeded = event => {
                const db = event.target.result;
                let store;
                if (!db.objectStoreNames.contains(CFG.STORE)) {
                    store = db.createObjectStore(CFG.STORE, { keyPath: 'id' });
                } else {
                    store = event.target.transaction.objectStore(CFG.STORE);
                }
                if (!store.indexNames.contains('serverRange')) {
                    store.createIndex('serverRange', ['server', 'range'], { unique: false });
                }
                if (!store.indexNames.contains('ts')) {
                    store.createIndex('ts', 'ts', { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return dbPromise;
    }

    async function getAllSnapshots() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const request = db.transaction(CFG.STORE, 'readonly').objectStore(CFG.STORE).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async function putSnapshot(snapshot) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CFG.STORE, 'readwrite');
            tx.objectStore(CFG.STORE).put(snapshot);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    async function deleteSnapshot(id) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CFG.STORE, 'readwrite');
            tx.objectStore(CFG.STORE).delete(id);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    async function getRangeHistory(range) {
        const all = await getAllSnapshots();
        return all
            .filter(item => item.server === location.hostname && item.range === range)
            .sort((a, b) => a.ts - b.ts);
    }

    async function trimHistory(range) {
        const history = await getRangeHistory(range);
        while (history.length > CFG.MAX_PER_RANGE) {
            const oldest = history.shift();
            await deleteSnapshot(oldest.id);
        }
    }

    async function createSnapshot(records, range) {
        const history = await getRangeHistory(range);
        const now = Date.now();
        let compareSnap = null;
        for (let i = history.length - 1; i >= 0; i--) {
            if (now - history[i].ts >= CFG.MIN_INTERVAL_MS) {
                compareSnap = history[i];
                break;
            }
        }
        const snapshot = {
            id: `${location.hostname}|${range}|${now}`,
            server: location.hostname,
            range,
            ts: now,
            title: `Comparativo ${fmtDateTime(now)}`,
            records,
            baselineTs: compareSnap ? compareSnap.ts : null,
            images: { comparison: null, panel: null },
            upload: { comparison: 'pending', panel: 'pending' }
        };
        await putSnapshot(snapshot);
        await trimHistory(range);
        return {
            snapshot,
            compareSnap,
            lastVisit: history.length ? history[history.length - 1] : null
        };
    }

    function calculateChanges(currentRecords, oldRecords) {
        if (!oldRecords) return [];
        const oldMap = new Map(oldRecords.map(item => [String(item.userid), item]));
        return currentRecords
            .map(current => {
                const old = oldMap.get(String(current.userid));
                if (!old) {
                    return {
                        current, old: null, isNew: true,
                        pos: 0, preciosidades: 0, ouro: 0,
                        ancestrais: 0, vitorias: 0, derrotas: 0
                    };
                }
                return {
                    current, old, isNew: false,
                    pos: old.pos - current.pos,
                    preciosidades: current.preciosidades - old.preciosidades,
                    ouro: current.ouro - old.ouro,
                    ancestrais: current.ancestrais - old.ancestrais,
                    vitorias: current.v - old.v,
                    derrotas: current.d - old.d
                };
            })
            .filter(item => {
                if (item.isNew) return true;
                return item.pos !== 0 || item.preciosidades !== 0 || item.ouro !== 0 ||
                       item.ancestrais !== 0 || item.vitorias !== 0 || item.derrotas !== 0;
            })
            .sort((a, b) => {
                if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
                const pa = Math.abs(a.pos), pb = Math.abs(b.pos);
                if (pa !== pb) return pb - pa;
                const ta = Math.abs(a.preciosidades) + Math.abs(a.ouro) + Math.abs(a.ancestrais) +
                           Math.abs(a.vitorias) + Math.abs(a.derrotas);
                const tb = Math.abs(b.preciosidades) + Math.abs(b.ouro) + Math.abs(b.ancestrais) +
                           Math.abs(b.vitorias) + Math.abs(b.derrotas);
                return tb - ta;
            });
    }

    function getTotals(changes) {
        return {
            changed: changes.filter(x => !x.isNew).length,
            newPlayers: changes.filter(x => x.isNew).length,
            up: changes.filter(x => !x.isNew && x.pos > 0).length,
            down: changes.filter(x => !x.isNew && x.pos < 0).length,
            stable: changes.filter(x => !x.isNew && x.pos === 0).length,
            preciosidades: changes.reduce((s, x) => s + x.preciosidades, 0),
            ouro: changes.reduce((s, x) => s + x.ouro, 0),
            ancestrais: changes.reduce((s, x) => s + x.ancestrais, 0),
            vitorias: changes.reduce((s, x) => s + x.vitorias, 0),
            derrotas: changes.reduce((s, x) => s + x.derrotas, 0)
        };
    }

    function deltaClass(value) {
        if (value > 0) return 'mg-hs-positive';
        if (value < 0) return 'mg-hs-negative';
        return 'mg-hs-neutral';
    }

    function deltaHtml(value) {
        return `<span class="mg-hs-delta ${deltaClass(value)}">${fmtSigned(value)}</span>`;
    }

    function statHtml(icon, label, value, delta, helpKey) {
        const title = helpKey && INDICATOR_HELP[helpKey]
            ? ` title="${escapeHtml(INDICATOR_HELP[helpKey])}"` : '';
        return `
            <div class="mg-hs-stat"${title}>
                <span class="mg-hs-stat-icon">${icon}</span>
                <span class="mg-hs-stat-content">
                    <span class="mg-hs-stat-label">${label}</span>
                    <span class="mg-hs-stat-value">${fmtNumber(value)}</span>
                    ${deltaHtml(delta)}
                </span>
            </div>
        `;
    }

    function positionHtml(current, old) {
        if (old === null || old === undefined) {
            return `<span class="mg-hs-position">${current}º</span>`;
        }
        const delta = old - current;
        return `
            <div class="mg-hs-position-wrap">
                <span class="mg-hs-position">${current}º</span>
                <span class="mg-hs-pos-change ${deltaClass(delta)}">
                    ${delta > 0 ? '▲' : delta < 0 ? '▼' : '—'}
                    ${delta !== 0 ? Math.abs(delta) : ''}
                </span>
            </div>
        `;
    }

    function renderPlayerRow(current, old) {
        const isNew = !old;
        return `
            <div class="mg-hs-row" data-userid="${escapeHtml(current.userid)}" data-name="${escapeHtml(current.name)}">
                <div class="mg-hs-player">
                    ${current.avatar ? `<img class="mg-hs-avatar" src="${escapeHtml(current.avatar)}" alt="" loading="lazy">` : ''}
                    <span class="mg-hs-rank">${current.pos}</span>
                    <div class="mg-hs-player-info">
                        <span class="mg-hs-name">${escapeHtml(current.name)}</span>
                        <span class="mg-hs-level">${isNew ? '<span class="mg-hs-new">NOVO</span>' : 'Nível ' + fmtNumber(current.level)}</span>
                    </div>
                </div>
                ${positionHtml(current.pos, old ? old.pos : null)}
                ${statHtml('💎', 'Preciosidades', current.preciosidades, old ? current.preciosidades - old.preciosidades : 0, 'preciosidades')}
                ${statHtml('🪙', 'Ouro', current.ouro, old ? current.ouro - old.ouro : 0, 'ouro')}
                ${statHtml('🏆', 'Ancestrais', current.ancestrais, old ? current.ancestrais - old.ancestrais : 0, 'ancestrais')}
                ${statHtml('⚔️', 'Vitórias', current.v, old ? current.v - old.v : 0, 'vitorias')}
                ${statHtml('☠️', 'Derrotas', current.d, old ? current.d - old.d : 0, 'derrotas')}
            </div>
        `;
    }

    function buildStyles() {
        if (document.getElementById('mg-highscore-v4-style')) return;
        const style = document.createElement('style');
        style.id = 'mg-highscore-v4-style';
        style.textContent = `
            #${CFG.PANEL_ID}{width:100%;max-width:100%;box-sizing:border-box;margin:0 0 16px 0;padding:14px;background:linear-gradient(165deg,#2e0c0c 0%,#1a0606 55%,#120404 100%);border:1px solid #7a1e1e;border-radius:12px;color:#e8c4a0;font-family:Georgia,'Times New Roman',serif;box-shadow:0 8px 24px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,200,140,.06);overflow:hidden}
            #${CFG.PANEL_ID} *{box-sizing:border-box}
            #${CFG.PANEL_ID}.mg-hs-minimized{padding:9px 14px}
            #${CFG.PANEL_ID}.mg-hs-minimized .mg-hs-lastvisit,#${CFG.PANEL_ID}.mg-hs-minimized .mg-hs-list,#${CFG.PANEL_ID}.mg-hs-minimized .mg-hs-empty,#${CFG.PANEL_ID}.mg-hs-minimized .mg-hs-legend{display:none}
            .mg-hs-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 4px 12px;border-bottom:1px solid #4e1a1a}
            .mg-hs-header-left{min-width:0}
            .mg-hs-title{color:#ffdca8;font-size:16px;font-weight:bold;letter-spacing:.2px}
            .mg-hs-range{color:#a98262;font-size:11px;margin-top:2px;white-space:nowrap}
            .mg-hs-header-actions{display:flex;gap:6px;flex-shrink:0}
            .mg-hs-icon-btn{width:32px;height:32px;border:1px solid #7a3030;border-radius:7px;background:#240808;color:#e8c39a;cursor:pointer;font-size:15px;transition:background .15s}
            .mg-hs-icon-btn:hover{background:#521515}
            .mg-hs-lastvisit{color:#9c7c5c;font-size:11px;padding:8px 4px 6px}
            .mg-hs-legend{display:flex;flex-wrap:wrap;gap:8px 14px;padding:4px 4px 10px;font-size:10px;color:#8a6a52}
            .mg-hs-legend span{display:inline-flex;align-items:center;gap:4px;cursor:help}
            .mg-hs-list{width:100%;max-width:100%}
            .mg-hs-scroll{width:100%;max-width:100%;overflow-x:auto;overflow-y:hidden;border-radius:8px;scrollbar-width:thin;scrollbar-color:#5a2020 #1a0808;-webkit-overflow-scrolling:touch}
            .mg-hs-scroll::-webkit-scrollbar{height:8px}
            .mg-hs-scroll::-webkit-scrollbar-track{background:#1a0808;border-radius:4px}
            .mg-hs-scroll::-webkit-scrollbar-thumb{background:#5a2020;border-radius:4px}
            .mg-hs-list-header,.mg-hs-row{display:grid;grid-template-columns:minmax(180px,1.35fr) 68px repeat(5,minmax(86px,1fr));align-items:center;gap:4px;min-width:720px}
            .mg-hs-list-header{padding:9px 11px;color:#c09a74;font-size:9px;text-transform:uppercase;letter-spacing:.4px;border:1px solid #4a1818;border-radius:8px 8px 0 0;background:rgba(18,4,4,.75)}
            .mg-hs-row{min-height:58px;padding:7px 11px;border-left:1px solid #3f1515;border-right:1px solid #3f1515;border-bottom:1px solid #3f1515;background:rgba(42,9,9,.78);cursor:pointer;transition:background .14s}
            .mg-hs-row:last-child{border-radius:0 0 8px 8px}
            .mg-hs-row:hover{background:rgba(78,16,16,.92)}
            .mg-hs-player{display:flex;align-items:center;min-width:0;gap:8px}
            .mg-hs-avatar{width:38px;height:38px;flex:0 0 38px;object-fit:cover;border:1px solid #8a3030;border-radius:50%;background:#160404}
            .mg-hs-rank{min-width:24px;color:#e0b88a;font-size:12px;font-weight:bold;text-align:center}
            .mg-hs-player-info{min-width:0;display:flex;flex-direction:column;gap:2px}
            .mg-hs-name{color:#f4d6b0;font-size:13px;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .mg-hs-level{color:#8c6e55;font-size:10px}
            .mg-hs-position-wrap{display:flex;align-items:center;justify-content:center;gap:4px}
            .mg-hs-position{color:#e8c498;font-size:13px;font-weight:bold}
            .mg-hs-pos-change{padding:2px 5px;border-radius:4px;font-size:10px;font-weight:bold}
            .mg-hs-stat{display:flex;align-items:center;min-width:0;gap:5px;cursor:help}
            .mg-hs-stat-icon{width:22px;flex:0 0 22px;text-align:center;font-size:15px}
            .mg-hs-stat-content{display:flex;flex-direction:column;min-width:0}
            .mg-hs-stat-label{color:#9a775c;font-size:8px;text-transform:uppercase;white-space:nowrap}
            .mg-hs-stat-value{color:#ebc8a0;font-size:12px;font-weight:bold;white-space:nowrap}
            .mg-hs-delta{font-size:10px;font-weight:bold;white-space:nowrap}
            .mg-hs-positive{color:#5ee07a}.mg-hs-negative{color:#ff6b6b}.mg-hs-neutral{color:#b99b7b}
            .mg-hs-new{display:inline-flex;padding:2px 6px;border-radius:4px;background:rgba(40,110,180,.22);color:#7dd0ff;font-size:9px;font-weight:bold}
            .mg-hs-empty{padding:18px 14px;color:#b08060;font-size:12px;text-align:center;line-height:1.5}
            #${CFG.TOOLS_ID}{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;padding:8px 10px;border:1px solid #6e2424;border-radius:9px;background:linear-gradient(180deg,#361212,#1a0606);color:#e6c19a;font-family:Georgia,serif;user-select:none;box-shadow:0 4px 14px rgba(0,0,0,.35)}
            .mg-hs-tool-btn{border:1px solid #7a3030;border-radius:6px;padding:7px 11px;background:#240808;color:#e8c39a;cursor:pointer;font:600 11px Georgia,serif;transition:background .14s;white-space:nowrap}
            .mg-hs-tool-btn:hover{background:#521515}
            .mg-hs-tool-btn:disabled{opacity:.55;cursor:not-allowed}
            .mg-hs-tool-btn.mg-hs-pos-btn{min-width:36px;padding:7px 8px;font-size:14px}
            .mg-hs-tool-status{margin-left:auto;font-size:11px;color:#a88262;padding:0 4px}
            .mg-hs-tool-status.ok{color:#5ee07a}.mg-hs-tool-status.err{color:#ff7a7a}.mg-hs-tool-status.busy{color:#7dd0ff}
            #${CFG.MODAL_ID}{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;padding:14px;background:rgba(0,0,0,.86);backdrop-filter:blur(3px)}
            #${CFG.MODAL_ID}.open{display:flex}
            .mg-hs-modal{width:min(1180px,100%);max-height:94vh;overflow:auto;border:1px solid #802828;border-radius:14px;background:linear-gradient(180deg,#2c0a0a,#120303);color:#e9c69e;font-family:Georgia,serif;box-shadow:0 20px 50px rgba(0,0,0,.6)}
            .mg-hs-modal-head{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #4e1a1a;background:#240808}
            .mg-hs-modal-title{color:#f0d0a5;font-size:17px;font-weight:bold}
            .mg-hs-tabs{display:flex;gap:6px;padding:10px 14px 0;flex-wrap:wrap}
            .mg-hs-tab{border:1px solid #7a3030;border-radius:6px;padding:8px 12px;background:#240808;color:#e8c39a;cursor:pointer;font:600 11px Georgia,serif;transition:background .14s}
            .mg-hs-tab:hover{background:#3e1212}.mg-hs-tab.active{background:#5a1818;border-color:#a04040}
            .mg-hs-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;padding:14px}
            .mg-hs-card{overflow:hidden;border:1px solid #4e1a1a;border-radius:10px;background:#180606;transition:transform .15s,box-shadow .15s}
            .mg-hs-card:hover{transform:translateY(-3px);box-shadow:0 8px 20px rgba(0,0,0,.4)}
            .mg-hs-card-preview{display:block;width:100%;height:220px;object-fit:cover;background:#0d0303;cursor:pointer}
            .mg-hs-card-empty{display:flex;align-items:center;justify-content:center;height:220px;color:#80604e;font-size:11px;text-align:center;padding:12px}
            .mg-hs-card-body{padding:10px}
            .mg-hs-card-title{display:block;overflow:hidden;color:#edcaa2;font-size:12px;font-weight:bold;text-overflow:ellipsis;white-space:nowrap}
            .mg-hs-card-date{display:block;margin-top:4px;color:#927159;font-size:9px}
            .mg-hs-card-actions{display:flex;gap:6px;margin-top:9px}
            .mg-hs-card-actions button{flex:1;border:1px solid #682222;border-radius:5px;padding:6px;background:#260909;color:#dcb98f;cursor:pointer;font:10px Georgia,serif}
            .mg-hs-card-actions button:hover{background:#521515}
            .mg-hs-analysis{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;padding:14px}
            .mg-hs-box{padding:13px;border:1px solid #4e1a1a;border-radius:9px;background:#180606}
            .mg-hs-box small{display:block;color:#947158;font-size:9px;text-transform:uppercase}
            .mg-hs-box strong{display:block;margin-top:5px;color:#edc99e;font-size:22px}
            .mg-hs-wide{grid-column:1/-1}
            .mg-hs-wide-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #351010;font-size:12px}
            .mg-hs-wide-row:last-child{border-bottom:none}
            #${CFG.BACK_BUTTON_ID}{position:fixed;right:22px;bottom:130px;z-index:2147483646;width:52px;height:52px;border:1px solid #a04040;border-radius:50%;background:linear-gradient(180deg,#5c1818,#2a0808);color:#f3c99b;font-size:24px;cursor:pointer;opacity:0;pointer-events:none;transform:translateY(12px);transition:.22s;box-shadow:0 6px 18px rgba(0,0,0,.4)}
            #${CFG.BACK_BUTTON_ID}.mg-hs-back-visible{opacity:1;pointer-events:auto;transform:translateY(0)}
            #${CFG.BACK_BUTTON_ID}:hover{background:linear-gradient(180deg,#6e1e1e,#3a0c0c)}
            @media(max-width:900px){.mg-hs-list-header,.mg-hs-row{grid-template-columns:minmax(150px,1.3fr) 58px repeat(5,minmax(72px,1fr));min-width:640px}}
            @media(max-width:700px){.mg-hs-analysis{grid-template-columns:1fr 1fr}#${CFG.TOOLS_ID}{gap:5px;padding:7px 8px}.mg-hs-tool-btn{padding:6px 9px;font-size:10px}.mg-hs-tool-status{width:100%;margin-left:0;margin-top:4px;text-align:center}}
            @media(max-width:480px){.mg-hs-analysis{grid-template-columns:1fr}.mg-hs-list-header,.mg-hs-row{grid-template-columns:minmax(130px,1.2fr) 50px repeat(5,minmax(68px,1fr));min-width:580px}.mg-hs-avatar{width:32px;height:32px;flex-basis:32px}.mg-hs-stat-icon{font-size:13px;width:18px;flex-basis:18px}.mg-hs-title{font-size:14px}.mg-hs-legend{font-size:9px;gap:6px 10px}}
        `;
        document.head.appendChild(style);
    }

    function placeTools(tools, table, position) {
        const panel = document.getElementById(CFG.PANEL_ID);
        if (position === 'top') {
            table.parentNode.insertBefore(tools, table);
        } else if (panel) {
            panel.parentNode.insertBefore(tools, panel);
        } else {
            table.parentNode.insertBefore(tools, table);
        }
    }

    function updatePosButtons(tools, position) {
        const upBtn = tools.querySelector('[data-tool="move-up"]');
        const downBtn = tools.querySelector('[data-tool="move-down"]');
        if (!upBtn || !downBtn) return;
        upBtn.disabled = position === 'top';
        downBtn.disabled = position === 'initial';
        upBtn.title = position === 'top' ? 'Já está acima da tabela' : 'Mover para cima da tabela';
        downBtn.title = position === 'initial' ? 'Já está acima do painel' : 'Mover para cima do painel';
    }

    function createTools(table) {
        let tools = document.getElementById(CFG.TOOLS_ID);
        if (tools) return tools;

        tools = document.createElement('div');
        tools.id = CFG.TOOLS_ID;
        tools.innerHTML = `
            <button class="mg-hs-tool-btn mg-hs-pos-btn" data-tool="move-up" type="button" title="Mover para cima da tabela">🔽</button>
            <button class="mg-hs-tool-btn mg-hs-pos-btn" data-tool="move-down" type="button" title="Mover para cima do painel">🔼</button>
            <button class="mg-hs-tool-btn" data-tool="album" type="button">▣ Álbum</button>
            <button class="mg-hs-tool-btn" data-tool="panel" type="button">◈ Painel</button>
            <button class="mg-hs-tool-btn" data-tool="retry" type="button">☁ Imagens</button>
            <span class="mg-hs-tool-status">Histórico ativo</span>
        `;

        const settings = getSettings();
        placeTools(tools, table, settings.toolsPosition);
        updatePosButtons(tools, settings.toolsPosition);

        tools.querySelector('[data-tool="move-up"]').addEventListener('click', e => {
            e.stopPropagation();
            const s = getSettings();
            if (s.toolsPosition === 'top') return;
            placeTools(tools, table, 'top');
            s.toolsPosition = 'top';
            saveSettings(s);
            updatePosButtons(tools, 'top');
        });

        tools.querySelector('[data-tool="move-down"]').addEventListener('click', e => {
            e.stopPropagation();
            const s = getSettings();
            if (s.toolsPosition === 'initial') return;
            placeTools(tools, table, 'initial');
            s.toolsPosition = 'initial';
            saveSettings(s);
            updatePosButtons(tools, 'initial');
        });

        tools.querySelector('[data-tool="album"]').addEventListener('click', e => {
            e.stopPropagation();
            openAlbum('comparison');
        });

        tools.querySelector('[data-tool="panel"]').addEventListener('click', e => {
            e.stopPropagation();
            openAlbum('panel');
        });

        tools.querySelector('[data-tool="retry"]').addEventListener('click', async e => {
            e.stopPropagation();
            if (!currentState || isUploading) return;
            const statusEl = tools.querySelector('.mg-hs-tool-status');
            const btn = tools.querySelector('[data-tool="retry"]');
            try {
                isUploading = true;
                btn.disabled = true;
                statusEl.textContent = 'Gerando imagens…';
                statusEl.className = 'mg-hs-tool-status busy';
                await generateAndUpload(currentState.snapshot, currentState.compareSnap);
                statusEl.textContent = '✓ Imagens atualizadas';
                statusEl.className = 'mg-hs-tool-status ok';
            } catch (err) {
                console.error('[MG Highscore] Upload:', err);
                statusEl.textContent = 'Upload pendente';
                statusEl.className = 'mg-hs-tool-status err';
            } finally {
                isUploading = false;
                btn.disabled = false;
            }
        });

        return tools;
    }

    function createBackButton() {
        let button = document.getElementById(CFG.BACK_BUTTON_ID);
        if (button) return button;
        button = document.createElement('button');
        button.id = CFG.BACK_BUTTON_ID;
        button.type = 'button';
        button.textContent = '↩';
        button.title = 'Voltar ao comparador';
        button.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            const panel = document.getElementById(CFG.PANEL_ID);
            if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            button.classList.remove('mg-hs-back-visible');
        });
        document.body.appendChild(button);
        return button;
    }

    function goToPlayer(userid, name) {
        const table = findTable();
        if (!table) return;
        let target = null;
        table.querySelectorAll('tr').forEach(row => {
            row.querySelectorAll('a').forEach(link => {
                const href = link.getAttribute('href') || '';
                const match = href.match(/showuserid=(\d+)/);
                if (match && match[1] === String(userid)) target = row;
            });
        });
        if (!target && name) {
            table.querySelectorAll('tr').forEach(row => {
                row.querySelectorAll('a').forEach(link => {
                    if (link.textContent.trim().toLowerCase() === name.trim().toLowerCase()) target = row;
                });
            });
        }
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        createBackButton().classList.add('mg-hs-back-visible');
    }

    function attachRowNavigation() {
        const panel = document.getElementById(CFG.PANEL_ID);
        if (!panel) return;
        panel.querySelectorAll('.mg-hs-row').forEach(row => {
            row.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                goToPlayer(row.dataset.userid, row.dataset.name);
            });
        });
    }

    function renderPanel(table, range, compareSnap, lastVisit, currentRecords) {
        const oldRecords = compareSnap ? compareSnap.records : null;
        const changes = calculateChanges(currentRecords, oldRecords);
        const topChanges = changes.slice(0, 20);
        const panel = document.createElement('div');
        panel.id = CFG.PANEL_ID;
        const settings = getSettings();

        const legendHtml = `
            <div class="mg-hs-legend">
                <span title="${escapeHtml(INDICATOR_HELP.preciosidades)}">💎 Preciosidades</span>
                <span title="${escapeHtml(INDICATOR_HELP.ouro)}">🪙 Ouro</span>
                <span title="${escapeHtml(INDICATOR_HELP.ancestrais)}">🏆 Ancestrais</span>
                <span title="${escapeHtml(INDICATOR_HELP.vitorias)}">⚔️ Vitórias</span>
                <span title="${escapeHtml(INDICATOR_HELP.derrotas)}">☠️ Derrotas</span>
            </div>
        `;

        if (!compareSnap) {
            panel.innerHTML = `
                <div class="mg-hs-header">
                    <div class="mg-hs-header-left">
                        <div class="mg-hs-title">📊 Comparador de Highscore</div>
                        <div class="mg-hs-range">Posições ${escapeHtml(range)}</div>
                    </div>
                    <div class="mg-hs-header-actions">
                        <button class="mg-hs-icon-btn" data-minimize title="Minimizar">${settings.minimized ? '＋' : '−'}</button>
                    </div>
                </div>
                <div class="mg-hs-lastvisit">
                    ${lastVisit
                        ? `🕓 Última visita: ${fmtDateTime(lastVisit.ts)} · há ${fmtElapsed(Date.now() - lastVisit.ts)}`
                        : '🕓 Primeira coleta desta faixa.'}
                </div>
                ${legendHtml}
                <div class="mg-hs-empty">
                    Ainda coletando dados desta faixa.<br>
                    Volte a esta mesma faixa daqui a pelo menos 1 hora para visualizar as mudanças.
                </div>
            `;
        } else if (!topChanges.length) {
            panel.innerHTML = `
                <div class="mg-hs-header">
                    <div class="mg-hs-header-left">
                        <div class="mg-hs-title">📊 Comparador de Highscore</div>
                        <div class="mg-hs-range">${escapeHtml(range)} · últimos ${fmtElapsed(Date.now() - compareSnap.ts)}</div>
                    </div>
                    <div class="mg-hs-header-actions">
                        <button class="mg-hs-icon-btn" data-minimize title="Minimizar">${settings.minimized ? '＋' : '−'}</button>
                    </div>
                </div>
                <div class="mg-hs-lastvisit">🕓 Última visita: ${lastVisit ? fmtDateTime(lastVisit.ts) : '—'}</div>
                ${legendHtml}
                <div class="mg-hs-empty">Nenhuma mudança detectada nesta faixa desde a última comparação.</div>
            `;
        } else {
            panel.innerHTML = `
                <div class="mg-hs-header">
                    <div class="mg-hs-header-left">
                        <div class="mg-hs-title">📊 Comparador de Highscore</div>
                        <div class="mg-hs-range">${escapeHtml(range)} · últimos ${fmtElapsed(Date.now() - compareSnap.ts)}</div>
                    </div>
                    <div class="mg-hs-header-actions">
                        <button class="mg-hs-icon-btn" data-minimize title="Minimizar">${settings.minimized ? '＋' : '−'}</button>
                    </div>
                </div>
                <div class="mg-hs-lastvisit">🕓 Comparando com: ${fmtDateTime(compareSnap.ts)}</div>
                ${legendHtml}
                <div class="mg-hs-list">
                    <div class="mg-hs-scroll">
                        <div class="mg-hs-list-header">
                            <span>Jogador</span>
                            <span>Posição</span>
                            <span title="${escapeHtml(INDICATOR_HELP.preciosidades)}">💎 Preciosidades</span>
                            <span title="${escapeHtml(INDICATOR_HELP.ouro)}">🪙 Ouro</span>
                            <span title="${escapeHtml(INDICATOR_HELP.ancestrais)}">🏆 Ancestrais</span>
                            <span title="${escapeHtml(INDICATOR_HELP.vitorias)}">⚔️ Vitórias</span>
                            <span title="${escapeHtml(INDICATOR_HELP.derrotas)}">☠️ Derrotas</span>
                        </div>
                        ${topChanges.map(item => renderPlayerRow(item.current, item.old)).join('')}
                    </div>
                </div>
            `;
        }

        table.parentNode.insertBefore(panel, table);
        if (settings.minimized) panel.classList.add('mg-hs-minimized');

        const minimize = panel.querySelector('[data-minimize]');
        if (minimize) {
            minimize.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                const newSettings = getSettings();
                newSettings.minimized = !newSettings.minimized;
                saveSettings(newSettings);
                panel.classList.toggle('mg-hs-minimized', newSettings.minimized);
                minimize.textContent = newSettings.minimized ? '＋' : '−';
            });
        }

        attachRowNavigation();
        return { panel, changes };
    }

    function ensureModal() {
        let modal = document.getElementById(CFG.MODAL_ID);
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = CFG.MODAL_ID;
        modal.innerHTML = `
            <div class="mg-hs-modal">
                <div class="mg-hs-modal-head">
                    <span class="mg-hs-modal-title">Histórico de Highscore</span>
                    <button class="mg-hs-tab" data-close type="button">Fechar</button>
                </div>
                <div class="mg-hs-tabs">
                    <button class="mg-hs-tab" data-tab="comparison" type="button">📊 Comparativos</button>
                    <button class="mg-hs-tab" data-tab="panel" type="button">◈ Painéis</button>
                    <button class="mg-hs-tab" data-tab="data" type="button">▤ Dados</button>
                </div>
                <div id="mg-hs-modal-content"></div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => {
            if (e.target === modal || e.target.closest('[data-close]')) modal.classList.remove('open');
        });
        modal.querySelectorAll('[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                modalTab = btn.dataset.tab;
                renderModal();
            });
        });
        return modal;
    }

    async function openAlbum(tab) {
        modalTab = tab;
        const modal = ensureModal();
        modal.classList.add('open');
        await renderModal();
    }

    async function renderModal() {
        const modal = ensureModal();
        modal.querySelectorAll('[data-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === modalTab);
        });
        const content = modal.querySelector('#mg-hs-modal-content');
        const all = (await getAllSnapshots())
            .filter(item => item.server === location.hostname)
            .sort((a, b) => b.ts - a.ts);
        if (modalTab === 'data') {
            renderDataTab(content, all);
            return;
        }
        renderImageTab(content, all, modalTab);
    }

    function renderDataTab(content, snapshots) {
        const latest = snapshots[0];
        if (!latest) {
            content.innerHTML = `<div class="mg-hs-empty">Nenhum snapshot salvo.</div>`;
            return;
        }
        const baseline = snapshots.find(item => item.ts === latest.baselineTs);
        const changes = calculateChanges(latest.records, baseline ? baseline.records : null);
        const totals = getTotals(changes);
        content.innerHTML = `
            <div class="mg-hs-analysis">
                <div class="mg-hs-box"><small>Servidor</small><strong>${escapeHtml(latest.server)}</strong></div>
                <div class="mg-hs-box"><small>Faixa</small><strong>${escapeHtml(latest.range)}</strong></div>
                <div class="mg-hs-box"><small>Snapshots</small><strong>${fmtNumber(snapshots.length)}</strong></div>
                <div class="mg-hs-box"><small>Jogadores</small><strong>${fmtNumber(latest.records.length)}</strong></div>
                <div class="mg-hs-box"><small>Subiram</small><strong>${fmtNumber(totals.up)}</strong></div>
                <div class="mg-hs-box"><small>Caíram</small><strong>${fmtNumber(totals.down)}</strong></div>
                <div class="mg-hs-box mg-hs-wide">
                    <div class="mg-hs-wide-row" title="${escapeHtml(INDICATOR_HELP.preciosidades)}"><span>💎 Preciosidades</span><strong>${fmtSigned(totals.preciosidades)}</strong></div>
                    <div class="mg-hs-wide-row" title="${escapeHtml(INDICATOR_HELP.ouro)}"><span>🪙 Ouro</span><strong>${fmtSigned(totals.ouro)}</strong></div>
                    <div class="mg-hs-wide-row" title="${escapeHtml(INDICATOR_HELP.ancestrais)}"><span>🏆 Ancestrais</span><strong>${fmtSigned(totals.ancestrais)}</strong></div>
                    <div class="mg-hs-wide-row" title="${escapeHtml(INDICATOR_HELP.vitorias)}"><span>⚔️ Vitórias</span><strong>${fmtSigned(totals.vitorias)}</strong></div>
                    <div class="mg-hs-wide-row" title="${escapeHtml(INDICATOR_HELP.derrotas)}"><span>☠️ Derrotas</span><strong>${fmtSigned(totals.derrotas)}</strong></div>
                </div>
            </div>
        `;
    }

    function renderImageTab(content, snapshots, type) {
        const cards = snapshots.map(snapshot => {
            const image = snapshot.images && snapshot.images[type];
            const fullUrl = image && (image.url || image.display_url || '');
            const previewUrl = image && (image.medium || image.thumbnail || image.url || '');

            return `
                <div class="mg-hs-card" data-snapshot-id="${escapeHtml(snapshot.id)}">
                    ${fullUrl
                        ? `<a href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener">
                               <img class="mg-hs-card-preview" src="${escapeHtml(previewUrl)}" alt="" loading="lazy">
                           </a>`
                        : `<div class="mg-hs-card-empty">Imagem ainda não disponível</div>`}
                    <div class="mg-hs-card-body">
                        <span class="mg-hs-card-title" title="${escapeHtml(snapshot.title || '')}">${escapeHtml(snapshot.title || 'Snapshot')}</span>
                        <span class="mg-hs-card-date">${fmtDateTime(snapshot.ts)} · posições ${escapeHtml(snapshot.range)}</span>
                        <div class="mg-hs-card-actions">
                            <button data-action="rename" data-id="${escapeHtml(snapshot.id)}" type="button">✎ Nome</button>
                            <button data-action="delete" data-id="${escapeHtml(snapshot.id)}" type="button">× Apagar</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        content.innerHTML = `<div class="mg-hs-gallery">${cards || `<div class="mg-hs-empty">Nenhuma imagem salva.</div>`}</div>`;

        content.querySelectorAll('[data-action="rename"]').forEach(button => {
            button.addEventListener('click', async e => {
                e.preventDefault();
                e.stopPropagation();
                const snapshot = snapshots.find(item => item.id === button.dataset.id);
                if (!snapshot) return;
                const current = snapshot.title || `Snapshot ${fmtDateTime(snapshot.ts)}`;
                const name = prompt('Novo nome para este snapshot:', current);
                if (name === null) return;
                const trimmed = name.trim();
                if (!trimmed) return;
                snapshot.title = trimmed;
                await putSnapshot(snapshot);
                await renderModal();
            });
        });

        content.querySelectorAll('[data-action="delete"]').forEach(button => {
            button.addEventListener('click', async e => {
                e.preventDefault();
                e.stopPropagation();
                const snapshot = snapshots.find(item => item.id === button.dataset.id);
                if (!snapshot) return;
                if (!confirm(`Apagar o snapshot "${snapshot.title}"?`)) return;
                await deleteSnapshot(snapshot.id);
                await renderModal();
            });
        });
    }

    function xmlEscape(value) {
        return escapeHtml(value);
    }

    function svgText(x, y, value, size = 16, color = '#ead2b5', weight = 400, anchor = 'start') {
        return `<text x="${x}" y="${y}" fill="${color}" font-family="Georgia, 'Times New Roman', serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${xmlEscape(value)}</text>`;
    }

    function svgRect(x, y, width, height, fill = '#1b0808', stroke = '#4d1717') {
        return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${fill}" stroke="${stroke}"/>`;
    }

    function comparisonSVG(snapshot, compareSnap, changes) {
        const totals = getTotals(changes);
        const rows = changes.slice(0, 30);
        const rowHeight = 72;
        const height = Math.max(1100, 680 + rows.length * rowHeight);
        const W = CFG.COMPARISON_W;

        let svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">
                <rect width="${W}" height="${height}" fill="#0f0505"/>
                ${svgRect(40, 40, W - 80, height - 80, '#1f0a0a', '#6e2222')}
                ${svgText(80, 100, 'MONSTERSGAME', 26, '#9d6a47', 700)}
                ${svgText(80, 155, 'COMPARATIVO DE HIGHSCORE', 42, '#f0c999', 700)}
                ${svgText(80, 195, `${snapshot.server} · posições ${snapshot.range}`, 18, '#b99472')}
                ${svgText(W - 80, 100, fmtDateTime(snapshot.ts), 16, '#d8b28d', 700, 'end')}
        `;

        if (!compareSnap) {
            svg += `
                ${svgRect(80, 240, W - 160, 220)}
                ${svgText(W / 2, 340, 'REGISTRO INICIAL', 34, '#f0c999', 700, 'middle')}
                ${svgText(W / 2, 390, 'Este snapshot representa o ponto de partida do histórico.', 20, '#b98e6c', 400, 'middle')}
            `;
            return svg + '</svg>';
        }

        const cards = [
            ['ALTERADOS', totals.changed],
            ['NOVOS', totals.newPlayers],
            ['SUBIRAM', totals.up],
            ['CAÍRAM', totals.down]
        ];
        cards.forEach((card, index) => {
            const gap = 20;
            const cw = (W - 160 - gap * 3) / 4;
            const x = 80 + index * (cw + gap);
            svg += `
                ${svgRect(x, 230, cw, 100)}
                ${svgText(x + 22, 268, card[0], 13, '#9b765c', 700)}
                ${svgText(x + 22, 310, fmtNumber(card[1]), 32, '#f1d0a5', 700)}
            `;
        });

        const headerY = 360;
        svg += `
            ${svgRect(80, headerY, W - 160, 88, '#140404', '#4d1717')}
            ${svgText(100, headerY + 30, 'JOGADOR', 14, '#b9916e', 700)}
            ${svgText(620, headerY + 30, 'POSIÇÃO', 14, '#b9916e', 700)}
            ${svgText(820, headerY + 30, 'PRECIOSIDADES', 14, '#b9916e', 700)}
            ${svgText(1150, headerY + 30, 'OURO', 14, '#b9916e', 700)}
            ${svgText(1450, headerY + 30, 'ANCESTRAIS', 14, '#b9916e', 700)}
            ${svgText(1800, headerY + 30, 'VITÓRIAS', 14, '#b9916e', 700)}
            ${svgText(2150, headerY + 30, 'DERROTAS', 14, '#b9916e', 700)}
            ${svgText(100, headerY + 58, 'Jogador', 12, '#755844')}
            ${svgText(620, headerY + 58, 'atual / variação', 12, '#755844')}
            ${svgText(820, headerY + 58, 'atual / diferença', 12, '#755844')}
            ${svgText(1150, headerY + 58, 'atual / diferença', 12, '#755844')}
            ${svgText(1450, headerY + 58, 'atual / diferença', 12, '#755844')}
            ${svgText(1800, headerY + 58, 'atual / diferença', 12, '#755844')}
            ${svgText(2150, headerY + 58, 'atual / diferença', 12, '#755844')}
        `;

        const colorFor = v => v > 0 ? '#72d98b' : v < 0 ? '#ef7777' : '#c5a98a';

        rows.forEach((item, index) => {
            const y = 470 + index * rowHeight;
            const posText = item.isNew
                ? 'NOVO'
                : `${item.current.pos}º ${item.pos > 0 ? '▲' + item.pos : item.pos < 0 ? '▼' + Math.abs(item.pos) : '—'}`;

            svg += `
                ${svgRect(80, y, W - 160, 62, index % 2 ? '#1a0808' : '#260c0c', 'none')}
                ${svgText(100, y + 38, `${index + 1}. ${item.current.name}`, 18, '#ead0ac', 700)}
                ${svgText(620, y + 38, posText, 15, item.isNew ? '#75c7ff' : colorFor(item.pos), 700)}
                ${svgText(820, y + 38, `${fmtNumber(item.current.preciosidades)} / ${fmtSigned(item.preciosidades)}`, 15, colorFor(item.preciosidades), 700)}
                ${svgText(1150, y + 38, `${fmtNumber(item.current.ouro)} / ${fmtSigned(item.ouro)}`, 15, colorFor(item.ouro), 700)}
                ${svgText(1450, y + 38, `${fmtNumber(item.current.ancestrais)} / ${fmtSigned(item.ancestrais)}`, 15, colorFor(item.ancestrais), 700)}
                ${svgText(1800, y + 38, `${fmtNumber(item.current.v)} / ${fmtSigned(item.vitorias)}`, 15, colorFor(item.vitorias), 700)}
                ${svgText(2150, y + 38, `${fmtNumber(item.current.d)} / ${fmtSigned(item.derrotas)}`, 15, colorFor(item.derrotas), 700)}
            `;
        });

        svg += svgText(80, height - 55, 'Legenda: valor atual / variação desde o snapshot de comparação  ·  Preciosidades · Ouro · Ancestrais · Vitórias · Derrotas', 14, '#85634d');
        return svg + '</svg>';
    }

    function panelSVG(snapshot, compareSnap, changes) {
        const totals = getTotals(changes);
        const W = CFG.PANEL_W;
        const H = CFG.PANEL_H;

        let svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
                <rect width="${W}" height="${H}" fill="#0f0505"/>
                ${svgRect(40, 40, W - 80, H - 80, '#1f0a0a', '#6e2222')}
                ${svgText(80, 105, 'MONSTERSGAME', 26, '#9d6a47', 700)}
                ${svgText(80, 160, 'PAINEL DE HIGHSCORE', 42, '#f0c999', 700)}
                ${svgText(80, 200, `${snapshot.server} · posições ${snapshot.range}`, 18, '#b99472')}
                ${svgText(W - 80, 105, fmtDateTime(snapshot.ts), 16, '#d8b28d', 700, 'end')}
        `;

        const cards = [
            ['JOGADORES', snapshot.records.length],
            ['ALTERADOS', totals.changed],
            ['NOVOS', totals.newPlayers],
            ['SUBIRAM', totals.up],
            ['CAÍRAM', totals.down],
            ['SEM TROCA', totals.stable]
        ];
        cards.forEach((card, index) => {
            const x = 80 + (index % 3) * 740;
            const y = 250 + Math.floor(index / 3) * 140;
            svg += `
                ${svgRect(x, y, 700, 120)}
                ${svgText(x + 28, y + 42, card[0], 15, '#9b765c', 700)}
                ${svgText(x + 28, y + 90, fmtNumber(card[1]), 36, '#edc99e', 700)}
            `;
        });

        svg += svgText(80, 580, 'VARIAÇÃO DAS ESTATÍSTICAS', 20, '#9d6a47', 700);

        const stats = [
            ['💎 Preciosidades', totals.preciosidades],
            ['🪙 Ouro', totals.ouro],
            ['🏆 Ancestrais', totals.ancestrais],
            ['⚔️ Vitórias', totals.vitorias],
            ['☠️ Derrotas', totals.derrotas]
        ];
        stats.forEach((stat, index) => {
            const y = 630 + index * 95;
            svg += `
                ${svgRect(80, y, W - 160, 80, index % 2 ? '#180909' : '#260c0c', 'none')}
                ${svgText(110, y + 50, stat[0], 22, '#ead0ac', 700)}
                ${svgText(W - 110, y + 50, fmtSigned(stat[1]), 22,
                    stat[1] > 0 ? '#72d98b' : stat[1] < 0 ? '#ef7777' : '#c5a98a', 700, 'end')}
            `;
        });

        svg += svgText(80, 1160, 'PRINCIPAIS MOVIMENTAÇÕES', 20, '#9d6a47', 700);

        changes.slice(0, 7).forEach((item, index) => {
            const y = 1220 + index * 55;
            const label = item.isNew ? 'NOVO' :
                item.pos > 0 ? `▲ ${item.pos}` :
                item.pos < 0 ? `▼ ${Math.abs(item.pos)}` : '—';
            svg += `
                ${svgText(110, y, `${index + 1}. ${item.current.name}`, 18, '#ead0ac', 700)}
                ${svgText(W - 110, y, label, 17,
                    item.isNew ? '#75c7ff' : item.pos > 0 ? '#72d98b' : item.pos < 0 ? '#ef7777' : '#c5a98a', 700, 'end')}
            `;
        });

        svg += svgText(80, H - 55, 'Preciosidades · Ouro · Ancestrais · Vitórias · Derrotas  ·  Snapshot de alta resolução (3×)', 14, '#85634d');
        return svg + '</svg>';
    }

    function svgToBlob(svgString, width, height) {
        return new Promise((resolve, reject) => {
            const finalSvg = svgString.replace(
                /<svg([^>]*)>/i,
                (match, attrs) => {
                    let clean = attrs
                        .replace(/\s*width\s*=\s*["'][^"']*["']/gi, '')
                        .replace(/\s*height\s*=\s*["'][^"']*["']/gi, '')
                        .replace(/\s*viewBox\s*=\s*["'][^"']*["']/gi, '');
                    return `<svg${clean} width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
                }
            );

            const blob = new Blob([finalSvg], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const img = new Image();

            img.onload = () => {
                const scale = CFG.SNAPSHOT_SCALE;
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(width * scale);
                canvas.height = Math.round(height * scale);

                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.fillStyle = '#0f0505';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                canvas.toBlob(result => {
                    URL.revokeObjectURL(url);
                    if (!result) {
                        reject(new Error('Falha ao gerar blob PNG'));
                        return;
                    }
                    resolve(result);
                }, 'image/png', 1.0);
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Falha ao carregar SVG'));
            };

            img.src = url;
        });
    }

    async function uploadImage(blob, filename) {
        const form = new FormData();
        form.append('image', blob, filename);
        form.append('file', blob, filename);

        const response = await fetch(`${CFG.WORKER_URL}/upload`, {
            method: 'POST',
            body: form
        });

        let data = null;
        try {
            data = await response.json();
        } catch (e) {}

        if (!response.ok || !data || !data.success) {
            throw new Error(
                data?.details?.reason || data?.error || `HTTP ${response.status}`
            );
        }

        const imgObj = data.image || {};
        const fullUrl = imgObj.url || imgObj.display_url || data.url || '';
        const mediumUrl = data.medium || '';
        const thumbUrl = data.thumbnail || imgObj.thumb?.url || '';

        return {
            url: fullUrl,
            medium: mediumUrl,
            thumbnail: thumbUrl || mediumUrl || fullUrl,
            viewer: data.delete_url ? data.delete_url.replace('/delete/', '/') : ''
        };
    }

    async function generateAndUpload(snapshot, compareSnap) {
        if (!compareSnap) return;

        const changes = calculateChanges(snapshot.records, compareSnap.records);
        const rowsCount = Math.min(changes.length, 30);
        const comparisonHeight = Math.max(1100, 680 + rowsCount * 72);

        const comparisonBlob = await svgToBlob(
            comparisonSVG(snapshot, compareSnap, changes),
            CFG.COMPARISON_W,
            comparisonHeight
        );

        const panelBlob = await svgToBlob(
            panelSVG(snapshot, compareSnap, changes),
            CFG.PANEL_W,
            CFG.PANEL_H
        );

        snapshot.images.comparison = await uploadImage(comparisonBlob, `mg-comparativo-${snapshot.ts}.png`);
        snapshot.upload.comparison = 'ok';
        await putSnapshot(snapshot);

        snapshot.images.panel = await uploadImage(panelBlob, `mg-painel-${snapshot.ts}.png`);
        snapshot.upload.panel = 'ok';
        await putSnapshot(snapshot);
    }

    async function run() {
        const table = findTable();
        if (!table) return;
        if (document.getElementById(CFG.PANEL_ID)) return;

        buildStyles();

        const records = parseHighscoreTable(table);
        if (!records.length) return;

        const range = rangeKeyFor(records);
        const state = await createSnapshot(records, range);
        currentState = state;

        renderPanel(table, range, state.compareSnap, state.lastVisit, records);
        createTools(table);

        if (state.compareSnap) {
            const statusEl = document.querySelector(`#${CFG.TOOLS_ID} .mg-hs-tool-status`);
            try {
                isUploading = true;
                if (statusEl) {
                    statusEl.textContent = 'Gerando imagens…';
                    statusEl.className = 'mg-hs-tool-status busy';
                }
                await generateAndUpload(state.snapshot, state.compareSnap);
                if (statusEl) {
                    statusEl.textContent = '✓ Imagens salvas';
                    statusEl.className = 'mg-hs-tool-status ok';
                }
            } catch (error) {
                console.error('[MG Highscore]', error);
                state.snapshot.upload.comparison = 'pending';
                state.snapshot.upload.panel = 'pending';
                await putSnapshot(state.snapshot);
                if (statusEl) {
                    statusEl.textContent = 'Upload pendente';
                    statusEl.className = 'mg-hs-tool-status err';
                }
            } finally {
                isUploading = false;
            }
        }
    }

    let attempts = 0;
    const timer = setInterval(async () => {
        if (findTable()) {
            clearInterval(timer);
            try {
                await run();
            } catch (error) {
                console.error('[MG Highscore]', error);
            }
        }
        attempts++;
        if (attempts > 40) clearInterval(timer);
    }, 500);
})();