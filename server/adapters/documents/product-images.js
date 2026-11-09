/** @file Almacenamiento privado de imágenes mediante Documents y pertenencia al recurso comercial. */
'use strict';
const { validate }         = require('../../contracts/action-dto');
const imageSchema          = require('../../modules/product/contracts/item.schema.json').properties.image;
const { ApplicationError } = require('../../shared/application-error');
/** @param {Object} messaging Transporte con origen acreditado. @returns {Object} Puerto de archivos de Product. */
function productImages(messaging) {
  /** @param {string} action Operación de almacenamiento. @param {Object} data Entrada canónica. @returns {Promise<Object>} Datos o fallo explícito. */
  async function request(action, data) {
    const result = await messaging.request('service-documents', 'files-storage-' + action, data, {
      timeoutMs : 310000,
    });
    if (!result || result.statusCode >= 400)
      throw new ApplicationError(
        result?.statusCode || 503,
        result?.descriptionCode || 'PRODUCT_IMAGE_UNAVAILABLE',
      );
    return result.data;
  }
  return {
    /** @param {Object} upload Temporal normalizado. @param {Object} owner Propietario. @returns {Promise<Object>} Referencia privada. */
    async upload(upload, owner) {
      const value = await request('upload', {
        ...upload,
        image            : true,
        visibility       : 'private',
        generateVariants : true,
        resourceType     : 'product-' + owner.resource,
        resourceCode     : owner.code,
        workspace        : 'allWorkspaces',
      });
      if (value.id !== upload.fileId || value.visibility !== 'private')
        throw new ApplicationError(503, 'PRODUCT_IMAGE_RESPONSE_INVALID');
      const image = {
        fileId   : value.id,
        name     : value.name,
        mimeType : value.mimeType,
        size     : value.size,
      };
      if (!validate(image, imageSchema, false))
        throw new ApplicationError(503, 'PRODUCT_IMAGE_RESPONSE_INVALID');
      return image;
    },
    /** @param {Object} owner Propietario. @param {string} fileId Archivo. @param {string} size Tamaño. @returns {Promise<Object>} Temporal confinado para el gateway. */
    read(owner, fileId, size) {
      return request('read', {
        fileId,
        resourceType : 'product-' + owner.resource,
        resourceCode : owner.code,
        size         : size || 'original',
      });
    },
    /** @param {Object} job Archivo pendiente de limpieza. @returns {Promise<Object>} Baja idempotente. */
    remove(job) {
      return request('delete', {
        fileId       : job.fileId,
        resourceType : 'product-' + job.resource,
        resourceCode : job.code,
      });
    },
  };
}
module.exports = { productImages };
