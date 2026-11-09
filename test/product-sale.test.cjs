/** @file Regresión de venta con nombre de unidad opcional y conservación del contrato público fiscal. */
'use strict';
const test              = require('node:test');
const assert            = require('node:assert/strict');
const { productSale }   = require('../server/modules/product/services/product-sale.service');
const { productFiscal } = require('../server/modules/product/services/product-fiscal.service');
const { actionDtos }    = require('../server/contracts');

/** @param {Object} fiscal Datos fiscales del artículo. @returns {Promise<Object>} Venta validada por el caso de uso, la fiscalidad y el DTO reales con lecturas controladas. */
async function resolve(fiscal) {
  const records = {
    item         : {
      code     : 'PRO-test',
      revision : 1,
      name     : 'Servicio',
      fiscal,
    },
    sku          : {
      code     : 'VAR-test',
      revision : 1,
      itemCode : 'PRO-test',
      sku      : 'SERV-1',
    },
    'price-list' : {
      code     : 'LPR-test',
      currency : 'MXN',
    },
    price        : {
      code      : 'PRE-test',
      revision  : 1,
      unitPrice : '100',
    },
  };
  const store   = {
    /** @param {string} resource Recurso comercial. @param {Object} filter Selector autorizado. @returns {Promise<Object>} Registro observado sin escrituras. */
    async get(resource, filter) {
      assert.equal(filter.active, true);
      return structuredClone(records[resource]);
    },
    /** @param {Function} work Lectura coherente. @returns {Promise<Object>} Resultado sin efectos externos. */
    transaction(work) {
      return work(store);
    },
  };
  const sale    = productSale({
    store,
    /** @returns {Object} Actor con permisos de lectura del catálogo. */
    context() {
      return {
        user     : { userCode: 'USER-test' },
        policies : ['item', 'sku', 'price-list', 'price'].map(
          /** @param {string} resource Recurso comercial. @returns {string} Política de lectura global. */
          (resource) => `product.${resource}.view.global`,
        ),
      };
    },
    fiscal : productFiscal({
      /** @param {Object[]} values Claves fiscales. @returns {Promise<void>} Comprueba que la clave de unidad siga validándose. */
      async values(values) {
        assert.deepEqual(values, [
          {
            kind : 'product-service',
            code : '81111500',
          },
          {
            kind : 'unit',
            code : 'E48',
          },
          {
            kind : 'tax-object',
            code : '02',
          },
        ]);
      },
      /** @returns {Promise<Object>} Tasa controlada que mantiene activa la validación tributaria. */
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
    }),
  });
  const dto     = actionDtos['product-sale-resolve'];
  const input   = dto.input({
    skuCode       : 'VAR-test',
    priceListCode : 'LPR-test',
    currency      : 'MXN',
  });
  return dto.output({
    statusCode : 200,
    data       : await sale(input),
  }).data;
}

const fiscal = {
  productService : '81111500',
  unit           : 'E48',
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
test('permite nombre de unidad ausente o vacío y conserva el nombre capturado', /** @returns {Promise<void>} Mantiene precio, impuestos y estructura de salida sin exigir el atributo opcional. */ async () => {
  for (const fields of [{}, { unitName: '' }, { unitName: 'Servicio' }]) {
    const input  = {
      ...fiscal,
      ...fields,
    };
    const before = structuredClone(input);
    const result = await resolve(input);
    assert.equal(result.unitName, fields.unitName || '');
    assert.equal(result.unit, 'E48');
    assert.equal(result.unitPrice, '100');
    assert.deepEqual(result.taxes, fiscal.taxes);
    assert.deepEqual(input, before);
  }
});
test('sigue rechazando claves requeridas ausentes e impuestos inválidos', /** @returns {Promise<void>} Quitar el requisito del nombre no relaja la fiscalidad obligatoria. */ async () => {
  for (const field of ['productService', 'unit', 'taxObject', 'taxes']) {
    const input = { ...fiscal };
    delete input[field];
    await assert.rejects(resolve(input), { descriptionCode: 'PRODUCT_FISCAL_INCOMPLETE' });
  }
  await assert.rejects(
    resolve({
      ...fiscal,
      taxes : [],
    }),
    { descriptionCode: 'PRODUCT_TAXES_REQUIRED' },
  );
  await assert.rejects(
    resolve({
      ...fiscal,
      taxes : [
        {
          ...fiscal.taxes[0],
          rate : '0.99',
        },
      ],
    }),
    { descriptionCode: 'PRODUCT_TAX_INVALID' },
  );
});
