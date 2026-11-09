/** @file Aceptación de eliminaciones y retirada de atributos con MongoDB transaccional aislado. */
'use strict';
const test                       = require('node:test');
const assert                     = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const mongoose                   = require('mongoose');
const { startIsolatedMongo }     = require('./helpers/isolated-mongo.cjs');
const {
  createProductStore,
} = require('../server/modules/product/repositories/product-store.repository');
const { composeProduct }     = require('../server/modules/product/compositions/product.composition');
const { createCatalog }      = require('../server/modules/catalog');
const { resourceIdentifier } = require('../server/adapters/identifiers/resource-identifier');
const policies               = require('../config/policies.json');
/** @param {string} code Código de dominio. @returns {Function} Predicado que no oculta fallos técnicos inesperados. */
function fails(code) {
  /** @param {Error} error Rechazo observado. @returns {boolean} Error público esperado. */
  return (error) => error.descriptionCode === code;
}
test(
  'retirada de variantes y atributos: transacciones reales y contratos públicos',
  {
    skip    : !process.env.TEST_MONGOD_BINARY,
    timeout : 120000,
  },
  /** @param {Object} t Escenarios secuenciales. @returns {Promise<void>} No conecta con instalaciones compartidas. */ async (
    t,
  ) => {
    const mongo = await startIsolatedMongo({
      binary : process.env.TEST_MONGOD_BINARY,
      mongoose,
    });
    t.after(mongo.stop);
    const db = mongo.connection.db;
    for (const [name, indexes] of Object.entries(
      require('../server/mongodb-indexes.json').collections,
    ))
      for (const index of indexes) {
        const { key, ...options } = index;
        await db.collection(name).createIndex(key, options);
      }
    const admin    = {
      user      : { userCode: 'USER-RETIREMENT' },
      workspace : 'WORK-TEST',
      policies  : policies.map(
        /** @param {Object} policy Política vigente. @returns {string} Identificador acreditado en la prueba. */
        (policy) => policy.identifier,
      ),
    };
    let actor      = admin;
    let failEvent  = '';
    const store    = createProductStore({
      db,
      client : mongo.connection.getClient(),
      /** @param {string} name Evento canónico. @param {Object} data Hecho. @param {Object} options Sesión. @returns {Promise<Object>} Outbox de prueba atómico o fallo deliberado. */
      publish(name, data, options) {
        if (data.eventType === failEvent) throw new Error('retirement-outbox-unavailable');
        return db.collection('TEST_RETIREMENT_OUTBOX').insertOne(
          {
            name,
            data,
          },
          options,
        );
      },
    });
    const services = composeProduct({
      store,
      identifier : resourceIdentifier,
      /** @returns {Object} Principal actual de cada escenario. */
      context    : () => actor,
      /** @returns {number} Reloj de la prueba. */
      clock      : () => Date.now(),
      /** @param {string} value Identidad canónica. @returns {string} Huella para los recibos reales. */
      digest     : (value) => createHash('sha256').update(value).digest('hex'),
      references : {
        /** @returns {Promise<Object>} Catálogo fiscal vacío; los productos no tienen datos fiscales. */
        async catalog() {
          return {
            items      : [],
            pagination : { total: 0 },
          };
        },
        /** @returns {Promise<Object>} Referencia no utilizada por los escenarios. */
        async customer() {
          return { workspace: actor.workspace };
        },
        /** @returns {Promise<Object>} Valores de referencia aceptados por el doble aislado. */
        async values() {
          return { valid: true };
        },
      },
      files      : {
        /** @returns {Promise<void>} No se permiten efectos documentales durante estas pruebas. */
        async upload() {
          throw new Error('UNEXPECTED_UPLOAD');
        },
        /** @returns {Promise<void>} No se realizan lecturas de archivos reales. */
        async read() {
          throw new Error('UNEXPECTED_FILE_READ');
        },
        /** @returns {Promise<void>} La eliminación lógica no borra imágenes históricas. */
        async remove() {
          throw new Error('UNEXPECTED_FILE_REMOVAL');
        },
      },
    });
    const catalog  = createCatalog({
      services,
      messaging : {
        /** @param {number} statusCode Estado. @param {Object} data Resultado. @returns {Object} Sobre sometido al DTO real. */
        successResponse(statusCode, data) {
          return {
            statusCode,
            descriptionCode : 'OK',
            data,
          };
        },
      },
    });
    /** @param {string} name Acción pública. @param {Object} data Entrada. @returns {Promise<Object>} Resultado validado por los DTO reales. */
    async function call(name, data) {
      return (
        await catalog
          .find(
            /** @param {Object} entry Acción registrada. @returns {boolean} Operación solicitada. */
            (entry) => entry.name === name,
          )
          .handler({ data })
      ).data;
    }
    /** @param {Object} item Registro público. @param {string[]} attributeCodes Ejes propuestos. @returns {Object} Comando cerrado que conserva los demás datos. */
    function changeAttributes(item, attributeCodes) {
      const { code, revision, name, description, type, mode, sku, categoryCode, fiscal, active } =
        item;
      return {
        code,
        revision,
        name,
        description,
        type,
        mode,
        sku,
        categoryCode,
        fiscal,
        active,
        attributeCodes,
      };
    }
    /** @returns {Promise<Object>} Caso Dominios con dos combinaciones y precios distintos. */
    async function fixture() {
      const domain   = await call('product-attribute-create', {
        name   : 'Dominio',
        values : ['.com', '.com.mx'],
        active : true,
      });
      const storage  = await call('product-attribute-create', {
        name   : 'Almacenamiento',
        values : ['1 gb', '2 gb'],
        active : true,
      });
      const item     = await call('product-item-create', {
        name           : 'Dominios',
        description    : '',
        type           : 'product',
        mode           : 'variants',
        sku            : '',
        categoryCode   : '',
        fiscal         : {},
        active         : true,
        attributeCodes : [domain.code, storage.code],
      });
      const variants = [];
      const list     = await call('product-price-list-create', {
        name     : 'Público',
        currency : 'MXN',
        active   : true,
      });
      const prices   = [];
      for (const value of domain.values) {
        const variant = await call('product-sku-create', {
          itemCode   : item.code,
          sku        : randomUUID(),
          name       : value,
          active     : true,
          selections : [
            {
              attributeCode : domain.code,
              value,
            },
            {
              attributeCode : storage.code,
              value         : '1 gb',
            },
          ],
        });
        variants.push(variant);
        prices.push(
          await call('product-price-create', {
            skuCode       : variant.code,
            priceListCode : list.code,
            unitPrice     : '123.456789',
            active        : true,
          }),
        );
      }
      return {
        domain,
        storage,
        item,
        variants,
        list,
        prices,
      };
    }
    await t.test(
      'retirar Almacenamiento conserva variantes, SKU, importes y referencias',
      /** @returns {Promise<void>} Proyecta ambas combinaciones y registra el cambio una sola vez por entidad. */ async () => {
        const f = await fixture();
        actor = {
          ...admin,
          policies : admin.policies.filter(
            /** @param {string} policy Permiso. @returns {boolean} Retira la autorización de modificar variantes. */
            (policy) => policy !== 'product.sku.update.global',
          ),
        };
        await assert.rejects(
          call('product-item-update', changeAttributes(f.item, [f.domain.code])),
          fails('FORBIDDEN'),
        );
        actor = admin;
        failEvent = 'product.sku.updated';
        await assert.rejects(
          call('product-item-update', changeAttributes(f.item, [f.domain.code])),
          /retirement-outbox-unavailable/,
        );
        failEvent = '';
        assert.deepEqual(await call('product-item-get-one', { code: f.item.code }), f.item);
        assert.equal(
          (await call('product-sku-get-one', { code: f.variants[0].code })).selections.length,
          2,
        );
        const item = await call('product-item-update', changeAttributes(f.item, [f.domain.code]));
        assert.equal(item.revision, f.item.revision + 1);
        const variants = await call('product-sku-get-list', { itemCode: item.code });
        assert.equal(variants.items.length, 2);
        for (const variant of variants.items) {
          const old = f.variants.find(
            /** @param {Object} previous Variante inicial. @returns {boolean} Misma identidad estable. */
            (previous) => previous.code === variant.code,
          );
          assert.equal(variant.sku, old.sku);
          assert.equal(variant.revision, old.revision + 1);
          assert.deepEqual(variant.selections, old.selections.slice(0, 1));
        }
        for (const price of f.prices)
          assert.deepEqual(await call('product-price-get-one', { code: price.code }), price);
        const attribute = await call('product-attribute-delete', {
          code     : f.storage.code,
          revision : f.storage.revision,
        });
        assert.equal(attribute.erased, true);
        await assert.rejects(
          call('product-attribute-get-one', { code: attribute.code }),
          fails('PRODUCT_NOT_FOUND'),
        );
      },
    );
    await t.test(
      'colisiones, último atributo y cambios de ejes rechazan sin escrituras parciales',
      /** @returns {Promise<void>} Incluye variantes inactivas y revierte artículos, combinaciones y outbox. */ async () => {
        const f       = await fixture();
        const variant = f.variants[0];
        await call('product-sku-create', {
          itemCode   : f.item.code,
          sku        : randomUUID(),
          name       : 'Otro almacenamiento',
          active     : false,
          selections : [
            {
              attributeCode : f.domain.code,
              value         : variant.selections[0].value,
            },
            {
              attributeCode : f.storage.code,
              value         : '2 gb',
            },
          ],
        });
        const before = await db.collection('TEST_RETIREMENT_OUTBOX').countDocuments();
        await assert.rejects(
          call('product-item-update', changeAttributes(f.item, [f.domain.code])),
          fails('PRODUCT_ATTRIBUTE_REMOVAL_DUPLICATE'),
        );
        assert.deepEqual(await call('product-item-get-one', { code: f.item.code }), f.item);
        assert.equal(await db.collection('TEST_RETIREMENT_OUTBOX').countDocuments(), before);
        assert.equal(
          (await call('product-sku-get-one', { code: variant.code })).selections.length,
          2,
        );
        await assert.rejects(
          call('product-item-update', changeAttributes(f.item, [])),
          fails('PRODUCT_MODE_INVALID'),
        );
        await assert.rejects(
          call('product-attribute-delete', {
            code     : f.domain.code,
            revision : f.domain.revision,
          }),
          fails('PRODUCT_ATTRIBUTE_IN_USE'),
        );
      },
    );
    await t.test(
      'eliminar variante retira más de cien precios y excluye todas las lecturas vigentes',
      /** @returns {Promise<void>} Verifica permisos, revisión, repetición, matrices, precios y referencias históricas. */ async () => {
        const f       = await fixture();
        const variant = f.variants[0];
        const lists = [],
          prices    = [];
        for (let index = 0; index < 101; index++) {
          const list = {
            ...f.list,
            code : resourceIdentifier('price-list'),
          };
          lists.push(list);
          prices.push({
            ...f.prices[0],
            code          : resourceIdentifier('price'),
            priceListCode : list.code,
          });
        }
        await db.collection('PRODUCT_PRICE_LIST').insertMany(lists);
        await db.collection('PRODUCT_PRICE').insertMany(prices);
        const input = {
          code           : variant.code,
          revision       : variant.revision,
          idempotencyKey : randomUUID(),
        };
        actor = {
          ...admin,
          policies : admin.policies.filter(
            /** @param {string} policy Permiso. @returns {boolean} Aísla el permiso de eliminación del de edición. */
            (policy) => policy !== 'product.sku.delete.global',
          ),
        };
        await assert.rejects(call('product-sku-delete', input), fails('FORBIDDEN'));
        actor = admin;
        await assert.rejects(
          call('product-sku-delete', {
            ...input,
            revision : 99,
          }),
          fails('PRODUCT_REVISION_CONFLICT'),
        );
        failEvent = 'product.sku.deleted';
        await assert.rejects(call('product-sku-delete', input), /retirement-outbox-unavailable/);
        failEvent = '';
        assert.equal((await call('product-sku-get-one', { code: variant.code })).active, true);
        assert.equal(
          await db.collection('PRODUCT_PRICE').countDocuments({
            skuCode : variant.code,
            erased  : true,
          }),
          0,
        );
        const removed = await call('product-sku-delete', input);
        assert.equal(removed.erased, true);
        assert.equal(removed.active, false);
        const events = await db.collection('TEST_RETIREMENT_OUTBOX').countDocuments();
        assert.deepEqual(await call('product-sku-delete', input), removed);
        assert.equal(await db.collection('TEST_RETIREMENT_OUTBOX').countDocuments(), events);
        await assert.rejects(
          call('product-sku-get-one', { code: variant.code }),
          fails('PRODUCT_NOT_FOUND'),
        );
        assert.equal(
          (await call('product-sku-get-list', { itemCode: f.item.code })).pagination.total,
          1,
        );
        assert.equal(
          (await call('product-item-prices-get-list', { code: f.item.code })).pagination.total,
          1,
        );
        assert.equal(
          (await call('product-price-get-list', { skuCode: variant.code })).pagination.total,
          0,
        );
        assert.equal(
          (await call('product-price-matrix-get-list', { perPage: 100 })).items.some(
            /** @param {Object} row Fila comercial vigente. @returns {boolean} Detecta una variante retirada que no debe aparecer. */
            (row) => row.variant.code === variant.code,
          ),
          false,
        );
        assert.equal((await services.records.reference('sku', variant.code)).erased, true);
        assert.equal(
          await db.collection('PRODUCT_PRICE').countDocuments({
            skuCode : variant.code,
            erased  : true,
          }),
          102,
        );
        const replacement = await call('product-sku-create', {
          itemCode   : f.item.code,
          name       : variant.name,
          sku        : randomUUID(),
          selections : variant.selections,
          active     : true,
        });
        assert.notEqual(replacement.code, variant.code);
        await call('product-sku-delete', {
          code     : replacement.code,
          revision : replacement.revision,
        });
      },
    );
    await t.test(
      'retirar un eje procesa más de cien variantes sin truncar la colección',
      /** @returns {Promise<void>} Recorre dos páginas reales y conserva identidades y revisiones coherentes. */
      async () => {
        const axis    = await call('product-attribute-create', {
          name   : 'Eje paginado',
          values : Array.from(
            { length: 100 },
            /** @param {unknown} entry Posición vacía. @param {number} index Valor comercial. @returns {string} Opción válida distinta. */
            (entry, index) => String(index),
          ),
          active : true,
        });
        const tier    = await call('product-attribute-create', {
          name   : 'Nivel',
          values : ['A', 'B'],
          active : true,
        });
        const storage = await call('product-attribute-create', {
          name   : 'Retirable',
          values : ['1 gb'],
          active : true,
        });
        const item    = await call('product-item-create', {
          name           : 'Paginado',
          description    : '',
          type           : 'product',
          mode           : 'variants',
          sku            : '',
          categoryCode   : '',
          attributeCodes : [axis.code, tier.code, storage.code],
          fiscal         : {},
          active         : true,
        });
        for (let index = 0; index < 101; index++)
          await call('product-sku-create', {
            itemCode   : item.code,
            name       : 'Variante ' + index,
            sku        : randomUUID(),
            active     : index % 2 === 0,
            selections : [
              {
                attributeCode : axis.code,
                value         : String(index % 100),
              },
              {
                attributeCode : tier.code,
                value         : index < 100 ? 'A' : 'B',
              },
              {
                attributeCode : storage.code,
                value         : '1 gb',
              },
            ],
          });
        await call('product-item-update', changeAttributes(item, [axis.code, tier.code]));
        const all = await db.collection('PRODUCT_SKU').find({ itemCode: item.code }).toArray();
        assert.equal(all.length, 101);
        for (const variant of all) {
          assert.equal(variant.revision, 2);
          assert.equal(variant.selections.length, 2);
        }
      },
    );
    await t.test(
      'unidad simple y atributos asociados no se eliminan; atributo libre sí',
      /** @returns {Promise<void>} Conserva relaciones y vuelve a autorizar los recibos. */ async () => {
        const simple = await call('product-item-create', {
          name           : 'Simple',
          description    : '',
          type           : 'product',
          mode           : 'simple',
          sku            : randomUUID(),
          categoryCode   : '',
          attributeCodes : [],
          fiscal         : {},
          active         : true,
        });
        await assert.rejects(
          call('product-sku-delete', {
            code     : simple.simpleSkuCode,
            revision : 1,
          }),
          fails('PRODUCT_SIMPLE_SKU_MANAGED_BY_ITEM'),
        );
        const attribute = await call('product-attribute-create', {
          name   : 'Libre',
          values : ['A'],
          active : true,
        });
        const input     = {
          code           : attribute.code,
          revision       : attribute.revision,
          idempotencyKey : randomUUID(),
        };
        const removed   = await call('product-attribute-delete', input);
        assert.equal(removed.erased, true);
        assert.deepEqual(await call('product-attribute-delete', input), removed);
        actor = {
          ...admin,
          policies : [],
        };
        await assert.rejects(call('product-attribute-delete', input), fails('FORBIDDEN'));
        actor = admin;
      },
    );
    await t.test(
      'creación concurrente no deja productos asociados a un atributo eliminado',
      /** @returns {Promise<void>} Los cercos serializan retirada y nuevas referencias. */ async () => {
        const attribute = await call('product-attribute-create', {
          name   : 'Concurrente',
          values : ['A'],
          active : true,
        });
        const results   = await Promise.allSettled([
          call('product-attribute-delete', {
            code     : attribute.code,
            revision : attribute.revision,
          }),
          call('product-item-create', {
            name           : 'Concurrente',
            description    : '',
            type           : 'product',
            mode           : 'variants',
            sku            : '',
            categoryCode   : '',
            attributeCodes : [attribute.code],
            fiscal         : {},
            active         : true,
          }),
        ]);
        assert.equal(
          results.filter(
            /** @param {Object} result Resultado concurrente. @returns {boolean} Sólo una intención incompatible puede confirmarse. */
            (result) => result.status === 'fulfilled',
          ).length,
          1,
        );
      },
    );
  },
);
