require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_URL = "https://live-football-api.com/api/v1";
const JWT_SECRET = process.env.JWT_SECRET || "arena_analytics_secret_key_2026";
const USERS_FILE = path.join(__dirname, "users.json");

app.use(cors());
app.use(express.json());

/* =========================================================
   1. BANCO DE DADOS EM ARQUIVO LOCAL (JSON) & ADMIN AUTOMÁTICO
========================================================= */

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify([]));
    }
    try {
        const data = fs.readFileSync(USERS_FILE, "utf8");
        return JSON.parse(data || "[]");
    } catch (e) {
        return [];
    }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Garante que o usuário Administrador (Acesso VIP Total) exista no sistema
async function ensureAdminUserExists() {
    const users = loadUsers();
    const adminEmail = "admin@arena.com";

    const adminExists = users.find(u => u.email.toLowerCase() === adminEmail);

    if (!adminExists) {
        const hashedPassword = await bcrypt.hash("admin123", 10);
        const adminUser = {
            id: "1000",
            name: "Administrador Master",
            email: adminEmail,
            password: hashedPassword,
            isVip: true,
            isAdmin: true,
            createdAt: new Date().toISOString()
        };
        users.push(adminUser);
        saveUsers(users);
        console.log("----------------------------------------");
        console.log("✅ CONTA ADMIN CRIADA COM SUCESSO!");
        console.log("LOGIN: admin@arena.com");
        console.log("SENHA: admin123");
        console.log("----------------------------------------");
    }
}

ensureAdminUserExists();

/* Middleware de Autenticação via JWT */
function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        req.user = null;
        return next();
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) req.user = null;
        else req.user = user;
        next();
    });
}

app.use(authenticateToken);

/* =========================================================
   2. ROTAS DE AUTENTICAÇÃO E GERENCIAMENTO ADMIN
========================================================= */

app.post("/api/auth/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ success: false, error: "Preencha todos os campos." });

        const users = loadUsers();
        if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
            return res.status(400).json({ success: false, error: "E-mail já cadastrado." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: Date.now().toString(),
            name,
            email: email.toLowerCase(),
            password: hashedPassword,
            isVip: false,
            isAdmin: false,
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        saveUsers(users);

        const token = jwt.sign({ id: newUser.id, name: newUser.name, email: newUser.email, isVip: newUser.isVip, isAdmin: newUser.isAdmin }, JWT_SECRET, { expiresIn: "7d" });

        res.json({ success: true, token, user: { id: newUser.id, name: newUser.name, email: newUser.email, isVip: newUser.isVip, isAdmin: newUser.isAdmin } });
    } catch (error) {
        res.status(500).json({ success: false, error: "Erro ao criar conta." });
    }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ success: false, error: "Informe e-mail e senha." });

        const users = loadUsers();
        const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ success: false, error: "Usuário ou senha inválidos." });
        }

        const token = jwt.sign({ id: user.id, name: user.name, email: user.email, isVip: user.isVip, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: "7d" });

        res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, isVip: user.isVip, isAdmin: user.isAdmin } });
    } catch (error) {
        res.status(500).json({ success: false, error: "Erro ao realizar login." });
    }
});

app.get("/api/auth/me", (req, res) => {
    if (!req.user) return res.json({ success: false, user: null });
    const users = loadUsers();
    const currentUser = users.find(u => u.id === req.user.id);

    if (!currentUser) return res.json({ success: false, user: null });

    res.json({
        success: true,
        user: { id: currentUser.id, name: currentUser.name, email: currentUser.email, isVip: currentUser.isVip, isAdmin: currentUser.isAdmin }
    });
});

/* Rotas de Painel de Controle de Usuários (Apenas Admin) */
app.get("/api/admin/users", (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ success: false, error: "Acesso negado." });
    const users = loadUsers().map(u => ({ id: u.id, name: u.name, email: u.email, isVip: u.isVip, isAdmin: u.isAdmin }));
    res.json({ success: true, users });
});

