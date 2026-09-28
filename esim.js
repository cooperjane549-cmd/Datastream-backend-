// eSIM provider module.
// Replace the body of createProfile() with the real wholesale provider API
// call once you have an account. The rest of the backend does not change.
//
// Must return: { lpaString: 'LPA:1$...', providerRef: 'their-order-id' }
// Must THROW on any failure (the backend then refunds the user's credits).

async function createProfile({ pack, uid }) {
  // Safe default: refuse unless test mode is explicitly on, so users can
  // never spend credits on a fake activation code by accident.
  if (process.env.ESIM_TEST_MODE !== 'true') {
    throw new Error('Live eSIM provider not connected yet');
  }

  return {
    providerRef: 'TEST-' + Date.now(),
    lpaString: 'LPA:1$test.example.com$TEST-ACTIVATION-CODE',
  };
}

module.exports = { createProfile };
