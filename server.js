import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'orders.json');
const FALLBACK_CHECKOUT = 'https://mpago.la/2ESH1hL';

const resend = new Resend(process.env.RESEND_API_KEY);

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/$/, '');
}

async function readOrders() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeOrders(orders) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

async function saveOrder(order) {
  const orders = await readOrders();
  const index = orders.findIndex((item) => item.id === order.id);

  if (index >= 0) {
    orders[index] = {
      ...orders[index],
      ...order,
      updatedAt: new Date().toISOString()
    };
  } else {
    orders.push({
      ...order,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  await writeOrders(orders);
}

async function findOrder(id) {
  const orders = await readOrders();
  return orders.find((order) => order.id === id);
}

async function sendMaterialEmail(order) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY ausente no Railway.');
  }

  const materialFile = env('MATERIAL_FILE', 'material/material.html');
  const materialPath = path.join(__dirname, materialFile);
  const fileBuffer = await fs.readFile(materialPath);

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2>Leilao Inteligente SP</h2>
      <p>Ola, ${order.name || 'cliente'}.</p>
      <p>Pagamento confirmado.</p>
      <p>Seu material digital esta em anexo neste e-mail.</p>
      <p><strong>Produto:</strong> Leilao Inteligente SP</p>
      <p><strong>Valor:</strong> R$ ${Number(order.amount || 27.99).toFixed(2).replace('.', ',')}</p>
      <p>Este material e informativo e educacional. Nao garante lucro, arrematacao ou resultado financeiro especifico.</p>
      <p>Obrigado pela compra.</p>
    </div>
  `;

  return await resend.emails.send({
    from: env('FROM_EMAIL', 'suporte@guiadeleilaosp.com.br'),
    to: [order.email],
    subject: 'Seu material Leilao Inteligente SP',
    html,
    attachments: [
      {
        filename: 'Leilao-Inteligente-SP.html',
        content: fileBuffer.toString('base64')
      }
    ]
  });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Leilão Inteligente SP',
    time: new Date().toISOString()
  });
});

app.post('/api/create-pix', async (req, res) => {
  try {
    const { name, email, whatsapp } = req.body;

    if (!name || !email || !whatsapp) {
      return res.status(400).json({ error: 'Preencha nome, e-mail e WhatsApp.' });
    }

    const orderId = crypto.randomUUID();
    const productTitle = env('PRODUCT_TITLE', 'Leilão Inteligente SP');
    const productPrice = Number(env('PRODUCT_PRICE', '27.99'));
    const publicBaseUrl = cleanBaseUrl(env('PUBLIC_BASE_URL'));

    if (!process.env.MP_ACCESS_TOKEN) {
      console.error('MP_ACCESS_TOKEN ausente.');
      return res.status(500).json({ error: 'Mercado Pago nao configurado.' });
    }

    if (!publicBaseUrl) {
      console.error('PUBLIC_BASE_URL ausente.');
      return res.status(500).json({ error: 'URL publica nao configurada.' });
    }

    const paymentPayload = {
      transaction_amount: productPrice,
      description: productTitle,
      payment_method_id: 'pix',
      payer: {
        email,
        first_name: name
      },
      external_reference: orderId,
      notification_url: `${publicBaseUrl}/webhooks/mercadopago`,
      metadata: {
        order_id: orderId,
        customer_name: name,
        customer_email: email,
        customer_whatsapp: whatsapp
      }
    };

    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env('MP_ACCESS_TOKEN')}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': orderId
      },
      body: JSON.stringify(paymentPayload)
    });

    const payment = await mpResponse.json();
    const transactionData = payment?.point_of_interaction?.transaction_data || {};

    await saveOrder({
      id: orderId,
      name,
      email,
      whatsapp,
      amount: productPrice,
      status: payment?.status || 'pending',
      paymentId: payment?.id ? String(payment.id) : null,
      pixQrCode: transactionData.qr_code || null,
      pixQrCodeBase64: transactionData.qr_code_base64 || null,
      pixTicketUrl: transactionData.ticket_url || null,
      paymentResponse: payment
    });

    if (mpResponse.ok && transactionData.qr_code) {
      console.log('Pix criado:', orderId, payment?.id);
      return res.json({
        orderId,
        paymentId: payment?.id,
        status: payment?.status,
        qrCode: transactionData.qr_code,
        qrCodeBase64: transactionData.qr_code_base64,
        ticketUrl: transactionData.ticket_url
      });
    }

    console.error('Mercado Pago nao retornou Pix:', JSON.stringify(payment));
    return res.status(400).json({
      error: 'Nao foi possivel gerar Pix.',
      details: payment
    });

  } catch (error) {
    console.error('Erro ao criar Pix:', error);
    return res.status(500).json({ error: 'Erro ao criar Pix.' });
  }
});

app.post('/api/create-checkout', async (req, res) => {
  try {
    const { name, email, whatsapp } = req.body;

    if (!name || !email || !whatsapp) {
      return res.status(400).json({ error: 'Preencha nome, e-mail e WhatsApp.' });
    }

    const orderId = crypto.randomUUID();
    const productTitle = env('PRODUCT_TITLE', 'Leilão Inteligente SP');
    const productPrice = Number(env('PRODUCT_PRICE', '27.99'));
    const publicBaseUrl = cleanBaseUrl(env('PUBLIC_BASE_URL'));
    const landingUrl = cleanBaseUrl(env('LANDING_URL', 'https://guiadeleilaosp.com.br'));

    if (!process.env.MP_ACCESS_TOKEN) {
      console.error('MP_ACCESS_TOKEN ausente. Usando fallback.');
      return res.json({ checkoutUrl: FALLBACK_CHECKOUT, orderId });
    }

    if (!publicBaseUrl) {
      console.error('PUBLIC_BASE_URL ausente. Usando fallback.');
      return res.json({ checkoutUrl: FALLBACK_CHECKOUT, orderId });
    }

    const preference = {
      items: [
        {
          title: productTitle,
          description: 'Material digital com leiloeiros, links oficiais, checklist e fórmula de margem.',
          quantity: 1,
          currency_id: 'BRL',
          unit_price: productPrice
        }
      ],
      payer: {
        name,
        email
      },
      external_reference: orderId,
      metadata: {
        order_id: orderId,
        customer_name: name,
        customer_email: email,
        customer_whatsapp: whatsapp
      },
      notification_url: `${publicBaseUrl}/webhooks/mercadopago`,
      back_urls: {
        success: `${landingUrl}/obrigado.html`,
        pending: `${landingUrl}/pendente.html`,
        failure: landingUrl
      },
      auto_return: 'approved'
    };

    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env('MP_ACCESS_TOKEN')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preference)
    });

    const data = await mpResponse.json();

    await saveOrder({
      id: orderId,
      name,
      email,
      whatsapp,
      amount: productPrice,
      status: 'created',
      preferenceStatus: mpResponse.status,
      preferenceId: data?.id,
      checkoutUrl: data?.init_point || FALLBACK_CHECKOUT,
      mpPreferenceResponse: data
    });

    if (mpResponse.ok && data?.init_point) {
      console.log('Checkout criado:', orderId);
      return res.json({
        checkoutUrl: data.init_point,
        orderId
      });
    }

    console.error('Mercado Pago não retornou init_point:', JSON.stringify(data));
    return res.json({
      checkoutUrl: FALLBACK_CHECKOUT,
      orderId
    });

  } catch (error) {
    console.error('Erro ao criar checkout:', error);
    return res.json({
      checkoutUrl: FALLBACK_CHECKOUT
    });
  }
});

function paymentEmail(payment) {
  return (
    payment?.payer?.email ||
    payment?.metadata?.customer_email ||
    payment?.additional_info?.payer?.email ||
    payment?.additional_info?.payer?.email_address ||
    ''
  );
}

function paymentName(payment) {
  return (
    payment?.metadata?.customer_name ||
    payment?.payer?.first_name ||
    payment?.additional_info?.payer?.first_name ||
    'cliente'
  );
}

function sameAmount(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) < 0.01;
}

async function alreadySentForPayment(paymentId) {
  const orders = await readOrders();
  return orders.find((order) => String(order.paymentId) === String(paymentId) && order.emailSentAt);
}

async function sendApprovedPaymentWithoutOrder(payment) {
  const paymentId = String(payment.id || '');
  const productPrice = Number(env('PRODUCT_PRICE', '27.99'));
  const amount = Number(payment.transaction_amount || 0);
  const email = paymentEmail(payment);
  const name = paymentName(payment);

  if (!paymentId) {
    console.log('Pagamento aprovado sem paymentId.');
    return;
  }

  if (payment.status !== 'approved') {
    console.log('Pagamento ainda não aprovado:', paymentId, payment.status);
    return;
  }

  if (!email) {
    console.error('Pagamento aprovado sem e-mail do comprador:', JSON.stringify({
      paymentId,
      status: payment.status,
      amount,
      payer: payment.payer
    }));
    return;
  }

  if (!sameAmount(amount, productPrice)) {
    console.log('Pagamento aprovado ignorado por valor diferente:', JSON.stringify({
      paymentId,
      amount,
      productPrice,
      email
    }));
    return;
  }

  const alreadySent = await alreadySentForPayment(paymentId);
  if (alreadySent) {
    console.log('E-mail já enviado anteriormente para este pagamento:', email);
    return;
  }

  const order = {
    id: `mp-${paymentId}`,
    name,
    email,
    whatsapp: '',
    amount,
    status: 'approved',
    paymentId,
    source: 'mercado-pago-sem-external-reference',
    paymentResponse: payment
  };

  const emailResult = await sendMaterialEmail(order);

  await saveOrder({
    ...order,
    emailSentAt: new Date().toISOString(),
    emailResult
  });

  console.log('Material enviado para:', email);
}

async function processMercadoPagoPayment(paymentId) {
  try {
    if (!paymentId) {
      console.log('Webhook recebido sem paymentId.');
      return;
    }

    const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${env('MP_ACCESS_TOKEN')}`
      }
    });

    const payment = await paymentResponse.json();

    console.log('Webhook Mercado Pago:', JSON.stringify({
      paymentId,
      status: payment.status,
      external_reference: payment.external_reference,
      email: paymentEmail(payment),
      amount: payment.transaction_amount
    }));

    if (!paymentResponse.ok) {
      console.error('Erro ao consultar pagamento Mercado Pago:', JSON.stringify(payment));
      return;
    }

    const orderId = payment.external_reference || payment.metadata?.order_id;

    if (!orderId) {
      console.log('Pagamento sem external_reference. Enviando pelo e-mail do próprio Mercado Pago.');
      await sendApprovedPaymentWithoutOrder(payment);
      return;
    }

    const order = await findOrder(orderId);

    if (!order) {
      console.log('Pedido não encontrado. Tentando enviar pelo e-mail do próprio Mercado Pago:', orderId);
      await sendApprovedPaymentWithoutOrder(payment);
      return;
    }

    if (payment.status !== 'approved') {
      await saveOrder({
        ...order,
        status: payment.status || 'unknown',
        paymentId: String(paymentId),
        paymentResponse: payment
      });
      return;
    }

    if (order.emailSentAt) {
      console.log('E-mail já enviado anteriormente:', order.email);
      return;
    }

    const emailResult = await sendMaterialEmail(order);

    await saveOrder({
      ...order,
      status: 'approved',
      paymentId: String(paymentId),
      paymentResponse: payment,
      emailSentAt: new Date().toISOString(),
      emailResult
    });

    console.log('Material enviado para:', order.email);

  } catch (error) {
    console.error('Erro ao processar pagamento/webhook:', error);
  }
}

