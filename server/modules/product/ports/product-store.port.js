/** @file Puerto transaccional mínimo del catálogo y su ciclo durable de imágenes. */
'use strict';
/** @param {Object} store Colaborador inyectado; consultas devuelven datos planos y null sólo para ausencia. @returns {Object} Puerto validado sin crear infraestructura. */
function productStore(store) {
  for (const method of [
    'emit',
    'get',
    'list',
    'listItemPrices',
    'listPrices',
    'listPriceMatrix',
    'insert',
    'replace',
    'touch',
    'transaction',
    'stageImage',
    'adoptImage',
    'queueImage',
    'claimImage',
    'finishImage',
    'retryImage',
  ])
    if (typeof store?.[method] !== 'function')
      throw new TypeError('INVALID_PRODUCT_STORE:' + method);
  return store;
}
module.exports = { productStore };
