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
    from: env('FROM_EMAIL', 'Leilão Inteligente SP <suporte@guiadeleilaosp.com.br>'),
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

app.post('/api/create-checkout', async (req, res) => {
  try {
    const { name, email, whatsapp } = req.body;

    if (!name || !email || !whatsapp) {
      return res.status(400).json({ error: 'Preencha nome, e-mail e WhatsApp.' });
    }

    const orderId = crypto.randomUUID();
    const productTitle = env('PRODUCT_TITLE', 'Leilão Inteligente SP');
    const productPrice = Number(env('PRODUCT_PRICE', '27.99'));
    const publicBaseUrl = env('PUBLIC_BASE_URL');
    const landingUrl = env('LANDING_URL', 'https://guiadeleilaosp.com.br').replace(/\/$/, '');

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
      notification_url: `${publicBaseUrl.replace(/\/$/, '')}/webhooks/mercadopago`,
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
      external_reference: payment.external_reference
    }));

    const orderId = payment.external_reference || payment.metadata?.order_id;

    if (!orderId) {
      console.error('Pagamento sem external_reference:', JSON.stringify(payment));
      return;
    }

    const order = await findOrder(orderId);

    if (!order) {
      console.error('Pedido não encontrado para pagamento:', orderId);
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
});

// force deploy backend final orderId
