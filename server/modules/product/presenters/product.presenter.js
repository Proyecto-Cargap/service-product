/** @file Proyección explícita de registros sin campos de persistencia o limpieza. */
'use strict';
const { descriptionHtml } = require('../policies/product-description.policy');
const { productGallery }  = require('../contracts/product-gallery');
const schemas             = {
  item         : require('../contracts/item.schema.json'),
  sku          : require('../contracts/sku.schema.json'),
  category     : require('../contracts/category.schema.json'),
  attribute    : require('../contracts/attribute.schema.json'),
  'price-list' : require('../contracts/price-list.schema.json'),
  price        : require('../contracts/price.schema.json'),
  assignment   : require('../contracts/assignment.schema.json'),
};
/** @param {string} resource Recurso acreditado. @param {Object} record Registro plano. @param {boolean} includeDescriptionHtml Opta por la representación enriquecida del artículo. @returns {Object} Lista blanca pública. */
function present(resource, record, includeDescriptionHtml = false) {
  const result = {};
  for (const key of Object.keys(schemas[resource].properties))
    if (key !== 'descriptionHtml' && record[key] !== undefined)
      result[key] = structuredClone(record[key]);
  if (resource === 'item' && includeDescriptionHtml)
    result.descriptionHtml = record.descriptionHtml ?? descriptionHtml(record.description);
  if (['sku', 'attribute', 'price', 'price-list'].includes(resource))
    result.erased = record.erased === true;
  if (['item', 'sku'].includes(resource)) {
    result.images = structuredClone(productGallery(record));
    delete result.image;
    if (result.images.length) result.image = result.images[0];
  }
  return result;
}
module.exports = { present };
