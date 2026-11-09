/** @file Migra fotografías individuales a galerías sin copiar archivos; simulación por defecto. */
'use strict';
/** @param {Object} db Base del catálogo. @param {boolean} apply Habilita escritura explícita. @returns {Promise<Object>} Cantidades verificables por colección. */
async function migrateGalleries(db, apply = false) {
  const results = {};
  for (const name of ['PRODUCT_ITEM', 'PRODUCT_SKU']) {
    const collection = db.collection(name);
    const filter     = { images: { $exists: false } };
    results[name] = {
      pending  : await collection.countDocuments(filter),
      modified : 0,
    };
    if (apply) {
      const result = await collection.updateMany(filter, [
        {
          $set : {
            images : { $cond: [{ $eq: [{ $type: '$image' }, 'object'] }, ['$image'], []] },
          },
        },
      ]);
      results[name].modified = result.modifiedCount;
    }
  }
  return results;
}
/** @returns {Promise<void>} Ejecuta contra DB explícita sin cargar credenciales ni modificar infraestructura. */
async function main() {
  if (!process.env.DB) throw new Error('DB_REQUIRED');
  const mongoose   = require('mongoose');
  const connection = await mongoose
    .createConnection(process.env.DB, {
      autoIndex  : false,
      autoCreate : false,
    })
    .asPromise();
  try {
    process.stdout.write(
      JSON.stringify(await migrateGalleries(connection.db, process.argv.includes('--apply'))) +
        '\n',
    );
  } finally {
    await connection.close();
  }
}
if (require.main === module)
  main().catch(
    /** @param {Error} error Fallo técnico; no publica URIs de conexión. @returns {void} Termina con diagnóstico acotado. */
    (error) => {
      process.stderr.write(
        (error.message === 'DB_REQUIRED' ? error.message : 'GALLERY_MIGRATION_FAILED') + '\n',
      );
      process.exitCode = 1;
    },
  );
module.exports = { migrateGalleries };
