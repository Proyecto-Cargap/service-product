/** @file Verifica vencimientos durables y recuperación sin barridos periódicos en product. */
'use strict';
const test                   = require('node:test');
const assert                 = require('node:assert/strict');
const mongoose               = require('mongoose');
const { startIsolatedMongo } = require('./helpers/isolated-mongo.cjs');
const {
  createProductStore,
} = require('../server/modules/product/repositories/product-store.repository');
test(
  'la agenda considera pendientes, leases y reintentos sin reactivar estados terminales',
  {
    skip    : !process.env.TEST_MONGOD_BINARY,
    timeout : 60000,
  },
  /** @returns {Promise<void>} Usa exclusivamente persistencia temporal. */ async () => {
    const mongo = await startIsolatedMongo({
      binary : process.env.TEST_MONGOD_BINARY,
      mongoose,
    });
    try {
      const db    = mongo.connection.db;
      const store = createProductStore({
        db,
        client : mongo.connection.getClient(),
        /** @returns {Promise<void>} La consulta de agenda no emite hechos. */ async publish() {
          assert.fail('Una lectura no publica eventos.');
        },
      });

      assert.equal(await store.nextImageAt(), undefined);
      await db.collection('PRODUCT_IMAGE_JOB').insertMany([
        {
          fileId      : 'F1',
          status      : 'pending',
          availableAt : 3000,
        },
        {
          fileId      : 'F2',
          status      : 'cleaning',
          availableAt : 2000,
        },
      ]);
      assert.equal(await store.nextImageAt(), 2000);
      const claim = await store.claimImage(2000);
      assert.equal(claim.fileId, 'F2');
      assert.equal(await store.nextImageAt(), 3000);
      await store.finishImage(claim);
      assert.equal(await store.nextImageAt(), 3000);
      await store.finishImage(await store.claimImage(3000));
      assert.equal(await store.nextImageAt(), undefined);
    } finally {
      await mongo.stop();
    }
  },
);
