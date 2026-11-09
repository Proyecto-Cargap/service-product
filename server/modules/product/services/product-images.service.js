/** @file Carga, adopción y limpieza durable de imágenes privadas con cercos de concurrencia. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const { present }          = require('../presenters/product.presenter');
const { productGallery }   = require('../contracts/product-gallery');
/** @param {Object} dependencies Persistencia, archivos, registros, reloj y contexto. @returns {Object} Operaciones de imágenes sin transporte concreto. */
function productImageService({ store, files, records, clock, context }) {
  const api = {
    /** @param {string} resource Artículo o variante. @param {Object} input Revisión y carga opcional; sin carga elimina imagen propia. @returns {Promise<Object>} Registro con adopción atómica. */
    async set(resource, input) {
      const previous  = await records.get(resource, input.code, 'update');
      const remaining = productGallery(previous).slice(1);
      return api.setGallery(resource, {
        ...input,
        fileIds : [
          ...(input.pictureUpload ? [input.pictureUpload.fileId] : []),
          ...remaining.map(
            /** @param {Object} image Fotografía conservada. @returns {string} Identidad documental. */
            (image) => image.fileId,
          ),
        ],
      });
    },
    /** @param {string} resource Artículo o variante. @param {Object} input Orden completo y carga opcional. @returns {Promise<Object>} Galería confirmada con portada derivada. */
    async setGallery(resource, input) {
      const actor = context(),
        previous  = await records.get(resource, input.code, 'update', actor);
      records.match(previous, input.revision);
      const existing = productGallery(previous);
      const ids      = input.fileIds;
      if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length)
        throw new ApplicationError(400, 'PRODUCT_GALLERY_INVALID');
      for (const id of ids)
        if (
          id !== input.pictureUpload?.fileId &&
          !existing.some(
            /** @param {Object} item Fotografía propia. @returns {boolean} Coincide con la selección. */
            (item) => item.fileId === id,
          )
        )
          throw new ApplicationError(400, 'PRODUCT_GALLERY_INVALID');
      if (
        input.pictureUpload &&
        (!ids.includes(input.pictureUpload.fileId) ||
          existing.some(
            /** @param {Object} item Fotografía propia. @returns {boolean} Una carga nueva no puede sobrescribir un archivo adoptado. */
            (item) => item.fileId === input.pictureUpload.fileId,
          ))
      )
        throw new ApplicationError(400, 'PRODUCT_GALLERY_INVALID');
      let image;
      if (input.pictureUpload) {
        await store.stageImage({
          fileId      : input.pictureUpload.fileId,
          resource,
          code        : previous.code,
          status      : 'pending',
          availableAt : clock() + 600000,
          fence       : 0,
        });
        image = await files.upload(input.pictureUpload, {
          resource,
          code : previous.code,
        });
      }
      const next = {
        ...previous,
        images     : ids.map(
          /** @param {string} id Identidad seleccionada. @returns {Object} Metadatos acreditados. */
          (id) =>
            id === image?.fileId
              ? image
              : existing.find(
                  /** @param {Object} item Fotografía existente. @returns {boolean} Identidad solicitada. */
                  (item) => item.fileId === id,
                ),
        ),
        revision   : previous.revision + 1,
        updateDate : clock(),
      };
      delete next.image;
      if (next.images.length) next.image = next.images[0];
      await store.transaction(
        /** @param {Object} tx Transacción sin efectos externos. @returns {Promise<void>} Adopción y sustitución indivisibles. */
        async (tx) => {
          if (image) await tx.adoptImage(image.fileId, clock());
          await tx.replace(resource, previous, next);
          for (const removed of existing.filter(
            /** @param {Object} item Fotografía anterior. @returns {boolean} Ya no pertenece a la galería. */
            (item) => !ids.includes(item.fileId),
          ))
            await tx.queueImage({
              fileId      : removed.fileId,
              resource,
              code        : previous.code,
              availableAt : clock(),
            });
          await records.timeline(tx, actor, resource, next, previous);
        },
      );
      return present(resource, next);
    },
    /** @param {string} resource Recurso visible. @param {Object} input Identidad y tamaño. @returns {Promise<Object>} Lectura autorizada con herencia de imagen de artículo. */
    async get(resource, input) {
      let owner = await records.get(resource, input.code),
        kind    = resource;
      if (!productGallery(owner).length && resource === 'sku') {
        owner = await records.get('item', owner.itemCode);
        kind = 'item';
      }
      const selected = input.fileId
        ? productGallery(owner).find(
            /** @param {Object} image Fotografía autorizada. @returns {boolean} Coincide con el archivo solicitado. */
            (image) => image.fileId === input.fileId,
          )
        : productGallery(owner)[0];
      if (!selected) throw new ApplicationError(404, 'PRODUCT_IMAGE_NOT_FOUND');
      return files.read(
        {
          resource : kind,
          code     : owner.code,
        },
        selected.fileId,
        input.size,
      );
    },
    /** @param {Object} options Cancelación del trabajador. @returns {Promise<void>} Recupera pendientes sin borrar archivos adoptados. */
    async tick({ shouldStop }) {
      for (let index = 0; index < 20 && !shouldStop(); index++) {
        const job = await store.claimImage(clock());
        if (!job) break;
        try {
          const owner = await store.get(job.resource, { code: job.code });
          if (
            !productGallery(owner).some(
              /** @param {Object} image Fotografía adoptada. @returns {boolean} Conserva el archivo del trabajo. */
              (image) => image.fileId === job.fileId,
            )
          )
            await files.remove(job);
          await store.finishImage(job);
        } catch {
          await store.retryImage(job, clock() + 60000);
        }
      }
    },
  };
  return api;
}
module.exports = { productImageService };
