/** @file Retira ejes de las variantes sin perder sus identidades, precios o historial. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
const { access }           = require('../policies/product-access.policy');
/** @param {Object} tx Transacción con el producto cercado. @param {Object} record Producto propuesto. @param {Object} previous Producto anterior. @param {Object} actor Principal autorizado. @param {Function} clock Reloj inyectado. @param {Function} timeline Publicación atómica del cambio. @returns {Promise<void>} Rechaza adiciones o combinaciones resultantes repetidas antes de escribir variantes. */
async function updateVariantAttributes(tx, record, previous, actor, clock, timeline) {
  await tx.touch('item', record.code);
  const variants = [];
  for (let page = 1; ; page++) {
    const batch = await tx.list(
      'sku',
      {
        itemCode  : record.code,
        workspace : record.workspace,
      },
      {
        page,
        perPage : 100,
      },
    );
    variants.push(...batch.items);
    if (page * batch.pagination.perPage >= batch.pagination.total) break;
  }
  if (!variants.length) return;
  if (
    record.attributeCodes.some(
      /** @param {string} code Eje propuesto. @returns {boolean} Detecta un eje nuevo sin valor para las variantes existentes. */
      (code) => !previous.attributeCodes.includes(code),
    )
  )
    throw new ApplicationError(409, 'PRODUCT_ITEM_ATTRIBUTES_IN_USE');
  access(actor, 'sku', 'update');
  const combinations = new Set();
  const changes      = variants.map(
    /** @param {Object} variant Variante existente. @returns {Object} Proyección que conserva campos comerciales, imágenes y metadatos. */
    (variant) => {
      const selections  = variant.selections.filter(
        /** @param {Object} selection Valor anterior. @returns {boolean} Mantiene sólo los ejes que conserva el producto. */
        (selection) => record.attributeCodes.includes(selection.attributeCode),
      );
      const combination = JSON.stringify(
        selections
          .map(
            /** @param {Object} selection Valor comercial. @returns {Array<string>} Identidad canónica independiente del orden visual. */
            (selection) => [selection.attributeCode, selection.value],
          )
          .sort(),
      );
      if (combinations.has(combination))
        throw new ApplicationError(409, 'PRODUCT_ATTRIBUTE_REMOVAL_DUPLICATE');
      combinations.add(combination);
      return {
        ...variant,
        selections,
        combination,
        revision   : variant.revision + 1,
        updateDate : clock(),
      };
    },
  );
  for (let index = 0; index < changes.length; index++) {
    await tx.replace('sku', variants[index], changes[index]);
    await timeline(tx, actor, 'sku', changes[index], variants[index]);
  }
}
module.exports = { updateVariantAttributes };
