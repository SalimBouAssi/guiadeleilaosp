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

function onlyUnique(value, index, array) {
  return value && array.indexOf(value) === index;
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

async function findOrderByPaymentId(paymentId) {
  const orders = await readOrders();
  return orders.find((order) => String(order.paymentId) === String(paymentId));
}

async function resolveMaterialPath() {
  const configured = env('MATERIAL_FILE', 'material/material.html');

  const candidates = [
    configured,
    'material/material.html',
    'material/Leilao-Inteligente-SP.html'
  ].filter(onlyUnique);

  for (const candidate of candidates) {
    const fullPath = path.join(__dirname, candidate);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // tenta o próximo nome
    }
  }

  throw new Error(`Material não encontrado. Tentados: ${candidates.join(', ')}`);
}

async function sendMaterialEmail(order) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY ausente no Railway.');
  }

  if (!order.email) {
    throw new Error('E-mail do comprador ausente. Não foi possível enviar o material.');
  }

  const materialPath = await resolveMaterialPath();
  const fileBuffer = await fs.readFile(materialPath);

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2>Leilão Inteligente SP</h2>
      <p>Olá, ${order.name || 'cliente'}.</p>
      <p>Pagamento confirmado.</p>
      <p>Seu material digital está em anexo neste e-mail.</p>
      <p><strong>Produto:</strong> Leilão Inteligente SP</p>
      <p><strong>Valor:</strong> R$ ${Number(order.amount || 27.99).toFixed(2).replace('.', ',')}</p>
      <p>Este material é informativo e educacional. Não garante lucro, arrematação ou resultado financeiro específico.</p>
      <p>Obrigado pela compra.</p>
    </div>
  `;

  return await resend.emails.send({
    from: env('FROM_EMAIL', 'suporte@guiadeleilaosp.com.br'),
    to: [order.email],
    subject: 'Seu material Leilão Inteligente SP',
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
      return res.status(500).json({ error: 'Mercado Pago não configurado.' });
    }

    if (!publicBaseUrl) {
      console.error('PUBLIC_BASE_URL ausente.');
      return res.status(500).json({ error: 'URL pública não configurada.' });
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
      paymentMethod: 'pix',
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

    console.error('Mercado Pago não retornou Pix:', JSON.stringify(payment));
    return res.status(400).json({
      error: 'Não foi possível gerar Pix.',
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

function extractPaymentId(req) {
  const value =
    req.body?.data?.id ||
    req.body?.resource ||
    req.query?.id ||
    req.query?.['data.id'];

  if (!value) return null;

  const text = String(value);
  if (text.includes('/')) {
    return text.split('/').filter(Boolean).pop();
  }

  return text;
}

function buildOrderFromPayment(payment, paymentId) {
  const payer = payment?.payer || {};
  const payerName = [payer.first_name, payer.last_name].filter(Boolean).join(' ').trim();

  return {
    id: payment.external_reference || payment.metadata?.order_id || `mp_${paymentId}`,
    name: payment.metadata?.customer_name || payerName || payer.nickname || 'cliente',
    email: payment.metadata?.customer_email || payer.email || payment?.additional_info?.payer?.email || '',
    whatsapp: payment.metadata?.customer_whatsapp || '',
    amount: payment.transaction_amount || Number(env('PRODUCT_PRICE', '27.99')),
    status: payment.status || 'unknown',
    paymentId: String(paymentId),
    paymentMethod: payment.payment_method_id || payment.payment_type_id || '',
    paymentType: payment.payment_type_id || '',
    source: payment.external_reference || payment.metadata?.order_id ? 'pedido_com_order_id' : 'pagamento_sem_order_id',
    paymentResponse: payment
  };
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

    if (!paymentResponse.ok) {
      console.error('Pagamento não encontrado ou não autorizado:', JSON.stringify({
        paymentId,
        status: paymentResponse.status,
        payment
      }));
      return;
    }

    console.log('Webhook Mercado Pago:', JSON.stringify({
      paymentId,
      status: payment.status,
      external_reference: payment.external_reference,
      payment_method_id: payment.payment_method_id,
      payment_type_id: payment.payment_type_id,
      payer_email: payment?.payer?.email
    }));

    const orderId = payment.external_reference || payment.metadata?.order_id;

    let order = null;

    if (orderId) {
      order = await findOrder(orderId);
    }

    if (!order) {
      order = await findOrderByPaymentId(paymentId);
    }

    if (!order) {
      order = buildOrderFromPayment(payment, paymentId);
      console.log('Pedido criado a partir do pagamento Mercado Pago:', JSON.stringify({
        id: order.id,
        email: order.email,
        paymentId: order.paymentId,
        paymentMethod: order.paymentMethod
      }));
    }

    if (payment.status !== 'approved') {
      await saveOrder({
        ...order,
        status: payment.status || 'unknown',
        paymentId: String(paymentId),
        paymentMethod: payment.payment_method_id || payment.payment_type_id || order.paymentMethod || '',
        paymentType: payment.payment_type_id || order.paymentType || '',
        paymentResponse: payment
      });

      console.log('Pagamento ainda não aprovado:', paymentId, payment.status);
      return;
    }

    if (order.emailSentAt) {
      console.log('E-mail já enviado anteriormente:', order.email);
      return;
    }

    const finalOrder = {
      ...order,
      status: 'approved',
      paymentId: String(paymentId),
      paymentMethod: payment.payment_method_id || payment.payment_type_id || order.paymentMethod || '',
      paymentType: payment.payment_type_id || order.paymentType || '',
      paymentResponse: payment
    };

    const emailResult = await sendMaterialEmail(finalOrder);

    await saveOrder({
      ...finalOrder,
      emailSentAt: new Date().toISOString(),
      emailResult
    });

    console.log('Material enviado automaticamente para:', finalOrder.email);

  } catch (error) {
    console.error('Erro ao processar pagamento/webhook:', error);
  }
}

app.post('/webhooks/mercadopago', async (req, res) => {
  res.sendStatus(200);
  await processMercadoPagoPayment(extractPaymentId(req));
});

app.get('/webhooks/mercadopago', async (req, res) => {
  res.sendStatus(200);
  await processMercadoPagoPayment(extractPaymentId(req));
});

app.listen(PORT, () => {
  console.log('Servidor rodando');
});
