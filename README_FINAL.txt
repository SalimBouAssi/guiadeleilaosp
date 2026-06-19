LEILÃO INTELIGENTE SP - FINAL

Feito sobre o backup limpo.

O que foi alterado:
- server.js limpo, sem conflito Git.
- Mantém checkout Mercado Pago.
- Adiciona webhook /webhooks/mercadopago.
- Envia material por e-mail via Resend após pagamento aprovado.
- Envia material/material.html como anexo.
- Remove Leilo do material.
- Adiciona Pestana, Superbid, Loop Brasil, João Emílio, Guariglia e Leopardo.

Railway Variables:
MP_ACCESS_TOKEN
RESEND_API_KEY
FROM_EMAIL=Leilão Inteligente SP <suporte@guiadeleilaosp.com.br>
PUBLIC_BASE_URL=https://sweet-determination-production-4696.up.railway.app
LANDING_URL=https://guiadeleilaosp.com.br
MATERIAL_FILE=material/material.html
PRODUCT_TITLE=Leilão Inteligente SP
PRODUCT_PRICE=27.99

Comandos:
npm install
npm start

Deploy:
Suba esta pasta no GitHub ligado ao Railway ou substitua os arquivos do projeto oficial por estes.
