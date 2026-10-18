const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const esim = require('./esim');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function loadServiceAccount(envVar = 'FIREBASE_SERVICE_ACCOUNT', filenameHint = 'firebase') {
  // Preferred: an env var holding the whole JSON.
  if (process.env[envVar]) {
    return JSON.parse(process.env[envVar]);
  }
  // Fallback: a Render "Secret File", which Render mounts under /etc/secrets/<filename>.
  const dir = '/etc/secrets';
  if (fs.existsSync(dir)) {
    const re = new RegExp(filenameHint, 'i');
    const match = fs.readdirSync(dir).find((f) => re.test(f));
    if (match) return JSON.parse(fs.readFileSync(path.join(dir, match), 'utf8'));
  }
  throw new Error(
    `No credentials found for ${envVar}. Set it as an env var, ` +
    `or add a Secret File whose name contains "${filenameHint}".`
  );
}

admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount('FIREBASE_SERVICE_ACCOUNT', 'firebase')),
});
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// The wallet's unit of account: an integer count of "credits" where this
// many credits = $1 USD. Every balance and every pack price is stored in
// credits, not megabytes — a pack's own costCredits field is what encodes
// "1GB costs more in Kenya than in country X" (see /redeem below), so this
// constant itself never changes per country. Must match the app's
// AppConfig.creditsPerUsd exactly, since both sides do this conversion.
const CREDITS_PER_USD = Number(process.env.CREDITS_PER_USD || 1000);

// Earning: what fraction of an advertiser's payout the user actually gets
// (the rest is your margin), converted straight to credits via CREDITS_PER_USD.
const USER_SHARE = Number(process.env.USER_SHARE || 0.5);

// M-Pesa top-up is no longer called from the app (switched to IAP-only —
// see AppConfig.iapProductIds in main.dart). The rate and endpoint below
// are left in place, dormant, in case Kenya-specific top-up comes back
// later; nothing currently sends traffic to them.
const CREDITS_PER_KES = Number(process.env.CREDITS_PER_KES || 4);
const MIN_TOPUP_KES = Number(process.env.MIN_TOPUP_KES || 10);

// How many credits each Play Console "in-app product" grants. This is the
// SINGLE source of truth for IAP amounts — the app only shows these for
// display, and a modified client claiming a different amount is ignored,
// since the backend looks the real amount up here by productId instead.
// Defaults assume each product is priced at roughly $1 / $5 / $10 in Play
// Console — adjust IAP_CREDITS_* to match whatever you actually price them at.
// Keep these IDs in sync with AppConfig.iapProductIds in main.dart.
const IAP_PRODUCT_CREDITS = {
  credits_small: Number(process.env.IAP_CREDITS_SMALL || 1 * CREDITS_PER_USD),
  credits_medium: Number(process.env.IAP_CREDITS_MEDIUM || 5 * CREDITS_PER_USD),
  credits_large: Number(process.env.IAP_CREDITS_LARGE || 10 * CREDITS_PER_USD),
};

// Your app's Android package name, exactly as in Play Console (and as set
// in android/app/build.gradle's applicationId).
const ANDROID_PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || '';

