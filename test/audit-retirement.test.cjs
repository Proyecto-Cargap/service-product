/** @file Comprueba el borrado idempotente y exclusivo de la bitácora retirada en una base MongoDB aislada. */
'use strict';
const test                   = require('node:test');
const assert                 = require('node:assert/strict');
const mongoose               = require('mongoose');
const { startIsolatedMongo } = require('./helpers/isolated-mongo.cjs');
const { removeLegacyAudit }  = require('../ops/remove-legacy-audit.cjs');
test(
  'retirada explícita elimina datos e índices antiguos y conserva productos y Timeline',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @returns {Promise<void>} Simulación, aplicación y segunda ejecución sin pérdida ajena. */ async () => {
    const mongo = await startIsolatedMongo({
      binary : process.env.TEST_MONGOD_BINARY,
      mongoose,
    });
    try {
      const db = mongo.connection.db;
      for (const name of ['PRODUCT_AUDIT', 'PRODUCT_ITEM', 'COMMUNICATION_TIMELINE'])
        await db.collection(name).insertOne({ code: 'preserved' });
      await db.collection('PRODUCT_AUDIT').createIndex({ code: 1 }, { unique: true });
      assert.equal((await removeLegacyAudit(db)).exists, true);
      const result = await removeLegacyAudit(db, true);
      assert.equal(result.count, 1);
      assert.equal(result.exists, false);
      assert.equal((await removeLegacyAudit(db, true)).count, 0);
      assert.equal(await db.collection('PRODUCT_ITEM').countDocuments(), 1);
      assert.equal(await db.collection('COMMUNICATION_TIMELINE').countDocuments(), 1);
    } finally {
      await mongo.stop();
    }
  },
);
