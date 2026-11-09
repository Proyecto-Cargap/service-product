/** @file Escapa descripciones históricas sin interpretar HTML ni depender del navegador. */
'use strict';
/** @param {string} text Descripción histórica literal. @returns {string} HTML escapado sin interpretar etiquetas anteriores. */
function descriptionHtml(text) {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return '<p>' + escaped.replace(/\r\n?|\n/g, '<br>') + '</p>';
}
module.exports = { descriptionHtml };