let autoSyncStarted = false;

async function syncApprovedPayments() {
  try {
    if (!process.env.MP_ACCESS_TOKEN) {
      console.log('Sync Mercado Pago ignorado: MP_ACCESS_TOKEN ausente.');
      return;
    }

    const lookbackHours = Number(env('PAYMENT_SYNC_LOOKBACK_HOURS', '6'));
    const endDate = new Date();
    const beginDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

    const params = new URLSearchParams({
      sort: 'date_created',
      criteria: 'desc',
      range: 'date_created',
      begin_date: beginDate.toISOString(),
      end_date: endDate.toISOString(),
      status: 'approved',
      limit: '20'
    });

    const response = await fetch(`https://api.mercadopago.com/v1/payments/search?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${env('MP_ACCESS_TOKEN')}`
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Erro no sync Mercado Pago:', JSON.stringify(data));
      return;
    }

    const payments = Array.isArray(data.results) ? data.results : [];

    console.log('Sync Mercado Pago aprovado:', payments.length, 'pagamentos encontrados.');

    for (const payment of payments) {
      if (payment?.id) {
        await processMercadoPagoPayment(payment.id);
      }
    }
  } catch (error) {
    console.error('Erro no sync automatico de pagamentos:', error);
  }
}

function startPaymentAutoSync() {
  if (autoSyncStarted) return;
  autoSyncStarted = true;

  const intervalMs = Number(env('PAYMENT_SYNC_INTERVAL_MS', '60000'));

  setTimeout(syncApprovedPayments, 10000);
  setInterval(syncApprovedPayments, intervalMs);

  console.log('Sync automatico Mercado Pago ativo.');
}

app.post('/webhooks/mercadopago', async (req, res) => {
  res.sendStatus(200);

  const paymentId =
    req.body?.data?.id ||
    req.query?.id ||
    req.query?.['data.id'];

  await processMercadoPagoPayment(paymentId);
});

app.get('/webhooks/mercadopago', async (req, res) => {
  res.sendStatus(200);

  const paymentId =
    req.query?.id ||
    req.query?.['data.id'];

  await processMercadoPagoPayment(paymentId);
});

app.listen(PORT, () => {
  console.log('Servidor rodando');
  startPaymentAutoSync();
});
