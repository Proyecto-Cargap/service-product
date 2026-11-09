/** @file Retirada lógica de variantes y atributos con revisión, recibo y Timeline atómicos. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const { access }           = require('../policies/product-access.policy');
const { present }          = require('../presenters/product.presenter');
const { operationReceipt } = require('./operation-receipt.service');
/** @param {Object} dependencies Persistencia, contexto y reglas canónicas de los registros. @returns {Object} Eliminaciones sin perder referencias históricas. */
function productRetirement({ store, context, clock, digest, records }) {
  /** @param {string} resource Recurso eliminable. @param {Object} input Identidad y revisión. @returns {Promise<Object>} Retirada autorizada; los reintentos no duplican el historial. */
  async function remove(resource, input) {
    const actor = context();
    access(actor, resource, 'delete');
    const mutation = operationReceipt({
      store,
      actor,
      action : resource + '-delete',
      input,
      digest,
      /** @param {Object} result Resultado original. @returns {Promise<void>} Revalida los permisos actuales antes de reproducir el recibo. */
      async authorize(result) {
        await records.get(resource, result.code, 'delete', actor, store, true);
      },
    });
    const replayed = await mutation.replay();
    if (replayed !== undefined) return replayed;
    return mutation.transaction(
      /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Conserva el catálogo histórico y revierte todos los efectos si falla el outbox. */
      async (tx) => {
        const previous = await records.get(resource, input.code, 'delete', actor, tx, true);
        if (previous.erased && [previous.revision, previous.revision - 1].includes(input.revision))
          return present(resource, previous);
        records.match(previous, input.revision);
        if (previous.erased) throw new ApplicationError(404, 'PRODUCT_NOT_FOUND');
        const record = {
          ...previous,
          erased     : true,
          active     : false,
          revision   : previous.revision + 1,
          updateDate : clock(),
        };
        if (resource === 'attribute') {
          await tx.touch('attribute', previous.code);
          if (
            (await tx.get('item', { attributeCodes: previous.code })) ||
            (await tx.get('sku', { 'selections.attributeCode': previous.code }))
          )
            throw new ApplicationError(409, 'PRODUCT_ATTRIBUTE_IN_USE');
        } else {
          const item = await tx.get('item', {
            code      : previous.itemCode,
            workspace : previous.workspace,
          });
          if (!item) throw new ApplicationError(409, 'PRODUCT_REFERENCE_MISSING');
          if (item.mode !== 'variants')
            throw new ApplicationError(409, 'PRODUCT_SIMPLE_SKU_MANAGED_BY_ITEM');
          await tx.touch('item', item.code);
          await tx.touch('sku', previous.code);
          // Libera la combinación comercial; el SKU histórico sigue reservado por su índice único.
          record.combination = 'erased:' + previous.code;
          for (;;) {
            const batch = await tx.list(
              'price',
              {
                skuCode   : previous.code,
                workspace : previous.workspace,
              },
              { perPage: 100 },
            );
            if (!batch.items.length) break;
            for (const price of batch.items) {
              const retired = {
                ...price,
                erased     : true,
                active     : false,
                revision   : price.revision + 1,
                updateDate : record.updateDate,
              };
              await tx.replace('price', price, retired);
              await records.timeline(tx, actor, 'price', retired, price);
            }
          }
        }
        await tx.replace(resource, previous, record);
        await records.timeline(tx, actor, resource, record, previous);
        return present(resource, record);
      },
    );
  }
  return {
    /** @param {Object} input Variante y revisión. @returns {Promise<Object>} Variante y precios retirados juntos. */
    deleteSku       : (input) => remove('sku', input),
    /** @param {Object} input Atributo y revisión. @returns {Promise<Object>} Atributo retirado sólo cuando ningún producto lo utiliza. */
    deleteAttribute : (input) => remove('attribute', input),
  };
}
module.exports = { productRetirement };
