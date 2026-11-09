/** @file Contratos y permisos de Product atravesando RabbitMQ y MongoDB efímeros reales. */
'use strict';
const test                   = require('node:test');
const assert                 = require('node:assert/strict');
const { randomUUID }         = require('node:crypto');
const mongoose               = require('mongoose');
const { startIsolatedMongo } = require('./helpers/isolated-mongo.cjs');
const { startIsolatedAmqp }  = require('./helpers/isolated-amqp.cjs');
const { MessagingRuntime }   = require('../server/library/messaging/runtime');
const { createFacade }       = require('../server/library/messaging/facade');
const { registerCatalog }    = require('../server/library/messaging/catalog');
const { createCatalog }      = require('../server/modules/catalog');
const { composeProduct }     = require('../server/modules/product/compositions/product.composition');
const {
  createProductStore,
} = require('../server/modules/product/repositories/product-store.repository');
const { resourceIdentifier } = require('../server/adapters/identifiers/resource-identifier');
test(
  'RPC real de Product conserva códigos, DTO, permisos y paginación',
  {
    skip    :
      !process.env.TEST_MONGOD_BINARY ||
      !process.env.TEST_RABBITMQ_SERVER_BINARY ||
      !process.env.TEST_EPMD_BINARY,
    timeout : 90000,
  },
  /** @returns {Promise<void>} Crea y libera exclusivamente procesos propios de integración. */
  async () => {
    let database, broker;
    const runtimes = [];
    try {
      database = await startIsolatedMongo({
        binary : process.env.TEST_MONGOD_BINARY,
        mongoose,
      });
      broker = await startIsolatedAmqp({
        rabbitmqServer : process.env.TEST_RABBITMQ_SERVER_BINARY,
        epmd           : process.env.TEST_EPMD_BINARY,
      });
      const connection = database.connection;
      for (const manifest of [
        require('../server/library/messaging/indexes.json'),
        require('../server/mongodb-indexes.json').collections,
      ])
        for (const [name, indexes] of Object.entries(manifest))
          for (const { key, ...options } of indexes)
            await connection.db.collection(name).createIndex(key, options);
      const namespace = 'product-test-' + randomUUID();
      /** @param {string} service Identidad de transporte. @returns {Object} Fachada real sobre el broker aislado. */
      function runtime(service) {
        const instance = new MessagingRuntime({
          service,
          namespace,
          url    : broker.url,
          config : {
            startTimeoutMs    : 10000,
            rpcTimeoutMs      : 5000,
            shutdownTimeoutMs : 5000,
          },
          logger : {
            /** @returns {void} Evita registrar cargas de la prueba. */
            error() {},
          },
        });
        runtimes.push(instance);
        return createFacade(instance);
      }
      const product = runtime('service-product'),
        caller      = runtime('service-apigateway');
      const events         = [];
      const timelineEvents = [];
      caller.subscribe({
        name      : 'communication.timeline.record-requested',
        version   : 1,
        execution : 'nonTransactional',
        retrySafe : true,
        /** @param {Object} data Hecho confirmado. @param {Object} execution Sobre AMQP. @returns {void} Captura la publicación real del productor. */
        handler(data, execution) {
          timelineEvents.push({
            data,
            originService : execution.message.source,
          });
        },
      });
      caller.subscribe({
        name      : 'product.resource.changed',
        version   : 1,
        execution : 'nonTransactional',
        retrySafe : true,
        /** @param {Object} data Aviso. @param {Object} execution Sobre acreditado por Messaging. @returns {void} Registra el evento recibido a través del broker real. */
        handler(data, execution) {
          events.push({
            data,
            originService : execution.message.source,
          });
        },
      });
      const services = composeProduct({
        store      : createProductStore({
          db      : connection.db,
          client  : connection.getClient(),
          publish : product.publishEvent.bind(product),
        }),
        identifier : resourceIdentifier,
        /** @returns {Object} Contexto propagado por RabbitMQ. */
        context    : () => product.getContext(),
        /** @returns {number} Instante UTC. */
        clock      : () => Date.now(),
        references : {
          /** @returns {Promise<Object>} Puerto no utilizado por altas sin datos fiscales. */
          async customer() {
            throw new Error('UNEXPECTED_CUSTOMER');
          },
          /** @returns {Promise<Object>} Referencia fiscal no utilizada en este escenario. */
          async values() {
            throw new Error('UNEXPECTED_VALUES');
          },
          /** @returns {Promise<Object>} Referencia fiscal no utilizada en este escenario. */
          async catalog() {
            throw new Error('UNEXPECTED_CATALOG');
          },
        },
        files      : {
          /** @returns {Promise<Object>} No hay cargas externas en este caso de transporte. */
          async upload() {
            throw new Error('UNEXPECTED_IMAGE');
          },
          /** @returns {Promise<Object>} No hay descargas externas en este caso de transporte. */
          async read() {
            throw new Error('UNEXPECTED_IMAGE');
          },
          /** @returns {Promise<Object>} No hay limpiezas externas en este caso de transporte. */
          async remove() {
            throw new Error('UNEXPECTED_IMAGE');
          },
        },
      });
      registerCatalog(product, {
        connection,
        service : 'service-product',
        health  : require('../server/library/messaging/health'),
        catalog : createCatalog({
          messaging : product,
          services,
        }),
      });
      await runtimes[0].start({ connection });
      await runtimes[1].start({ connection });
      const context = {
        user      : { userCode: 'local-user' },
        workspace : 'workspace-a',
        policies  : ['product.item.create.global', 'product.item.view.global'],
      };
      const created = await caller.request(
        'service-product',
        'product-item-create',
        {
          name            : 'Servicio local',
          description     : '',
          descriptionHtml : '<p>Texto <strong>RPC</strong></p>',
          type            : 'service',
          mode            : 'simple',
          sku             : 'LOCAL-1',
          categoryCode    : '',
          attributeCodes  : [],
          fiscal          : {},
          active          : true,
        },
        { context },
      );
      assert.equal(created.statusCode, 201);
      assert.equal(created.data.description, 'Texto RPC');
      assert.equal(created.data.descriptionHtml, '<p>Texto <strong>RPC</strong></p>');
      const plainDescription = await caller.request(
        'service-product',
        'product-item-get-one',
        { code: created.data.code },
        { context },
      );
      assert.equal(Object.hasOwn(plainDescription.data, 'descriptionHtml'), false);
      const rich = await caller.request(
        'service-product',
        'product-item-get-one',
        {
          code                   : created.data.code,
          includeDescriptionHtml : true,
        },
        { context },
      );
      assert.equal(rich.data.descriptionHtml, created.data.descriptionHtml);
      assert.match(created.data.code, /^PRO-/);
      const deadline = Date.now() + 10000;
      while (
        (!events.some(
          /** @param {Object} event Hecho recibido. @returns {boolean} Artículo creado. */
          (event) => event.data.resource === 'item',
        ) ||
          !timelineEvents.length) &&
        Date.now() < deadline
      )
        await new Promise(
          /** @param {Function} resolve Continuación. @returns {void} Espera brevemente la entrega del outbox. */
          (resolve) => setTimeout(resolve, 20),
        );
      assert.deepEqual(
        events.find(
          /** @param {Object} event Hecho acreditado. @returns {boolean} Cambio del artículo. */
          (event) => event.data.resource === 'item',
        ),
        {
          originService : 'service-product',
          data          : {
            resource  : 'item',
            code      : created.data.code,
            revision  : created.data.revision,
            workspace : 'allWorkspaces',
            erased    : false,
          },
        },
      );
      assert.equal(timelineEvents.length, 1);
      assert.equal(timelineEvents[0].originService, 'service-product');
      assert.equal(timelineEvents[0].data.workspace, 'allWorkspaces');
      assert.equal(timelineEvents[0].data.subject.code, created.data.code);
      assert.equal(timelineEvents[0].data.eventType, 'product.item.created');
      const access = await caller.request(
        'service-product',
        'resource-access-check',
        {
          references : [
            {
              domain : 'item',
              code   : created.data.code,
            },
          ],
        },
        { context },
      );
      assert.deepEqual(access.data.items, [
        {
          domain    : 'item',
          code      : created.data.code,
          allowed   : true,
          workspace : 'allWorkspaces',
        },
      ]);
      const read = await caller.request(
        'service-product',
        'product-item-get-list',
        {
          page    : 1,
          perPage : 1,
        },
        { context },
      );
      assert.equal(read.statusCode, 200);
      assert.equal(read.data.items[0].code, created.data.code);
      const matrix = await caller.request(
        'service-product',
        'product-price-matrix-get-list',
        {
          page          : 1,
          perPage       : 20,
          variantActive : true,
        },
        {
          context : {
            ...context,
            policies : [
              ...context.policies,
              'product.price.view.global',
              'product.sku.view.global',
              'product.price-list.view.global',
            ],
          },
        },
      );
      assert.equal(matrix.statusCode, 200);
      assert.equal(matrix.data.items[0].variant.code, created.data.simpleSkuCode);
      assert.deepEqual(matrix.data.items[0].prices, []);
      assert.deepEqual(matrix.data.priceLists, []);
      const matrixDenied = await caller.request(
        'service-product',
        'product-price-matrix-get-list',
        {},
        { context },
      );
      assert.equal(matrixDenied.statusCode, 403);
      const denied = await caller.request(
        'service-product',
        'product-item-get-list',
        {},
        {
          context : {
            ...context,
            policies : [],
          },
        },
      );
      assert.equal(denied.statusCode, 403);
      const invalid = await caller.request(
        'service-product',
        'product-item-get-list',
        { consumer: 'billing' },
        { context },
      );
      assert.equal(invalid.statusCode, 400);
      const discovery = await caller.request(
        'service-product',
        'service-contracts-get',
        {},
        { context },
      );
      assert.equal(discovery.data.service, 'service-product');
    } finally {
      for (const runtime of runtimes.reverse()) await runtime.close();
      try {
        await broker?.stop();
      } finally {
        await database?.stop();
      }
    }
  },
);
