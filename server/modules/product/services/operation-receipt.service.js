/** @file Recibos atómicos por actor, cliente, workspace y acción; los replays vuelven a autorizarse. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {*} value Valor JSON. @returns {string} Representación estable independiente del orden de propiedades. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          /** @param {string} key Campo. @returns {string} Par JSON canónico. */
          (key) => JSON.stringify(key) + ':' + canonical(value[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
/** @param {Object} options Persistencia, actor, entrada, digest y autorización actual. @returns {Object} Recuperación y transacción sin red dentro de callbacks Mongo. */
function operationReceipt({ store, actor, action, input, digest, authorize }) {
  const idempotencyKey = input.idempotencyKey || actor.operation?.idempotencyKey;
  if (actor.delegation && !idempotencyKey)
    throw new ApplicationError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  if (
    idempotencyKey &&
    (typeof digest !== 'function' ||
      typeof store.receiptRead !== 'function' ||
      typeof store.receiptInsert !== 'function')
  )
    throw new TypeError('RECEIPT_CAPABILITY_REQUIRED');
  const key         = idempotencyKey
    ? digest(
        canonical([
          actor.user.userCode,
          actor.delegation?.clientId || 'session',
          actor.workspace,
          action,
          idempotencyKey,
        ]),
      )
    : '';
  const fingerprint = key ? digest(canonical(input)) : '';
  /** @param {Object} receipt Recibo confirmado. @returns {Object} Resultado de la misma intención o conflicto explícito. */
  function result(receipt) {
    if (receipt.fingerprint !== fingerprint)
      throw new ApplicationError(409, 'IDEMPOTENCY_CONFLICT');
    return structuredClone(receipt.result);
  }
  return {
    /** @returns {Promise<Object|undefined>} Recuperación tras comprobar acceso actual al recurso. */
    async replay() {
      if (!key) return undefined;
      const saved = await store.receiptRead(key);
      if (!saved) return undefined;
      const value = result(saved);
      await authorize(value);
      return value;
    },
    /** @param {Function} work Mutación y eventos de la misma unidad. @returns {Promise<Object>} Commit único o resultado previo autorizado. */
    async transaction(work) {
      if (!key) return store.transaction(work);
      let repeated = false;
      let value;
      try {
        value = await store.transaction(
          /** @param {Object} tx Puerto ligado a la transacción. @returns {Promise<Object>} Cambio y recibo indivisibles. */
          async (tx) => {
            const previous = await tx.receiptRead(key);
            if (previous) {
              repeated = true;
              return result(previous);
            }
            const output = await work(tx);
            await tx.receiptInsert({
              code   : key,
              fingerprint,
              result : output,
            });
            return output;
          },
        );
      } catch (error) {
        const saved = await store.receiptRead(key);
        if (!saved) throw error;
        repeated = true;
        value = result(saved);
      }
      if (repeated) await authorize(value);
      return value;
    },
  };
}
module.exports = { operationReceipt };
