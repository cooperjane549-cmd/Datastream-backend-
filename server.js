const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const esim = require('./esim');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.serviceAccountkey.json)),
});
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// Rates. Placeholders: set them so credits always cost you LESS than the
// wholesale eSIM data they are redeemed for.
const MB_PER_KES = Number(process.env.MB_PER_KES || 4);      // top-up: MB credits per 1 KES paid
const MB_PER_USD = Number(process.env.MB_PER_USD || 500);    // earning: MB credits per $1 given to the user
const USER_SHARE = Number(process.env.USER_SHARE || 0.5);    // earning: share of advertiser payout the user gets
const MIN_TOPUP_KES = Number(process.env.MIN_TOPUP_KES || 10);

const app = express();

// ---------------------------------------------------------------------------
// Ledger: the ONLY place balances change. Idempotent and atomic.
// ---------------------------------------------------------------------------
async function applyLedger({ uid, deltaMb, type, refId, meta = {}, orderRef = null }) {
  const ledgerRef = db.collection('ledger').doc(`${type}_${refId}`);
  const userRef = db.collection('users').doc(uid);

  return db.runTransaction(async (tx) => {
    const [ledgerSnap, userSnap, orderSnap] = await Promise.all([
      tx.get(ledgerRef),
      tx.get(userRef),
      orderRef ? tx.get(orderRef) : Promise.resolve(null),
    ]);

    if (ledgerSnap.exists) return { duplicate: true }; // already processed
    if (!userSnap.exists) throw new Error('User not found');
    if (orderRef && (!orderSnap.exists || orderSnap.data().status !== 'pending')) {
      return { duplicate: true };
    }

    const balance = Number(userSnap.data().dataBalanceMb || 0);
    if (balance + deltaMb < 0) throw new Error('INSUFFICIENT');

    tx.update(userRef, { dataBalanceMb: FieldValue.increment(deltaMb) });
    tx.set(ledgerRef, {
      uid, type, deltaMb, refId, meta,
      status: 'confirmed',
      createdAt: FieldValue.serverTimestamp(),
    });
    if (orderRef) {
      tx.update(orderRef, { status: 'completed', completedAt: FieldValue.serverTimestamp() });
    }
    return { duplicate: false, newBalance: balance + deltaMb };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function requireUser(req, res, next) {
  try {
    const h = req.get('Authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Missing token' });
    req.uid = (await admin.auth().verifyIdToken(token)).uid;
    next();
  } catch (e) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (/^254[17]\d{8}$/.test(d)) return '0' + d.slice(3);
  if (/^0[17]\d{8}$/.test(d)) return d;
  if (/^[17]\d{8}$/.test(d)) return '0' + d;
  return null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifyPayHeroSignature(rawBody, headerValue) {
  const secret = process.env.PAYHERO_WEBHOOK_SECRET;
  if (!secret || !headerValue) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const got = String(headerValue).replace(/^sha256=/i, '').trim();
  return safeEqual(digest.toString('hex'), got) || safeEqual(digest.toString('base64'), got);
}

// ---------------------------------------------------------------------------
// PayHero webhook. Registered BEFORE express.json() so the body stays raw.
// ---------------------------------------------------------------------------
app.post('/webhooks/payhero', express.raw({ type: '*/*' }), async (req, res) => {
  const headerName = (process.env.PAYHERO_SIGNATURE_HEADER || 'x-payhero-signature').toLowerCase();

  if (!verifyPayHeroSignature(req.body, req.get(headerName))) {
    // Header NAMES only (never values) so you can see what PayHero really sends.
    console.warn('PayHero webhook rejected. Headers received:', Object.keys(req.headers).join(', '));
    return res.sendStatus(401);
  }

  try {
    const body = JSON.parse(req.body.toString('utf8'));
    const r = body.response || body;
    const ref = r.ExternalReference || r.external_reference;
    const status = String(r.Status || r.status || '').toLowerCase();
    const codeOk = r.ResultCode === undefined || Number(r.ResultCode) === 0;
    const paid = status === 'success' && codeOk;

    if (!ref) return res.sendStatus(200);
    const orderRef = db.collection('orders').doc(ref);
    const order = (await orderRef.get()).data();
    if (!order) return res.sendStatus(200);

    if (!paid) {
      if (order.status === 'pending') await orderRef.update({ status: 'failed' });
      return res.sendStatus(200);
    }

    // Fail closed: amount must be present and at least what was requested.
    if (!(Number(r.Amount) >= order.amountKes)) {
      await orderRef.update({ status: 'amount_mismatch' });
      return res.sendStatus(200);
    }

    await applyLedger({
      uid: order.uid,
      deltaMb: Math.floor(order.amountKes * MB_PER_KES),
      type: 'topup',
      refId: ref,
      meta: { amountKes: order.amountKes, mpesaReceipt: r.MpesaReceiptNumber || null },
      orderRef,
    });
    return res.sendStatus(200);
  } catch (e) {
    console.error('PayHero webhook error', e);
    return res.sendStatus(500); // PayHero will retry
  }
});

app.use(express.json());

// ---------------------------------------------------------------------------
// Health check (also useful for a free uptime pinger to reduce cold starts)
// ---------------------------------------------------------------------------
app.get('/', (req, res) => res.send('DataStream backend OK'));
app.get('/health', (req, res) => res.send('ok'));

// ---------------------------------------------------------------------------
// Top-up: creates a pending order and sends the M-Pesa STK push via PayHero
// ---------------------------------------------------------------------------
app.post('/topup', requireUser, async (req, res) => {
  try {
    const amountKes = Math.floor(Number(req.body.amountKes));
    const phone = normalizePhone(req.body.phone);
    if (!amountKes || amountKes < MIN_TOPUP_KES || amountKes > 20000) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (!phone) return res.status(400).json({ success: false, message: 'Invalid phone number' });

    const ref = `TOP-${crypto.randomUUID()}`;
    const orderRef = db.collection('orders').doc(ref);
    await orderRef.set({
      uid: req.uid, amountKes, phone, status: 'pending', createdAt: FieldValue.serverTimestamp(),
    });

    const auth = Buffer.from(`${process.env.PAYHERO_USER}:${process.env.PAYHERO_PASS}`).toString('base64');
    const r = await fetch('https://backend.payhero.co.ke/api/v2/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: amountKes,
        phone_number: phone,
        channel_id: Number(process.env.PAYHERO_CHANNEL_ID),
        provider: 'm-pesa',
        external_reference: ref,
        callback_url: `${process.env.PUBLIC_URL}/webhooks/payhero`,
      }),
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('PayHero STK error', r.status, JSON.stringify(data).slice(0, 300));
      await orderRef.update({ status: 'failed' });
      return res.status(502).json({ success: false, message: 'Could not start payment' });
    }
    res.json({ success: true, reference: ref, message: 'Check your phone and enter your M-Pesa PIN' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// Redeem an eSIM pack with data credits. Safe to retry with the same requestId.
// Pack docs live at config/data_packs/items/{packId} with a costMb field.
// ---------------------------------------------------------------------------
app.post('/redeem', requireUser, async (req, res) => {
  const { packId, requestId } = req.body || {};
  if (!packId || !requestId) {
    return res.status(400).json({ success: false, message: 'Missing packId or requestId' });
  }

  const uid = req.uid;
  const orderId = `${uid}_${String(requestId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`;
  const orderRef = db.collection('esim_orders').doc(orderId);

  try {
    const existing = await orderRef.get();
    if (existing.exists) {
      const o = existing.data();
      if (o.status === 'completed') {
        return res.json({ success: true, esimDetails: { lpaString: o.lpaString } });
      }
      return res.status(409).json({ success: false, message: 'Order already processed or in progress' });
    }

    const packSnap = await db.collection('config').doc('data_packs').collection('items').doc(String(packId)).get();
    const pack = packSnap.data();
    if (!pack || !(pack.costMb > 0) || pack.active === false) {
      return res.status(404).json({ success: false, message: 'Pack not available' });
    }

    await orderRef.create({
      uid, packId, costMb: pack.costMb, status: 'pending', createdAt: FieldValue.serverTimestamp(),
    });

    try {
      await applyLedger({ uid, deltaMb: -pack.costMb, type: 'esim', refId: orderId, meta: { packId } });
    } catch (e) {
      await orderRef.update({ status: 'failed' });
      if (e.message === 'INSUFFICIENT') {
        return res.status(402).json({ success: false, message: 'Not enough data credits' });
      }
      throw e;
    }

    try {
      const profile = await esim.createProfile({ pack: { id: packId, ...pack }, uid });
      await orderRef.update({
        status: 'completed', lpaString: profile.lpaString, providerRef: profile.providerRef || null,
      });
      return res.json({ success: true, esimDetails: { lpaString: profile.lpaString } });
    } catch (e) {
      console.error('eSIM provider failed', e.message);
      await applyLedger({ uid, deltaMb: pack.costMb, type: 'esim_refund', refId: orderId, meta: { packId } });
      await orderRef.update({ status: 'refunded' });
      return res.status(502).json({ success: false, message: 'eSIM provider error. Your credits were refunded.' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// CPA / offerwall postback. The network calls this when a user completes an
// offer. Give the network this URL, e.g.:
//   https://YOUR-APP.onrender.com/postback/cpalead?secret=XXXX&uid={subid}&txid={txid}&payout={payout}
// (replace the {macros} with that network's own macro names)
// ---------------------------------------------------------------------------
app.all('/postback/:network', async (req, res) => {
  try {
    const q = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };

    const want = process.env.CPA_POSTBACK_SECRET || '';
    if (!want || !safeEqual(q.secret || '', want)) return res.sendStatus(401);

    const uid = q.uid || q.user_id || q.subid || q.sub_id;
    const txid = q.txid || q.transaction_id || q.tx_id || q.oid;
    const payoutUsd = Number(q.payout || q.amount || q.reward);
    if (!uid || !txid || !(payoutUsd > 0)) return res.status(400).send('bad params');

    const mb = Math.floor(payoutUsd * USER_SHARE * MB_PER_USD);
    if (mb < 1) return res.status(200).send('too small');

    const network = req.params.network.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
    const result = await applyLedger({
      uid: String(uid),
      deltaMb: mb,
      type: `offer_${network}`,
      refId: String(txid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100),
      meta: { payoutUsd },
    });
    res.status(200).send(result.duplicate ? 'duplicate' : 'ok');
  } catch (e) {
    console.error('postback error', e.message);
    res.status(500).send('error');
  }
});

app.listen(process.env.PORT || 3000, () => console.log('DataStream backend running'));