// Lazily-created Play Developer API client. Needs a Google service account
// (separate from your Firebase one) that's been linked in Play Console under
// Setup > API access, with "View financial data" permission at minimum.
let _androidPublisher = null;
async function getAndroidPublisher() {
  if (_androidPublisher) return _androidPublisher;
  const auth = new google.auth.GoogleAuth({
    credentials: loadServiceAccount('GOOGLE_PLAY_SERVICE_ACCOUNT', 'google-play'),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  _androidPublisher = google.androidpublisher({ version: 'v3', auth });
  return _androidPublisher;
}

const app = express();

// ---------------------------------------------------------------------------
// Ledger: the ONLY place balances change. Idempotent and atomic.
// ---------------------------------------------------------------------------
async function applyLedger({ uid, deltaCredits, type, refId, meta = {}, orderRef = null }) {
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

    const balance = Number(userSnap.data().creditBalance || 0);
    if (balance + deltaCredits < 0) throw new Error('INSUFFICIENT');

    tx.update(userRef, { creditBalance: FieldValue.increment(deltaCredits) });
    tx.set(ledgerRef, {
      uid, type, deltaCredits, refId, meta,
      status: 'confirmed',
      createdAt: FieldValue.serverTimestamp(),
    });
    if (orderRef) {
      tx.update(orderRef, { status: 'completed', completedAt: FieldValue.serverTimestamp() });
    }
    return { duplicate: false, newBalance: balance + deltaCredits };
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
      deltaCredits: Math.floor(order.amountKes * CREDITS_PER_KES),
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
// Verify a Google Play purchase and credit the wallet accordingly. This
// NEVER trusts the amount the client claims — it looks up the real credit
// amount in IAP_PRODUCT_CREDITS by productId, and confirms the purchase
// itself directly with Google's Play Developer API using purchaseToken, so
// a modified APK can't fake a purchase or inflate the credited amount.
// ---------------------------------------------------------------------------
app.post('/iap/verify', requireUser, async (req, res) => {
  const { productId, purchaseToken } = req.body || {};
  if (!productId || !purchaseToken) {
    return res.status(400).json({ success: false, message: 'Missing productId or purchaseToken' });
  }
  const credits = IAP_PRODUCT_CREDITS[productId];
  if (!credits) {
    return res.status(400).json({ success: false, message: 'Unknown product' });
  }
  if (!ANDROID_PACKAGE_NAME) {
    console.error('ANDROID_PACKAGE_NAME not set — cannot verify IAP purchases');
    return res.status(500).json({ success: false, message: 'Server not configured for purchases yet' });
  }

  try {
    const publisher = await getAndroidPublisher();
    const result = await publisher.purchases.products.get({
      packageName: ANDROID_PACKAGE_NAME,
      productId,
      token: purchaseToken,
    });

    // purchaseState: 0 = purchased, 1 = cancelled, 2 = pending
    if (result.data.purchaseState !== 0) {
      return res.status(402).json({ success: false, message: 'Purchase not completed' });
    }

    // Use the token itself as the idempotency key — Google issues a unique
    // token per purchase, so replaying the same token can't double-credit.
    const refId = crypto.createHash('sha256').update(purchaseToken).digest('hex').slice(0, 40);

    await applyLedger({
      uid: req.uid,
      deltaCredits: credits,
      type: 'iap',
      refId,
      meta: { productId },
    });

    // Tell Google this purchase has been delivered, so it won't auto-refund
    // for "not acknowledged within 3 days". Consumables are then "consumed"
    // on the client side (completePurchase), which is what actually allows
    // the user to buy the same product again.
    try {
      await publisher.purchases.products.acknowledge({
        packageName: ANDROID_PACKAGE_NAME,
        productId,
        token: purchaseToken,
        requestBody: {},
      });
    } catch (ackErr) {
      // Already acknowledged is fine; anything else just gets logged —
      // the credit above has already happened either way.
      console.warn('IAP acknowledge warning', ackErr.message);
    }

    res.json({ success: true, creditedCredits: credits });
  } catch (e) {
    console.error('IAP verify error', e.message);
    res.status(502).json({ success: false, message: 'Could not verify purchase with Google' });
  }
});

// ---------------------------------------------------------------------------
// Redeem an eSIM pack with data credits. Safe to retry with the same requestId.
//
// Pack docs live at config/data_packs/items/{packId} with a costCredits
// field — this is where per-country pricing actually lives. costCredits is
// set independently per pack from that country's real wholesale $/GB, so a
// Kenya pack and a cheaper country's pack can (and should) cost different
// amounts of credits for the "same" 1GB — CREDITS_PER_USD above never
// changes, only each pack's own price does. sizeMb is just the nominal
// data amount for display; it plays no part in the price.
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
    if (!pack || !(pack.costCredits > 0) || pack.active === false) {
      return res.status(404).json({ success: false, message: 'Pack not available' });
    }

    await orderRef.create({
      uid, packId, costCredits: pack.costCredits, status: 'pending', createdAt: FieldValue.serverTimestamp(),
    });

    try {
      await applyLedger({ uid, deltaCredits: -pack.costCredits, type: 'esim', refId: orderId, meta: { packId } });
    } catch (e) {
      await orderRef.update({ status: 'failed' });
      if (e.message === 'INSUFFICIENT') {
        return res.status(402).json({ success: false, message: 'Not enough credits' });
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
      await applyLedger({ uid, deltaCredits: pack.costCredits, type: 'esim_refund', refId: orderId, meta: { packId } });
      await orderRef.update({ status: 'refunded' });
      return res.status(502).json({ success: false, message: 'eSIM provider error. Your credits were refunded.' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// Tapjoy S2S callback. Tapjoy calls this with its OWN scheme — a GET request
// with an MD5 verifier, not the generic postback format below. Set this
// exact URL as your "Callback URL" under Tapjoy Dashboard > Monetize >
// Virtual Currency, and put the currency's "Secret Key" (NOT the SDK key)
// in Render as TAPJOY_VC_SECRET_KEY.
//
// Simplest setup: in that Virtual Currency's exchange-rate settings, make
// 1 unit of Tapjoy currency = 1 credit (i.e. $0.001, matching CREDITS_PER_USD
// above), so the `currency` param below can be credited directly with no
// extra conversion math.
// ---------------------------------------------------------------------------
app.get('/postback/tapjoy', async (req, res) => {
  try {
    const { snuid, currency, id, verifier } = req.query;
    if (!snuid || !currency || !id || !verifier) return res.sendStatus(403);

    const secret = process.env.TAPJOY_VC_SECRET_KEY || '';
    const expected = crypto
      .createHash('md5')
      .update(`${id}:${snuid}:${currency}:${secret}`)
      .digest('hex');

    if (!safeEqual(expected, String(verifier))) {
      console.warn('Tapjoy callback: verifier mismatch for id', id);
      return res.sendStatus(403); // tells Tapjoy: do not retry
    }

    const credits = Math.floor(Number(currency));
    if (!(credits > 0)) return res.sendStatus(403);

    await applyLedger({
      uid: String(snuid),
      deltaCredits: credits,
      type: 'offer_tapjoy',
      refId: String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100),
      meta: {},
    });
    return res.sendStatus(200); // tells Tapjoy: credited, stop retrying
  } catch (e) {
    console.error('Tapjoy callback error', e.message);
    return res.sendStatus(500); // unexpected error — let Tapjoy retry
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

    const credits = Math.floor(payoutUsd * USER_SHARE * CREDITS_PER_USD);
    if (credits < 1) return res.status(200).send('too small');

    const network = req.params.network.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
    const result = await applyLedger({
      uid: String(uid),
      deltaCredits: credits,
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
