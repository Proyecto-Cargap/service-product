/** @file Reglas de descripción enriquecida: formatos seguros, texto comercial, límites y contenido histórico. */
'use strict';
const test                     = require('node:test');
const assert                   = require('node:assert/strict');
const { normalizeDescription } = require('../server/adapters/content/product-description');
const {
  descriptionHtml,
} = require('../server/modules/product/policies/product-description.policy');
test('normaliza formatos compartidos y conserva párrafos, entidades y listas' /** @returns {void} Acredita una proyección legible sin HTML en el texto simple. */, () => {
  const value = normalizeDescription(
    '<p>Diseño <b>web</b> &amp; <i>móvil</i></p><ol><li>Uno</li><li>Dos<br>Tres</li></ol><blockquote>Cita</blockquote><p><a href="https://example.test" onclick="bad()">Enlace</a></p>',
  );
  assert.equal(value.description, 'Diseño web & móvil\nUno\nDos\nTres\nCita\nEnlace');
  assert.match(value.descriptionHtml, /<strong>web<\/strong>/);
  assert.match(value.descriptionHtml, /<em>móvil<\/em>/);
  assert.equal(value.descriptionHtml.includes('onclick'), false);
  assert.deepEqual(normalizeDescription(value.descriptionHtml), value);
});
test('retira contenido ejecutable, recursos y esquemas de enlace inseguros' /** @returns {void} Evita ejecución y descargas mediante el HTML persistido. */, () => {
  const value = normalizeDescription(
    '<script>alert(1)</script><style>bad</style><iframe>oculto</iframe><p style="color:red" onmouseover="bad()">Texto<img src="https://remote.test/a"><a href="javascript:alert(1)">Peligro</a><a href="//remote.test">Relativo</a><a href="mailto:user@example.test">Correo</a></p>',
  );
  assert.equal(value.description, 'TextoPeligroRelativoCorreo');
  assert.doesNotMatch(
    value.descriptionHtml,
    /script|iframe|style|onmouseover|<img|javascript:|href="\/\//,
  );
  assert.match(value.descriptionHtml, /href="mailto:user@example.test"/);
});
test('conserva texto histórico literal y normaliza el vacío sin cambios artificiales' /** @returns {void} Escapa etiquetas anteriores y elimina documentos visualmente vacíos. */, () => {
  assert.equal(
    descriptionHtml('<literal> & texto\nOtra línea'),
    '<p>&lt;literal&gt; &amp; texto<br>Otra línea</p>',
  );
  assert.deepEqual(normalizeDescription('<p><br></p>'), {
    description     : '',
    descriptionHtml : '',
  });
  assert.equal(descriptionHtml(''), '');
});
test('valida 1000 caracteres visibles y 16384 de HTML sin truncar' /** @returns {void} El formato no consume el límite comercial del texto. */, () => {
  assert.equal(
    normalizeDescription('<p><strong>' + 'a'.repeat(1000) + '</strong></p>').description.length,
    1000,
  );
  assert.throws(
    /** @returns {Object} Supera el límite visible. */
    () => normalizeDescription('<p>' + 'a'.repeat(1001) + '</p>'),
    /** @param {Error} error Rechazo de dominio. @returns {boolean} Error público esperado. */
    (error) => error.descriptionCode === 'PRODUCT_DESCRIPTION_TOO_LONG',
  );
  assert.throws(
    /** @returns {Object} Supera el límite del transporte. */
    () => normalizeDescription('a'.repeat(16385)),
    /** @param {Error} error Rechazo de dominio. @returns {boolean} Error público esperado. */
    (error) => error.descriptionCode === 'PRODUCT_DESCRIPTION_HTML_TOO_LONG',
  );
});

test('texto simple separa el padre y los hijos de listas anidadas' /** @returns {void} El HTML de móvil y web produce la misma proyección legible. */, () => {
  assert.equal(
    normalizeDescription('<ul><li>Padre<ul><li>Hijo</li></ul></li><li>Otro</li></ul>').description,
    'Padre\nHijo\nOtro',
  );
});

test('enlaces absolutos: retira rutas relativas, anclas y destinos malformados' /** @returns {void} La lista de esquemas no permite que el saneador conserve URLs relativas implícitas. */, () => {
  for (const href of [
    '/ruta',
    '#ancla',
    'archivo.txt',
    'http://',
    'https://user:pass@example.test',
    'mailto:',
    'data:text/html,bad',
  ]) {
    assert.equal(
      normalizeDescription('<p><a href="' + href + '">Texto</a></p>').descriptionHtml,
      '<p><a>Texto</a></p>',
    );
  }
});
