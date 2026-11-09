/** @file Permisos globales del catálogo y acceso separado a asignaciones por cliente. */
'use strict';
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} actor Contexto del transporte. @param {string} resource Recurso. @param {string} action Acción. @returns {Object} Selector autorizado obligatorio. */
function access(actor, resource, action) {
  if (!actor?.user?.userCode) throw new ApplicationError(401, 'UNAUTHORIZED');
  const scope = resource === 'assignment' ? 'workspace' : 'global';
  if (!actor.policies?.includes(`product.${resource}.${action}.${scope}`))
    throw new ApplicationError(403, 'FORBIDDEN');
  if (scope === 'workspace' && (!actor.workspace || actor.workspace === 'allWorkspaces'))
    throw new ApplicationError(400, 'PRODUCT_WORKSPACE_REQUIRED');
  return { workspace: scope === 'global' ? 'allWorkspaces' : actor.workspace };
}
/** @param {Object} actor Principal actual. @param {Object} customer Cliente acreditado por su API. @param {boolean} writable Requiere actualizar cliente. @returns {void} No amplía el ámbito de Customer. */
function customerAccess(actor, customer, writable) {
  if (customer.workspace !== actor.workspace) throw new ApplicationError(403, 'FORBIDDEN');
  if (!writable) return;
  const base = 'customer.customer.update.';
  if (
    actor.policies.includes(base + 'global') ||
    actor.policies.includes(base + 'workspace') ||
    (actor.policies.includes(base + 'owner') && customer.userCreate === actor.user.userCode) ||
    (actor.policies.includes(base + 'assigned') && customer.userAssigned === actor.user.userCode)
  )
    return;
  throw new ApplicationError(403, 'FORBIDDEN');
}
module.exports = {
  access,
  customerAccess,
};
