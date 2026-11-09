/** @file Referencias canónicas a Customer y Directory sin acceso a persistencia ajena. */
'use strict';
const { ApplicationError } = require('../../shared/application-error');
/** @param {Object} messaging Transporte autenticado. @returns {Object} Consultas mínimas del dominio. */
function productReferences(messaging) {
  /** @param {string} service Productor. @param {string} action Acción. @param {Object} data Entrada cerrada. @returns {Promise<Object>} Resultado o error explícito. */
  async function request(service, action, data) {
    let result;
    try {
      result = await messaging.request(service, action, data, { timeoutMs: 15000 });
    } catch {
      throw new ApplicationError(503, 'PRODUCT_REFERENCE_UNAVAILABLE');
    }
    if (!result || result.statusCode >= 400)
      throw new ApplicationError(
        result?.statusCode || 503,
        result?.descriptionCode || 'PRODUCT_REFERENCE_UNAVAILABLE',
      );
    return result.data;
  }
  return {
    /** @param {string} customerCode Cliente. @returns {Promise<Object>} Cliente visible en el contexto actual. */
    customer(customerCode) {
      return request('service-customer', 'customer-get-one', { customerCode });
    },
    /** @param {Object[]} values Claves. @returns {Promise<Object>} Validación vigente de Directory. */
    values(values) {
      return request('service-directory', 'fiscal-values-validate', { values });
    },
    /** @param {Object} query Filtros y paginación. @returns {Promise<Object>} Página fiscal canónica. */
    catalog(query) {
      return request('service-directory', 'fiscal-catalog-get-list', query);
    },
  };
}
module.exports = { productReferences };
