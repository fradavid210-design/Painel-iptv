# Meu IPTV — Painel completo

Inclui:
- login administrativo com JWT
- cadastro/exclusão/ativação/bloqueio de clientes
- validade por data
- dashboard
- cadastro/exclusão de canais
- geração automática de playlist M3U individual por cliente
- playlist bloqueada quando o cliente está vencido ou desativado
- interface responsiva para iPhone

## Rodar
1. Instale Node.js 20+.
2. No terminal, entre na pasta.
3. Rode `npm install`.
4. Defina `JWT_SECRET`, `ADMIN_USER` e `ADMIN_PASS`.
5. Rode `npm start`.
6. Abra a URL mostrada no terminal.

## Segurança
O arquivo `data.json` é uma solução simples para protótipo. Para produção com muitos usuários, troque por PostgreSQL/Supabase e use HTTPS. Nunca mantenha a senha `1234` nem a chave JWT padrão em produção.

## Conteúdo
Cadastre somente streams, logos e conteúdos que você tenha autorização para distribuir.
