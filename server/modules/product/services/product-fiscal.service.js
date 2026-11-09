/** @file Valida información fiscal opcional y acredita que un artículo esté listo para facturar. */
'use strict';
const Decimal              = require('decimal.js');
const { ApplicationError } = require('../../../shared/application-error');
/** @param {Object} references Catálogos acreditados. @returns {Function} Validación sin persistencia propia. */
function productFiscal(references) {
  /** @param {Object} fiscal Datos comerciales opcionales. @param {boolean} complete Exige información para facturar. @returns {Promise<void>} Rechaza datos inválidos y propaga indisponibilidad. */
  return async function validateFiscal(fiscal, complete = false) {
    if (
      complete &&
      (!fiscal.productService || !fiscal.unit || !fiscal.taxObject || !Array.isArray(fiscal.taxes))
    )
      throw new ApplicationError(409, 'PRODUCT_FISCAL_INCOMPLETE');
    const values = [];
    for (const [key, kind] of [
      ['productService', 'product-service'],
      ['unit', 'unit'],
      ['taxObject', 'tax-object'],
    ])
      if (fiscal[key])
        values.push({
          kind,
          code : fiscal[key],
        });
    if (values.length) await references.values(values);
    if (complete && fiscal.taxObject === '02' && !fiscal.taxes?.length)
      throw new ApplicationError(400, 'PRODUCT_TAXES_REQUIRED');
    const taxes = fiscal.taxes || [];
    if (
      (['01', '03', '04', '05'].includes(fiscal.taxObject) && taxes.length) ||
      (['06', '08'].includes(fiscal.taxObject) &&
        taxes.some(
          /** @param {Object} tax Impuesto. @returns {boolean} Sólo admite retención ISR. */
          (tax) => tax.kind !== 'withheld' || tax.code !== '001',
        )) ||
      (fiscal.taxObject === '07' &&
        (taxes.some(
          /** @param {Object} tax Impuesto. @returns {boolean} Excluye IVA e ISR trasladado. */
          (tax) => tax.code === '002' || (tax.code === '001' && tax.kind !== 'withheld'),
        ) ||
          (complete &&
            !taxes.some(
              /** @param {Object} tax Impuesto. @returns {boolean} Requiere IEPS trasladado al facturar. */
              (tax) => tax.code === '003' && tax.kind === 'transferred',
            ))))
    )
      throw new ApplicationError(400, 'PRODUCT_TAX_OBJECT_CONFLICT');
    if (!taxes.length) return;
    const rates = [];
    let page = 1,
      total;
    do {
      const result = await references.catalog({
        kind    : 'tax-rate',
        page,
        perPage : 100,
      });
      rates.push(...result.items);
      total = result.pagination?.total ?? rates.length;
      page++;
      if (!result.items.length && rates.length < total)
        throw new ApplicationError(503, 'PRODUCT_REFERENCE_INCOMPLETE');
    } while (rates.length < total);
    const seen = new Set();
    for (const tax of taxes) {
      const key = [tax.kind, tax.code, tax.factor, tax.rate || ''].join(':');
      if (seen.has(key)) throw new ApplicationError(400, 'PRODUCT_TAX_INVALID');
      seen.add(key);
      if (tax.factor === 'Exento') {
        if (tax.kind !== 'transferred' || tax.code !== '002' || tax.rate)
          throw new ApplicationError(400, 'PRODUCT_TAX_INVALID');
        continue;
      }
      if (!tax.rate) throw new ApplicationError(400, 'PRODUCT_TAX_RATE_REQUIRED');
      const rate = new Decimal(tax.rate);
      if (
        !rates.some(
          /** @param {Object} entry Tasa de Directory. @returns {boolean} Coincidencia de impuesto, factor, dirección y rango. */
          (entry) =>
            entry.tax === tax.code &&
            entry.factor === tax.factor &&
            entry[tax.kind] &&
            (entry.kind === 'fixed'
              ? rate.eq(entry.max)
              : rate.gte(entry.min) && rate.lte(entry.max)),
        )
      )
        throw new ApplicationError(400, 'PRODUCT_TAX_INVALID');
    }
  };
}
module.exports = { productFiscal };
