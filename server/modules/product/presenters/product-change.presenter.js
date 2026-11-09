/** @file Referencia mínima de un cambio Product, sin precios, contenido, credenciales ni archivos. */
'use strict';
/** @param {string} resource Recurso confirmado. @param {Object} record Estado nuevo. @param {Object|null} previous Estado anterior. @param {string|undefined} itemCode Artículo derivado por el repositorio para un precio. @returns {Object} Causa para recalcular únicamente ventanas autorizadas afectadas. */
function productResourceChange(resource, record, previous = null, itemCode) {
  const change = {
    resource,
    code      : record.code,
    revision  : record.revision,
    workspace : record.workspace,
    erased    : record.erased === true,
  };
  for (const key of ['itemCode', 'skuCode', 'priceListCode', 'customerCode']) {
    if (typeof record[key] === 'string') change[key] = record[key];
    if (previous && typeof previous[key] === 'string' && previous[key] !== record[key])
      change['previous' + key[0].toUpperCase() + key.slice(1)] = previous[key];
  }
  if (itemCode) change.itemCode = itemCode;
  return change;
}
module.exports = { productResourceChange };
