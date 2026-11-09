/** @file Composición del catálogo con dependencias mínimas y sin conexiones implícitas. */
'use strict';
const { normalizeDescription } = require('../../../adapters/content/product-description');
const { productStore }         = require('../ports/product-store.port');
const { productFiscal }        = require('../services/product-fiscal.service');
const { productRecords }       = require('../services/product-records.service');
const { productRetirement }    = require('../services/product-retirement.service');
const { productSale }          = require('../services/product-sale.service');
const { productPresentation }  = require('../services/product-presentation.service');
const { productImageService }  = require('../services/product-images.service');
const { createResourceAccess } = require('../services/resource-access.service');
/** @param {Object} dependencies Colaboradores explícitos. @returns {Object} Casos de uso sustituibles en pruebas. */
function composeProduct(dependencies) {
  const store = productStore(dependencies.store);
  for (const name of ['clock', 'identifier', 'context'])
    if (typeof dependencies[name] !== 'function')
      throw new TypeError('INVALID_PRODUCT_DEPENDENCY:' + name);
  for (const name of ['customer', 'values', 'catalog'])
    if (typeof dependencies.references?.[name] !== 'function')
      throw new TypeError('INVALID_PRODUCT_REFERENCE:' + name);
  for (const name of ['upload', 'read', 'remove'])
    if (typeof dependencies.files?.[name] !== 'function')
      throw new TypeError('INVALID_PRODUCT_FILE_PORT:' + name);
  const fiscal = productFiscal(dependencies.references),
    options    = {
      ...dependencies,
      store,
      fiscal,
      normalizeDescription,
    };
  const records = productRecords(options);
  return {
    records,
    retirement     : productRetirement({
      ...options,
      records,
    }),
    resourceAccess : createResourceAccess({ records }),
    resolve        : productSale(options),
    presentation   : productPresentation({
      ...options,
      records,
    }),
    images         : productImageService({
      ...options,
      records,
    }),
  };
}
module.exports = { composeProduct };
