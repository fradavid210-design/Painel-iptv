import express from "express";
import fs from "fs";
import readline from "readline";
import path from "path";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.json({ limit: "200mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA = path.join(__dirname, "data.json");
const IMPORT_FILE = path.join(__dirname, "channels.ndjson");

const SECRET =
  process.env.JWT_SECRET || "TROQUE_ESTA_CHAVE_EM_PRODUCAO";

const ADMIN_USER =
  process.env.ADMIN_USER || "admin";

const ADMIN_PASS =
  process.env.ADMIN_PASS || "1234";


/* =========================
   BANCO LOCAL
========================= */

function load() {
  if (!fs.existsSync(DATA)) {
    fs.writeFileSync(
      DATA,
      JSON.stringify(
        {
          clients: [],
          channels: []
        },
        null,
        2
      )
    );
  }

  return JSON.parse(
    fs.readFileSync(DATA, "utf8")
  );
}

function save(data) {
  fs.writeFileSync(
    DATA,
    JSON.stringify(data, null, 2)
  );
}

function id() {
  return crypto.randomUUID();
}


/* =========================
   AUTENTICAÇÃO
========================= */

function auth(req, res, next) {

  const header =
    req.headers.authorization || "";

  const token =
    header.startsWith("Bearer ")
      ? header.substring(7)
      : "";

  try {

    req.admin = jwt.verify(
      token,
      SECRET
    );

    next();

  } catch (e) {

    return res.status(401).json({
      error: "Não autorizado"
    });

  }
}


/* =========================
   CLIENTE ATIVO
========================= */

function active(c) {

  if (!c.active) {
    return false;
  }

  return new Date(
    c.expiresAt + "T23:59:59"
  ) >= new Date();
}


/* =========================
   LOGIN
========================= */

app.post("/api/login", (req, res) => {

  console.log(">>> LOGIN CHEGOU NO SERVIDOR <<<");

  const {
    username,
    password
  } = req.body || {};

  if (
    username !== ADMIN_USER ||
    password !== ADMIN_PASS
  ) {

    return res.status(401).json({
      error: "Usuário ou senha inválidos"
    });

  }

  const token = jwt.sign(
    {
      admin: true
    },
    SECRET,
    {
      expiresIn: "12h"
    }
  );

  res.json({
    token
  });

});


/* =========================
   DASHBOARD
========================= */

app.get(
  "/api/dashboard",
  auth,
  async (req, res) => {

    try {

      const data = load();

      let channels = 0;

      if (fs.existsSync(IMPORT_FILE)) {

        const stream =
          fs.createReadStream(
            IMPORT_FILE,
            {
              encoding: "utf8"
            }
          );

        for await (
          const chunk of stream
        ) {

          channels +=
            (chunk.match(/\n/g) || [])
              .length;

        }

      }

      res.json({
        clients: data.clients.length,
        active: data.clients.filter(active).length,
        expired: data.clients.filter(
          c => !active(c)
        ).length,
        channels
      });

    } catch (e) {

      console.error(
        "Erro no dashboard:",
        e
      );

      res.status(500).json({
        error:
          "Erro ao carregar dashboard."
      });

    }

  }
);


/* =========================
   CLIENTES
========================= */

app.get(
  "/api/clients",
  auth,
  (req, res) => {

    res.json(
      load().clients
    );

  }
);


app.post(
  "/api/clients",
  auth,
  (req, res) => {

    const {
      name,
      username,
      expiresAt
    } = req.body || {};

    if (
      !name ||
      !username ||
      !expiresAt
    ) {

      return res.status(400).json({
        error:
          "Preencha nome, usuário e validade"
      });

    }

    const data = load();

    if (
      data.clients.some(
        c => c.username === username
      )
    ) {

      return res.status(409).json({
        error:
          "Usuário já existe"
      });

    }

    const client = {

      id: id(),

      name,

      username,

      expiresAt,

      active: true,

      token:
        crypto.randomBytes(18)
          .toString("hex")

    };

    data.clients.push(client);

    save(data);

    res.json(client);

  }
);


app.patch(
  "/api/clients/:id",
  auth,
  (req, res) => {

    const data = load();

    const client =
      data.clients.find(
        x => x.id === req.params.id
      );

    if (!client) {

      return res.status(404).json({
        error:
          "Cliente não encontrado"
      });

    }

    Object.assign(
      client,
      req.body
    );

    save(data);

    res.json(client);

  }
);


app.delete(
  "/api/clients/:id",
  auth,
  (req, res) => {

    const data = load();

    data.clients =
      data.clients.filter(
        x => x.id !== req.params.id
      );

    save(data);

    res.json({
      ok: true
    });

  }
);


/* =========================
   CANAIS
========================= */

app.get(
  "/api/channels",
  auth,
  async (req, res) => {

    try {

      const limit =
        Math.min(
          Math.max(
            Number(req.query.limit) || 100,
            1
          ),
          500
        );

      const offset =
        Math.max(
          Number(req.query.offset) || 0,
          0
        );

      const canais = [];

      if (
        fs.existsSync(IMPORT_FILE)
      ) {

        const stream =
          fs.createReadStream(
            IMPORT_FILE,
            {
              encoding: "utf8"
            }
          );

        const rl =
          readline.createInterface({
            input: stream,
            crlfDelay: Infinity
          });

        let index = 0;

        for await (
          const line of rl
        ) {

          if (!line.trim()) {
            continue;
          }

          if (index++ < offset) {
            continue;
          }

          if (
            canais.length >= limit
          ) {
            break;
          }

          try {

            canais.push(
              JSON.parse(line)
            );

          } catch {}

        }

      }

      res.json(canais);

    } catch (e) {

      console.error(
        "Erro ao carregar canais:",
        e
      );

      res.status(500).json({
        error:
          "Erro ao carregar canais."
      });

    }

  }
);


app.post(
  "/api/channels",
  auth,
  (req, res) => {

    const {
      name,
      category,
      url,
      logo
    } = req.body || {};

    if (!name || !url) {

      return res.status(400).json({
        error:
          "Nome e URL são obrigatórios"
      });

    }

    const channel = {

      id: id(),

      name,

      category:
        category || "Geral",

      url,

      logo:
        logo || ""

    };

    fs.appendFileSync(
      IMPORT_FILE,
      JSON.stringify(channel) + "\n",
      "utf8"
    );

    res.json(channel);

  }
);


app.delete(
  "/api/channels/:id",
  auth,
  (req, res) => {

    if (
      !fs.existsSync(IMPORT_FILE)
    ) {

      return res.json({
        ok: true
      });

    }

    const lines =
      fs.readFileSync(
        IMPORT_FILE,
        "utf8"
      )
      .split(/\r?\n/)
      .filter(Boolean);

    const filtered =
      lines.filter(line => {

        try {

          const channel =
            JSON.parse(line);

          return (
            channel.id !==
            req.params.id
          );

        } catch {

          return true;

        }

      });

    fs.writeFileSync(
      IMPORT_FILE,
      filtered.length
        ? filtered.join("\n") + "\n"
        : "",
      "utf8"
    );

    res.json({
      ok: true
    });

  }
);


/* =========================
   IMPORTAR M3U
========================= */

app.post(
  "/api/import-m3u",
  auth,
  (req, res) => {

    try {

      const content =
        String(
          req.body?.content || ""
        );

      if (!content.trim()) {

        return res.status(400).json({
          error:
            "Playlist M3U vazia."
        });

      }

      const lines =
        content.match(
          /[^\r\n]+/g
        ) || [];

      let current = null;

      const output = [];

      let imported = 0;

      for (
        const rawLine of lines
      ) {

        const line =
          rawLine.trim();

        if (!line) {
          continue;
        }

        if (
          line.startsWith(
            "#EXTINF:"
          )
        ) {

          const comma =
            line.indexOf(",");

          const name =
            comma >= 0
              ? line
                  .substring(
                    comma + 1
                  )
                  .trim()
              : "Canal";

          const groupMatch =
            line.match(
              /group-title="([^"]*)"/i
            );

          const logoMatch =
            line.match(
              /tvg-logo="([^"]*)"/i
            );

          current = {

            name,

            category:
              groupMatch
                ? groupMatch[1]
                : "Geral",

            logo:
              logoMatch
                ? logoMatch[1]
                : ""

          };

          continue;
        }

        if (
          current &&
          !line.startsWith("#")
        ) {

          output.push(
            JSON.stringify({

              id: id(),

              name:
                current.name,

              category:
                current.category,

              url: line,

              logo:
                current.logo

            })
          );

          imported++;

          current = null;

        }

      }

      if (output.length) {

        fs.appendFileSync(
          IMPORT_FILE,
          output.join("\n") + "\n",
          "utf8"
        );

      }

      res.json({

        ok: true,

        imported

      });

    } catch (e) {

      console.error(
        "Erro ao importar M3U:",
        e
      );

      res.status(500).json({
        error:
          "Erro ao importar M3U."
      });

    }

  }
);


