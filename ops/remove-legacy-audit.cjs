/** @file Administración explícita para retirar exclusivamente PRODUCT_AUDIT después de activar Timeline. */
'use strict';
const fs                      = require('node:fs');
const { parseArgs, parseEnv } = require('node:util');
/** @param {Object} db Base acreditada por el operador. @param {boolean} apply Autoriza la eliminación solicitada, sin respaldo. @returns {Promise<Object>} Inventario mínimo y resultado idempotente de la colección retirada. */
async function removeLegacyAudit(db, apply = false) {
  if (!db.databaseName || ['admin', 'config', 'local'].includes(db.databaseName))
    throw new Error('EXPLICIT_APPLICATION_DATABASE_REQUIRED');
  const collection = 'PRODUCT_AUDIT';
  const exists     =
    (await db.listCollections({ name: collection }, { nameOnly: true }).toArray()).length > 0;
  const count      = exists ? await db.collection(collection).countDocuments({}) : 0;
  if (exists && apply) await db.collection(collection).drop();
  const remaining =
    (await db.listCollections({ name: collection }, { nameOnly: true }).toArray()).length > 0;
  return {
    database : db.databaseName,
    collection,
    count,
    applied  : apply,
    exists   : remaining,
  };
}
/** @returns {Promise<void>} Lee configuración privada sin imprimirla y aplica sólo sobre la base explícitamente seleccionada. */
async function main() {
  const { values } = parseArgs({
    options : {
      'service-env' : { type: 'string' },
      database      : { type: 'string' },
      apply         : {
        type    : 'boolean',
        default : false,
      },
    },
  });
  const filename   = values['service-env'];
  if (!filename || !require('node:path').isAbsolute(filename) || !values.database)
    throw new Error('SERVICE_ENV_AND_DATABASE_REQUIRED');
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || ![0o400, 0o600].includes(stat.mode & 0o777))
    throw new Error('PRIVATE_ENV_FILE_REQUIRED');
  const env   = parseEnv(fs.readFileSync(filename, 'utf8'));
  const match = /^mongodb(?:\+srv)?:\/\/[^/?]+\/([^?]+)(?:\?.*)?$/.exec(env.DB || '');
  if (!match || decodeURIComponent(match[1]) !== values.database)
    throw new Error('DATABASE_MISMATCH');
  const manifest = require('../server/contracts/service.json');
  if (
    manifest.endpoints.some(
      /** @param {Object} endpoint Contrato publicado. @returns {boolean} Detecta una versión que conserva la bitácora antigua. */
      (endpoint) => endpoint.name.startsWith('product-audit-'),
    ) ||
    require('../server/mongodb-indexes.json').collections.PRODUCT_AUDIT
  )
    throw new Error('TIMELINE_RELEASE_REQUIRED');
  const { MongoClient } = require('mongoose').mongo;
  const client          = new MongoClient(env.DB, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    if (client.db().databaseName !== values.database) throw new Error('DATABASE_MISMATCH');
    console.log(JSON.stringify(await removeLegacyAudit(client.db(), values.apply)));
  } finally {
    await client.close();
  }
}
if (require.main === module)
  main().catch(
    /** @param {Error} error Fallo administrativo. @returns {void} Publica sólo una causa segura, sin URI ni contenido privado. */
    (error) => {
      console.error(
        JSON.stringify({
          name : error.name,
          code : error.code || 'AUDIT_RETIREMENT_FAILED',
        }),
      );
      process.exitCode = 1;
    },
  );
module.exports = { removeLegacyAudit };
