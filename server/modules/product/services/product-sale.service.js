/** @file Resuelve una unidad comercializable con su precio y fiscalidad, sin recalcular históricos. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const { access }           = require('../policies/product-access.policy');
/** @param {Object} dependencies Lectura transaccional, fiscalidad y contexto. @returns {Function} Resolución comercial canónica. */
function productSale({ store, fiscal, context }) {
  /** @param {Object} input SKU, lista y moneda. @returns {Promise<Object>} Copia comercial con revisiones de origen. */
  return async function resolve(input) {
    const actor = context();
    for (const resource of ['item', 'sku', 'price-list', 'price']) access(actor, resource, 'view');
    const result = await store.transaction(
      /** @param {Object} tx Instantánea consistente. @returns {Promise<Object>} Referencias del mismo instante lógico. */
      async (tx) => {
        const sku  = await tx.get('sku', {
          code      : input.skuCode,
          active    : true,
          workspace : 'allWorkspaces',
        });
        const item =
          sku &&
          (await tx.get('item', {
            code      : sku.itemCode,
            active    : true,
            workspace : 'allWorkspaces',
          }));
        const list = await tx.get('price-list', {
          code      : input.priceListCode,
          active    : true,
          workspace : 'allWorkspaces',
        });
        if (!sku || !item || !list) throw new ApplicationError(409, 'PRODUCT_REFERENCE_INACTIVE');
        if (list.currency !== input.currency)
          throw new ApplicationError(409, 'PRODUCT_CURRENCY_MISMATCH');
        const price = await tx.get('price', {
          skuCode       : sku.code,
          priceListCode : list.code,
          active        : true,
        });
        if (!price) throw new ApplicationError(409, 'PRODUCT_PRICE_MISSING');
        return {
          catalogReference : {
            itemCode      : item.code,
            skuCode       : sku.code,
            priceListCode : list.code,
            itemRevision  : item.revision,
            skuRevision   : sku.revision,
            priceCode     : price.code,
            priceRevision : price.revision,
          },
          description      : item.description || item.name,
          sku              : sku.sku,
          currency         : list.currency,
          unitPrice        : price.unitPrice,
          ...item.fiscal,
          unitName         : item.fiscal?.unitName || '',
        };
      },
    );
    await fiscal(result, true);
    return result;
  };
}
module.exports = { productSale };