/* =========================
   FUNÇÃO PARA BUSCAR XTREAM
========================= */

async function tentarXtream(url) {

  console.log(
    "Tentando:",
    url
  );

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {

          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

          "Accept":
            "application/x-mpegURL, application/vnd.apple.mpegurl, text/plain, */*",

          "Cache-Control":
            "no-cache"

        },

        redirect: "follow"

      }
    );

  return response;

}


/* =========================
   IMPORTAR XTREAM
========================= */

app.post(
  "/api/import-xtream",
  auth,
  async (req, res) => {

    try {

      const {
        server,
        username,
        password
      } = req.body || {};

      if (
        !server ||
        !username ||
        !password
      ) {

        return res.status(400).json({
          error:
            "Servidor, usuário e senha são obrigatórios."
        });

      }

      let base =
        String(server)
          .trim()
          .replace(/\/+$/, "");

      if (
        !/^https?:\/\//i.test(base)
      ) {

        base =
          "http://" + base;

      }

      const params =
        new URLSearchParams({

          username:
            String(username),

          password:
            String(password),

          type:
            "m3u_plus",

          output:
            "ts"

        });


      /* 
         Primeiro tenta exatamente
         o endereço informado.
      */

      const urls = [

        `${base}/get.php?${params.toString()}`

      ];


      /*
         Se foi informado HTTP,
         também tenta HTTPS.
      */

      if (
        base.startsWith(
          "http://"
        )
      ) {

        urls.push(
          `https://${base.substring(7)}/get.php?${params.toString()}`
        );

      }


      let response = null;

      let lastStatus = null;

      for (
        const url of urls
      ) {

        try {

          const r =
            await tentarXtream(
              url
            );

          lastStatus =
            r.status;

          console.log(
            "Resposta Xtream:",
            r.status
          );

          if (
            r.ok
          ) {

            response = r;

            break;

          }

        } catch (e) {

          console.error(
            "Falha na tentativa:",
            e.message
          );

        }

      }


      if (!response) {

        return res.status(502).json({

          error:
            `O servidor Xtream recusou a conexão. HTTP ${lastStatus || "sem resposta"}.`

        });

      }


      const content =
        await response.text();


      if (
        !content ||
        !content.includes(
          "#EXTINF"
        )
      ) {

        return res.status(502).json({

          error:
            "O servidor respondeu, mas não retornou uma playlist M3U válida."

        });

      }


      const lines =
        content.split(
          /\r?\n/
        );

      let current = null;

      const output = [];

      for (
        const rawLine of lines
      ) {

        const line =
          rawLine.trim();

        if (!line) {
          continue;
        }


        if (
          line.startsWith(
            "#EXTINF:"
          )
        ) {

          const comma =
            line.indexOf(",");

          const name =
            comma >= 0
              ? line
                  .substring(
                    comma + 1
                  )
                  .trim()
              : "Canal";


          const groupMatch =
            line.match(
              /group-title="([^"]*)"/i
            );


          const logoMatch =
            line.match(
              /tvg-logo="([^"]*)"/i
            );


          current = {

            name,

            category:
              groupMatch
                ? groupMatch[1]
                : "Geral",

            logo:
              logoMatch
                ? logoMatch[1]
                : ""

          };

          continue;

        }


        if (
          current &&
          !line.startsWith("#")
        ) {

          output.push(
            JSON.stringify({

              id: id(),

              name:
                current.name,

              category:
                current.category,

              url:
                line,

              logo:
                current.logo

            })
          );

          current = null;

        }

      }


      if (!output.length) {

        return res.status(400).json({

          error:
            "Nenhum canal foi encontrado na playlist Xtream."

        });

      }


      fs.appendFileSync(

        IMPORT_FILE,

        output.join("\n") + "\n",

        "utf8"

      );


      console.log(
        "Xtream importado:",
        output.length,
        "canais"
      );


      res.json({

        ok: true,

        imported:
          output.length

      });

    } catch (e) {

      console.error(
        "Erro ao importar Xtream:",
        e
      );

      res.status(500).json({

        error:
          "Erro ao importar a playlist Xtream."

      });

    }

  }
);


