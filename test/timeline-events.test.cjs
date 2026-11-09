/** @file Hechos de Product: asociación al producto, referencias restringidas y exclusión de cambios técnicos. */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  emitTimelineChange,
} = require('../server/modules/product/services/timeline-events.service');
const {
  createResourceAccess,
} = require('../server/modules/product/services/resource-access.service');
const { ApplicationError } = require('../server/shared/application-error');
test('todos los recursos escriben hechos con el alcance de su registro y sin duplicar sincronizaciones técnicas', /** @returns {Promise<void>} Acredita enrutamiento, cambios efectivos, imágenes y errores transaccionales. */ async () => {
  const events = [];
  const actor  = {
    workspace : 'w',
    user      : { userCode: 'u' },
  };
  const tx     = {
    /** @param {string} resource Colección. @param {Object} filter Referencia. @returns {Promise<Object>} Variante del producto padre. */
    async get(resource, filter) {
      assert.equal(resource, 'sku');
      return {
        code     : filter.code,
        itemCode : 'product',
      };
    },
    /** @param {string} name Evento. @param {Object} data Hecho. @returns {Promise<void>} Outbox observable. */
    async emit(name, data) {
      assert.equal(name, 'communication.timeline.record-requested');
      events.push(data);
    },
  };
  let sequence = 0;
  /** @returns {string} Identidad de evento inyectada. */
  function identifier() {
    return 'event-' + ++sequence;
  }
  for (const resource of [
    'item',
    'sku',
    'category',
    'attribute',
    'price-list',
    'price',
    'assignment',
  ]) {
    const record = {
      code          : resource,
      workspace     : resource === 'assignment' ? 'w' : 'allWorkspaces',
      name          : 'Registro',
      active        : true,
      updateDate    : 12,
      itemCode      : 'product',
      skuCode       : 'sku',
      priceListCode : 'list',
    };
    await emitTimelineChange(tx, actor, resource, record, null, identifier);
    const event = events.at(-1);
    assert.equal(event.workspace, record.workspace);
    assert.deepEqual(event.actor, {
      type : 'human',
      code : 'u',
    });
    assert.equal(event.subject.domain, ['sku', 'price'].includes(resource) ? 'item' : resource);
    assert.equal(event.subject.code, ['sku', 'price'].includes(resource) ? 'product' : resource);
    assert.equal(
      event.accessReferences.length,
      resource === 'price' ? 3 : resource === 'sku' ? 1 : 0,
    );
    const count = events.length;
    await emitTimelineChange(
      tx,
      actor,
      resource,
      {
        ...record,
        revision   : 2,
        updateDate : 14,
      },
      record,
      identifier,
    );
    assert.equal(events.length, count);
    await emitTimelineChange(
      tx,
      actor,
      resource,
      {
        ...record,
        active : false,
      },
      record,
      identifier,
    );
    assert.equal(events.at(-1).description, 'Cambios: Estado.');
  }
  const item = {
    code       : 'p',
    workspace  : 'allWorkspaces',
    updateDate : 20,
    image      : { fileId: 'image' },
  };
  await emitTimelineChange(
    tx,
    actor,
    'item',
    item,
    {
      ...item,
      image : undefined,
    },
    identifier,
  );
  assert.equal(events.at(-1).eventType, 'product.item.image-updated');
  await emitTimelineChange(
    tx,
    actor,
    'item',
    {
      ...item,
      image : undefined,
    },
    item,
    identifier,
  );
  assert.equal(events.at(-1).eventType, 'product.item.image-removed');
  assert.equal(
    new Set(
      events.map(
        /** @param {Object} event Hecho. @returns {string} Identidad durable. */
        (event) => event.eventId,
      ),
    ).size,
    events.length,
  );
  await assert.rejects(
    emitTimelineChange(
      {
        ...tx,
        /** @returns {Promise<never>} Error técnico que debe abortar la escritura original. */
        async emit() {
          throw new Error('outbox-offline');
        },
      },
      actor,
      'item',
      item,
      null,
      identifier,
    ),
    /outbox-offline/,
  );
});
test('resource-access-check conserva permisos, ausencia, orden y fallos técnicos', /** @returns {Promise<void>} No convierte indisponibilidad en acceso denegado. */ async () => {
  const check      = createResourceAccess({
    records : {
      /** @param {string} domain Recurso. @param {string} code Código. @returns {Promise<Object>} Lectura autorizada del propietario. */
      async reference(domain, code) {
        if (code === 'denied') throw new ApplicationError(403, 'FORBIDDEN');
        if (code === 'missing') throw new ApplicationError(404, 'PRODUCT_NOT_FOUND');
        if (code === 'offline') throw new Error('database-offline');
        return { workspace: domain === 'assignment' ? 'w' : 'allWorkspaces' };
      },
    },
  });
  const references = [
    {
      domain : 'item',
      code   : 'p',
    },
    {
      domain : 'assignment',
      code   : 'a',
    },
    {
      domain : 'item',
      code   : 'denied',
    },
    {
      domain : 'item',
      code   : 'missing',
    },
    {
      domain : 'audit',
      code   : 'removed',
    },
  ];
  const result     = await check({ references });
  assert.deepEqual(
    result.items.map(
      /** @param {Object} item Permiso. @returns {string|null} Alcance acreditado o ausencia. */
      (item) => item.workspace,
    ),
    ['allWorkspaces', 'w', null, null, null],
  );
  await assert.rejects(
    check({
      references : [
        {
          domain : 'item',
          code   : 'offline',
        },
      ],
    }),
    /database-offline/,
  );
});
