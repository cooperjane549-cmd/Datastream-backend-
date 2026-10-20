// One-off script: bulk-imports a pack catalog CSV into Firestore's
// config/data_packs/items collection. Safe to re-run — each row's "id"
// column is used as the Firestore document ID, so re-running with an
// updated CSV (e.g. next month's eSIM Go rate sheet) just overwrites the
// same documents with fresh prices, rather than creating duplicates.
//
// Usage (from the backend's root folder, wherever FIREBASE_SERVICE_ACCOUNT
// is available as an env var — e.g. Render's Shell tab, or locally with a
// .env you source first):
//
//   node import-packs.js data/esimgo-packs-2026-10.csv
//
// CSV columns expected: id,country,name,sizeMb,validityDays,costCredits,providerBundleCode,active

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const dir = '/etc/secrets';
  if (fs.existsSync(dir)) {
    const match = fs.readdirSync(dir).find((f) => /firebase/i.test(f));
    if (match) return JSON.parse(fs.readFileSync(path.join(dir, match), 'utf8'));
  }
  throw new Error('No Firebase credentials found (FIREBASE_SERVICE_ACCOUNT env var or a Secret File).');
}

// Minimal CSV parser — fine for this file since none of the fields contain
// commas or quotes (country names like "Congo (Region)" have no commas).
function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => (row[h] = (cells[i] || '').trim()));
    return row;
  });
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node import-packs.js <path-to-csv>');
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  const db = admin.firestore();

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Importing ${rows.length} packs from ${csvPath} ...`);

  const collectionRef = db.collection('config').doc('data_packs').collection('items');

  // Firestore batches max out at 500 writes — chunk accordingly.
  const BATCH_SIZE = 450;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const row of chunk) {
      const docRef = collectionRef.doc(row.id);
      batch.set(docRef, {
        country: row.country,
        name: row.name,
        sizeMb: Number(row.sizeMb),
        validityDays: Number(row.validityDays),
        costCredits: Number(row.costCredits),
        providerBundleCode: row.providerBundleCode,
        active: row.active === 'true',
      });
    }
    await batch.commit();
    written += chunk.length;
    console.log(`  ${written} / ${rows.length} written`);
  }

  console.log('Done.');
}

main().catch((e) => {
  console.error('Import failed:', e);
  process.exit(1);
});
