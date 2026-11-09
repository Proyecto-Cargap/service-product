/** @file Persistencia MongoDB del catálogo con unicidad, revisión, outbox y limpieza cercada. */
'use strict';
const { ApplicationError }      = require('../../../shared/application-error');
const { productResourceChange } = require('../presenters/product-change.presenter');
const RESOURCES                 = ['item', 'sku', 'category', 'attribute', 'price-list', 'price', 'assignment'];
/** @param {Object|null} document Documento técnico. @returns {Object|null} Registro plano independiente del driver. */
function plain(document) {
  if (!document) return null;
  const result = { ...document };
  delete result._id;
  return result;
}
/** @param {Object} dependencies Base abierta, cliente y sesión opcional. @returns {Object} Puerto cuyo trabajo transaccional sólo realiza persistencia repetible. */
function createProductStore({ db, client, publish, session }) {
  if (typeof publish !== 'function') throw new TypeError('PRODUCT_EVENT_PUBLISHER_REQUIRED');
  const options = session ? { session } : {};
  const jobs    = db.collection('PRODUCT_IMAGE_JOB');
  /** @param {string} resource Recurso canónico. @returns {Object} Colección propia. */
  function collection(resource) {
    if (!RESOURCES.includes(resource)) throw new TypeError('PRODUCT_RESOURCE_INVALID');
    return db.collection('PRODUCT_' + resource.replaceAll('-', '_').toUpperCase());
  }
  /** @param {string} resource Recurso. @param {Object} filter Selector autorizado. @returns {Object} Excluye retirados sin exigir migración a registros anteriores. */
  function visible(resource, filter) {
    return ['sku', 'attribute', 'price', 'price-list'].includes(resource)
      ? {
          ...filter,
          erased : { $ne: true },
        }
      : filter;
  }
  /** @param {string} resource Recurso. @param {Object} record Estado confirmado. @param {Object|null} previous Estado anterior. @returns {Promise<void>} Persiste la causa con la misma sesión de negocio; el fallo revierte toda la escritura. */
  async function changed(resource, record, previous = null) {
    if (!session) throw new TypeError('PRODUCT_EVENT_TRANSACTION_REQUIRED');
    const sku =
      resource === 'price'
        ? await collection('sku').findOne({ code: record.skuCode }, options)
        : null;
    await publish(
      'product.resource.changed',
      productResourceChange(resource, record, previous, sku?.itemCode),
      { session },
    );
  }
  return {
    /** @returns {Promise<number|undefined>} Próxima limpieza o recuperación de lease, sin cargar archivos. */
    async nextImageAt() {
      const row = await jobs.findOne(
        {},
        {
          projection : { availableAt: 1 },
          sort       : { availableAt: 1 },
        },
      );
      return row?.availableAt;
    },
    /** @param {string} code Clave opaca de la operación. @returns {Promise<Object|null>} Recibo confirmado dentro de la unidad vigente. */
    async receiptRead(code) {
      const row = await db.collection('PRODUCT_OPERATION_RECEIPT').findOne({ code }, options);
      if (!row) return null;
      return {
        code        : row.code,
        fingerprint : row.fingerprint,
        result      : row.result,
      };
    },
    /** @param {Object} record Resultado y huella. @returns {Promise<void>} El índice único arbitra llamadas concurrentes. */
    async receiptInsert(record) {
      await db.collection('PRODUCT_OPERATION_RECEIPT').insertOne({ ...record }, options);
    },
    /** @param {Object} filter Ámbito autorizado de variantes. @param {Object} query Página y estado opcional de variante. @returns {Promise<Object>} Catálogo completo y página de SKU con precios; no realiza lecturas por celda. */
    async listPriceMatrix(filter, query = {}) {
      const page = query.page || 1,
        perPage  = query.perPage || 20;
      const priceLists = await collection('price-list')
        .find({ workspace: filter.workspace }, options)
        .sort({
          creationDate : -1,
          code         : 1,
        })
        .toArray();
      const pages      = await collection('sku')
        .aggregate(
          [
            {
              $match : {
                ...filter,
                erased : { $ne: true },
                ...(query.variantActive === undefined ? {} : { active: query.variantActive }),
              },
            },
            {
              $sort : {
                creationDate : -1,
                code         : 1,
              },
            },
            {
              $facet : {
                count : [{ $count: 'total' }],
                items : [
                  { $skip: (page - 1) * perPage },
                  { $limit: perPage },
                  {
                    $lookup : {
                      from         : 'PRODUCT_PRICE',
                      localField   : 'code',
                      foreignField : 'skuCode',
                      pipeline     : [
                        {
                          $match : {
                            workspace : filter.workspace,
                            erased    : { $ne: true },
                          },
                        },
                      ],
                      as           : 'prices',
                    },
                  },
                  {
                    $project : {
                      _id     : 0,
                      variant : '$$ROOT',
                      prices  : 1,
                    },
                  },
                ],
              },
            },
          ],
          options,
        )
        .toArray();
      const result     = pages[0];
      return {
        priceLists,
        items      : result.items,
        pagination : {
          page,
          perPage,
          total : result.count[0]?.total || 0,
        },
      };
    },
    /** @param {string} name Evento canónico. @param {Object} data Hecho comercial. @returns {Promise<Object>} Publicación durable en la misma transacción, sin contexto privilegiado. */
    emit(name, data) {
      if (!session) throw new TypeError('PRODUCT_TIMELINE_TRANSACTION_REQUIRED');
      return publish(name, data, {
        session,
        publicationId : data.eventId,
        context       : {},
      });
    },
    /** @param {string} code Artículo autorizado. @param {Object} query Página del conjunto completo. @returns {Promise<Object>} Precios y referencias de todas sus unidades, sin truncar variantes. */
    async listItemPrices(code, query = {}) {
      const page = query.page || 1,
        perPage  = query.perPage || 10;
      const [result] = await collection('sku')
        .aggregate(
          [
            {
              $match : {
                itemCode  : code,
                workspace : 'allWorkspaces',
                erased    : { $ne: true },
              },
            },
            {
              $lookup : {
                from         : 'PRODUCT_PRICE',
                localField   : 'code',
                foreignField : 'skuCode',
                as           : 'prices',
              },
            },
            { $unwind: '$prices' },
            {
              $match : {
                'prices.workspace' : 'allWorkspaces',
                'prices.erased'    : { $ne: true },
              },
            },
            {
              $sort : {
                'prices.creationDate' : -1,
                'prices.code'         : 1,
              },
            },
            {
              $facet : {
                count : [{ $count: 'total' }],
                items : [
                  { $skip: (page - 1) * perPage },
                  { $limit: perPage },
                  {
                    $lookup : {
                      from         : 'PRODUCT_PRICE_LIST',
                      localField   : 'prices.priceListCode',
                      foreignField : 'code',
                      as           : 'lists',
                    },
                  },
                  {
                    $project : {
                      _id         : 0,
                      record      : '$prices',
                      variantName : '$name',
                      sku         : 1,
                      priceList   : { $arrayElemAt: ['$lists', 0] },
                    },
                  },
                ],
              },
            },
          ],
          options,
        )
        .toArray();
      return {
        items      : result.items,
        pagination : {
          page,
          perPage,
          total : result.count[0]?.total || 0,
        },
      };
    },
    /** @param {Object} filter Selector autorizado. @param {Object} query Paginación. @returns {Promise<Object>} Precios con nombres y moneda sin consultas por fila. */
    async listPrices(filter, query = {}) {
      const page = query.page || 1,
        perPage  = query.perPage || 20;
      const [result] = await collection('price')
        .aggregate(
          [
            { $match: visible('price', filter) },
            {
              $sort : {
                creationDate : -1,
                code         : 1,
              },
            },
            {
              $facet : {
                count : [{ $count: 'total' }],
                items : [
                  { $skip: (page - 1) * perPage },
                  { $limit: perPage },
                  {
                    $lookup : {
                      from         : 'PRODUCT_SKU',
                      localField   : 'skuCode',
                      foreignField : 'code',
                      as           : 'units',
                    },
                  },
                  {
                    $lookup : {
                      from         : 'PRODUCT_PRICE_LIST',
                      localField   : 'priceListCode',
                      foreignField : 'code',
                      as           : 'lists',
                    },
                  },
                  {
                    $project : {
                      _id       : 0,
                      record    : '$$ROOT',
                      variant   : { $arrayElemAt: ['$units', 0] },
                      priceList : { $arrayElemAt: ['$lists', 0] },
                    },
                  },
                ],
              },
            },
          ],
          options,
        )
        .toArray();
      return {
        items      : result.items,
        pagination : {
          page,
          perPage,
          total : result.count[0]?.total || 0,
        },
      };
    },
    /** @param {string} resource Recurso. @param {Object} filter Selector autorizado. @param {Object} read Opciones internas de acceso histórico. @returns {Promise<Object|null>} Ausencia real o registro. */
    async get(resource, filter, { includeErased = false } = {}) {
      return plain(
        await collection(resource).findOne(
          includeErased ? filter : visible(resource, filter),
          options,
        ),
      );
    },
    /** @param {string} resource Recurso. @param {Object} filter Selector. @param {Object} query Página acotada. @returns {Promise<Object>} Página estable con total del mismo ámbito. */
    async list(resource, filter, query = {}) {
      const page = query.page || 1,
        perPage  = query.perPage || 20;
      return {
        items      : (
          await collection(resource)
            .find(visible(resource, filter), options)
            .sort({
              creationDate : -1,
              code         : 1,
            })
            .skip((page - 1) * perPage)
            .limit(perPage)
            .toArray()
        ).map(plain),
        pagination : {
          page,
          perPage,
          total : await collection(resource).countDocuments(visible(resource, filter), options),
        },
      };
    },
    /** @param {string} resource Recurso. @param {Object} record Alta. @returns {Promise<void>} Unicidad acreditada por índices. */
    async insert(resource, record) {
      if (!session)
        return this.transaction(
          /** @param {Object} tx Unidad de trabajo. @returns {Promise<void>} Confirma artículo y aviso en la misma transacción. */
          (tx) => tx.insert(resource, record),
        );
      try {
        await collection(resource).insertOne({ ...record }, options);
      } catch (error) {
        if (error.code === 11000) throw new ApplicationError(409, 'PRODUCT_DUPLICATE');
        throw error;
      }
      await changed(resource, record);
    },
    /** @param {string} resource Recurso. @param {Object} previous Revisión observada. @param {Object} next Registro propuesto. @returns {Promise<void>} Escritura condicional sin pérdida de cambios. */
    async replace(resource, previous, next) {
      if (!session)
        return this.transaction(
          /** @param {Object} tx Unidad de trabajo. @returns {Promise<void>} Confirma revisión e invalidación juntas. */
          (tx) => tx.replace(resource, previous, next),
        );
      try {
        const result = await collection(resource).replaceOne(
          {
            code      : previous.code,
            workspace : previous.workspace,
            revision  : previous.revision,
          },
          { ...next },
          options,
        );
        if (result.matchedCount !== 1) throw new ApplicationError(409, 'PRODUCT_REVISION_CONFLICT');
      } catch (error) {
        if (error.code === 11000) throw new ApplicationError(409, 'PRODUCT_DUPLICATE');
        throw error;
      }
      await changed(resource, next, previous);
    },
    /** @param {string} resource Recurso referido. @param {string} code Código. @returns {Promise<void>} Serializa validaciones dependientes frente a cambios concurrentes. */
    async touch(resource, code) {
      const result = await collection(resource).updateOne(
        { code },
        { $inc: { _guard: 1 } },
        options,
      );
      if (!result.matchedCount) throw new ApplicationError(409, 'PRODUCT_REFERENCE_CHANGED');
    },
    /** @param {Function} work Trabajo sin red ni almacenamiento externo. @returns {Promise<*>} Confirmación atómica o rollback. */
    async transaction(work) {
      if (session) return work(this);
      const owned = client.startSession();
      try {
        return await owned.withTransaction(
          /** @returns {Promise<*>} Reintento seguro de persistencia local. */
          () =>
            work(
              createProductStore({
                db,
                client,
                publish,
                session : owned,
              }),
            ),
          { readConcern: { level: 'snapshot' } },
        );
      } finally {
        await owned.endSession();
      }
    },
    /** @param {Object} job Reserva previa al efecto externo. @returns {Promise<void>} Un fileId sólo puede pertenecer a una carga. */
    async stageImage(job) {
      try {
        await jobs.insertOne({ ...job }, options);
      } catch (error) {
        if (error.code === 11000) throw new ApplicationError(409, 'PRODUCT_IMAGE_ALREADY_RESERVED');
        throw error;
      }
    },
    /** @param {string} fileId Archivo reservado. @param {number} now Reloj. @returns {Promise<void>} Adopta sólo una reserva vigente sin limpieza en curso. */
    async adoptImage(fileId, now) {
      const result = await jobs.deleteOne(
        {
          fileId,
          status      : 'pending',
          availableAt : { $gt: now },
        },
        options,
      );
      if (result.deletedCount !== 1) throw new ApplicationError(409, 'PRODUCT_IMAGE_EXPIRED');
    },
    /** @param {Object} job Archivo sustituido. @returns {Promise<void>} Encola la limpieza dentro de la escritura del artículo. */
    async queueImage(job) {
      await jobs.updateOne(
        { fileId: job.fileId },
        {
          $setOnInsert : {
            ...job,
            status : 'pending',
          },
        },
        {
          ...options,
          upsert : true,
        },
      );
    },
    /** @param {number} now Reloj. @returns {Promise<Object|null>} Reclamo cercado; recupera trabajadores interrumpidos. */
    async claimImage(now) {
      return jobs.findOneAndUpdate(
        { availableAt: { $lte: now } },
        {
          $set : {
            status      : 'cleaning',
            availableAt : now + 360000,
          },
          $inc : { fence: 1 },
        },
        {
          returnDocument : 'after',
          sort           : { availableAt: 1 },
        },
      );
    },
    /** @param {Object} job Reclamo vigente. @returns {Promise<void>} No borra un reclamo posterior. */
    async finishImage(job) {
      await jobs.deleteOne({
        fileId : job.fileId,
        fence  : job.fence,
      });
    },
    /** @param {Object} job Reclamo. @param {number} at Próximo intento. @returns {Promise<void>} Conserva evidencia ante indisponibilidad. */
    async retryImage(job, at) {
      await jobs.updateOne(
        {
          fileId : job.fileId,
          fence  : job.fence,
        },
        { $set: { availableAt: at } },
      );
    },
  };
}
module.exports = { createProductStore };
