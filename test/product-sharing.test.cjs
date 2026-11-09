/** @file Casos comerciales de galerías y fichas compartidas sin red ni credenciales. */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  productImageService,
} = require('../server/modules/product/services/product-images.service');
const {
  productPresentation,
} = require('../server/modules/product/services/product-presentation.service');
const { migrateGalleries } = require('../ops/migrate-product-galleries.cjs');
/** @returns {Object} Colaboradores mínimos y registros verificables. */
function fixture() {
  const image = {
    fileId   : 'photo',
    name     : 'producto.png',
    mimeType : 'image/png',
    size     : 200,
  };
  const data  = {
    item         : {
      code           : 'item',
      name           : 'Camisa',
      description    : 'Algodón',
      type           : 'product',
      mode           : 'variants',
      categoryCode   : 'category',
      attributeCodes : ['attribute'],
      active         : true,
      revision       : 1,
      images         : [image],
      image,
    },
    category     : {
      code     : 'category',
      name     : 'Ropa',
      revision : 1,
      active   : true,
    },
    attribute    : {
      code     : 'attribute',
      name     : 'Talla',
      revision : 1,
      active   : true,
    },
    'price-list' : {
      code     : 'list',
      name     : 'Público',
      currency : 'MXN',
      revision : 1,
      active   : true,
    },
    sku          : {
      code       : 'sku',
      itemCode   : 'item',
      name       : 'Mediana',
      sku        : 'CAM-M',
      selections : [
        {
          attributeCode : 'attribute',
          value         : 'M',
        },
      ],
      revision   : 1,
      active     : true,
    },
  };
  const jobs = [],
    removed  = [];
  const store   = {
    /** @param {Function} work Trabajo. @returns {Promise<*>} Misma unidad lógica. */
    async transaction(work) {
      return work(store);
    },
    /** @param {string} resource Recurso. @returns {Promise<Object|null>} Referencia o precio ausente. */
    async get(resource) {
      return data[resource] || null;
    },
    /** @param {string} resource Recurso. @param {Object} filter Ámbito. @param {Object} query Página. @returns {Promise<Object>} Dos páginas de variantes activas. */
    async list(resource, filter, query) {
      return {
        items      : [
          {
            ...data.sku,
            code : 'sku-' + query.page,
          },
        ],
        pagination : { total: 2 },
      };
    },
    /** @returns {Promise<void>} Registra carga temporal. */
    async stageImage() {},
    /** @returns {Promise<void>} Adopta la carga. */
    async adoptImage() {},
    /** @param {string} resource Recurso. @param {Object} previous Anterior. @param {Object} next Nuevo. @returns {Promise<void>} Conserva revisión. */
    async replace(resource, previous, next) {
      data[resource] = next;
    },
    /** @param {Object} job Limpieza. @returns {Promise<void>} Retención durable. */
    async queueImage(job) {
      jobs.push(job);
    },
    /** @returns {Promise<Object|undefined>} Trabajo pendiente. */
    async claimImage() {
      return jobs.shift();
    },
    /** @returns {Promise<void>} Finaliza el trabajo. */
    async finishImage() {},
    /** @returns {Promise<void>} Conserva reintento. */
    async retryImage() {},
  };
  const records = {
    /** @param {string} resource Recurso. @returns {Promise<Object>} Lectura acreditada por el doble. */
    async get(resource) {
      return data[resource];
    },
    /** @param {Object} record Registro. @param {number} revision Revisión. @returns {void} Rechaza cambios concurrentes. */
    match(record, revision) {
      if (record.revision !== revision) throw new Error('CONFLICT');
    },
    /** @returns {Promise<void>} Evento del cambio. */
    async timeline() {},
  };
  const files   = {
    /** @param {Object} upload Archivo nuevo. @returns {Promise<Object>} Metadatos acreditados. */
    async upload(upload) {
      return {
        ...image,
        fileId : upload.fileId,
      };
    },
    /** @param {Object} owner Propietario. @param {string} id Archivo. @returns {Promise<Object>} Referencia de descarga. */
    async read(owner, id) {
      return {
        owner,
        id,
      };
    },
    /** @param {Object} job Archivo retirado. @returns {Promise<void>} Registra eliminación. */
    async remove(job) {
      removed.push(job.fileId);
    },
  };
  /** @returns {Object} Identidad de prueba con lectura de catálogos. */
  const context = () => ({
    user     : { userCode: 'user' },
    policies : ['item', 'sku', 'category', 'attribute', 'price-list', 'price'].map(
      /** @param {string} resource Recurso. @returns {string} Permiso concreto. */
      (resource) => `product.${resource}.view.global`,
    ),
  });
  /** @returns {number} Reloj determinista. */
  const clock   = () => 100;
  return {
    data,
    jobs,
    removed,
    store,
    records,
    files,
    context,
    clock,
  };
}
test('galería conserva fotos, cambia portada y elimina sólo archivos retirados' /** @returns {Promise<void>} Comprueba conservación y limpieza diferida. */, async () => {
  const f = fixture(),
    api   = productImageService(f);
  let item = await api.setGallery('item', {
    code          : 'item',
    revision      : 1,
    fileIds       : ['photo', 'new'],
    pictureUpload : { fileId: 'new' },
  });
  assert.equal(item.images.length, 2);
  item = await api.setGallery('item', {
    code     : 'item',
    revision : 2,
    fileIds  : ['new', 'photo'],
  });
  assert.equal(item.image.fileId, 'new');
  assert.equal(f.jobs.length, 0);
  await assert.rejects(
    api.setGallery('item', {
      code     : 'item',
      revision : 1,
      fileIds  : [],
    }),
    /CONFLICT/,
  );
  await assert.rejects(
    api.setGallery('item', {
      code     : 'item',
      revision : 3,
      fileIds  : ['foreign'],
    }),
  );
  await api.setGallery('item', {
    code     : 'item',
    revision : 3,
    fileIds  : ['new'],
  });
  await api.tick({
    /** @returns {boolean} Permite consumir trabajos disponibles. */
    shouldStop : () => false,
  });
  assert.deepEqual(f.removed, ['photo']);
});
test('ficha incluye todas las páginas, etiquetas, moneda y precios por confirmar' /** @returns {Promise<void>} Comprueba el contenido y su referencia de revisión. */, async () => {
  const f   = fixture(),
    resolve = productPresentation(f);
  const first = await resolve({
    itemCode      : 'item',
    priceListCode : 'list',
  });
  assert.equal(first.variants.length, 2);
  assert.match(first.text, /Talla: M/);
  assert.match(first.text, /Precio por confirmar/);
  assert.equal(first.currency, 'MXN');
  assert.equal(first.images[0].fileId, 'photo');
  f.data.item.revision++;
  assert.notEqual(
    (
      await resolve({
        itemCode      : 'item',
        priceListCode : 'list',
      })
    ).revisionKey,
    first.revisionKey,
  );
  await assert.rejects(
    resolve({
      itemCode      : 'item',
      priceListCode : 'list',
      imageIds      : ['foreign'],
    }),
  );
  f.data['price-list'].active = false;
  await assert.rejects(
    resolve({
      itemCode      : 'item',
      priceListCode : 'list',
    }),
  );
});
test('migración simula por defecto y aplica el mismo filtro idempotente' /** @returns {Promise<void>} No duplica archivos ni modifica sin --apply. */, async () => {
  let writes = 0;
  const db   = {
    /** @returns {Object} Colección sustituible. */
    collection() {
      return {
        /** @param {Object} filter Pendientes. @returns {Promise<number>} Cantidad. */
        async countDocuments(filter) {
          assert.deepEqual(filter, { images: { $exists: false } });
          return 2;
        },
        /** @param {Object} filter Pendientes. @param {Object[]} update Operación. @returns {Promise<Object>} Escritura acreditada. */
        async updateMany(filter, update) {
          assert.deepEqual(filter, { images: { $exists: false } });
          assert.ok(update[0].$set.images);
          writes++;
          return { modifiedCount: 2 };
        },
      };
    },
  };
  await migrateGalleries(db);
  assert.equal(writes, 0);
  await migrateGalleries(db, true);
  assert.equal(writes, 2);
});