/* =========================
   PLAYLIST INDIVIDUAL
========================= */

app.get(
  "/playlist/:token.m3u",
  async (req, res) => {

    const data = load();

    const client =
      data.clients.find(
        x =>
          x.token ===
          req.params.token
      );

    if (
      !client ||
      !active(client)
    ) {

      return res
        .status(403)
        .type("text")
        .send(
          "#EXTM3U\n# Playlist bloqueada ou vencida"
        );

    }


    res.set(
      "Content-Type",
      "audio/x-mpegurl"
    );

    res.set(
      "Content-Disposition",
      'attachment; filename="playlist.m3u"'
    );


    res.write(
      "#EXTM3U\n"
    );


    if (
      fs.existsSync(
        IMPORT_FILE
      )
    ) {

      const stream =
        fs.createReadStream(
          IMPORT_FILE,
          {
            encoding: "utf8"
          }
        );

      const rl =
        readline.createInterface({
          input: stream,
          crlfDelay: Infinity
        });


      for await (
        const line of rl
      ) {

        if (!line.trim()) {
          continue;
        }


        try {

          const channel =
            JSON.parse(line);


          const name =
            String(
              channel.name || ""
            )
            .replaceAll(
              '"',
              ""
            );


          const logo =
            String(
              channel.logo || ""
            )
            .replaceAll(
              '"',
              ""
            );


          const category =
            String(
              channel.category ||
              "Geral"
            )
            .replaceAll(
              '"',
              ""
            );


          res.write(

            `#EXTINF:-1 tvg-name="${name}" tvg-logo="${logo}" group-title="${category}",${name}\n${channel.url}\n`

          );

        } catch {}

      }

    }


    res.end();

  }
);


/* =========================
   FRONTEND
========================= */

app.get(
  "/{*splat}",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );

  }
);


/* =========================
   SERVIDOR
========================= */

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {

    console.log(
      "Painel online na porta " +
      PORT
    );

  }
);
