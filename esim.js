// eSIM provider module — eSIM Go integration.
//
// Must return: { lpaString: 'LPA:1$...', providerRef: 'their-order-id' }
// Must THROW on any failure (the backend then refunds the user's credits —
// see the try/catch around esim.createProfile() in server.js's /redeem).
//
// Docs used for this: https://docs.esim-go.com/guides/ordering/
//                      https://docs.esim-go.com/guides/authentication/
//                      https://docs.esim-go.com/api/v2_5/operations/orders/post

const ESIMGO_BASE_URL = process.env.ESIMGO_BASE_URL || 'https://api.esim-go.com/v2.5';

async function createProfile({ pack, uid }) {
  // Test mode: returns a fake code with NO call to eSIM Go, so you can
  // exercise the full redeem/ledger/refund flow without spending real
  // balance. Flip ESIM_TEST_MODE to 'false' on Render once you're ready
  // to go live with real orders.
  if (process.env.ESIM_TEST_MODE === 'true') {
    return {
      providerRef: 'TEST-' + Date.now(),
      lpaString: 'LPA:1$test.example.com$TEST-ACTIVATION-CODE',
    };
  }

  const apiKey = process.env.ESIMGO_API_KEY;
  if (!apiKey) {
    throw new Error('ESIMGO_API_KEY not set — cannot place a real eSIM order');
  }

  // Each pack document needs its own eSIM Go bundle code (from their
  // catalogue, e.g. "esim_1GB_7D_KE_U") stored as providerBundleCode.
  // costCredits/sizeMb are YOUR pricing/display fields — eSIM Go only
  // cares about this code.
  const bundleCode = pack.providerBundleCode;
  if (!bundleCode) {
    throw new Error(`Pack ${pack.id} has no providerBundleCode set`);
  }

  const response = await fetch(`${ESIMGO_BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'transaction',
      assign: true, // create + assign a brand-new eSIM for this order
      order: [
        { type: 'bundle', quantity: 1, item: bundleCode },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Common cause: your eSIM Go account balance is empty — same idea as
    // PayHero's Service Wallet. Check their portal's balance page first.
    throw new Error(
      `eSIM Go order failed (${response.status}): ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  // The exact response shape for a small (<=5 eSIM) order includes the
  // activation details directly. Field names below are eSIM Go's
  // documented ones (iccid, smdpAddress, matchingId) — if their response
  // shape differs from this in practice, this throws with the RAW
  // response logged, rather than silently returning a broken code.
  const orderItem = (data.order && data.order[0]) || data;
  const smdpAddress = orderItem.smdpAddress || data.smdpAddress;
  const matchingId = orderItem.matchingId || data.matchingId;

  if (!smdpAddress || !matchingId) {
    console.error('eSIM Go order response (unexpected shape):', JSON.stringify(data));
    throw new Error('eSIM Go order succeeded but activation details were missing from the response');
  }

  const orderReference = data.orderReference || null;
  let appleInstallUrl = null;
  let androidInstallUrl = null;

  // Fetch one-tap install links — lets the user install the eSIM with a
  // single tap on the SAME phone, no QR scan and no second device needed.
  // Best-effort: if this call fails for any reason, we still return the
  // QR/manual-entry fallback (lpaString) rather than failing the whole
  // order over a nice-to-have.
  if (orderReference) {
    try {
      const assignRes = await fetch(
        `${ESIMGO_BASE_URL}/esims/assignments?reference=${encodeURIComponent(orderReference)}&additionalFields=installUrl`,
        { headers: { 'X-API-Key': apiKey } }
      );
      const assignData = await assignRes.json().catch(() => ({}));
      if (assignRes.ok) {
        const assignment = (Array.isArray(assignData) && assignData[0]) || assignData.assignments?.[0] || assignData;
        appleInstallUrl = assignment.appleInstallUrl || null;
        androidInstallUrl = assignment.androidInstallUrl || null;
      } else {
        console.warn('eSIM Go install-link fetch failed (non-fatal):', JSON.stringify(assignData).slice(0, 300));
      }
    } catch (e) {
      console.warn('eSIM Go install-link fetch error (non-fatal):', e.message);
    }
  }

  return {
    providerRef: orderReference || orderItem.iccid || 'unknown',
    lpaString: `LPA:1$${smdpAddress}$${matchingId}`,
    smdpAddress,
    activationCode: matchingId,
    appleInstallUrl,
    androidInstallUrl,
  };
}

module.exports = { createProfile };
