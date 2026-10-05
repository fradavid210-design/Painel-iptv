import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "url";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
app.use(express.json({ limit: "200mb" }));
app.use(express.static(path.join(__dirname,"public")));

const DATA=path.join(__dirname,"data.json");
const SECRET=process.env.JWT_SECRET || "TROQUE_ESTA_CHAVE_EM_PRODUCAO";
const ADMIN_USER=process.env.ADMIN_USER || "admin";
const ADMIN_PASS=process.env.ADMIN_PASS || "1234";

function load(){
  if(!fs.existsSync(DATA)) fs.writeFileSync(DATA,JSON.stringify({clients:[],channels:[]},null,2));
  return JSON.parse(fs.readFileSync(DATA,"utf8"));
}
function save(d){fs.writeFileSync(DATA,JSON.stringify(d,null,2))}
function id(){return crypto.randomUUID()}
function auth(req,res,next){
  const h=req.headers.authorization||"";
  try{req.admin=jwt.verify(h.replace("Bearer ",""),SECRET);next()}
  catch{return res.status(401).json({error:"Não autorizado"})}
}
function active(c){return c.active && new Date(c.expiresAt+"T23:59:59")>=new Date()}

app.post("/api/login",(req,res)=>{
  const {username,password}=req.body||{};
  if(username!==ADMIN_USER || password!==ADMIN_PASS) return res.status(401).json({error:"Login inválido"});
  res.json({token:jwt.sign({admin:true},SECRET,{expiresIn:"12h"})});
});

app.get("/api/dashboard",auth,(req,res)=>{
  const d=load();
  res.json({
    clients:d.clients.length,
    active:d.clients.filter(active).length,
    expired:d.clients.filter(c=>!active(c)).length,
    channels:d.channels.length
  });
});

app.get("/api/clients",auth,(req,res)=>res.json(load().clients));
app.post("/api/clients",auth,(req,res)=>{
  const {name,username,expiresAt}=req.body||{};
  if(!name||!username||!expiresAt) return res.status(400).json({error:"Preencha nome, usuário e validade"});
  const d=load();
  if(d.clients.some(c=>c.username===username)) return res.status(409).json({error:"Usuário já existe"});
  const c={id:id(),name,username,expiresAt,active:true,token:crypto.randomBytes(18).toString("hex")};
  d.clients.push(c);save(d);res.json(c);
});
app.patch("/api/clients/:id",auth,(req,res)=>{
  const d=load(),c=d.clients.find(x=>x.id===req.params.id);
  if(!c)return res.status(404).json({error:"Cliente não encontrado"});
  Object.assign(c,req.body);save(d);res.json(c);
});
app.delete("/api/clients/:id",auth,(req,res)=>{
  const d=load();d.clients=d.clients.filter(x=>x.id!==req.params.id);save(d);res.json({ok:true});
});

app.get("/api/channels",auth,(req,res)=>res.json(load().channels));
app.post("/api/channels",auth,(req,res)=>{
  const {name,category,url,logo}=req.body||{};
  if(!name||!url)return res.status(400).json({error:"Nome e URL são obrigatórios"});
  const d=load(),c={id:id(),name,category:category||"Geral",url,logo:logo||""};
  d.channels.push(c);save(d);res.json(c);
});
app.delete("/api/channels/:id",auth,(req,res)=>{
  const d=load();d.channels=d.channels.filter(x=>x.id!==req.params.id);save(d);res.json({ok:true});
});

// Importação de playlist M3U
app.post("/api/import-m3u", auth, (req, res) => {
  try {
    const content = String(req.body?.content || "");

    if (!content.trim()) {
      return res.status(400).json({
        error: "Playlist M3U vazia."
      });
    }

    const d = load();
    let imported = 0;
    let current = null;

    const lines = content.match(/[^\r\n]+/g) || [];

    for (const rawLine of lines) {
      const s = rawLine.trim();

      if (!s) continue;

      if (s.startsWith("#EXTINF:")) {
        const comma = s.indexOf(",");

        const name =
          comma >= 0
            ? s.substring(comma + 1).trim()
            : "Canal";

        const groupMatch =
          s.match(/group-title="([^"]*)"/i);

        const logoMatch =
          s.match(/tvg-logo="([^"]*)"/i);

        current = {
          name,
          category: groupMatch
            ? groupMatch[1]
            : "Geral",
          logo: logoMatch
            ? logoMatch[1]
            : ""
        };

        continue;
      }

      if (
        current &&
        !s.startsWith("#")
      ) {
        d.channels.push({
          id: id(),
          name: current.name,
          category: current.category,
          url: s,
          logo: current.logo
        });

        imported++;
        current = null;
      }
    }

    save(d);

    res.json({
      ok: true,
      imported
    });

  } catch (e) {
    console.error("Erro ao importar M3U:", e);

    res.status(500).json({
      error: "Erro ao importar M3U."
    });
  }
});
/* Playlist M3U individual. O link só funciona se o cliente existir,
   estiver ativo e não estiver vencido. */
app.get("/playlist/:token.m3u",(req,res)=>{
  const d=load(),c=d.clients.find(x=>x.token===req.params.token);
  if(!c||!active(c)) return res.status(403).type("text").send("#EXTM3U\n# Playlist bloqueada ou vencida");
  let out="#EXTM3U\n";
  for(const ch of d.channels){
    out+=`#EXTINF:-1 tvg-name="${String(ch.name).replaceAll('"','')}" tvg-logo="${String(ch.logo||"").replaceAll('"','')}" group-title="${String(ch.category||"Geral").replaceAll('"','')}",${ch.name}\n${ch.url}\n`;
  }
  res.set("Content-Type","audio/x-mpegurl; charset=utf-8").send(out);
});

app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(process.env.PORT||3000,()=>console.log("Painel online na porta "+(process.env.PORT||3000)));
