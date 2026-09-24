require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// 1. INITIALIZE FIREBASE ADMIN SDK
const serviceAccount = require('./serviceAccountKey.json');
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

  try {
    const userRef = db.collection('users').doc(userId);
    
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const currentBalance = userDoc.data().balanceUsd || 0;
      if (currentBalance < packageCostUsd) {
        throw new Error('Insufficient balance');
      }

      // Deduct credits
      transaction.update(userRef, {
        balanceUsd: admin.firestore.FieldValue.increment(-packageCostUsd)
      });
    });

    // Mock/External eSIM API Call (Replace with live eSIM provider API if needed)
    const lpaString = `LPA:1$rsp.global-esim.com$DS-${Date.now()}-${userId.substring(0, 5)}`;

    // Log transaction record
    await db.collection('esim_redemptions').add({
      userId,
      packageId,
      costUsd: packageCostUsd,
      lpaString,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'eSIM profile activated',
      esimDetails: { lpaString }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// =============================================================================
// PAYPAL CHECKOUT & IPN / WEBHOOK
// =============================================================================
app.get('/paypal/checkout', (req, res) => {
  const { userId } = req.query;
  // Redirect user to PayPal approval URL or hosted payment page
  res.send(`<h2>PayPal Checkout for User: ${userId}</h2><p>Redirecting to payment provider...</p>`);
});

app.post('/api/paypal/webhook', async (req, res) => {
  const { userId, amountPaidUsd, paymentStatus } = req.body;

  if (paymentStatus === 'COMPLETED') {
    await db.collection('users').doc(userId).update({
      balanceUsd: admin.firestore.FieldValue.increment(parseFloat(amountPaidUsd))
    });
    return res.json({ status: 'success' });
  }

  res.status(400).json({ status: 'ignored' });
});

// =============================================================================
// TELEGRAM BOT (M-PESA DEPOSIT APPROVAL)
// =============================================================================

// Firestore listener for new M-Pesa submissions
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

// Handle Telegram Approve button click
bot.action(/approve_(.+)/, async (ctx) => {
  const depositId = ctx.match[1];
  const depositRef = db.collection('mpesa_deposits').doc(depositId);

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(depositRef);
      if (!doc.exists || doc.data().status !== 'pending') {
        throw new Error('Deposit processed or non-existent');
      }

      const deposit = doc.data();
      // Exchange rate logic (e.g. 1 USD = 130 KES)
      const usdCredit = deposit.amountKes / 130.0;

      const userRef = db.collection('users').doc(deposit.userId);
      transaction.update(userRef, {
        balanceUsd: admin.firestore.FieldValue.increment(usdCredit)
      });

      transaction.update(depositRef, { status: 'approved', approvedAt: admin.firestore.FieldValue.serverTimestamp() });
    });

    await ctx.answerCbQuery('Deposit Approved!');
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n✅ <b>STATUS: APPROVED</b>`, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.answerCbQuery(`Error: ${err.message}`);
  }
});

// Handle Telegram Reject button click
bot.action(/reject_(.+)/, async (ctx) => {
  const depositId = ctx.match[1];
  await db.collection('mpesa_deposits').doc(depositId).update({ status: 'rejected' });
  await ctx.answerCbQuery('Deposit Rejected');
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n❌ <b>STATUS: REJECTED</b>`, { parse_mode: 'HTML' });
});

bot.launch();

// START EXPRESS SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DataStream backend live on port ${PORT}`);
});