app.post("/api/admin/toggle-vip", (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ success: false, error: "Acesso negado." });
    const { userId } = req.body;

    const users = loadUsers();
    const targetUser = users.find(u => u.id === userId);

    if (!targetUser) return res.status(404).json({ success: false, error: "Usuário não encontrado." });

    targetUser.isVip = !targetUser.isVip;
    saveUsers(users);

    res.json({ success: true, isVip: targetUser.isVip });
});

/* =========================================================
   3. API DE FUTEBOL E CÁLCULOS ESTATÍSTICOS
========================================================= */

async function footballAPI(endpoint, params = {}) {
    if (!API_KEY) throw new Error("Chave da API não configurada.");
    const url = new URL(API_URL + endpoint);
    url.searchParams.set("api_key", API_KEY);
    url.searchParams.set("lang", "en");

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Erro HTTP ${response.status}`);
    const data = await response.json();
    if (!data.success) throw new Error(data.message || "Erro na API.");
    return data;
}

function calculateStats(matches, teamId) {
    if (!Array.isArray(matches)) return { games: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, averageGoals: 0, averageConceded: 0, points: 0 };

    const completed = matches.filter(match => {
        const status = typeof match.status === "object" ? match.status.status : match.status;
        return ["FT", "AET", "PEN", "PENS"].includes(status);
    }).slice(0, 10);

    let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;

    completed.forEach(match => {
        const isHome = String(match.home?.id) === String(teamId);
        const scored = Number(isHome ? match.home?.score : match.away?.score) || 0;
        const conceded = Number(isHome ? match.away?.score : match.home?.score) || 0;

        goalsFor += scored;
        goalsAgainst += conceded;

        if (scored > conceded) wins++;
        else if (scored === conceded) draws++;
        else losses++;
    });

    const games = completed.length;
    return {
        games, wins, draws, losses, goalsFor, goalsAgainst,
        averageGoals: games ? goalsFor / games : 0,
        averageConceded: games ? goalsAgainst / games : 0,
        points: wins * 3 + draws
    };
}

function calculatePoissonScore(expectedHome, expectedAway) {
    const factorial = (n) => (n <= 1 ? 1 : n * factorial(n - 1));
    const poisson = (k, lambda) => (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);

    let maxProb = 0, bestScore = "1 - 1";
    for (let h = 0; h <= 4; h++) {
        for (let a = 0; a <= 4; a++) {
            const prob = poisson(h, expectedHome) * poisson(a, expectedAway);
            if (prob > maxProb) {
                maxProb = prob;
                bestScore = `${h} - ${a}`;
            }
        }
    }
    return { bestScore, probability: (maxProb * 100).toFixed(1) + "%" };
}

app.get("/api/teams/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q || q.length < 2) return res.json({ success: true, teams: [] });
        const data = await footballAPI("/team_search", { q });
        res.json({ success: true, teams: data.data || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: "Falha na busca dos times." });
    }
});

app.get("/api/analyze", async (req, res) => {
    try {
        const { home, away } = req.query;
        if (!home || !away) return res.status(400).json({ success: false, error: "Selecione ambos os times." });

        const [homeMatches, awayMatches] = await Promise.all([
            footballAPI("/team_matches", { team_id: home }),
            footballAPI("/team_matches", { team_id: away })
        ]);

        const homeStats = calculateStats(homeMatches.data?.matches, home);
        const awayStats = calculateStats(awayMatches.data?.matches, away);

        let homeScore = 50 + (homeStats.averageGoals - awayStats.averageConceded) * 12 + (homeStats.points - awayStats.points) * 0.8 + 5;
        let awayScore = 50 + (awayStats.averageGoals - homeStats.averageConceded) * 12 + (awayStats.points - homeStats.points) * 0.8;
        let drawScore = Math.max(1, 35 - Math.abs(homeScore - awayScore) * 0.25);

        homeScore = Math.max(1, homeScore);
        awayScore = Math.max(1, awayScore);
        const total = homeScore + awayScore + drawScore;

        const probabilities = { home: homeScore / total, draw: drawScore / total, away: awayScore / total };
        const expectedHome = Math.max(0.1, homeStats.averageGoals * 0.65 + awayStats.averageConceded * 0.35);
        const expectedAway = Math.max(0.1, awayStats.averageGoals * 0.65 + homeStats.averageConceded * 0.35);

        const poisson = calculatePoissonScore(expectedHome, expectedAway);
        const projectedCorners = (8.5 + (expectedHome + expectedAway) * 1.2).toFixed(1);
        const projectedCards = (3.5 + Math.abs(homeStats.points - awayStats.points) * 0.1).toFixed(1);

        res.json({
            success: true,
            stats: { home: homeStats, away: awayStats },
            probabilities,
            expectedGoals: { home: expectedHome, away: expectedAway },
            vip: { exactScore: poisson.bestScore, exactScoreConfidence: poisson.probability, projectedCorners, projectedCards }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: "Erro na análise estatística." });
    }
});

/* =========================================================
   4. MANIFESTO & SERVICE WORKER PARA APP WEB / PWA
========================================================= */

app.get("/manifest.json", (req, res) => {
    res.json({
        name: "Arena Analytics VIP",
        short_name: "ArenaAI",
        description: "Inteligência Estatística de Futebol",
        start_url: "/",
        display: "standalone",
        background_color: "#070a0f",
        theme_color: "#10b981",
        icons: [{ src: "https://cdn-icons-png.flaticon.com/512/53/53283.png", sizes: "192x192", type: "image/png" }]
    });
});

app.get("/sw.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.send(`
        const CACHE_NAME = 'arena-v5';
        self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(['/']))));
        self.addEventListener('fetch', e => {
            if (e.request.url.includes('/api/')) return;
            e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
        });
    `);
});

/* =========================================================
   5. INTERFACE DO USUÁRIO (FRONTEND WEB COMPLETO)
========================================================= */

const HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Arena Analytics — Análises Esportivas e Sistema VIP</title>

<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#10b981">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">

<style>
:root {
  --bg-main: #070a0f;
  --bg-card: #0f172a;
  --accent: #10b981;
  --vip-gold: #f59e0b;
  --text-white: #ffffff;
  --text-muted: #9ca3af;
  --border-color: #1e293b;
}

* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
body { background: var(--bg-main); color: var(--text-white); min-height: 100vh; }

header {
  height: 70px; padding: 0 5%; display: flex; align-items: center; justify-content: space-between;
  background: rgba(7, 10, 15, 0.9); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border-color);
  position: sticky; top: 0; z-index: 100;
}

.logo { font-size: 20px; font-weight: 800; display: flex; align-items: center; gap: 6px; }
.logo span { color: var(--accent); }

.nav-actions { display: flex; gap: 10px; align-items: center; }
.btn-auth {
  background: transparent; border: 1px solid var(--border-color); color: #fff;
  padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; transition: 0.2s;
}
.btn-auth:hover { border-color: var(--accent); color: var(--accent); }
.btn-admin { background: #ef4444 !important; border: 0 !important; color: white !important; font-weight: 800; }

.vip-badge-head {
  background: linear-gradient(135deg, #f59e0b, #d97706); color: #000; font-size: 11px;
  font-weight: 800; padding: 8px 14px; border-radius: 20px; text-transform: uppercase; cursor: pointer;
}

.tag-vip { background: var(--vip-gold); color: #000; font-size: 10px; padding: 3px 8px; border-radius: 4px; font-weight: 800; }

.hero { text-align: center; padding: 40px 5% 20px; }
.hero h1 { font-size: clamp(32px, 5vw, 54px); font-weight: 800; }
.hero h1 span { color: var(--accent); }

.analyzer-container { max-width: 1000px; margin: 20px auto; padding: 0 5%; }
.search-grid { display: grid; grid-template-columns: 1fr 40px 1fr; gap: 15px; align-items: center; }
.search-box { position: relative; }
.search-box input {
  width: 100%; padding: 16px; background: var(--bg-card); border: 1px solid var(--border-color);
  border-radius: 12px; color: white; font-size: 15px; outline: none;
}
.search-box input:focus { border-color: var(--accent); }
.search-results {
  position: absolute; top: 75px; left: 0; right: 0; background: #0d1527;
  border: 1px solid var(--border-color); border-radius: 12px; z-index: 50; max-height: 200px; overflow-y: auto;
}
.search-result { padding: 12px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.05); }
.search-result:hover { background: rgba(16, 185, 129, 0.1); }

.btn-primary {
  width: 100%; background: var(--accent); color: #031008; border: 0; padding: 16px;
  border-radius: 12px; font-weight: 800; font-size: 16px; cursor: pointer; margin-top: 20px; transition: 0.2s;
}
.btn-primary:hover { opacity: 0.9; }

.results-section { max-width: 1000px; margin: 40px auto; padding: 0 5%; }
.hidden { display: none !important; }

.cards-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 20px; }
.card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 14px; padding: 20px; text-align: center; }
.card span { font-size: 12px; color: var(--text-muted); font-weight: 700; }
.card strong { font-size: 26px; color: var(--accent); display: block; margin-top: 4px; }

/* PAINEL VIP */
.vip-card {
  position: relative; background: linear-gradient(145deg, #131c31, #0d1322);
  border: 2px solid var(--vip-gold); border-radius: 18px; padding: 28px; margin-top: 30px; overflow: hidden;
}
.vip-content-blur { filter: blur(7px); opacity: 0.3; user-select: none; pointer-events: none; }
.vip-unlocked { filter: none !important; opacity: 1 !important; user-select: auto !important; pointer-events: auto !important; }

.vip-overlay {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(13, 19, 34, 0.88); backdrop-filter: blur(4px);
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20px;
}
.btn-vip {
  background: linear-gradient(135deg, #f59e0b, #d97706); color: #000; border: 0;
  padding: 14px 32px; border-radius: 12px; font-weight: 800; font-size: 15px; cursor: pointer; transition: 0.2s;
}
.btn-vip:hover { transform: translateY(-1px); }

/* MODAIS */
.modal-backdrop {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85);
  display: flex; align-items: center; justify-content: center; z-index: 200; padding: 20px;
}
.modal-card {
  background: #0f172a; border: 1px solid var(--border-color); border-radius: 20px;
  max-width: 450px; width: 100%; padding: 30px; position: relative;
}
.close-modal { position: absolute; top: 15px; right: 15px; color: var(--text-muted); cursor: pointer; font-weight: 800; }

.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; font-weight: 700; }
.form-group input {
  width: 100%; padding: 12px; background: #070a0f; border: 1px solid var(--border-color);
  border-radius: 8px; color: white; font-size: 14px; outline: none;
}
.form-group input:focus { border-color: var(--accent); }

.user-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-color); }

@media(max-width: 768px) {
  .search-grid { grid-template-columns: 1fr; }
  .cards-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<header>
  <div class="logo">⚽ ARENA <span>ANALYTICS</span></div>
  
  <div class="nav-actions">
    <button id="adminBtn" class="btn-auth btn-admin hidden" onclick="openAdminModal()">⚙️ PAINEL ADMIN</button>
    
    <div id="loggedOutNav" style="display: flex; gap: 8px;">
      <button class="btn-auth" onclick="openLoginModal()">Entrar</button>
      <button class="btn-auth" style="background: var(--accent); color: #000; border: 0;" onclick="openRegisterModal()">Criar Conta</button>
    </div>

    <div id="loggedInNav" class="hidden" style="display: flex; align-items: center; gap: 10px;">
      <span id="userNameLabel" style="font-size: 13px; font-weight: 700;">-</span>
      <span id="vipBadgeTag" class="tag-vip hidden">VIP</span>
      <button class="btn-auth" onclick="logout()" style="padding: 4px 10px; font-size: 11px;">Sair</button>
    </div>

    <div class="vip-badge-head" onclick="openVipModal()">👑 SEJA VIP</div>
  </div>
</header>

<section class="hero">
  <h1>Inteligência Esportiva <span>& Análises VIP</span></h1>
  <p style="color: var(--text-muted); margin-top: 8px;">Faça login com a conta <b>admin@arena.com</b> ou assine para liberar 100% dos dados.</p>
</section>

<section class="analyzer-container">
  <div class="search-grid">
    <div class="search-box">
      <input id="homeSearch" placeholder="🏠 Time Mandante..." autocomplete="off">
      <div id="homeResults" class="search-results"></div>
    </div>
    <div style="text-align: center; font-weight: 900; color: var(--accent);">VS</div>
    <div class="search-box">
      <input id="awaySearch" placeholder="✈️ Time Visitante..." autocomplete="off">
      <div id="awayResults" class="search-results"></div>
    </div>
  </div>
  <button id="analyzeBtn" class="btn-primary">🤖 GERAR ANÁLISE ESTATÍSTICA</button>
</section>

<section id="estatisticas" class="results-section hidden">
  <h2 id="matchName" style="text-align: center; font-size: 26px;">—</h2>

  <div class="cards-grid">
    <div class="card"><span>MANDANTE</span><strong id="probHome">0%</strong></div>
    <div class="card"><span>EMPATE</span><strong id="probDraw" style="color: #cbd5e1;">0%</strong></div>
    <div class="card"><span>VISITANTE</span><strong id="probAway">0%</strong></div>
  </div>

  <!-- CONTAINER VIP -->
  <div class="vip-card">
    <div style="color: var(--vip-gold); font-size: 16px; font-weight: 800; margin-bottom: 15px;">👑 ESTATÍSTICAS AVANÇADAS VIP</div>

    <div id="vipBlurContainer" class="vip-content-blur">
      <div class="cards-grid">
        <div class="card"><span>PLACAR EXATO (POISSON)</span><strong id="vipScore">2 - 1</strong></div>
        <div class="card"><span>PROJEÇÃO ESCANTEIOS</span><strong id="vipCorners">9.5+</strong></div>
        <div class="card"><span>PROJEÇÃO CARTÕES</span><strong id="vipCards">4.5+</strong></div>
      </div>
    </div>

    <div id="vipOverlay" class="vip-overlay">
      <h4 style="font-size: 20px; margin-bottom: 6px;">🔒 Conteúdo Exclusivo VIP</h4>
      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px;">Faça login com sua conta VIP ou assine para desbloquear os dados de Placar Exato, Escanteios e Cartões.</p>

      <div style="display: flex; gap: 10px;">
        <button class="btn-auth" onclick="openLoginModal()" style="padding: 12px 20px;">Fazer Login</button>
        <button class="btn-vip" onclick="openVipModal()">Assinar Plano VIP</button>
      </div>
    </div>
  </div>
</section>

<!-- MODAL DE LOGIN -->
<div id="loginModal" class="modal-backdrop hidden">
  <div class="modal-card">
    <span class="close-modal" onclick="closeModal('loginModal')">✕</span>
    <h3 style="margin-bottom: 15px;">Acessar sua Conta</h3>
    <form onsubmit="handleLogin(event)">
      <div class="form-group">
        <label>E-mail</label>
        <input type="email" id="loginEmail" value="admin@arena.com" required>
      </div>
      <div class="form-group">
        <label>Senha</label>
        <input type="password" id="loginPassword" value="admin123" required>
      </div>
      <button type="submit" class="btn-primary">Entrar na Conta</button>
    </form>
  </div>
</div>

<!-- MODAL DE CADASTRO -->
<div id="registerModal" class="modal-backdrop hidden">
  <div class="modal-card">
    <span class="close-modal" onclick="closeModal('registerModal')">✕</span>
    <h3 style="margin-bottom: 15px;">Criar Nova Conta</h3>
    <form onsubmit="handleRegister(event)">
      <div class="form-group">
        <label>Nome Completo</label>
        <input type="text" id="regName" required>
      </div>
      <div class="form-group">
        <label>E-mail</label>
        <input type="email" id="regEmail" required>
      </div>
      <div class="form-group">
        <label>Senha</label>
        <input type="password" id="regPassword" required>
      </div>
      <button type="submit" class="btn-primary">Criar Conta</button>
    </form>
  </div>
</div>

<!-- MODAL PAINEL ADMIN -->
<div id="adminModal" class="modal-backdrop hidden">
  <div class="modal-card" style="max-width: 600px;">
    <span class="close-modal" onclick="closeModal('adminModal')">✕</span>
    <h3 style="margin-bottom: 20px; color: #ef4444;">⚙️ Painel de Controle de Usuários</h3>
    <div id="usersList">Carregando usuários...</div>
  </div>
</div>

<!-- MODAL ASSINATURA VIP -->
<div id="vipModal" class="modal-backdrop hidden">
  <div class="modal-card" style="text-align: center;">
    <span class="close-modal" onclick="closeModal('vipModal')">✕</span>
    <div style="color: var(--vip-gold); font-size: 12px; font-weight: 800;">PLANO VIP ARENA ANALYTICS</div>
    <div style="font-size: 36px; font-weight: 800; margin: 10px 0;">R$ 19,90 <span style="font-size: 14px; color: var(--text-muted);">/mês</span></div>
    
    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px;">Acesse o algoritmo estatístico avançado de placar exato e mercados de escanteios e cartões.</p>

    <a href="https://seu-link-de-pagamento-aqui.com" target="_blank" style="text-decoration: none;">
      <button class="btn-vip" style="width: 100%;">ASSINAR AGORA COM PIX</button>
    </a>
  </div>
</div>

<script>
let currentUser = null;
let homeTeam = null;
let awayTeam = null;

window.onload = checkAuth;

async function checkAuth() {
  const token = localStorage.getItem("arena_token");
  if (!token) return;

  try {
    const res = await fetch("/api/auth/me", { headers: { "Authorization": "Bearer " + token } });
    const data = await res.json();
    if (data.success && data.user) {
      currentUser = data.user;
      updateNav(currentUser);
    } else logout();
  } catch (e) { logout(); }
}

function updateNav(user) {
  if (user) {
    document.getElementById("loggedOutNav").style.display = "none";
    document.getElementById("loggedInNav").classList.remove("hidden");
    document.getElementById("userNameLabel").innerText = user.name;
    
    if (user.isAdmin) {
      document.getElementById("adminBtn").classList.remove("hidden");
    }

    if (user.isVip || user.isAdmin) {
      document.getElementById("vipBadgeTag").classList.remove("hidden");
      unlockVipArea();
    }
  }
}

function unlockVipArea() {
  document.getElementById("vipBlurContainer").classList.add("vip-unlocked");
  document.getElementById("vipOverlay").style.display = "none";
}

async function handleLogin(e) {
  e.preventDefault();
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: document.getElementById("loginEmail").value,
      password: document.getElementById("loginPassword").value
    })
  });
  const data = await res.json();
  if (data.success) {
    localStorage.setItem("arena_token", data.token);
    currentUser = data.user;
    updateNav(currentUser);
    closeModal("loginModal");
  } else alert(data.error);
}

async function handleRegister(e) {
  e.preventDefault();
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("regName").value,
      email: document.getElementById("regEmail").value,
      password: document.getElementById("regPassword").value
    })
  });
  const data = await res.json();
  if (data.success) {
    localStorage.setItem("arena_token", data.token);
    currentUser = data.user;
    updateNav(currentUser);
    closeModal("registerModal");
  } else alert(data.error);
}

function logout() {
  localStorage.removeItem("arena_token");
  location.reload();
}

// Painel Admin
async function openAdminModal() {
  document.getElementById("adminModal").classList.remove("hidden");
  const res = await fetch("/api/admin/users", {
    headers: { "Authorization": "Bearer " + localStorage.getItem("arena_token") }
  });
  const data = await res.json();
  
  if (data.success) {
    const list = document.getElementById("usersList");
    list.innerHTML = "";
    data.users.forEach(u => {
      const div = document.createElement("div");
      div.className = "user-row";
      div.innerHTML = \`
        <div>
          <b>\${u.name}</b> <small>(\${u.email})</small>
          \${u.isVip ? '<span class="tag-vip">VIP</span>' : ''}
        </div>
        <button onclick="toggleVip('\${u.id}')" style="padding: 6px 12px; font-size: 11px; cursor: pointer;">
          \${u.isVip ? 'Remover VIP' : 'Dar VIP'}
        </button>
      \`;
      list.appendChild(div);
    });
  }
}

async function toggleVip(userId) {
  await fetch("/api/admin/toggle-vip", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + localStorage.getItem("arena_token")
    },
    body: JSON.stringify({ userId })
  });
  openAdminModal();
}

function openLoginModal() { document.getElementById("loginModal").classList.remove("hidden"); }
function openRegisterModal() { document.getElementById("registerModal").classList.remove("hidden"); }
function openVipModal() { document.getElementById("vipModal").classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

// Busca e Análise de Times
const homeSearch = document.getElementById("homeSearch");
const awaySearch = document.getElementById("awaySearch");

async function searchTeams(query, resultsElement, type) {
  if (query.length < 2) return;
  const res = await fetch("/api/teams/search?q=" + encodeURIComponent(query));
  const data = await res.json();
  resultsElement.innerHTML = "";
  (data.teams || []).slice(0, 5).forEach(team => {
    const div = document.createElement("div");
    div.className = "search-result";
    div.innerHTML = \`<b>\${team.name}</b>\`;
    div.onclick = () => {
      if(type==='home'){ homeTeam=team; homeSearch.value=team.name; }
      else { awayTeam=team; awaySearch.value=team.name; }
      resultsElement.innerHTML = "";
    };
    resultsElement.appendChild(div);
  });
}

homeSearch.addEventListener("input", e => searchTeams(e.target.value.trim(), document.getElementById("homeResults"), "home"));
awaySearch.addEventListener("input", e => searchTeams(e.target.value.trim(), document.getElementById("awayResults"), "away"));

document.getElementById("analyzeBtn").addEventListener("click", async () => {
  if(!homeTeam || !awayTeam) return alert("Selecione os dois times!");
  const res = await fetch(\`/api/analyze?home=\${homeTeam.id}&away=\${awayTeam.id}\`);
  const data = await res.json();

  document.querySelector(".results-section").classList.remove("hidden");
  document.getElementById("matchName").innerText = homeTeam.name + " 🆚 " + awayTeam.name;
  document.getElementById("probHome").innerText = Math.round(data.probabilities.home * 100) + "%";
  document.getElementById("probDraw").innerText = Math.round(data.probabilities.draw * 100) + "%";
  document.getElementById("probAway").innerText = Math.round(data.probabilities.away * 100) + "%";
  
  document.getElementById("vipScore").innerText = data.vip.exactScore;
  document.getElementById("vipCorners").innerText = data.vip.projectedCorners + " Cantos";
  document.getElementById("vipCards").innerText = data.vip.projectedCards + " Cartões";
});
</script>
</body>
</html>
`;

app.get("*", (req, res) => {
    res.send(HTML);
});

app.listen(PORT, () => {
    console.log(`Arena Analytics rodando em http://localhost:${PORT}`);
});