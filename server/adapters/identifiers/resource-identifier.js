/** @file Identificadores internos con prefijos de exactamente tres letras y UUID independiente del SKU. */
'use strict';
const { randomUUID } = require('node:crypto');
const PREFIXES       = {
  item         : 'PRO',
  sku          : 'VAR',
  category     : 'CAT',
  attribute    : 'ATR',
  'price-list' : 'LPR',
  price        : 'PRE',
  assignment   : 'ACL',
  timeline     : 'TLE',
};
/** @param {string} resource Recurso del catálogo. @returns {string} Código inmutable. */
function resourceIdentifier(resource) {
  if (!PREFIXES[resource]) throw new TypeError('PRODUCT_RESOURCE_INVALID');
  return PREFIXES[resource] + '-' + randomUUID();
}
module.exports = { resourceIdentifier };
