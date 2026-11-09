/** @file Traduce hechos comerciales de Product a Timeline dentro de la transacción original. */
'use strict';
const { isDeepStrictEqual } = require('node:util');
const { ApplicationError }  = require('../../../shared/application-error');
const fields                = {
  name            : 'Nombre',
  description     : 'Descripción',
  descriptionHtml : 'Formato de la descripción',
  type            : 'Tipo',
  mode            : 'Presentación',
  sku             : 'SKU',
  categoryCode    : 'Categoría',
  attributeCodes  : 'Atributos',
  fiscal          : 'Información fiscal',
  active          : 'Estado',
  selections      : 'Combinación',
  values          : 'Valores',
  currency        : 'Moneda',
  priceListCode   : 'Lista de precios',
  skuCode         : 'Variante',
  customerCode    : 'Cliente',
  unitPrice       : 'Precio',
  image           : 'Imagen',
  erased          : 'Eliminación',
};
const labels                = {
  item         : 'Producto o servicio',
  sku          : 'Variante',
  category     : 'Categoría',
  attribute    : 'Atributo',
  'price-list' : 'Lista de precios',
  price        : 'Precio',
  assignment   : 'Asignación comercial',
};
/** @param {string} domain Recurso propietario. @param {string} code Código persistido. @returns {Object} Referencia genérica sin datos del cliente. */
function reference(domain, code) {
  return {
    service : 'service-product',
    domain,
    code,
  };
}
/**
 * Los cambios de variantes y precios se registran una vez sobre su producto padre.
 * @param {Object} tx Unidad transaccional con outbox.
 * @param {Object} actor Identidad acreditada del transporte.
 * @param {string} resource Recurso modificado.
 * @param {Object} record Estado confirmado por la misma transacción.
 * @param {Object|null} previous Estado anterior o ausencia en altas.
 * @param {Function} identifier Generador inyectado de identidad estable en el outbox.
 * @returns {Promise<void>} Hecho durable; omite cambios exclusivamente técnicos.
 */
async function emitTimelineChange(tx, actor, resource, record, previous, identifier) {
  const changed = Object.keys(fields).filter(
    /** @param {string} field Campo comercial. @returns {boolean} Cambio efectivo sin metadatos de revisión. */
    (field) => previous && !isDeepStrictEqual(previous[field], record[field]),
  );
  if (previous && !changed.length) return;
  let subject            = reference(resource, record.code);
  const accessReferences = [];
  if (resource === 'sku') {
    subject = reference('item', record.itemCode);
    accessReferences.push(reference('sku', record.code));
  }
  if (resource === 'price') {
    const sku = await tx.get('sku', {
      code      : record.skuCode,
      workspace : record.workspace,
    });
    if (!sku) throw new ApplicationError(409, 'PRODUCT_REFERENCE_MISSING');
    subject = reference('item', sku.itemCode);
    accessReferences.push(
      reference('price', record.code),
      reference('sku', sku.code),
      reference('price-list', record.priceListCode),
    );
  }
  const action      = !previous
    ? 'created'
    : record.erased && !previous.erased
      ? 'deleted'
      : changed.length === 1 && changed[0] === 'image'
        ? record.image
          ? 'image-updated'
          : 'image-removed'
        : 'updated';
  const description = previous
    ? 'Cambios: ' +
      changed
        .map(
          /** @param {string} field Campo modificado. @returns {string} Etiqueta sin snapshots privados. */
          (field) => fields[field],
        )
        .join(', ') +
      '.'
    : String(record.name || record.sku || labels[resource]);
  await tx.emit('communication.timeline.record-requested', {
    eventId     : identifier('timeline'),
    workspace   : record.workspace,
    actor       : {
      type : actor.actorType === 'agent' ? 'agent' : 'human',
      code :
        actor.actorType === 'agent' ? actor.agentCode || actor.user.userCode : actor.user.userCode,
    },
    subject,
    eventType   : `product.${resource}.${action}`,
    title       : `${labels[resource]}: ${!previous ? 'alta' : action === 'deleted' ? 'eliminación' : action === 'image-removed' ? 'imagen retirada' : action === 'image-updated' ? 'imagen actualizada' : 'actualización'}`,
    description : description.slice(0, 4000),
    occurredAt  : record.updateDate,
    accessReferences,
  });
}
module.exports = { emitTimelineChange };
