
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pg from "pg";
import readline from "readline";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "200mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA = path.join(__dirname, "data.json");
const IMPORT_FILE = path.join(__dirname, "channels.ndjson");

const SECRET = process.env.JWT_SECRET || process.env.JWT_SECRETO;
const ADMIN_USER = process.env.ADMIN_USER || process.env.ADMIN_USUÁRIO || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMINISTRADOR_PASS || "1234";

const connectionString =
  process.env.DATABASE_URL ||
  process.env["URL DO BANCO DE DADOS"] ||
  process.env.URL_DO_BANCO_DE_DADOS;

if (!connectionString) {
  throw new Error("Configure a URL de conexão PostgreSQL nas variáveis do Render.");
}

if (!SECRET || SECRET === "TROQUE_ESTA_CHAVE_EM_PRODUCAO") {
  console.warn("Atenção: configure JWT_SECRET no Render.");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 15000
});

function id() {
  return crypto.randomUUID();
}

function active(c) {
  if (!c.active || !c.expiresAt) return false;
  return new Date(c.expiresAt + "T23:59:59") >= new Date();
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  try {
    req.admin = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Não autorizado" });
  }
}

/* BANCO DE DADOS */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      "expiresAt" TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      token TEXT NOT NULL UNIQUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Geral',
      url TEXT NOT NULL,
      logo TEXT NOT NULL DEFAULT ''
    )
  `);

  // Importa clientes dos arquivos antigos, se ainda existirem.
  if (fs.existsSync(DATA)) {
    try {
      const old = JSON.parse(fs.readFileSync(DATA, "utf8"));
      for (const c of old.clients || []) {
        if (!c.id || !c.name || !c.username || !c.expiresAt || !c.token) continue;
        await pool.query(
          `INSERT INTO clients (id,name,username,"expiresAt",active,token)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [c.id, c.name, c.username, c.expiresAt, c.active !== false, c.token]
        );
      }
    } catch (e) {
      console.error("Não foi possível migrar data.json:", e.message);
    }
  }

  // Importa canais dos arquivos antigos, se ainda existirem.
  if (fs.existsSync(IMPORT_FILE)) {
    const stream = fs.createReadStream(IMPORT_FILE, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        if (!c.id || !c.name || !c.url) continue;
        await pool.query(
          `INSERT INTO channels (id,name,category,url,logo)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [c.id, c.name, c.category || "Geral", c.url, c.logo || ""]
        );
      } catch (e) {
        console.error("Linha antiga ignorada:", e.message);
      }
    }
  }

  console.log("PostgreSQL conectado e tabelas verificadas.");
}

/* LOGIN */

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ error: "Usuário ou senha inválidos" });
  }

  const token = jwt.sign({ admin: true }, SECRET, { expiresIn: "12h" });
  res.json({ token });
});

/* DASHBOARD */

app.get("/api/dashboard", auth, async (req, res) => {
  try {
    const clients = await pool.query("SELECT * FROM clients");
    const channels = await pool.query("SELECT COUNT(*)::int AS total FROM channels");
    const all = clients.rows;

    res.json({
      clients: all.length,
      active: all.filter(active).length,
      expired: all.filter(c => !active(c)).length,
      channels: channels.rows[0].total
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao carregar dashboard." });
  }
});

/* CLIENTES */

app.get("/api/clients", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM clients ORDER BY name");
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao carregar clientes." });
  }
});

app.post("/api/clients", auth, async (req, res) => {
  try {
    const { name, username, expiresAt } = req.body || {};
    if (!name || !username || !expiresAt) {
      return res.status(400).json({ error: "Preencha nome, usuário e validade" });
    }

    const exists = await pool.query(
      "SELECT id FROM clients WHERE username = $1",
      [username]
    );
    if (exists.rowCount) {
      return res.status(409).json({ error: "Usuário já existe" });
    }

    const client = {
      id: id(), name, username, expiresAt,
      active: true, token: crypto.randomBytes(18).toString("hex")
    };

    await pool.query(
      `INSERT INTO clients (id,name,username,"expiresAt",active,token)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [client.id, client.name, client.username, client.expiresAt, client.active, client.token]
    );

    res.json(client);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao criar cliente." });
  }
});

app.patch("/api/clients/:id", auth, async (req, res) => {
  try {
    const { active } = req.body || {};
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "Status inválido." });
    }

    const result = await pool.query(
      `UPDATE clients SET active=$1 WHERE id=$2 RETURNING *`,
      [active, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Cliente não encontrado" });
    }
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao alterar cliente." });
  }
});

app.delete("/api/clients/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM clients WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao excluir cliente." });
  }
});

/* CANAIS */

app.get("/api/channels", auth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await pool.query(
      "SELECT * FROM channels ORDER BY name LIMIT $1 OFFSET $2",
      [limit, offset]
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao carregar canais." });
  }
});

