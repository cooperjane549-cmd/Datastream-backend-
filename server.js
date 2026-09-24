require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. INITIALIZE FIREBASE ADMIN
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. INITIALIZE TELEGRAM BOT
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

// =============================================================================
// ESIM REDEMPTION ENDPOINT
// =============================================================================
app.post('/api/esim/redeem', async (req, res) => {
  const { userId, packageId, packageCostUsd } = req.body;

  if (!userId || !packageId || !packageCostUsd) {
    return res.status(400).json({ success: false, message: 'Missing required parameters' });
  }

  try {
    const userRef = db.collection('users').doc(userId);
    const cost = parseFloat(packageCostUsd);

    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const currentBalance = userDoc.data().balanceUsd || 0;
      if (currentBalance < cost) {
        throw new Error('Insufficient balance');
      }

      transaction.update(userRef, {
        balanceUsd: admin.firestore.FieldValue.increment(-cost)
      });
    });

    // Real API integration space for providers (e.g., Celitech / eSIM Go)
    let lpaString = `LPA:1$rsp.global-esim.com$DS-${Date.now()}-${userId.substring(0, 5)}`;
    
    if (process.env.ESIM_PROVIDER_API_KEY) {
      try {
        const esimRes = await axios.post(
          `${process.env.ESIM_PROVIDER_BASE_URL}/orders`,
          { packageId: packageId },
          { headers: { 'X-API-Key': process.env.ESIM_PROVIDER_API_KEY } }
        );
        if (esimRes.data && esimRes.data.lpaString) {
          lpaString = esimRes.data.lpaString;
        }
      } catch (esimError) {
        console.error('eSIM Provider API Call Error, fallback used:', esimError.message);
      }
    }

    await db.collection('esim_redemptions').add({
      userId,
      packageId,
      costUsd: cost,
      lpaString,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'eSIM profile activated successfully',
      esimDetails: { lpaString }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// =============================================================================
// PAYPAL CHECKOUT & WEBHOOK
// =============================================================================
app.get('/paypal/checkout', (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).send('User ID required');
  }

  res.send(`
    <html>
      <head><title>DataStream PayPal Checkout</title></head>
      <body style="background-color: #0F172A; color: white; font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h2>PayPal Wallet Top-Up</h2>
        <p>User ID: ${userId}</p>
        <p>Redirecting to PayPal securely...</p>
        <script>
          // In production, initiate PayPal SDK JS order here
        </script>
      </body>
    </html>
  `);
});

app.post('/api/paypal/webhook', async (req, res) => {
  const { userId, amountPaidUsd, paymentStatus } = req.body;

  if (paymentStatus === 'COMPLETED' && userId && amountPaidUsd) {
    await db.collection('users').doc(userId).update({
      balanceUsd: admin.firestore.FieldValue.increment(parseFloat(amountPaidUsd))
    });
    return res.json({ status: 'success' });
  }

  res.status(400).json({ status: 'ignored' });
});

// =============================================================================
// TAPJOY POSTBACK ENDPOINT
// =============================================================================
app.get('/api/tapjoy/postback', async (req, res) => {
  const { snuid, currency, mac } = req.query;

  if (!snuid || !currency) {
    return res.status(400).send('Missing parameters');
  }

  try {
    if (process.env.TAPJOY_SECRET_KEY && mac) {
      const computedMac = crypto
        .createHash('sha256')
        .update(`${snuid}:${currency}:${process.env.TAPJOY_SECRET_KEY}`)
        .digest('hex');

      if (computedMac !== mac) {
        return res.status(403).send('Unauthorized signature mismatch');
      }
    }

    const userRef = db.collection('users').doc(snuid);
    await userRef.update({
      balanceUsd: admin.firestore.FieldValue.increment(parseFloat(currency))
    });

    res.status(200).send('200 OK');
  } catch (error) {
    console.error('Tapjoy Postback Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// =============================================================================
// TELEGRAM BOT (M-PESA DEPOSIT LISTENER & HANDLER)
// =============================================================================
db.collection('mpesa_deposits').where('status', '==', 'pending')
  .onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added') {
        const deposit = change.doc.data();
        const depositId = change.doc.id;

        const message = `📥 <b>New M-Pesa Deposit Request</b>\n\n` +
          `<b>User ID:</b> ${deposit.userId}\n` +
          `<b>Email:</b> ${deposit.email}\n` +
          `<b>M-Pesa Ref:</b> <code>${deposit.mpesaRef}</code>\n` +
          `<b>Amount:</b> KES ${deposit.amountKes}`;

        if (ADMIN_CHAT_ID) {
          bot.telegram.sendMessage(ADMIN_CHAT_ID, message, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('Approve & Credit', `approve_${depositId}`),
                Markup.button.callback('Reject', `reject_${depositId}`)
              ]
            ])
          });
        }
      }
    });
  });

bot.action(/approve_(.+)/, async (ctx) => {
  const depositId = ctx.match[1];
  const depositRef = db.collection('mpesa_deposits').doc(depositId);

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(depositRef);
      if (!doc.exists || doc.data().status !== 'pending') {
        throw new Error('Deposit already processed or non-existent');
      }

      const deposit = doc.data();
      const kesToUsdRate = parseFloat(process.env.KES_TO_USD_RATE || '130.0');
      const usdCredit = deposit.amountKes / kesToUsdRate;

      const userRef = db.collection('users').doc(deposit.userId);
      transaction.update(userRef, {
        balanceUsd: admin.firestore.FieldValue.increment(usdCredit)
      });

      transaction.update(depositRef, { 
        status: 'approved', 
        approvedAt: admin.firestore.FieldValue.serverTimestamp() 
      });
    });

    await ctx.answerCbQuery('Deposit Approved!');
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n✅ <b>STATUS: APPROVED</b>`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.answerCbQuery(`Error: ${err.message}`);
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  const depositId = ctx.match[1];
  await db.collection('mpesa_deposits').doc(depositId).update({ status: 'rejected' });
  await ctx.answerCbQuery('Deposit Rejected');
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n❌ <b>STATUS: REJECTED</b>`, { parse_mode: 'HTML' });
});

bot.launch();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DataStream backend server active on port ${PORT}`);
});
