/** @file Idempotencia comercial con MongoDB real: concurrencia, rollback, recuperación y autorización actual. */
'use strict';
const test                   = require('node:test');
const assert                 = require('node:assert/strict');
const crypto                 = require('node:crypto');
const { startIsolatedMongo } = require('./helpers/isolated-mongo.cjs');
const {
  operationReceipt,
} = require('../server/modules/product/services/operation-receipt.service');
const {
  createProductStore,
} = require('../server/modules/product/repositories/product-store.repository');
/** @param {string} value Entrada estable. @returns {string} Huella de contenido. */
function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
test(
  'product: recibo y efectos confirman una sola vez incluso con respuesta perdida',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @param {Object} t Ciclo de vida. @returns {Promise<void>} Usa únicamente réplica temporal propia. */ async (
    t,
  ) => {
    const mongo = await startIsolatedMongo({
      binary   : process.env.TEST_MONGOD_BINARY,
      mongoose : require('mongoose'),
    });
    t.after(mongo.stop);
    const db = mongo.connection.db,
      client = mongo.connection.getClient();
    for (const [name, indexes] of Object.entries(
      require('../server/mongodb-indexes.json').collections,
    ))
      for (const entry of indexes) {
        const { key, ...options } = entry;
        await db.collection(name).createIndex(key, options);
      }
    const store = createProductStore({
      db,
      client,
      /** @param {string} name Evento. @param {Object} data Datos. @param {Object} options Transacción. @returns {Promise<Object>} Outbox real sintético. */ publish :
        (name, data, options) =>
          db.collection('TEST_OUTBOX').insertOne(
            {
              name,
              data,
            },
            options,
          ),
    });
    let allowed = true;
    const actor = {
      user       : { userCode: 'U1' },
      workspace  : 'W1',
      delegation : {
        clientId  : 'C1',
        grantCode : 'G1',
      },
    };
    /** @param {Object} input Comando. @param {Object} source Puerto opcional. @returns {Object} Recibo independiente, como tras reiniciar el proceso. */
    function receipt(input, source = store) {
      return operationReceipt({
        store  : source,
        actor,
        action : 'synthetic-create',
        input,
        digest,
        /** @returns {Promise<void>} Revalida la recuperación. */ async authorize() {
          if (!allowed) throw Object.assign(new Error('revoked'), { statusCode: 403 });
        },
      });
    }
    const input = {
      idempotencyKey : 'key-for-concurrent-operation',
      name           : 'Único',
    };
    /** @param {Object} tx Unidad. @returns {Promise<Object>} Hecho y resultado indivisibles. */
    async function change(tx) {
      await tx.emit('synthetic.changed', { code: 'unique' });
      return {
        code     : 'unique',
        revision : 1,
      };
    }
    const values = await Promise.all(
      Array.from(
        { length: 8 },
        /** @returns {Promise<Object>} Carrera real de commits. */ () =>
          receipt(input).transaction(change),
      ),
    );
    assert.ok(
      values.every(
        /** @param {Object} value Resultado. @returns {boolean} Identidad estable. */ (value) =>
          value.code === 'unique',
      ),
    );
    assert.equal(await db.collection('TEST_OUTBOX').countDocuments(), 1);
    assert.deepEqual(
      await receipt({
        name           : 'Único',
        idempotencyKey : input.idempotencyKey,
      }).replay(),
      values[0],
    );
    await assert.rejects(
      receipt({
        ...input,
        name : 'Distinto',
      }).transaction(change),
      { statusCode: 409 },
    );
    allowed = false;
    await assert.rejects(receipt(input).replay(), { statusCode: 403 });
    allowed = true;
    const rollback = {
      ...input,
      idempotencyKey : 'key-for-rollback-operation',
    };
    await assert.rejects(
      receipt(rollback).transaction(
        /** @param {Object} tx Unidad. @returns {Promise<void>} Simula fallo antes de commit. */ async (
          tx,
        ) => {
          await change(tx);
          throw new Error('rollback');
        },
      ),
      /rollback/,
    );
    assert.equal(await receipt(rollback).replay(), undefined);
    assert.equal(await db.collection('TEST_OUTBOX').countDocuments(), 1);
    const lost      = {
      ...input,
      idempotencyKey : 'key-for-lost-response',
    };
    const uncertain = {
      ...store,
      /** @param {Function} work Trabajo. @returns {Promise<void>} Confirma y pierde la respuesta del commit. */ async transaction(
        work,
      ) {
        await store.transaction(work);
        throw new Error('connection-lost-after-commit');
      },
    };
    assert.deepEqual(await receipt(lost, uncertain).transaction(change), values[0]);
    assert.deepEqual(await receipt(lost).replay(), values[0]);
    assert.equal(await db.collection('TEST_OUTBOX').countDocuments(), 2);

    const {
      productRecords,
    } = require('../server/modules/product/services/product-records.service');
    const records = productRecords({
      store,
      digest,
      references                                                                          : {},
      fiscal                                                                              : {},
      /** @returns {Object} Delegación. */ context                                        : () => actor,
      clock                                                                               : Date.now,
      /** @param {string} resource Tipo. @returns {string} Identidad nueva. */ identifier : (
        resource,
      ) => resource + '-' + crypto.randomUUID(),
    });
    actor.policies = [
      'product.category.create.global',
      'product.category.update.global',
      'product.category.view.global',
    ];
    const data    = {
      name           : 'Categoría sintética',
      description    : '',
      active         : true,
      parentCode     : '',
      idempotencyKey : 'real-product-operation',
    };
    const created = await records.create('category', data);
    assert.deepEqual(await records.create('category', data), created);
    const update  = {
      ...data,
      code           : created.code,
      revision       : created.revision,
      name           : 'Cambio',
      idempotencyKey : 'real-product-update',
    };
    const updated = await records.update('category', update);
    assert.deepEqual(await records.update('category', update), updated);
    await assert.rejects(
      records.update('category', {
        ...update,
        idempotencyKey : 'real-stale-revision',
      }),
      { statusCode: 409 },
    );
    actor.policies = [];
    await assert.rejects(records.create('category', data), { statusCode: 403 });
  },
);
