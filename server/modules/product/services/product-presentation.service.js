/** @file Resuelve una ficha comercial consistente para su revisión y publicación expresa. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const { access }           = require('../policies/product-access.policy');
const { productGallery }   = require('../contracts/product-gallery');

/** @param {Object} dependencies Lectura transaccional y contexto acreditado. @returns {Function} Consulta comercial sin efectos externos. */
function productPresentation({ store, records, context }) {
  /** @param {Object} input Producto, lista, variantes y fotografías elegidas. @returns {Promise<Object>} Ficha completa, texto y referencia de concurrencia. */
  return async function resolve(input) {
    const actor = context();
    for (const resource of ['item', 'sku', 'price-list', 'price']) access(actor, resource, 'view');
    return store.transaction(
      /** @param {Object} tx Instantánea consistente del catálogo. @returns {Promise<Object>} Representación autorizada. */
      async (tx) => {
        const revisions = [];
        /** @param {string} resource Recurso comercial. @param {string} code Identidad. @returns {Promise<Object>} Registro activo y autorizado. */
        async function read(resource, code) {
          const record = await records.get(resource, code, 'view', actor, tx);
          if (!record.active) throw new ApplicationError(409, 'PRODUCT_REFERENCE_INACTIVE');
          revisions.push([resource, code, record.revision]);
          return record;
        }
        const item       = await read('item', input.itemCode);
        const list       = await read('price-list', input.priceListCode);
        const category   = item.categoryCode ? await read('category', item.categoryCode) : null;
        const attributes = new Map();
        for (const code of item.attributeCodes) attributes.set(code, await read('attribute', code));
        const skus = [];
        if (input.skuCodes?.length) {
          for (const code of input.skuCodes) skus.push(await read('sku', code));
        } else {
          let page = 1;
          let result;
          do {
            result = await tx.list(
              'sku',
              {
                itemCode  : item.code,
                active    : true,
                workspace : 'allWorkspaces',
              },
              {
                page,
                perPage : 100,
              },
            );
            for (const sku of result.items) {
              skus.push(sku);
              revisions.push(['sku', sku.code, sku.revision]);
            }
            page++;
          } while (skus.length < result.pagination.total);
        }
        if (
          !skus.length ||
          skus.some(
            /** @param {Object} sku Variante seleccionada. @returns {boolean} Pertenece a otro artículo. */
            (sku) => sku.itemCode !== item.code,
          )
        )
          throw new ApplicationError(400, 'PRODUCT_VARIANTS_INVALID');
        const variants = [];
        for (const sku of skus) {
          const price = await tx.get('price', {
            skuCode       : sku.code,
            priceListCode : list.code,
            active        : true,
            workspace     : 'allWorkspaces',
          });
          revisions.push(['price', sku.code, price?.code || '', price?.revision || 0]);
          variants.push({
            skuCode    : sku.code,
            sku        : sku.sku,
            name       : sku.name || item.name,
            attributes : sku.selections.map(
              /** @param {Object} selection Valor comercial. @returns {Object} Etiquetas publicables sin metadatos internos. */
              (selection) => ({
                name  : attributes.get(selection.attributeCode)?.name || selection.attributeCode,
                value : selection.value,
              }),
            ),
            unitPrice  : price?.unitPrice ?? null,
          });
        }
        const available = [];
        /** @param {string} resource Tipo de propietario. @param {Object} owner Registro autorizado. @returns {void} Añade imágenes sin duplicados. */
        function collect(resource, owner) {
          for (const image of productGallery(owner))
            if (
              !available.some(
                /** @param {Object} previous Archivo ya incluido. @returns {boolean} Identidad repetida. */
                (previous) => previous.fileId === image.fileId,
              )
            )
              available.push({
                ...image,
                resource,
                code : owner.code,
              });
        }
        collect('item', item);
        for (const sku of skus) collect('sku', sku);
        const imageIds =
          input.imageIds ??
          available.slice(0, 5).map(
            /** @param {Object} image Fotografía elegible. @returns {string} Identidad documental. */
            (image) => image.fileId,
          );
        if (imageIds.length > 5 || new Set(imageIds).size !== imageIds.length)
          throw new ApplicationError(400, 'PRODUCT_IMAGES_INVALID');
        const images  = imageIds.map(
          /** @param {string} id Fotografía elegida. @returns {Object} Referencia acreditada por pertenencia. */
          (id) => {
            const image = available.find(
              /** @param {Object} candidate Fotografía disponible. @returns {boolean} Identidad solicitada. */
              (candidate) => candidate.fileId === id,
            );
            if (!image) throw new ApplicationError(400, 'PRODUCT_IMAGES_INVALID');
            return image;
          },
        );
        const product = {
          itemCode      : item.code,
          name          : item.name,
          description   : item.description,
          type          : item.type,
          category      : category?.name || '',
          priceListCode : list.code,
          priceListName : list.name,
          currency      : list.currency,
          variants,
        };
        const lines   = [
          item.name,
          item.description,
          `Tipo: ${item.type === 'service' ? 'Servicio' : 'Producto'}`,
          `Lista de precios: ${list.name}`,
          `Moneda: ${list.currency}`,
        ];
        if (category) lines.push(`Categoría: ${category.name}`);
        for (const variant of variants) {
          const details = variant.attributes
            .map(
              /** @param {Object} value Atributo. @returns {string} Etiqueta legible. */
              (value) => `${value.name}: ${value.value}`,
            )
            .join(', ');
          lines.push(
            `${variant.name} (${variant.sku})${details ? ' — ' + details : ''}: ${variant.unitPrice === null ? 'Precio por confirmar' : variant.unitPrice + ' ' + list.currency}`,
          );
        }
        const text = lines.filter(Boolean).join('\n');
        if (text.length > 10000) throw new ApplicationError(413, 'PRODUCT_PRESENTATION_TOO_LARGE');
        return {
          ...product,
          images,
          availableImages : available,
          text,
          revisionKey     : JSON.stringify([revisions, imageIds]),
        };
      },
    );
  };
}
module.exports = { productPresentation };