app.post("/api/channels", auth, async (req, res) => {
  try {
    const { name, category, url, logo } = req.body || {};
    if (!name || !url) {
      return res.status(400).json({ error: "Nome e URL são obrigatórios" });
    }

    const channel = {
      id: id(), name, category: category || "Geral", url, logo: logo || ""
    };

    await pool.query(
      `INSERT INTO channels (id,name,category,url,logo) VALUES ($1,$2,$3,$4,$5)`,
      [channel.id, channel.name, channel.category, channel.url, channel.logo]
    );
    res.json(channel);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao criar canal." });
  }
});

app.delete("/api/channels/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM channels WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao excluir canal." });
  }
});

/* IMPORTAR M3U */

app.post("/api/import-m3u", auth, async (req, res) => {
  try {
    const content = String(req.body?.content || "");
    if (!content.trim()) {
      return res.status(400).json({ error: "Playlist M3U vazia." });
    }

    const lines = content.split(/\r?\n/);
    let current = null;
    let imported = 0;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith("#EXTINF:")) {
        const comma = line.indexOf(",");
        const name = comma >= 0 ? line.slice(comma + 1).trim() : "Canal";
        const group = line.match(/group-title="([^"]*)"/i);
        const logo = line.match(/tvg-logo="([^"]*)"/i);
        current = {
          name,
          category: group?.[1] || "Geral",
          logo: logo?.[1] || ""
        };
        continue;
      }

      if (current && !line.startsWith("#")) {
        await pool.query(
          `INSERT INTO channels (id,name,category,url,logo) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING`,
          [id(), current.name, current.category, line, current.logo]
        );
        imported++;
        current = null;
      }
    }

    res.json({ ok: true, imported });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao importar M3U." });
  }
});

/* IMPORTAR XTREAM */

app.post("/api/import-xtream", auth, async (req, res) => {
  try {
    const { server, username, password } = req.body || {};
    if (!server || !username || !password) {
      return res.status(400).json({ error: "Servidor, usuário e senha são obrigatórios." });
    }

    let base = String(server).trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;

    const params = new URLSearchParams({ username: String(username), password: String(password) });
    const apiUrl = `${base}/player_api.php?${params}`;

    const response = await fetch(apiUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json,text/plain,*/*" }
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Servidor Xtream respondeu HTTP ${response.status}` });
    }

    const info = await response.json();
    if (info.user_info?.auth === 0) {
      return res.status(401).json({ error: "Usuário ou senha Xtream inválidos." });
    }

    const streamsParams = new URLSearchParams({
      username: String(username), password: String(password), action: "get_live_streams"
    });
    const streamsResponse = await fetch(`${base}/player_api.php?${streamsParams}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json,text/plain,*/*" }
    });

    if (!streamsResponse.ok) {
      return res.status(502).json({ error: "Não foi possível carregar os canais Xtream." });
    }

    const streams = await streamsResponse.json();
    if (!Array.isArray(streams) || !streams.length) {
      return res.status(400).json({ error: "Nenhum canal encontrado nessa conta Xtream." });
    }

    let imported = 0;
    for (const c of streams) {
      if (!c.stream_id) continue;

      const channel = {
        id: id(),
        name: String(c.name || c.stream_display_name || "Canal"),
        category: String(c.category_name || "Geral"),
        logo: String(c.stream_icon || ""),
        url: `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${c.stream_id}.ts`
      };

      await pool.query(
        `INSERT INTO channels (id,name,category,url,logo) VALUES ($1,$2,$3,$4,$5)`,
        [channel.id, channel.name, channel.category, channel.url, channel.logo]
      );
      imported++;
    }

    res.json({ ok: true, imported });
  } catch (e) {
    console.error("Erro Xtream:", e);
    res.status(500).json({ error: "Erro ao consultar a API Xtream." });
  }
});

/* PLAYLIST INDIVIDUAL */

app.get("/playlist/:token.m3u", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM clients WHERE token=$1",
      [req.params.token]
    );
    const client = result.rows[0];

    if (!client || !active(client)) {
      return res.status(403).type("text").send("#EXTM3U\n# Playlist bloqueada ou vencida");
    }

    res.set("Content-Type", "audio/x-mpegurl");
    res.set("Content-Disposition", 'attachment; filename="playlist.m3u"');
    res.write("#EXTM3U\n");

    const channels = await pool.query("SELECT * FROM channels ORDER BY name");
    for (const c of channels.rows) {
      const clean = value => String(value || "").replaceAll('"', "");
      res.write(
        `#EXTINF:-1 tvg-name="${clean(c.name)}" tvg-logo="${clean(c.logo)}" group-title="${clean(c.category)}",${clean(c.name)}\n${c.url}\n`
      );
    }
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).send("Erro ao gerar playlist.");
    else res.end();
  }
});

/* FRONTEND */

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* INICIAR */

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(PORT, () => console.log("Painel online na porta " + PORT));
  })
  .catch(e => {
    console.error("Falha ao iniciar o banco:", e);
    process.exit(1);
  });
