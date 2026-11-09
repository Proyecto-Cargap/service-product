/** @file Colección ordenada de fotografías y portada de un recurso comercial. */
'use strict';
/** @param {Object|null} record Registro comercial. @returns {Object[]} Fotografías propias, incluida la imagen aún pendiente de migración. */
function productGallery(record) {
  return record?.images || (record?.image ? [record.image] : []);
}
module.exports = { productGallery };
