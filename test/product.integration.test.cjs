/** @file Aceptación del catálogo con MongoDB real aislado, contratos públicos e imágenes simuladas. */
'use strict';
const test                   = require('node:test');
const assert                 = require('node:assert/strict');
const mongoose               = require('mongoose');
const { startIsolatedMongo } = require('./helpers/isolated-mongo.cjs');
const {
  createProductStore,
} = require('../server/modules/product/repositories/product-store.repository');
const { composeProduct }     = require('../server/modules/product/compositions/product.composition');
const { createCatalog }      = require('../server/modules/catalog');
const { resourceIdentifier } = require('../server/adapters/identifiers/resource-identifier');
const manifest               = require('../server/contracts/service.json');
const policies               = require('../config/policies.json');
const { actionDtos }         = require('../server/contracts');
/** @param {string} code Descripción pública esperada. @returns {Function} Predicado del error de dominio. */
function fails(code) {
  /** @param {Error} error Fallo observado. @returns {boolean} Coincidencia exacta sin ocultar fallos técnicos. */
  return (error) => error.descriptionCode === code;
}
test(
  'Product: catálogo, precios, permisos e imágenes sobre MongoDB aislado',
  {
    skip    : !process.env.TEST_MONGOD_BINARY,
    timeout : 120000,
  },
  /** @param {Object} t Contexto de prueba. @returns {Promise<void>} Matriz sin acceso a instalaciones compartidas. */
  async (t) => {
    const mongo = await startIsolatedMongo({
      binary : process.env.TEST_MONGOD_BINARY,
      mongoose,
    });
    t.after(mongo.stop);
    const db = mongo.connection.db,
      client = mongo.connection.getClient();
    for (const [name, indexes] of Object.entries(
      require('../server/mongodb-indexes.json').collections,
    ))
      for (const index of indexes) {
        const { key, ...options } = index;
        await db.collection(name).createIndex(key, options);
      }
    let now            = 1000000;
    const admin        = {
      user      : { userCode: 'USER-A' },
      workspace : 'WORK-A',
      policies  : [
        ...policies.map(
          /** @param {Object} entry Política. @returns {string} Identificador. */
          (entry) => entry.identifier,
        ),
        'customer.customer.update.workspace',
      ],
    };
    let actor          = admin;
    const deleted      = [];
    let failRetirement = false;
    /** @param {string} name Evento. @param {Object} data Aviso. @param {Object} options Sesión. @returns {Promise<Object>} Outbox aislado en la misma transacción. */
    const publish      = (name, data, options) => {
      if (failRetirement && data.eventType === 'product.price-list.deleted')
        throw new Error('outbox-retirement-offline');
      return db.collection('TEST_PRODUCT_OUTBOX').insertOne(
        {
          name,
          data,
        },
        options,
      );
    };
    const store        = createProductStore({
      db,
      client,
      publish,
    });
    const services     = composeProduct({
      store,
      identifier : resourceIdentifier,
      /** @returns {Object} Contexto controlado por la prueba. */
      context    : () => actor,
      /** @returns {number} Reloj reproducible. */
      clock      : () => now,
      references : {
        /** @param {string} customerCode Cliente. @returns {Promise<Object>} Referencia con ámbito acreditado. */
        async customer(customerCode) {
          return {
            customerCode,
            workspace  : customerCode === 'foreign' ? 'WORK-B' : 'WORK-A',
            userCreate : 'USER-A',
          };
        },
        /** @param {Object[]} values Claves. @returns {Promise<Object>} Validación del puerto fiscal simulado. */
        async values(values) {
          assert.ok(Array.isArray(values));
          return { valid: true };
        },
        /** @returns {Promise<Object>} Catálogo de tasas de prueba. */
        async catalog() {
          return {
            items      : [
              {
                tax         : '002',
                factor      : 'Tasa',
                transferred : true,
                kind        : 'fixed',
                max         : '0.16',
              },
            ],
            pagination : { total: 1 },
          };
        },
      },
      files      : {
        /** @param {Object} upload Selección. @returns {Promise<Object>} Referencia documental privada. */
        async upload(upload) {
          return {
            fileId   : upload.fileId,
            name     : 'imagen.png',
            mimeType : 'image/png',
            size     : 100,
          };
        },
        /** @param {Object} owner Propietario. @param {string} fileId Archivo. @returns {Promise<Object>} Temporal simulado con contrato real de Documents. */
        async read(owner, fileId) {
          return {
            tempFilePath : '/tmp/' + fileId,
            fileName     : owner.code + '.png',
            mimeType     : 'image/png',
            size         : 'original',
          };
        },
        /** @param {Object} job Limpieza. @returns {Promise<Object>} Efecto registrado. */
        async remove(job) {
          deleted.push(job.fileId);
          return { deleted: true };
        },
      },
    });
    const catalog      = createCatalog({
      services,
      messaging : {
        /** @param {number} statusCode Estado. @param {Object} data Resultado. @returns {Object} Sobre del transporte. */
        successResponse(statusCode, data) {
          return {
            statusCode,
            descriptionCode : 'OK',
            data,
          };
        },
      },
    });
    /** @param {string} action Operación RPC. @param {Object} data Entrada. @returns {Promise<Object>} Resultado acreditado por DTO de entrada y salida. */
    async function call(action, data) {
      return (
        await catalog
          .find(
            /** @param {Object} entry Acción registrada. @returns {boolean} Coincidencia. */
            (entry) => entry.name === action,
          )
          .handler({ data })
      ).data;
    }
    const records = services.records;
    let item, sku, list, price, assignment, attribute;
    const fiscal = {
      productService : '81111500',
      unit           : 'E48',
      unitName       : 'Servicio',
      taxObject      : '02',
      taxes          : [
        {
          kind   : 'transferred',
          code   : '002',
          factor : 'Tasa',
          rate   : '0.16',
        },
      ],
    };
    await t.test(
      'alta global, prefijo PRO y SKU único incluso entre artículos y variantes',
      /** @returns {Promise<void>} Acredita identidad y transacción de SKU simple. */
      async () => {
        item = await call('product-item-create', {
          name           : 'Consultoría',
          description    : 'Servicio profesional',
          type           : 'service',
          mode           : 'simple',
          sku            : 'CONSULTA',
          categoryCode   : '',
          attributeCodes : [],
          fiscal,
          active         : true,
        });
        assert.match(item.code, /^PRO-[a-f0-9-]{36}$/);
        assert.match(item.simpleSkuCode, /^VAR-/);
        assert.equal(item.workspace, 'allWorkspaces');
        sku = await call('product-sku-get-one', { code: item.simpleSkuCode });
        await assert.rejects(
          records.create('item', {
            name           : 'Duplicado',
            description    : '',
            type           : 'product',
            mode           : 'simple',
            sku            : 'consulta',
            categoryCode   : '',
            attributeCodes : [],
            fiscal         : {},
            active         : true,
          }),
          fails('PRODUCT_DUPLICATE'),
        );
        assert.equal((await records.getList('item', {})).pagination.total, 1);
      },
    );
    await t.test(
      'variantes por ejes: combinación completa y unicidad en índices',
      /** @returns {Promise<void>} Combinaciones válidas e inválidas. */
      async () => {
        attribute = await call('product-attribute-create', {
          name   : 'Duración',
          values : ['Una hora', 'Dos horas'],
          active : true,
        });
        const parent       = await call('product-item-create', {
          name           : 'Asesoría',
          description    : '',
          type           : 'service',
          mode           : 'variants',
          sku            : '',
          categoryCode   : '',
          attributeCodes : [attribute.code],
          fiscal,
          active         : true,
        });
        const variantInput = {
          itemCode   : parent.code,
          name       : 'Asesoría de una hora',
          sku        : 'ASE-1H',
          selections : [
            {
              attributeCode : attribute.code,
              value         : 'Una hora',
            },
          ],
          active     : true,
        };
        await call('product-sku-create', variantInput);
        await assert.rejects(
          records.create('sku', {
            ...variantInput,
            sku : 'ASE-DUP',
          }),
          fails('PRODUCT_DUPLICATE'),
        );
        await assert.rejects(
          records.create('sku', {
            ...variantInput,
            sku        : 'ASE-INVALID',
            selections : [],
          }),
          fails('PRODUCT_COMBINATION_INVALID'),
        );
        await assert.rejects(
          records.update('attribute', {
            code     : attribute.code,
            revision : attribute.revision,
            name     : attribute.name,
            values   : ['Dos horas'],
            active   : true,
          }),
          fails('PRODUCT_ATTRIBUTE_IN_USE'),
        );
      },
    );
    await t.test(
      'edición de atributos antes de crear variantes y protección transaccional de combinaciones',
      /** @returns {Promise<void>} Altas, sustitución, retirada, referencias, revisión y concurrencia con una variante. */
      async () => {
        const color    = await call('product-attribute-create', {
          name   : 'Color editable',
          values : ['Rojo', 'Azul'],
          active : true,
        });
        const size     = await call('product-attribute-create', {
          name   : 'Talla editable',
          values : ['M', 'L'],
          active : true,
        });
        const inactive = await call('product-attribute-create', {
          name   : 'Atributo inactivo',
          values : ['Uno'],
          active : false,
        });
        const input    = {
          name           : 'Producto editable',
          description    : '',
          type           : 'product',
          mode           : 'variants',
          sku            : '',
          categoryCode   : '',
          attributeCodes : [color.code],
          fiscal         : {},
          active         : true,
        };
        let parent     = await call('product-item-create', input);
        /** @param {string[]} attributeCodes Ejes propuestos. @param {Object} extra Campos opcionales. @returns {Object} Comando público con la última revisión confirmada. */
        const update   = (attributeCodes, extra = {}) => ({
          ...input,
          code     : parent.code,
          revision : parent.revision,
          attributeCodes,
          ...extra,
        });
        parent = await call('product-item-update', update([color.code, size.code]));
        assert.deepEqual(parent.attributeCodes, [color.code, size.code]);
        parent = await call('product-item-update', update([size.code]));
        assert.deepEqual(parent.attributeCodes, [size.code]);
        parent = await call('product-item-update', update([color.code]));
        assert.equal(parent.revision, 4);
        await assert.rejects(
          call('product-item-update', update([inactive.code])),
          fails('PRODUCT_REFERENCE_INACTIVE'),
        );
        await assert.rejects(
          call('product-item-update', update(['ATR-missing'])),
          fails('PRODUCT_REFERENCE_INACTIVE'),
        );
        await assert.rejects(
          call('product-item-update', update([])),
          fails('PRODUCT_MODE_INVALID'),
        );
        await assert.rejects(
          records.update('item', update([color.code, color.code])),
          fails('PRODUCT_ATTRIBUTE_DUPLICATE'),
        );
        await assert.rejects(
          call('product-item-update', update([color.code], { revision: 1 })),
          fails('PRODUCT_REVISION_CONFLICT'),
        );
        await assert.rejects(
          call('product-item-update', update([color.code], { type: 'service' })),
          fails('PRODUCT_STRUCTURE_IMMUTABLE'),
        );
        assert.deepEqual(
          (await call('product-item-get-one', { code: parent.code })).attributeCodes,
          [color.code],
        );
        const variantInput = {
          itemCode   : parent.code,
          sku        : 'EDITABLE-ROJO',
          name       : 'Variante editable',
          selections : [
            {
              attributeCode : color.code,
              value         : 'Rojo',
            },
          ],
          active     : true,
        };
        let variant        = await call('product-sku-create', variantInput);
        for (const axes of [[size.code], [color.code, size.code]])
          await assert.rejects(
            call('product-item-update', update(axes)),
            fails('PRODUCT_ITEM_ATTRIBUTES_IN_USE'),
          );
        variant = await call('product-sku-update', {
          ...variantInput,
          code       : variant.code,
          revision   : variant.revision,
          name       : 'Variante azul actualizada',
          sku        : 'EDITABLE-AZUL',
          selections : [
            {
              attributeCode : color.code,
              value         : 'Azul',
            },
          ],
          active     : false,
        });
        assert.equal(variant.sku, 'EDITABLE-AZUL');
        assert.equal(variant.name, 'Variante azul actualizada');
        assert.equal(variant.selections[0].value, 'Azul');
        await assert.rejects(
          call('product-item-update', update([size.code])),
          fails('PRODUCT_ITEM_ATTRIBUTES_IN_USE'),
        );
        parent = await call(
          'product-item-update',
          update([color.code], { name: 'Nombre actualizado' }),
        );
        assert.equal(parent.name, 'Nombre actualizado');
        assert.equal(parent.revision, 5);
        const concurrent = await call('product-item-create', {
          ...input,
          name : 'Concurrencia de ejes',
        });
        const results    = await Promise.allSettled([
          call('product-item-update', {
            ...input,
            code           : concurrent.code,
            revision       : concurrent.revision,
            attributeCodes : [size.code],
          }),
          call('product-sku-create', {
            ...variantInput,
            itemCode : concurrent.code,
            sku      : 'EDITABLE-CONCURRENT',
          }),
        ]);
        assert.equal(
          results.filter(
            /** @param {Object} result Operación competidora. @returns {boolean} Cuenta confirmaciones atómicas. */
            (result) => result.status === 'fulfilled',
          ).length,
          1,
        );
        const saved    = await call('product-item-get-one', {
          code : concurrent.code,
        });
        const variants = await call('product-sku-get-list', {
          itemCode : concurrent.code,
        });
        for (const row of variants.items)
          assert.deepEqual(
            row.selections.map(
              /** @param {Object} selection Eje persistido. @returns {string} Identidad que debe seguir perteneciendo al padre. */
              (selection) => selection.attributeCode,
            ),
            saved.attributeCodes,
          );
      },
    );
    await t.test(
      'lista por moneda, resolución con precisión decimal y rechazo de faltantes',
      /** @returns {Promise<void>} Precio y datos fiscales sin conversiones. */
      async () => {
        list = await call('product-price-list-create', {
          name     : 'General MXN',
          currency : 'MXN',
          active   : true,
        });
        await assert.rejects(
          services.resolve({
            skuCode       : sku.code,
            priceListCode : list.code,
            currency      : 'MXN',
          }),
          fails('PRODUCT_PRICE_MISSING'),
        );
        price = await call('product-price-create', {
          priceListCode : list.code,
          skuCode       : sku.code,
          unitPrice     : '1234.123456',
          active        : true,
        });
        const sale = await call('product-sale-resolve', {
          skuCode       : sku.code,
          priceListCode : list.code,
          currency      : 'MXN',
        });
        assert.equal(sale.unitPrice, '1234.123456');
        assert.equal(sale.catalogReference.itemCode, item.code);
        await assert.rejects(
          services.resolve({
            skuCode       : sku.code,
            priceListCode : list.code,
            currency      : 'USD',
          }),
          fails('PRODUCT_CURRENCY_MISMATCH'),
        );
        await assert.rejects(
          records.create('price', {
            priceListCode : list.code,
            skuCode       : sku.code,
            unitPrice     : '2',
            active        : true,
          }),
          fails('PRODUCT_DUPLICATE'),
        );
      },
    );
    await t.test(
      'asignaciones no amplían los permisos ni el workspace de Customer',
      /** @returns {Promise<void>} Asignación, retirada y aislamiento. */
      async () => {
        assignment = await call('product-assignment-create', {
          customerCode  : 'customer-a',
          priceListCode : list.code,
          active        : true,
        });
        assert.equal(
          (
            await call('product-customer-price-list-get', {
              customerCode : 'customer-a',
            })
          ).assignment.code,
          assignment.code,
        );
        await assert.rejects(
          records.create('assignment', {
            customerCode  : 'foreign',
            priceListCode : list.code,
            active        : true,
          }),
          fails('FORBIDDEN'),
        );
        actor = {
          ...admin,
          policies : admin.policies.filter(
            /** @param {string} value Política. @returns {boolean} Retira modificación del cliente. */
            (value) => !value.startsWith('customer.'),
          ),
        };
        await assert.rejects(
          records.update('assignment', {
            code          : assignment.code,
            revision      : assignment.revision,
            customerCode  : 'customer-a',
            priceListCode : list.code,
            active        : false,
          }),
          fails('FORBIDDEN'),
        );
        actor = admin;
        await call('product-assignment-update', {
          code          : assignment.code,
          revision      : assignment.revision,
          customerCode  : 'customer-a',
          priceListCode : list.code,
          active        : false,
        });
        assert.equal(
          (
            await call('product-customer-price-list-get', {
              customerCode : 'customer-a',
            })
          ).assignment,
          null,
        );
      },
    );
    await t.test(
      'concurrencia rechaza la segunda revisión y conserva Timeline',
      /** @returns {Promise<void>} No pierde modificaciones concurrentes. */
      async () => {
        const changes = {
          code          : price.code,
          revision      : price.revision,
          priceListCode : list.code,
          skuCode       : sku.code,
          active        : true,
        };
        const results = await Promise.allSettled([
          records.update('price', {
            ...changes,
            unitPrice : '10',
          }),
          records.update('price', {
            ...changes,
            unitPrice : '20',
          }),
        ]);
        assert.equal(
          results.filter(
            /** @param {Object} result Resultado. @returns {boolean} Éxito confirmado. */
            (result) => result.status === 'fulfilled',
          ).length,
          1,
        );
        assert.ok(
          await db.collection('TEST_PRODUCT_OUTBOX').countDocuments({
            name : 'communication.timeline.record-requested',
          }),
        );
      },
    );
    await t.test(
      'datos fiscales incompletos permiten catálogo y bloquean facturación',
      /** @returns {Promise<void>} Catálogo comercial independiente de facturación. */
      async () => {
        const incomplete = await call('product-item-create', {
          name           : 'Pendiente',
          description    : '',
          type           : 'product',
          mode           : 'simple',
          sku            : 'PEND',
          categoryCode   : '',
          attributeCodes : [],
          fiscal         : {},
          active         : true,
        });
        await records.create('price', {
          priceListCode : list.code,
          skuCode       : incomplete.simpleSkuCode,
          unitPrice     : '0.10',
          active        : true,
        });
        await assert.rejects(
          services.resolve({
            skuCode       : incomplete.simpleSkuCode,
            priceListCode : list.code,
            currency      : 'MXN',
          }),
          fails('PRODUCT_FISCAL_INCOMPLETE'),
        );
      },
    );
    await t.test(
      'impuestos repetidos o incompatibles se rechazan antes de vender',
      /** @returns {Promise<void>} Product acredita las mismas restricciones de partidas que Billing. */
      async () => {
        for (const [proposed, code] of [
          [
            {
              ...fiscal,
              taxObject : '01',
            },
            'PRODUCT_TAX_OBJECT_CONFLICT',
          ],
          [
            {
              ...fiscal,
              taxes : [fiscal.taxes[0], fiscal.taxes[0]],
            },
            'PRODUCT_TAX_INVALID',
          ],
        ])
          await assert.rejects(
            records.create('item', {
              name           : 'Fiscal inválido',
              description    : '',
              type           : 'service',
              mode           : 'simple',
              sku            : 'INVALID-FISCAL',
              categoryCode   : '',
              attributeCodes : [],
              fiscal         : proposed,
              active         : true,
            }),
            fails(code),
          );
      },
    );
    await t.test(
      'los precios inactivos tampoco admiten referencias inexistentes',
      /** @returns {Promise<void>} La desactivación no permite crear huérfanos. */
      async () => {
        await assert.rejects(
          records.create('price', {
            skuCode       : 'missing',
            priceListCode : list.code,
            unitPrice     : '10',
            active        : false,
          }),
          fails('PRODUCT_REFERENCE_INACTIVE'),
        );
        await assert.rejects(
          records.create('assignment', {
            customerCode  : 'CUSTOMER-B',
            priceListCode : 'missing',
            active        : false,
          }),
          fails('PRODUCT_REFERENCE_INACTIVE'),
        );
      },
    );
    await t.test(
      'imágenes privadas: adopción, herencia, conflicto y recuperación tras reiniciar',
      /** @returns {Promise<void>} Limpieza sólo de archivos no adoptados. */
      async () => {
        const upload = {
          fileId           : 'b08a2209-6fc1-4ff8-8083-5deff6b40caf',
          tempFilePath     : '/tmp/test.png',
          name             : 'imagen.png',
          visibility       : 'private',
          generateVariants : true,
        };
        item = await call('product-item-image-set', {
          code          : item.code,
          revision      : item.revision,
          pictureUpload : upload,
        });
        assert.ok(
          (await call('product-sku-image-get', { code: sku.code })).tempFilePath.endsWith(
            upload.fileId,
          ),
        );
        const stale = {
          ...upload,
          fileId : '07374141-6ca2-48b4-bb0b-8170ca1b38e5',
        };
        await assert.rejects(
          services.images.set('item', {
            code          : item.code,
            revision      : item.revision - 1,
            pictureUpload : stale,
          }),
          fails('PRODUCT_REVISION_CONFLICT'),
        );
        assert.equal(
          await db.collection('PRODUCT_IMAGE_JOB').countDocuments({ fileId: stale.fileId }),
          0,
        );
        const replacement = {
          ...upload,
          fileId : 'b5df1a8a-e8c3-4dd3-81ba-0d32b1d6d285',
        };
        item = await call('product-item-image-set', {
          code          : item.code,
          revision      : item.revision,
          pictureUpload : replacement,
        });
        const orphan = '883ac671-98c0-4e0a-9c3d-3d4fd438f2b6';
        await store.stageImage({
          fileId      : orphan,
          resource    : 'item',
          code        : item.code,
          status      : 'pending',
          availableAt : now + 600000,
          fence       : 0,
        });
        const restarted =
          require('../server/modules/product/services/product-images.service').productImageService({
            store   : createProductStore({
              db,
              client,
              publish,
            }),
            records,
            /** @returns Reloj del nuevo trabajador. */
            clock   : () => now,
            /** @returns Actor acreditado. */
            context : () => actor,
            files   : {
              /** @param job Archivo sin adoptar. @returns Limpieza observada después de reconstruir el trabajador. */
              async remove(job) {
                deleted.push(job.fileId);
              },
            },
          });
        now += 700000;
        await restarted.tick({
          /** @returns {boolean} Permite procesar todo el lote de prueba. */
          shouldStop : () => false,
        });
        assert.deepEqual(new Set(deleted), new Set([upload.fileId, orphan]));
        assert.equal(item.image.fileId, replacement.fileId);
      },
    );
    await t.test(
      'Timeline conserva el workspace de asignaciones y no publica datos del cliente',
      /** @returns {Promise<void>} La asignación queda en su propio historial, sin ampliar su alcance. */
      async () => {
        const change = await db.collection('TEST_PRODUCT_OUTBOX').findOne({
          name                  : 'communication.timeline.record-requested',
          'data.subject.domain' : 'assignment',
          'data.subject.code'   : assignment.code,
        });
        assert.ok(change);
        assert.equal(change.data.workspace, admin.workspace);
        assert.equal(change.data.customerCode, undefined);
        assert.equal(change.data.priceListCode, undefined);
        assert.deepEqual(
          await services.resourceAccess({
            references : [
              {
                domain : 'assignment',
                code   : assignment.code,
              },
            ],
          }),
          {
            items : [
              {
                domain    : 'assignment',
                code      : assignment.code,
                allowed   : true,
                workspace : admin.workspace,
              },
            ],
          },
        );
      },
    );
    await t.test(
      'el outbox comercial confirma sólo revisiones persistidas y revierte con el artículo',
      /** @returns {Promise<void>} Acredita atomicidad real y aviso mínimo sobre MongoDB aislado. */
      async () => {
        const events = db.collection('TEST_PRODUCT_OUTBOX');
        const before = await events.find({}).toArray();
        assert.ok(before.length > 0);
        for (const event of before.filter(
          /** @param {Object} entry Evento del outbox. @returns {boolean} Selecciona invalidaciones del listado. */
          (entry) => entry.name === 'product.resource.changed',
        )) {
          assert.ok(
            ['item', 'sku', 'category', 'attribute', 'price-list', 'price', 'assignment'].includes(
              event.data.resource,
            ),
          );
          assert.equal(typeof event.data.code, 'string');
          assert.ok(event.data.revision >= 1);
          for (const key of Object.keys(event.data))
            assert.ok(
              [
                'resource',
                'code',
                'revision',
                'workspace',
                'erased',
                'itemCode',
                'skuCode',
                'priceListCode',
                'customerCode',
                'previousItemCode',
                'previousSkuCode',
                'previousPriceListCode',
                'previousCustomerCode',
              ].includes(key),
            );
        }
        const previous = await store.get('item', { code: item.code });
        const next     = {
          ...previous,
          revision : previous.revision + 1,
        };
        await assert.rejects(
          store.transaction(
            /** @param {Object} tx Unidad MongoDB real. @returns {Promise<void>} Fuerza rollback después de persistir registro y aviso. */
            async (tx) => {
              await tx.replace('item', previous, next);
              throw new Error('rollback-fixture');
            },
          ),
          /rollback-fixture/,
        );
        assert.equal((await store.get('item', { code: item.code })).revision, previous.revision);
        assert.equal(await events.countDocuments({}), before.length);
      },
    );
    await t.test(
      'precios del artículo: todas las variantes, monedas, rollback y concurrencia en el guardado conjunto',
      /** @returns {Promise<void>} Contratos reales y transacciones MongoDB para la pestaña de precios. */
      async () => {
        actor = admin;
        const axis   = await records.create('attribute', {
          name   : 'Modelo de prueba',
          values : Array.from(
            { length: 12 },
            /** @param {unknown} value Posición vacía. @param {number} index Índice. @returns {string} Opción única. */
            (value, index) => String(index + 1),
          ),
          active : true,
        });
        const fields = {
          name           : 'Producto con precios conjuntos',
          description    : '',
          type           : 'product',
          mode           : 'variants',
          sku            : '',
          categoryCode   : '',
          attributeCodes : [axis.code],
          fiscal         : {},
          active         : true,
        };
        let parent   = await call('product-item-create', fields);
        const lists  = [
          await records.create('price-list', {
            name     : 'Tab MXN',
            currency : 'MXN',
            active   : true,
          }),
          await records.create('price-list', {
            name     : 'Tab USD',
            currency : 'USD',
            active   : true,
          }),
        ];
        const units = [],
          entries   = [];
        for (let index = 1; index <= 12; index++) {
          const unit = await records.create('sku', {
            itemCode   : parent.code,
            name       : 'Modelo ' + index,
            sku        : 'TAB-' + index,
            selections : [
              {
                attributeCode : axis.code,
                value         : String(index),
              },
            ],
            active     : true,
          });
          units.push(unit);
          for (const selected of lists)
            entries.push(
              await records.create('price', {
                skuCode       : unit.code,
                priceListCode : selected.code,
                unitPrice     : '123.456789',
                active        : index !== 12,
              }),
            );
        }
        const pages = [];
        for (let page = 1; page <= 3; page++)
          pages.push(
            await call('product-item-prices-get-list', {
              code    : parent.code,
              page,
              perPage : 10,
            }),
          );
        assert.deepEqual(
          pages.map(
            /** @param {Object} page Respuesta. @returns {number} Filas de la página. */
            (page) => page.items.length,
          ),
          [10, 10, 4],
        );
        const rows = pages.flatMap(
          /** @param {Object} page Respuesta. @returns {Object[]} Página completa. */
          (page) => page.items,
        );
        assert.equal(
          new Set(
            rows.map(
              /** @param {Object} row Precio. @returns {string} Identidad. */
              (row) => row.code,
            ),
          ).size,
          24,
        );
        assert.ok(
          rows.some(
            /** @param {Object} row Precio. @returns {boolean} Incluye precios inactivos. */
            (row) => !row.active,
          ),
        );
        assert.deepEqual(
          [
            ...new Set(
              rows.map(
                /** @param {Object} row Precio. @returns {string} Moneda acreditada. */
                (row) => row.currency,
              ),
            ),
          ].sort(),
          ['MXN', 'USD'],
        );
        const third  = await records.create('price-list', {
          name     : 'Tab EUR',
          currency : 'EUR',
          active   : true,
        });
        const change = {
          code          : entries[0].code,
          revision      : entries[0].revision,
          skuCode       : entries[0].skuCode,
          priceListCode : entries[0].priceListCode,
          unitPrice     : '0.000001',
          active        : false,
        };
        const added  = {
          skuCode       : units[0].code,
          priceListCode : third.code,
          unitPrice     : '999999999999999.123456',
          active        : true,
        };
        const saved  = await call('product-item-save', {
          code     : parent.code,
          revision : parent.revision,
          item     : {
            ...fields,
            description : 'Guardado conjunto',
          },
          prices   : [change, added],
        });
        parent = saved.item;
        assert.equal(parent.description, 'Guardado conjunto');
        assert.equal(saved.prices[0].unitPrice, '0.000001');
        assert.equal(saved.prices[1].unitPrice, added.unitPrice);
        assert.equal(
          (await call('product-item-prices-get-list', { code: parent.code })).pagination.total,
          25,
        );
        const beforeOutbox = await db.collection('TEST_PRODUCT_OUTBOX').countDocuments({});
        await assert.rejects(
          call('product-item-save', {
            code     : parent.code,
            revision : parent.revision,
            item     : {
              ...fields,
              description : 'No debe confirmarse',
            },
            prices   : [
              {
                ...change,
                revision  : saved.prices[0].revision,
                unitPrice : '55',
              },
              added,
            ],
          }),
          fails('PRODUCT_DUPLICATE'),
        );
        assert.equal(
          (await records.getOne('item', { code: parent.code })).description,
          'Guardado conjunto',
        );
        assert.equal((await records.getOne('price', { code: change.code })).unitPrice, '0.000001');
        assert.equal(await db.collection('TEST_PRODUCT_OUTBOX').countDocuments({}), beforeOutbox);
        await assert.rejects(
          call('product-item-save', {
            code     : parent.code,
            revision : parent.revision,
            item     : null,
            prices   : [change],
          }),
          fails('PRODUCT_REVISION_CONFLICT'),
        );
        await assert.rejects(
          call('product-item-save', {
            code     : parent.code,
            revision : parent.revision - 1,
            item     : null,
            prices   : [],
          }),
          fails('PRODUCT_REVISION_CONFLICT'),
        );
        await assert.rejects(
          call('product-item-save', {
            code     : parent.code,
            revision : parent.revision,
            item     : null,
            prices   : [
              {
                ...added,
                skuCode : item.simpleSkuCode,
              },
            ],
          }),
          fails('PRODUCT_PRICE_ITEM_MISMATCH'),
        );
        actor = {
          ...admin,
          policies : ['product.item.view.global', 'product.price.view.global'],
        };
        await assert.rejects(
          call('product-item-prices-get-list', { code: parent.code }),
          fails('FORBIDDEN'),
        );
        actor = {
          ...admin,
          policies : ['product.item.update.global'],
        };
        await assert.rejects(
          call('product-item-save', {
            code     : parent.code,
            revision : parent.revision,
            item     : null,
            prices   : [added],
          }),
          fails('FORBIDDEN'),
        );
        actor = admin;
        assert.throws(
          /** @returns {Object} Intenta actualizar sin revisión de precio. */
          () =>
            actionDtos['product-item-save'].input({
              code     : parent.code,
              revision : parent.revision,
              item     : null,
              prices   : [
                {
                  ...added,
                  code : change.code,
                },
              ],
            }),
        );
        const serviceFields = {
          name           : 'Servicio con tarifa',
          description    : '',
          type           : 'service',
          mode           : 'simple',
          sku            : 'SERVICE-PRICE-TAB',
          categoryCode   : '',
          attributeCodes : [],
          fiscal         : {},
          active         : true,
        };
        const serviceItem   = await call('product-item-create', serviceFields);
        const empty         = await call('product-item-prices-get-list', {
          code : serviceItem.code,
        });
        assert.deepEqual(empty.items, []);
        assert.equal(empty.pagination.total, 0);
        const serviceSaved = await call('product-item-save', {
          code     : serviceItem.code,
          revision : serviceItem.revision,
          item     : {
            ...serviceFields,
            name : 'Servicio actualizado',
            sku  : 'SERVICE-PRICE-UPDATED',
          },
          prices   : [
            {
              skuCode       : serviceItem.simpleSkuCode,
              priceListCode : third.code,
              unitPrice     : '0.000001',
              active        : true,
            },
          ],
        });
        const serviceRows  = await call('product-item-prices-get-list', {
          code : serviceItem.code,
        });
        assert.equal(serviceRows.items.length, 1);
        assert.equal(serviceRows.items[0].variantName, 'Servicio actualizado');
        assert.equal(serviceRows.items[0].sku, 'SERVICE-PRICE-UPDATED');
        assert.equal(serviceRows.items[0].unitPrice, '0.000001');
        assert.equal(serviceSaved.item.type, 'service');
        const simple = await call('product-item-prices-get-list', {
          code    : item.code,
          perPage : 10,
        });
        assert.ok(
          simple.items.every(
            /** @param {Object} row Precio. @returns {boolean} La consulta simple no mezcla otros artículos. */
            (row) => row.skuCode === item.simpleSkuCode,
          ),
        );
      },
    );
    await t.test(
      'eliminación lógica: permisos, asignaciones, rollback, referencias históricas y reintentos',
      /** @returns {Promise<void>} Acredita cascada atómica sin perder historial ni permitir nuevas ventas. */
      async () => {
        const disposable = await call('product-price-list-create', {
          name     : 'Retirable',
          currency : 'MXN',
          active   : true,
        });
        const entry      = await call('product-price-create', {
          priceListCode : disposable.code,
          skuCode       : sku.code,
          unitPrice     : '1234.123456',
          active        : true,
        });
        const page       = await call('product-price-get-list', {
          priceListCode : disposable.code,
        });
        assert.equal(
          page.items[0].variantName,
          (await records.getOne('sku', { code: sku.code })).name,
        );
        assert.equal(page.items[0].priceListName, disposable.name);
        assert.equal(page.items[0].currency, 'MXN');
        assert.equal(page.items[0].unitPrice, '1234.123456');
        actor = {
          ...admin,
          policies : admin.policies.filter(
            /** @param {string} policy Permiso. @returns {boolean} Retira exclusivamente eliminación. */
            (policy) => policy !== 'product.price-list.delete.global',
          ),
        };
        await assert.rejects(
          call('product-price-list-delete', {
            code     : disposable.code,
            revision : disposable.revision,
          }),
          fails('FORBIDDEN'),
        );
        actor = admin;
        await assert.rejects(
          call('product-price-list-delete', {
            code     : disposable.code,
            revision : 99,
          }),
          fails('PRODUCT_REVISION_CONFLICT'),
        );
        await db.collection('PRODUCT_ASSIGNMENT').insertOne({
          code          : 'test-retirement-assignment',
          workspace     : 'WORK-B',
          priceListCode : disposable.code,
          active        : false,
        });
        await assert.rejects(
          call('product-price-list-delete', {
            code     : disposable.code,
            revision : disposable.revision,
          }),
          fails('PRODUCT_PRICE_LIST_ASSIGNED'),
        );
        await db.collection('PRODUCT_ASSIGNMENT').deleteOne({ code: 'test-retirement-assignment' });
        const before = await db.collection('TEST_PRODUCT_OUTBOX').countDocuments();
        failRetirement = true;
        await assert.rejects(
          call('product-price-list-delete', {
            code     : disposable.code,
            revision : disposable.revision,
          }),
          /outbox-retirement-offline/,
        );
        failRetirement = false;
        assert.equal((await records.getOne('price-list', { code: disposable.code })).erased, false);
        assert.equal((await records.getOne('price', { code: entry.code })).erased, false);
        assert.equal(await db.collection('TEST_PRODUCT_OUTBOX').countDocuments(), before);
        const retired = await call('product-price-list-delete', {
          code     : disposable.code,
          revision : disposable.revision,
        });
        assert.equal(retired.erased, true);
        assert.equal(retired.active, false);
        assert.equal(retired.revision, disposable.revision + 1);
        assert.deepEqual(
          await call('product-price-list-delete', {
            code     : disposable.code,
            revision : disposable.revision,
          }),
          retired,
        );
        await assert.rejects(
          records.getOne('price-list', { code: disposable.code }),
          fails('PRODUCT_NOT_FOUND'),
        );
        await assert.rejects(
          records.getOne('price', { code: entry.code }),
          fails('PRODUCT_NOT_FOUND'),
        );
        assert.equal(
          (await records.getList('price', { priceListCode: disposable.code })).pagination.total,
          0,
        );
        await assert.rejects(
          records.create('price', {
            priceListCode : disposable.code,
            skuCode       : sku.code,
            unitPrice     : '1',
            active        : false,
          }),
          fails('PRODUCT_REFERENCE_INACTIVE'),
        );
        const access = await services.resourceAccess({
          references : [
            {
              domain : 'price-list',
              code   : disposable.code,
            },
            {
              domain : 'price',
              code   : entry.code,
            },
          ],
        });
        assert.ok(
          access.items.every(
            /** @param {Object} reference Recurso retirado. @returns {boolean} Retiene autorización histórica global. */
            (reference) => reference.allowed && reference.workspace === 'allWorkspaces',
          ),
        );
        const events = await db
          .collection('TEST_PRODUCT_OUTBOX')
          .find({
            'data.eventType' : {
              $in : ['product.price.deleted', 'product.price-list.deleted'],
            },
          })
          .toArray();
        assert.equal(events.length, 2);
        const priceEvent = events.find(
          /** @param {Object} event Hecho. @returns {boolean} Identifica la retirada del precio. */
          (event) => event.data.eventType === 'product.price.deleted',
        );
        assert.equal(priceEvent.data.subject.code, sku.itemCode);
      },
    );
    await t.test(
      'una asignación concurrente y la retirada de su lista no pueden confirmarse juntas',
      /** @returns {Promise<void>} El cerco de escritura evita asignaciones huérfanas entre transacciones. */
      async () => {
        const candidate = await records.create('price-list', {
          name     : 'Lista concurrente',
          currency : 'MXN',
          active   : true,
        });
        const outcomes  = await Promise.allSettled([
          records.deletePriceList({
            code     : candidate.code,
            revision : candidate.revision,
          }),
          records.create('assignment', {
            customerCode  : 'retirement-race',
            priceListCode : candidate.code,
            active        : false,
          }),
        ]);
        assert.equal(
          outcomes.filter(
            /** @param {Object} outcome Resultado. @returns {boolean} Confirmación durable. */
            (outcome) => outcome.status === 'fulfilled',
          ).length,
          1,
        );
        const current         = await records.reference('price-list', candidate.code);
        const assignmentCount = await db
          .collection('PRODUCT_ASSIGNMENT')
          .countDocuments({ priceListCode: candidate.code });
        assert.equal(current.erased === true, assignmentCount === 0);
      },
    );
    await t.test(
      'el contexto global no acredita asignaciones de un workspace concreto',
      /** @returns {Promise<void>} Deniega referencias sin confundir falta de alcance con indisponibilidad. */
      async () => {
        actor = {
          ...admin,
          workspace : 'allWorkspaces',
        };
        try {
          const result = await services.resourceAccess({
            references : [
              {
                domain : 'assignment',
                code   : assignment.code,
              },
            ],
          });
          assert.deepEqual(result.items, [
            {
              domain    : 'assignment',
              code      : assignment.code,
              allowed   : false,
              workspace : null,
            },
          ]);
        } finally {
          actor = admin;
        }
      },
    );
    await t.test(
      'matriz pagina variantes, incluye vacíos y estados, conserva precisión y rechaza referencias o permisos insuficientes',
      /** @returns {Promise<void>} Consulta agrupada acreditada por contratos sobre MongoDB real. */
      async () => {
        const mxn      = await records.create('price-list', {
          name     : 'Matriz MXN',
          currency : 'MXN',
          active   : true,
        });
        const usd      = await records.create('price-list', {
          name     : 'Matriz USD',
          currency : 'USD',
          active   : false,
        });
        const retired  = await records.create('price-list', {
          name     : 'Matriz retirada',
          currency : 'MXN',
          active   : true,
        });
        const variants = [];
        for (let index = 0; index < 22; index++) {
          now++;
          const product = await records.create('item', {
            name           : 'Matriz ' + index,
            description    : '',
            type           : 'service',
            mode           : 'simple',
            sku            : 'MATRIX-' + index,
            categoryCode   : '',
            attributeCodes : [],
            fiscal,
            active         : index !== 21,
          });
          variants.push(product.simpleSkuCode);
        }
        const zero = await records.create('price', {
          priceListCode : mxn.code,
          skuCode       : variants[20],
          unitPrice     : '0',
          active        : true,
        });
        await records.create('price', {
          priceListCode : usd.code,
          skuCode       : variants[20],
          unitPrice     : '12.123456',
          active        : false,
        });
        await records.create('price', {
          priceListCode : retired.code,
          skuCode       : variants[20],
          unitPrice     : '99',
          active        : true,
        });
        await records.deletePriceList({
          code     : retired.code,
          revision : retired.revision,
        });
        const before = await db.collection('TEST_PRODUCT_OUTBOX').countDocuments();
        const first  = await call('product-price-matrix-get-list', {
          page    : 1,
          perPage : 20,
        });
        const second = await call('product-price-matrix-get-list', {
          page    : 2,
          perPage : 20,
        });
        assert.equal(first.items.length, 20);
        assert.deepEqual(first.priceLists, second.priceLists);
        assert.equal(
          first.pagination.total,
          await db.collection('PRODUCT_SKU').countDocuments({ workspace: 'allWorkspaces' }),
        );
        assert.equal(
          new Set(
            [...first.items, ...second.items].map(
              /** @param {Object} row Fila. @returns {string} Identidad única de SKU simple o variante. */
              (row) => row.variant.code,
            ),
          ).size,
          first.items.length + second.items.length,
        );
        assert.equal(
          first.priceLists.some(
            /** @param {Object} column Columna. @returns {boolean} Lista retirada. */
            (column) => column.code === retired.code,
          ),
          false,
        );
        const blank = first.items.find(
          /** @param {Object} row Fila. @returns {boolean} Variante sin precios. */
          (row) => row.variant.code === variants[21],
        );
        assert.equal(blank.variant.active, false);
        assert.deepEqual(blank.prices, []);
        const priced = first.items.find(
          /** @param {Object} row Fila. @returns {boolean} Variante con dos monedas. */
          (row) => row.variant.code === variants[20],
        );
        assert.deepEqual(
          priced.prices
            .map(
              /** @param {Object} price Precio. @returns {string} Importe exacto. */
              (price) => price.unitPrice,
            )
            .sort(),
          ['0', '12.123456'],
        );
        const inactive = await call('product-price-matrix-get-list', {
          variantActive : false,
        });
        assert.ok(
          inactive.items.every(
            /** @param {Object} row Fila. @returns {boolean} Filtro aplicado a variantes. */
            (row) => !row.variant.active,
          ),
        );
        for (const permission of ['price', 'sku', 'price-list']) {
          actor = {
            ...admin,
            policies : admin.policies.filter(
              /** @param {string} policy Permiso. @returns {boolean} Retira una referencia necesaria. */
              (policy) => policy !== 'product.' + permission + '.view.global',
            ),
          };
          await assert.rejects(records.priceMatrix({}), fails('FORBIDDEN'));
        }
        actor = admin;
        await db
          .collection('PRODUCT_PRICE')
          .updateOne({ code: zero.code }, { $set: { priceListCode: 'MISSING' } });
        await assert.rejects(records.priceMatrix({}), fails('PRODUCT_REFERENCE_MISSING'));
        await db
          .collection('PRODUCT_PRICE')
          .updateOne({ code: zero.code }, { $set: { priceListCode: mxn.code } });
        assert.equal(await db.collection('TEST_PRODUCT_OUTBOX').countDocuments(), before);
        assert.throws(
          /** @returns {*} Rechaza el filtro comercial antiguo. */
          () => actionDtos['product-price-matrix-get-list'].input({ active: true }),
        );
      },
    );
    await t.test(
      'todos los contratos rechazan suplantación y los listados recorren páginas',
      /** @returns {Promise<void>} Contratos cerrados y paginación reproducible. */
      async () => {
        assert.throws(
          /** @returns {*} Intenta inyectar contexto no admitido. */
          () => actionDtos['product-item-get-list'].input({ workspace: 'WORK-B' }),
        );
        const first  = await call('product-item-get-list', {
          page    : 1,
          perPage : 1,
        });
        const second = await call('product-item-get-list', {
          page    : 2,
          perPage : 1,
        });
        assert.notEqual(first.items[0].code, second.items[0].code);
        assert.equal(first.pagination.total, second.pagination.total);
        assert.equal(catalog.length, manifest.endpoints.length);
        actor = {
          ...admin,
          policies : [],
        };
        await assert.rejects(records.getList('item', {}), fails('FORBIDDEN'));
        actor = admin;
      },
    );
    await t.test(
      'descripción enriquecida: proyección optativa, compatibilidad y guardado atómico',
      /** @returns {Promise<void>} Cruza los DTO y MongoDB sin filtrar HTML a consumidores de texto simple. */
      async () => {
        const input = {
          name           : 'Descripción enriquecida',
          description    : 'No confiable',
          type           : 'service',
          mode           : 'simple',
          sku            : 'RICH-DESCRIPTION',
          categoryCode   : '',
          attributeCodes : [],
          fiscal,
          active         : true,
        };
        const html  =
          '<p>Instalación <strong>segura</strong> &amp; soporte</p><ul><li>Primero</li><li><em>Segundo</em></li></ul>';
        let saved   = await call('product-item-create', {
          ...input,
          descriptionHtml : html,
        });
        assert.equal(saved.description, 'Instalación segura & soporte\nPrimero\nSegundo');
        assert.equal(saved.descriptionHtml, html);
        const plain = await call('product-item-get-one', { code: saved.code });
        assert.equal(Object.hasOwn(plain, 'descriptionHtml'), false);
        const rich = await call('product-item-get-one', {
          code                   : saved.code,
          includeDescriptionHtml : true,
        });
        assert.equal(rich.descriptionHtml, html);
        saved = await call('product-item-update', {
          ...input,
          description : saved.description,
          name        : 'Otro nombre',
          code        : saved.code,
          revision    : saved.revision,
        });
        assert.equal(Object.hasOwn(saved, 'descriptionHtml'), false);
        assert.equal(
          (
            await call('product-item-get-one', {
              code                   : saved.code,
              includeDescriptionHtml : true,
            })
          ).descriptionHtml,
          html,
        );
        saved = await call('product-item-update', {
          ...input,
          description : '<literal> & texto',
          code        : saved.code,
          revision    : saved.revision,
        });
        assert.equal(
          (
            await call('product-item-get-one', {
              code                   : saved.code,
              includeDescriptionHtml : true,
            })
          ).descriptionHtml,
          '<p>&lt;literal&gt; &amp; texto</p>',
        );
        const formatted = await call('product-item-save', {
          code     : saved.code,
          revision : saved.revision,
          item     : {
            ...input,
            descriptionHtml : '<p><em>Restaurado</em></p>',
          },
          prices   : [],
        });
        assert.equal(formatted.item.description, 'Restaurado');
        assert.equal(formatted.item.descriptionHtml, '<p><em>Restaurado</em></p>');
        const pricesOnly = await call('product-item-save', {
          code     : saved.code,
          revision : formatted.item.revision,
          item     : null,
          prices   : [],
        });
        assert.equal(Object.hasOwn(pricesOnly.item, 'descriptionHtml'), false);
        assert.equal(
          (
            await call('product-item-get-one', {
              code                   : saved.code,
              includeDescriptionHtml : true,
            })
          ).descriptionHtml,
          formatted.item.descriptionHtml,
        );
        const priceList = await call('product-price-list-create', {
          name     : 'Rich MXN',
          currency : 'MXN',
          active   : true,
        });
        await call('product-price-create', {
          priceListCode : priceList.code,
          skuCode       : formatted.item.simpleSkuCode,
          unitPrice     : '100',
          active        : true,
        });
        const sale = await call('product-sale-resolve', {
          priceListCode : priceList.code,
          skuCode       : formatted.item.simpleSkuCode,
          currency      : 'MXN',
        });
        assert.equal(sale.description, 'Restaurado');
        assert.equal(Object.hasOwn(sale, 'descriptionHtml'), false);
        const presentation = await services.presentation({
          itemCode      : saved.code,
          priceListCode : priceList.code,
        });
        assert.equal(presentation.description, 'Restaurado');
        assert.ok(presentation.text.includes('Restaurado'));
        assert.equal(presentation.text.includes('<em>'), false);
        assert.equal(Object.hasOwn(presentation, 'descriptionHtml'), false);
        const page = await call('product-item-get-list', { search: 'Descripción enriquecida' });
        assert.ok(
          page.items.every(
            /** @param {Object} row Artículo de la página. @returns {boolean} La lectura simple no incluye HTML. */
            (row) => !Object.hasOwn(row, 'descriptionHtml'),
          ),
        );
        await assert.rejects(
          call('product-item-update', {
            ...input,
            descriptionHtml : '<p>Conflicto</p>',
            code            : saved.code,
            revision        : 1,
          }),
          fails('PRODUCT_REVISION_CONFLICT'),
        );
      },
    );
    await t.test(
      'las páginas de catálogos conservan filas y total del mismo snapshot',
      /** @returns {Promise<void>} Una escritura concurrente no mezcla estados en la lectura canónica. */
      async () => {
        actor = admin;
        await call('product-category-create', {
          name        : 'Categoría de snapshot',
          description : '',
          active      : true,
        });
        const collection = db.collection('PRODUCT_CATEGORY');
        const original   = await collection.findOne({});
        assert.ok(original);
        const count       = await collection.countDocuments({ workspace: 'allWorkspaces' });
        const transaction = store.transaction;
        const addedCode   = 'CATEGORY-SNAPSHOT-TEST';
        /** @param {Function} work Consulta canónica. @returns {Promise<Object>} Fija un snapshot antes de un alta concurrente fuera de la sesión. */
        store.transaction = (work) =>
          transaction.call(
            store,
            /** @param {Object} tx Puerto transaccional. @returns {Promise<Object>} Consulta real después de confirmar otro estado. */
            async (tx) => {
              await tx.get('category', { code: original.code });
              const added = {
                ...original,
                code : addedCode,
                name : 'Snapshot de aceptación',
              };
              delete added._id;
              await collection.insertOne(added);
              await collection.updateOne(
                { code: original.code },
                { $set: { name: 'Cambio concurrente' } },
              );
              return work(tx);
            },
          );
        try {
          const page = await call('product-category-get-list', {
            page    : 1,
            perPage : 100,
          });
          assert.equal(page.pagination.total, count);
          assert.equal(
            page.items.find(
              /** @param {Object} row Fila. @returns {boolean} Recurso existente al iniciar la consulta. */
              (row) => row.code === original.code,
            ).name,
            original.name,
          );
          assert.equal(
            page.items.some(
              /** @param {Object} row Fila. @returns {boolean} Alta posterior al snapshot. */
              (row) => row.code === addedCode,
            ),
            false,
          );
        } finally {
          store.transaction = transaction;
          await collection.deleteOne({ code: addedCode });
          await collection.replaceOne({ _id: original._id }, original);
        }
      },
    );
  },
);
