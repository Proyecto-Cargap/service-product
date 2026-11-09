/** @file Normaliza la descripción enriquecida y mantiene su proyección comercial de texto simple. */
'use strict';
const sanitizeHtml         = require('sanitize-html');
const { Parser }           = require('htmlparser2');
const { ApplicationError } = require('../../shared/application-error');
/** @param {string} value Destino no confiable. @returns {boolean} Sólo enlaces absolutos HTTP, HTTPS o correo sin controles ni credenciales. */
function allowedLink(value) {
  if (!/^(https?:\/\/|mailto:)[^\s\u0000-\u001f\u007f]+$/i.test(value)) return false;
  try {
    const uri = new URL(value);
    if (uri.protocol === 'mailto:') return Boolean(uri.pathname) && !uri.host;
    return Boolean(uri.hostname) && !uri.username && !uri.password;
  } catch {
    return false;
  }
}
/** @param {string} html Fragmento ya saneado. @returns {string} Texto con separaciones entre párrafos y elementos de lista. */
function descriptionText(html) {
  let text     = '';
  const parser = new Parser(
    {
      /** @param {string} name Etiqueta abierta. @returns {void} Conserva saltos explícitos. */
      onopentag(name) {
        if (['p', 'li', 'blockquote', 'ul', 'ol'].includes(name) && text && !text.endsWith('\n'))
          text += '\n';
        if (name === 'br') text += '\n';
      },
      /** @param {string} value Texto con entidades ya decodificadas. @returns {void} Reúne el contenido visible. */
      ontext(value) {
        text += value;
      },
      /** @param {string} name Etiqueta cerrada. @returns {void} Separa bloques sin fusionar palabras. */
      onclosetag(name) {
        if (['p', 'li', 'blockquote'].includes(name) && !text.endsWith('\n')) text += '\n';
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
/** @param {string} html Entrada no confiable. @returns {{description:string,descriptionHtml:string}} HTML acotado y texto derivado por el servidor. @throws {ApplicationError} Rechaza tamaño excesivo sin truncar contenido. */
function normalizeDescription(html) {
  if (typeof html !== 'string' || html.length > 16384)
    throw new ApplicationError(400, 'PRODUCT_DESCRIPTION_HTML_TOO_LONG');
  const clean = sanitizeHtml(html, {
    allowedTags           : ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'a'],
    allowedAttributes     : { a: ['href'] },
    allowedSchemes        : ['http', 'https', 'mailto'],
    allowProtocolRelative : false,
    transformTags         : {
      b : 'strong',
      i : 'em',
      /** @param {string} tagName Etiqueta de enlace. @param {Object} attributes Atributos decodificados. @returns {Object} Retira destinos relativos o ajenos a los protocolos admitidos. */
      a(tagName, attributes) {
        return {
          tagName,
          attribs : allowedLink(attributes.href || '') ? { href: attributes.href } : {},
        };
      },
    },
    nonTextTags           : ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed'],
  });
  const text  = descriptionText(clean);
  if (text.length > 1000) throw new ApplicationError(400, 'PRODUCT_DESCRIPTION_TOO_LONG');
  if (clean.length > 16384) throw new ApplicationError(400, 'PRODUCT_DESCRIPTION_HTML_TOO_LONG');
  return {
    description     : text,
    descriptionHtml : text ? clean : '',
  };
}
module.exports = {
  descriptionText,
  normalizeDescription,
};
