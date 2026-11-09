/** @file Casos de uso del catálogo global; reglas de variantes y precios con validación transaccional. */
'use strict';
const { ApplicationError }        = require('../../../shared/application-error');
const { access, customerAccess }  = require('../policies/product-access.policy');
const { present }                 = require('../presenters/product.presenter');
const { emitTimelineChange }      = require('./timeline-events.service');
const { updateVariantAttributes } = require('./product-variant-attributes.service');
/** @param {Object} dependencies Puertos mínimos, contexto, reloj e identificadores. @returns {Object} Consultas y escrituras autorizadas del catálogo. */
function productRecords({
  store,
  references,
  fiscal,
  context,
  clock,
  identifier,
  digest,
  normalizeDescription,
  readingSnapshot = false,
}) {
  /** @param {string} resource Recurso. @param {Object} actor Identidad acreditada. @returns {Object} Metadatos generados en el servidor. */
  function metadata(resource, actor) {
    return {
      code         : identifier(resource),
      workspace    : resource === 'assignment' ? actor.workspace : 'allWorkspaces',
      userCreate   : actor.user.userCode,
      creationDate : clock(),
      updateDate   : clock(),
      revision     : 1,
    };
  }
  /** @param {Object} tx Unidad transaccional. @param {Object} actor Identidad acreditada. @param {string} resource Recurso. @param {Object} record Estado nuevo. @param {Object|null} previous Estado anterior. @returns {Promise<void>} Publica el hecho comercial en el outbox atómico. */
  function timeline(tx, actor, resource, record, previous) {
    return emitTimelineChange(tx, actor, resource, record, previous, identifier);
  }
  /** @param {string} resource Recurso. @param {string} code Código. @param {string} action Acción. @param {Object} actor Contexto. @param {Object} source Puerto. @param {boolean} includeErased Permite sólo la autorización histórica y reintentos de retirada. @returns {Promise<Object>} Registro autorizado. */
  async function get(
    resource,
    code,
    action = 'view',
    actor = context(),
    source = store,
    includeErased = false,
  ) {
    const result = await source.get(
      resource,
      {
        ...access(actor, resource, action),
        code,
      },
      { includeErased },
    );
    if (!result) throw new ApplicationError(404, 'PRODUCT_NOT_FOUND');
    if (resource === 'assignment')
      customerAccess(actor, await references.customer(result.customerCode), action !== 'view');
    return result;
  }

  /** @param {string} resource Recurso. @param {string} action Acción. @param {Object} input Datos originales. @param {string} name Operación canónica. @returns {Object} Recibo atómico con autorización del estado vigente. */
  function receipt(resource, action, input, name = action) {
    const actor = context();
    access(actor, resource, action);
    return require('./operation-receipt.service').operationReceipt({
      store,
      actor,
      action : resource + '-' + name,
      input,
      digest,
      /** @param {Object} result Resultado original, posiblemente compuesto. @returns {Promise<void>} No devuelve datos de una asignación cuyo acceso fue retirado. */
      async authorize(result) {
        await get(resource, (result.item || result).code, action, actor, store, true);
        if (Array.isArray(input.prices))
          for (const price of input.prices)
            access(actor, 'price', price.code ? 'update' : 'create');
      },
    });
  }
  /** @param {Object} current Estado observado. @param {number} revision Revisión esperada. @returns {void} Rechaza sobrescritura. */
  function match(current, revision) {
    if (current.revision !== revision) throw new ApplicationError(409, 'PRODUCT_REVISION_CONFLICT');
  }
  /** @param {Object} tx Persistencia. @param {string} resource Recurso referido. @param {string} code Código. @param {boolean} requireActive Requiere vigencia para una referencia habilitada. @returns {Promise<Object>} Referencia cuya modificación se serializa con esta escritura. */
  async function active(tx, resource, code, requireActive = true) {
    const record = await tx.get(resource, {
      code,
      workspace : 'allWorkspaces',
      ...(requireActive ? { active: true } : {}),
    });
    if (!record) throw new ApplicationError(409, 'PRODUCT_REFERENCE_INACTIVE');
    await tx.touch(resource, code);
    return record;
  }
  /** @param {string} resource Tipo. @param {Object} data Campos validados por DTO. @param {Object} actor Contexto. @returns {Promise<Object>} Entrada normalizada antes de abrir la transacción. */
  async function prepare(resource, data, actor) {
    const result = { ...data };
    delete result.code;
    delete result.revision;
    delete result.idempotencyKey;
    for (const key of ['name', 'description', 'sku'])
      if (typeof result[key] === 'string') result[key] = result[key].trim();
    if (Object.hasOwn(result, 'name') && !result.name)
      throw new ApplicationError(400, 'PRODUCT_NAME_REQUIRED');
    if (typeof result.sku === 'string') result.sku = result.sku.toUpperCase();
    if (resource === 'item') {
      if (Object.hasOwn(result, 'descriptionHtml'))
        Object.assign(result, normalizeDescription(result.descriptionHtml));
      if (result.mode === 'simple' && !result.sku)
        throw new ApplicationError(400, 'PRODUCT_SKU_REQUIRED');
      if (
        (result.mode === 'simple' && result.attributeCodes.length) ||
        (result.mode === 'variants' && (!result.attributeCodes.length || result.sku))
      )
        throw new ApplicationError(400, 'PRODUCT_MODE_INVALID');
      if (new Set(result.attributeCodes).size !== result.attributeCodes.length)
        throw new ApplicationError(400, 'PRODUCT_ATTRIBUTE_DUPLICATE');
      await fiscal(result.fiscal);
    }
    if (resource === 'sku' && !result.sku) throw new ApplicationError(400, 'PRODUCT_SKU_REQUIRED');
    if (resource === 'attribute') {
      result.values = result.values.map(
        /** @param {string} value Opción del atributo. @returns {string} Valor normalizado. */
        (value) => value.trim(),
      );
      if (
        result.values.some(
          /** @param {string} value Opción. @returns {boolean} Detecta valores vacíos. */
          (value) => !value,
        ) ||
        new Set(result.values).size !== result.values.length
      )
        throw new ApplicationError(400, 'PRODUCT_ATTRIBUTE_VALUES_INVALID');
    }
    if (resource === 'price-list') {
      result.currency = result.currency.toUpperCase();
      if (result.currency === 'XXX') throw new ApplicationError(400, 'PRODUCT_CURRENCY_INVALID');
      await references.values([
        {
          kind : 'currency',
          code : result.currency,
        },
      ]);
    }
    if (resource === 'assignment')
      customerAccess(actor, await references.customer(result.customerCode), true);
    return result;
  }
  /** @param {Object} tx Transacción. @param {string} resource Recurso. @param {Object} record Candidato. @param {Object|null} previous Estado anterior. @param {Object} actor Contexto. @param {boolean} hasDescriptionHtml La escritura aporta HTML explícito. @returns {Promise<void>} Invariantes y referencias acreditadas sin red. */
  async function validate(tx, resource, record, previous, actor, hasDescriptionHtml = false) {
    if (resource === 'item') {
      if (previous && !hasDescriptionHtml && record.description !== previous.description)
        delete record.descriptionHtml;
      if (previous && (previous.type !== record.type || previous.mode !== record.mode))
        throw new ApplicationError(409, 'PRODUCT_STRUCTURE_IMMUTABLE');
      if (
        previous &&
        (previous.attributeCodes.length !== record.attributeCodes.length ||
          previous.attributeCodes.some(
            /** @param {string} code Eje anterior. @returns {boolean} Detecta sustitución o retirada sin confundir un cambio de orden. */
            (code) => !record.attributeCodes.includes(code),
          ))
      ) {
        await updateVariantAttributes(tx, record, previous, actor, clock, timeline);
      }
      if (record.categoryCode && (!previous || previous.categoryCode !== record.categoryCode))
        await active(tx, 'category', record.categoryCode);
      for (const code of record.attributeCodes)
        if (!previous || !previous.attributeCodes.includes(code))
          await active(tx, 'attribute', code);
      if (record.mode === 'simple') {
        const oldSku = previous ? await tx.get('sku', { code: previous.simpleSkuCode }) : null;
        const sku    = {
          ...(oldSku || metadata('sku', actor)),
          itemCode    : record.code,
          sku         : record.sku,
          name        : record.name,
          selections  : [],
          combination : '',
          active      : record.active,
        };
        if (oldSku) {
          sku.revision++;
          sku.updateDate = clock();
          await tx.replace('sku', oldSku, sku);
        } else await tx.insert('sku', sku);
        record.simpleSkuCode = sku.code;
      }
    }
    if (resource === 'sku') {
      if (previous && previous.itemCode !== record.itemCode)
        throw new ApplicationError(409, 'PRODUCT_STRUCTURE_IMMUTABLE');
      const item = await active(tx, 'item', record.itemCode);
      if (item.mode !== 'variants')
        throw new ApplicationError(409, 'PRODUCT_SIMPLE_SKU_MANAGED_BY_ITEM');
      const selected = new Map();
      for (const selection of record.selections) {
        if (
          selected.has(selection.attributeCode) ||
          !item.attributeCodes.includes(selection.attributeCode)
        )
          throw new ApplicationError(400, 'PRODUCT_COMBINATION_INVALID');
        const attribute = await tx.get('attribute', {
          code : selection.attributeCode,
        });
        if (!attribute || !attribute.values.includes(selection.value))
          throw new ApplicationError(400, 'PRODUCT_COMBINATION_INVALID');
        if (
          !attribute.active &&
          (!previous || JSON.stringify(previous.selections) !== JSON.stringify(record.selections))
        )
          throw new ApplicationError(409, 'PRODUCT_REFERENCE_INACTIVE');
        await tx.touch('attribute', attribute.code);
        selected.set(attribute.code, selection.value);
      }
      if (selected.size !== item.attributeCodes.length)
        throw new ApplicationError(400, 'PRODUCT_COMBINATION_INVALID');
      record.combination = JSON.stringify([...selected].sort());
    }
    if (resource === 'attribute' && previous) {
      for (const value of previous.values)
        if (
          !record.values.includes(value) &&
          (await tx.get('sku', {
            selections : {
              $elemMatch : {
                attributeCode : record.code,
                value,
              },
            },
          }))
        )
          throw new ApplicationError(409, 'PRODUCT_ATTRIBUTE_IN_USE');
    }
    if (resource === 'price-list' && previous && previous.currency !== record.currency)
      throw new ApplicationError(409, 'PRODUCT_CURRENCY_IMMUTABLE');
    if (resource === 'price') {
      if (
        previous &&
        (previous.skuCode !== record.skuCode || previous.priceListCode !== record.priceListCode)
      )
        throw new ApplicationError(409, 'PRODUCT_PRICE_IDENTITY_IMMUTABLE');
      await active(tx, 'price-list', record.priceListCode, record.active);
      const sku = await active(tx, 'sku', record.skuCode, record.active);
      await active(tx, 'item', sku.itemCode, record.active);
    }
    if (resource === 'assignment') {
      if (previous && previous.customerCode !== record.customerCode)
        throw new ApplicationError(409, 'PRODUCT_ASSIGNMENT_IDENTITY_IMMUTABLE');
      await active(tx, 'price-list', record.priceListCode, record.active);
    }
  }
  const api = {
    get,
    /** @param {Object} query Página de variantes y estado opcional. @returns {Promise<Object>} Matriz autorizada; una referencia ausente nunca se convierte en un precio vacío. */
    async priceMatrix(query) {
      const actor = context();
      access(actor, 'price', 'view');
      access(actor, 'price-list', 'view');
      const result = await store.listPriceMatrix(access(actor, 'sku', 'view'), query);
      const lists  = new Map(
        result.priceLists.map(
          /** @param {Object} list Lista histórica o vigente. @returns {Array} Referencia para distinguir retirada de corrupción. */
          (list) => [list.code, list],
        ),
      );
      return {
        priceLists : result.priceLists
          .filter(
            /** @param {Object} list Lista autorizada. @returns {boolean} Mantiene sólo el catálogo comercial. */
            (list) => !list.erased,
          )
          .map(
            /** @param {Object} list Lista vigente. @returns {Object} Proyección pública. */
            (list) => present('price-list', list),
          ),
        items      : result.items.map(
          /** @param {Object} row Variante y precios de la página. @returns {Object} Referencias acreditadas sin campos técnicos. */
          (row) => ({
            variant : present('sku', row.variant),
            prices  : row.prices
              .filter(
                /** @param {Object} price Precio existente. @returns {boolean} Excluye retirados y rechaza referencias inexistentes. */
                (price) => {
                  const list = lists.get(price.priceListCode);
                  if (!list || price.skuCode !== row.variant.code)
                    throw new ApplicationError(409, 'PRODUCT_REFERENCE_MISSING');
                  return !list.erased;
                },
              )
              .map(
                /** @param {Object} price Precio autorizado. @returns {Object} Proyección con revisión e importe decimal exacto. */
                (price) => present('price', price),
              ),
          }),
        ),
        pagination : result.pagination,
      };
    },
    /** @param {string} resource Recurso. @param {string} code Código histórico. @returns {Promise<Object>} Acredita acceso vigente conservando referencias retiradas. */
    reference(resource, code) {
      return get(resource, code, 'view', context(), store, true);
    },
    match,
    timeline,
    /** @param {string} resource Recurso. @param {Object} input Código. @returns {Promise<Object>} Proyección autorizada. */
    async getOne(resource, input) {
      return present(
        resource,
        await get(resource, input.code),
        input.includeDescriptionHtml === true,
      );
    },
    /** @param {string} resource Recurso. @param {Object} query Filtros cerrados. @returns {Promise<Object>} Página autorizada sin filtrado posterior. */
    async getList(resource, query) {
      const actor = context(),
        filter    = access(actor, resource, 'view');
      if (resource === 'assignment') {
        if (!query.customerCode) throw new ApplicationError(400, 'PRODUCT_CUSTOMER_REQUIRED');
        customerAccess(actor, await references.customer(query.customerCode), false);
      }
      for (const key of [
        'active',
        'itemCode',
        'categoryCode',
        'priceListCode',
        'skuCode',
        'customerCode',
        'currency',
        'type',
      ])
        if (query[key] !== undefined) filter[key] = query[key];
      if (query.search) {
        const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = ['code', 'name', 'sku'].map(
          /** @param {string} key Campo indexable. @returns {Object} Búsqueda literal sin operadores del cliente. */
          (key) => ({
            [key] : {
              $regex   : escaped,
              $options : 'i',
            },
          }),
        );
      }
      if (resource === 'price') {
        access(actor, 'sku', 'view');
        access(actor, 'price-list', 'view');
        const result = await store.listPrices(filter, query);
        return {
          ...result,
          items : result.items.map(
            /** @param {Object} row Precio y referencias. @returns {Object} Proyección comercial autorizada. */
            (row) => {
              if (
                !row.variant ||
                row.variant.workspace !== 'allWorkspaces' ||
                !row.priceList ||
                row.priceList.erased ||
                row.priceList.workspace !== 'allWorkspaces'
              )
                throw new ApplicationError(409, 'PRODUCT_REFERENCE_MISSING');
              return {
                ...present('price', row.record),
                variantName   : row.variant.name,
                priceListName : row.priceList.name,
                currency      : row.priceList.currency,
              };
            },
          ),
        };
      }
      const result = await store.list(resource, filter, query);
      return {
        ...result,
        items : result.items.map(
          /** @param {Object} item Registro. @returns {Object} Campos públicos. */
          (item) => present(resource, item),
        ),
      };
    },
    /** @param {Object} input Artículo y página solicitada. @returns {Promise<Object>} Precios de todas las unidades con referencias autorizadas. */
    async itemPrices(input) {
      const actor = context();
      for (const resource of ['price', 'sku', 'price-list']) access(actor, resource, 'view');
      await get('item', input.code, 'view', actor);
      const result = await store.listItemPrices(input.code, input);
      return {
        ...result,
        items : result.items.map(
          /** @param {Object} row Precio y referencias acreditadas. @returns {Object} Proyección explícita, incluida la moneda de su lista. */
          (row) => {
            if (
              !row.priceList ||
              row.priceList.erased ||
              row.priceList.workspace !== 'allWorkspaces'
            )
              throw new ApplicationError(409, 'PRODUCT_REFERENCE_MISSING');
            return {
              ...present('price', row.record),
              variantName   : row.variantName,
              sku           : row.sku,
              priceListName : row.priceList.name,
              currency      : row.priceList.currency,
            };
          },
        ),
      };
    },
    /** @param {Object} input Artículo, revisión y cambios de precios. @returns {Promise<Object>} Confirma datos y precios juntos; cualquier rechazo revierte escrituras, Timeline y outbox. */
    async saveItem(input) {
      const mutation = receipt('item', 'update', input, 'saveItem');
      const replayed = await mutation.replay();
      if (replayed !== undefined) return replayed;
      const actor = context();
      access(actor, 'item', 'update');
      const prepared = input.item ? await prepare('item', input.item, actor) : null;
      const changes  = [];
      const pairs = new Set(),
        codes     = new Set();
      for (const change of input.prices) {
        access(actor, 'price', change.code ? 'update' : 'create');
        const pair = JSON.stringify([change.skuCode, change.priceListCode]);
        if (pairs.has(pair) || (change.code && codes.has(change.code)))
          throw new ApplicationError(409, 'PRODUCT_DUPLICATE');
        pairs.add(pair);
        if (change.code) codes.add(change.code);
        changes.push({
          input    : change,
          prepared : await prepare('price', change, actor),
          initial  : change.code ? null : metadata('price', actor),
        });
      }
      return mutation.transaction(
        /** @param {Object} tx Transacción aislada. @returns {Promise<Object>} Revalida todas las revisiones y la pertenencia de cada precio al artículo. */
        async (tx) => {
          const previous = await get('item', input.code, 'update', actor, tx);
          match(previous, input.revision);
          const item = {
            ...previous,
            ...(prepared ? structuredClone(prepared) : {}),
            revision   : previous.revision + 1,
            updateDate : clock(),
          };
          if (prepared)
            await validate(
              tx,
              'item',
              item,
              previous,
              actor,
              Object.hasOwn(prepared, 'descriptionHtml'),
            );
          await tx.replace('item', previous, item);
          const prices = [];
          for (const change of changes) {
            const unit = await tx.get('sku', {
              code      : change.input.skuCode,
              itemCode  : item.code,
              workspace : 'allWorkspaces',
            });
            if (!unit) throw new ApplicationError(409, 'PRODUCT_PRICE_ITEM_MISMATCH');
            const old = change.input.code
              ? await get('price', change.input.code, 'update', actor, tx)
              : null;
            if (old) match(old, change.input.revision);
            const price = old
              ? {
                  ...old,
                  ...structuredClone(change.prepared),
                  revision   : old.revision + 1,
                  updateDate : clock(),
                }
              : {
                  ...structuredClone(change.prepared),
                  ...change.initial,
                };
            await validate(tx, 'price', price, old, actor);
            if (old) await tx.replace('price', old, price);
            else await tx.insert('price', price);
            await timeline(tx, actor, 'price', price, old);
            prices.push(present('price', price));
          }
          await timeline(tx, actor, 'item', item, previous);
          return {
            item : present('item', item, !!prepared && Object.hasOwn(prepared, 'descriptionHtml')),
            prices,
          };
        },
      );
    },
    /** @param {string} resource Recurso. @param {Object} data Alta. @returns {Promise<Object>} Alta y Timeline atómicas. */
    async create(resource, data) {
      const mutation = receipt(resource, 'create', data, 'create');
      const replayed = await mutation.replay();
      if (replayed !== undefined)
        return present(resource, replayed, Object.hasOwn(data, 'descriptionHtml'));
      const actor = context();
      access(actor, resource, 'create');
      const prepared = await prepare(resource, data, actor),
        initial      = metadata(resource, actor);
      const saved = await mutation.transaction(
        /** @param {Object} tx Unidad transaccional. @returns {Promise<Object>} Candidato nuevo por intento. */
        async (tx) => {
          const record = {
            ...structuredClone(prepared),
            ...initial,
          };
          await validate(
            tx,
            resource,
            record,
            null,
            actor,
            Object.hasOwn(prepared, 'descriptionHtml'),
          );
          await tx.insert(resource, record);
          await timeline(tx, actor, resource, record, null);
          return record;
        },
      );
      return present(resource, saved, Object.hasOwn(data, 'descriptionHtml'));
    },
    /** @param {string} resource Recurso. @param {Object} data Actualización completa con revisión. @returns {Promise<Object>} Escritura condicional y Timeline. */
    async update(resource, data) {
      const mutation = receipt(resource, 'update', data, 'update');
      const replayed = await mutation.replay();
      if (replayed !== undefined)
        return present(resource, replayed, Object.hasOwn(data, 'descriptionHtml'));
      const actor = context(),
        previous  = await get(resource, data.code, 'update', actor);
      match(previous, data.revision);
      const prepared = await prepare(resource, data, actor);
      const saved    = await mutation.transaction(
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Registro confirmado. */
        async (tx) => {
          const record = {
            ...previous,
            ...structuredClone(prepared),
            revision   : previous.revision + 1,
            updateDate : clock(),
          };
          await validate(
            tx,
            resource,
            record,
            previous,
            actor,
            Object.hasOwn(prepared, 'descriptionHtml'),
          );
          await tx.replace(resource, previous, record);
          await timeline(tx, actor, resource, record, previous);
          return record;
        },
      );
      return present(resource, saved, Object.hasOwn(data, 'descriptionHtml'));
    },
    /** @param {Object} input Lista y revisión esperada. @returns {Promise<Object>} Retira lista y precios atómicamente; un reintento confirmado no repite eventos. */
    async deletePriceList(input) {
      const mutation = receipt('price-list', 'delete', input, 'deletePriceList');
      const replayed = await mutation.replay();
      if (replayed !== undefined) return replayed;
      const actor = context();
      access(actor, 'price-list', 'delete');
      return mutation.transaction(
        /** @param {Object} tx Transacción. @returns {Promise<Object>} Conserva referencias históricas y rechaza asignaciones de cualquier workspace. */
        async (tx) => {
          const previous = await get('price-list', input.code, 'delete', actor, tx, true);
          if (
            previous.erased &&
            [previous.revision, previous.revision - 1].includes(input.revision)
          )
            return present('price-list', previous);
          match(previous, input.revision);
          if (await tx.get('assignment', { priceListCode: previous.code }))
            throw new ApplicationError(409, 'PRODUCT_PRICE_LIST_ASSIGNED');
          const record = {
            ...previous,
            erased     : true,
            active     : false,
            revision   : previous.revision + 1,
            updateDate : clock(),
          };
          await tx.replace('price-list', previous, record);
          for (;;) {
            const batch = await tx.list(
              'price',
              {
                priceListCode : previous.code,
                workspace     : previous.workspace,
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
              await timeline(tx, actor, 'price', retired, price);
            }
          }
          await timeline(tx, actor, 'price-list', record, previous);
          return present('price-list', record);
        },
      );
    },
    /** @param {Object} input Cliente actual. @returns {Promise<Object>} Asignación opcional, sin fallback inventado. */
    async customerPriceList(input) {
      const actor = context();
      access(actor, 'assignment', 'view');
      customerAccess(actor, await references.customer(input.customerCode), false);
      const record = await store.get('assignment', {
        workspace    : actor.workspace,
        customerCode : input.customerCode,
        active       : true,
      });
      return { assignment: record ? present('assignment', record) : null };
    },
  };
  if (!readingSnapshot)
    for (const method of ['priceMatrix', 'getOne', 'getList', 'itemPrices', 'customerPriceList']) {
      /** @param {...*} args Consulta pública. @returns {Promise<Object>} Datos, referencias locales y total del mismo snapshot del productor. */
      api[method] = (...args) =>
        store.transaction(
          /** @param {Object} tx Puerto enlazado a la sesión de lectura. @returns {Promise<Object>} La misma consulta canónica con sus permisos y proyección. */
          (tx) =>
            productRecords({
              store           : tx,
              references,
              fiscal,
              context,
              clock,
              identifier,
              digest,
              normalizeDescription,
              readingSnapshot : true,
            })[method](...args),
        );
    }
  return api;
}
module.exports = { productRecords };