test(
  'migración real conserva referencias y no modifica registros en la segunda ejecución',
  { skip: !process.env.TEST_MONGOD_BINARY },
  /** @returns {Promise<void>} Ejecuta simulación y aplicación sólo en MongoDB efímero. */
  async () => {
    const { startIsolatedMongo } = require('./helpers/isolated-mongo.cjs');
    const mongo                  = await startIsolatedMongo({
      binary   : process.env.TEST_MONGOD_BINARY,
      mongoose : require('mongoose'),
    });
    try {
      const db = mongo.connection.db,
        image  = {
          fileId   : 'existing',
          name     : 'Original.png',
          mimeType : 'image/png',
          size     : 42,
        };
      await db.collection('PRODUCT_ITEM').insertMany([
        {
          code     : 'legacy',
          image,
          revision : 4,
        },
        {
          code     : 'empty',
          revision : 1,
        },
        {
          code     : 'migrated',
          image,
          images   : [image],
          revision : 3,
        },
      ]);
      assert.equal((await migrateGalleries(db)).PRODUCT_ITEM.pending, 2);
      assert.equal(
        (await db.collection('PRODUCT_ITEM').findOne({ code: 'legacy' })).images,
        undefined,
      );
      assert.equal((await migrateGalleries(db, true)).PRODUCT_ITEM.modified, 2);
      assert.equal((await migrateGalleries(db, true)).PRODUCT_ITEM.modified, 0);
      const saved = await db.collection('PRODUCT_ITEM').findOne({ code: 'legacy' });
      assert.deepEqual(saved.images, [image]);
      assert.equal(saved.revision, 4);
    } finally {
      await mongo.stop();
    }
  },
);

test('variantes sin galería heredan fotos y los permisos no se amplían al resolver una ficha' /** @returns {Promise<void>} Comprueba propietario efectivo y rechazo de acceso sin permisos. */, async () => {
  const fixtureData = fixture(),
    images          = productImageService(fixtureData);
  const inherited = await images.get('sku', {
    code   : 'sku',
    fileId : 'photo',
  });
  assert.deepEqual(inherited.owner, {
    resource : 'item',
    code     : 'item',
  });
  await assert.rejects(
    images.get('sku', {
      code   : 'sku',
      fileId : 'foreign',
    }),
    { descriptionCode: 'PRODUCT_IMAGE_NOT_FOUND' },
  );
  const resolve = productPresentation({
    ...fixtureData,
    /** @returns {Object} Identidad sin acceso al catálogo. */
    context : () => ({
      user     : { userCode: 'user' },
      policies : [],
    }),
  });
  await assert.rejects(
    resolve({
      itemCode      : 'item',
      priceListCode : 'list',
    }),
  );
});
