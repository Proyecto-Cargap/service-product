/** @file Composición técnica única y catálogo RPC del dominio Product. */
'use strict';
const { composeProduct } = require('./product/compositions/product.composition');
/** @param {Object} options Transporte y servicios opcionales de prueba. @returns {Object[]} Catálogo con contratos explícitos. */
function createCatalog({ messaging, services }) {
  if (!services) {
    const database = require('../adapters/mongodb/connection').connection;
    const store    = require('./product/repositories/product-store.repository').createProductStore({
      db      : database.db,
      client  : database.getClient(),
      publish : messaging.publishEvent.bind(messaging),
    });
    services = composeProduct({
      store,
      references : require('../adapters/messaging/product-references').productReferences(messaging),
      files      : require('../adapters/documents/product-images').productImages(messaging),
      identifier : require('../adapters/identifiers/resource-identifier').resourceIdentifier,
      /** @param {string} value Entrada canónica. @returns {string} Huella SHA-256 para recibos. */
      digest     : (value) => require('node:crypto').createHash('sha256').update(value).digest('hex'),
      /** @returns {Object} Contexto aislado por solicitud. */
      context    : () => messaging.getContext(),
      /** @returns {number} Milisegundos UTC. */
      clock      : () => Date.now(),
    });
    messaging.productWorker = require('../library/work/reactive-worker').createReactiveWorker({
      source    : require('../library/work/mongo-changes').createMongoChanges({
        connection  : database,
        collections : ['PRODUCT_IMAGE_JOB'],
        logger      : require('../telemetry').logger,
        component   : 'product-images',
      }),
      nextAt    : store.nextImageAt,
      tick      : services.images.tick,
      logger    : require('../telemetry').logger,
      component : 'product-images',
    });
  }
  const entries = [];
  /** @param {string} name Acción RPC. @param {Function} invoke Caso de uso. @param {number} status Código de éxito. @returns {void} Adaptación sin reglas de negocio. */
  function register(name, invoke, status = 200) {
    entries.push({
      name,
      kind : 'action',
      /** @param {Object} message Entrada acreditada. @returns {Promise<Object>} Sobre canónico. */
      async handler(message) {
        return messaging.successResponse(status, await invoke(message.data));
      },
    });
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
    for (const [operation, method] of [
      ['get-one', 'getOne'],
      ['get-list', 'getList'],
      ['create', 'create'],
      ['update', 'update'],
    ])
      register(
        `product-${resource}-${operation}`,
        /** @param {Object} data Entrada. @returns {Promise<Object>} Operación autorizada. */
        (data) => services.records[method](resource, data),
        operation === 'create' ? 201 : 200,
      );
  }
  register('product-price-list-delete', services.records.deletePriceList);
  register('product-sku-delete', services.retirement.deleteSku);
  register('product-attribute-delete', services.retirement.deleteAttribute);
  register('product-price-matrix-get-list', services.records.priceMatrix);
  register('resource-access-check', services.resourceAccess);
  register('product-sale-resolve', services.resolve);
  register('product-presentation-resolve', services.presentation);
  register('product-item-prices-get-list', services.records.itemPrices);
  register('product-item-save', services.records.saveItem);
  register('product-customer-price-list-get', services.records.customerPriceList);
  for (const resource of ['item', 'sku'])
    register(
      `product-${resource}-images-set`,
      /** @param {Object} data Orden y fotografía opcional. @returns {Promise<Object>} Galería autorizada. */
      (data) => services.images.setGallery(resource, data),
    );
  for (const resource of ['item', 'sku'])
    for (const action of ['get', 'set'])
      register(
        `product-${resource}-image-${action}`,
        /** @param {Object} data Imagen. @returns {Promise<Object>} Lectura o sustitución autorizada. */
        (data) => services.images[action](resource, data),
      );
  return entries;
}
module.exports = {
  createCatalog : require('../contracts/index').catalogFactory(createCatalog),
};
