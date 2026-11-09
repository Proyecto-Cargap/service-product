/** @file Acredita permisos y alcance de referencias de Product sin exponer sus datos comerciales. */
'use strict';
const resources = ['item', 'sku', 'category', 'attribute', 'price-list', 'price', 'assignment'];
/** @param {Object} dependencies Lecturas autorizadas del propietario. @returns {Function} Consulta de permisos por lotes con orden estable. */
function createResourceAccess({ records }) {
  /** @param {Object} input Referencias canónicas. @returns {Promise<Object>} Permisos y workspace del registro; propaga fallos técnicos. */
  return async function check(input) {
    const items = [];
    for (const ref of input.references) {
      let workspace = null;
      if (resources.includes(ref.domain)) {
        try {
          const record = await records.reference(ref.domain, ref.code);
          workspace = record.workspace;
        } catch (error) {
          if (
            ![401, 403, 404].includes(error.statusCode) &&
            error.descriptionCode !== 'PRODUCT_WORKSPACE_REQUIRED'
          )
            throw error;
        }
      }
      items.push({
        domain  : ref.domain,
        code    : ref.code,
        allowed : workspace !== null,
        workspace,
      });
    }
    return { items };
  };
}
module.exports = { createResourceAccess };
